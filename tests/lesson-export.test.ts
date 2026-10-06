import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LessonExportManifest } from '@sew/study-contracts';
import { classroomDocumentDigest, stripQuizAnswers } from '@sew/study-domain';
import { buildLessonExport, readZip, StudyStore } from '@sew/study-storage';

const PROJECT = 'proj_export';
const STAGE = 'stage_formal_lesson_1_v1';
const LESSON = 'lesson_1';

const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

const document = {
  stage: { id: STAGE, name: '导出测试课件', description: 'x', createdAt: 0, updatedAt: 0 },
  scenes: [
    {
      id: 'scene_slide_1',
      type: 'slide',
      title: '幻灯片一',
      order: 0,
      content: {
        type: 'slide',
        schemaVersion: 1,
        canvas: {
          id: 'c1',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          elements: [
            {
              id: 'e1',
              type: 'text',
              left: 0,
              top: 0,
              width: 100,
              height: 50,
              content: '<p>正文</p>',
            },
            { id: 'e2', type: 'image', left: 0, top: 0, width: 100, height: 50, src: 'demo-image' },
            {
              id: 'e3',
              type: 'image',
              left: 0,
              top: 0,
              width: 100,
              height: 50,
              src: 'missing-image',
            },
          ],
        },
      },
    },
    {
      id: 'scene_quiz_1',
      type: 'quiz',
      title: '测验一',
      order: 1,
      content: {
        type: 'quiz',
        questions: [
          {
            id: 'q1',
            type: 'single',
            question: '题干',
            options: [{ label: 'A', value: 'A' }],
            answer: ['A'],
            analysis: '解析',
            points: 5,
          },
        ],
      },
    },
  ],
};

describe('lesson export package builder', () => {
  let temp: string;
  let store: StudyStore;
  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), 'sew-lesson-export-'));
    store = StudyStore.open({ file: join(temp, 'study.db') });
    store.createProject({ projectId: PROJECT, displayName: '导出测试' });
    store.putClassroomAsset(
      PROJECT,
      'asset_img',
      'image/png',
      { symbolicRef: 'demo-image' },
      imageBytes,
    );
    store.saveClassroomDocument({
      recordScope: 'formal',
      projectId: PROJECT,
      stageId: STAGE,
      lessonId: LESSON,
      dslVersion: '0.3.0',
      document,
      digest: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
      sceneCount: 2,
      scenes: [
        { sceneId: 'scene_slide_1', knowledgeIds: ['kp_1'], questionId: null },
        { sceneId: 'scene_quiz_1', knowledgeIds: ['kp_2'], questionId: 'q1' },
      ],
      reviewedBy: '测试审核人',
      reviewNote: '导出测试',
    });
    store.putClassroomAssetBinding(PROJECT, STAGE, 'scene_slide_1', 'image:e2', 'asset_img');
  });
  afterEach(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    rmSync(temp, { recursive: true, force: true });
  });

  const build = (exportDocument: unknown = document) =>
    buildLessonExport({
      store,
      projectId: PROJECT,
      lessonId: LESSON,
      version: 1,
      title: '导出测试课件',
      bundleDigest: 'bundle-digest',
      plan: null,
      stageId: STAGE,
      dslVersion: '0.3.0',
      documentDigest: 'a'.repeat(64),
      document: exportDocument,
    });

  it('produces a readable archive with a manifest, bundled assets, and an offline HTML', () => {
    const pkg = build();
    expect(pkg.fileName).toBe('lesson-lesson_1-v1.zip');
    const entries = readZip(pkg.bytes);
    const paths = entries.map((entry) => entry.path);
    expect(paths).toContain('manifest.json');
    expect(paths).toContain('index.html');
    expect(paths.some((path) => path.startsWith('assets/'))).toBe(true);

    const manifest = JSON.parse(
      new TextDecoder().decode(entries.find((entry) => entry.path === 'manifest.json')!.bytes),
    ) as LessonExportManifest;
    expect(manifest.lessonId).toBe(LESSON);
    expect(manifest.lessonVersion).toBe(1);
    expect(manifest.sceneCount).toBe(2);
    expect(manifest.documentDigest).toBe('a'.repeat(64));
    // 每个清单条目都能在归档里找到，且摘要一致。
    for (const entry of manifest.entries) {
      const file = entries.find((candidate) => candidate.path === entry.path)!;
      expect(createHash('sha256').update(file.bytes).digest('hex')).toBe(entry.sha256);
      expect(file.bytes.byteLength).toBe(entry.byteLength);
    }
    // 文档引用的库内资源被内联，引用不到的登记为缺口。
    expect(pkg.unresolvedAssets).toEqual(['missing-image']);
    expect(manifest.resources.some((r) => r.kind === 'image' && r.status === 'inlined')).toBe(true);
    expect(manifest.resources.some((r) => r.reference === 'katex' && r.status === 'missing')).toBe(
      true,
    );
  });

  it('strips quiz answers from the packaged projection (non-vacuous: projection digest differs from source)', () => {
    const pkg = build();
    const html = new TextDecoder().decode(
      readZip(pkg.bytes).find((entry) => entry.path === 'index.html')!.bytes,
    );
    expect(html).toContain('幻灯片一');
    expect(html).toContain('测验一');
    expect(html).toContain('题干');

    type QuizDoc = {
      scenes: Array<{ content?: { questions?: Array<Record<string, unknown>> } }>;
    };
    // 源文档确实带判分依据。
    const sourceQuestion = (document as QuizDoc).scenes[1]!.content!.questions![0]!;
    expect(sourceQuestion['answer']).toEqual(['A']);
    expect(sourceQuestion['analysis']).toBe('解析');
    expect(sourceQuestion['points']).toBe(5);

    // 打包投影移除答案/解析/给分点。
    const stripped = stripQuizAnswers(document);
    const strippedQuestion = (stripped.document as QuizDoc).scenes[1]!.content!.questions![0]!;
    expect(strippedQuestion['answer']).toBeUndefined();
    expect(strippedQuestion['analysis']).toBeUndefined();
    expect(strippedQuestion['points']).toBeUndefined();

    // 清单记录的「实际打包投影」摘要 = 去答案后的文档摘要，且与源文档摘要不同。
    expect(pkg.manifest.exportedDocumentDigest).toBe(classroomDocumentDigest(stripped.document));
    expect(pkg.manifest.exportedDocumentDigest).not.toBe(classroomDocumentDigest(document));
  });

  it('never writes absolute paths or external URLs into the manifest', () => {
    const pkg = build();
    const serialized = JSON.stringify(pkg.manifest);
    expect(serialized).not.toMatch(/[A-Za-z]:\\/);
    expect(serialized).not.toMatch(/https?:\/\//);
  });

  it('exports only the immutable formal scene binding despite newer same-symbol resources', () => {
    for (const scope of ['formal', 'demo'] as const) {
      store.putClassroomAsset(
        PROJECT,
        `unreviewed_${scope}`,
        'image/png',
        { symbolicRef: 'demo-image' },
        new TextEncoder().encode(`UNREVIEWED_${scope}`),
        scope,
      );
    }
    const assets = readZip(build().bytes).filter((entry) => entry.path.startsWith('assets/'));
    expect(assets).toHaveLength(1);
    expect([...assets[0]!.bytes]).toEqual([...imageBytes]);
    expect(() =>
      store.putClassroomAsset(
        PROJECT,
        'asset_img',
        'image/png',
        { symbolicRef: 'demo-image' },
        new Uint8Array([1]),
      ),
    ).toThrow();
  });

  it('does not bundle unbound or ambiguous resources', () => {
    store.putClassroomAsset(
      PROJECT,
      'unbound',
      'image/png',
      { symbolicRef: 'missing-image' },
      imageBytes,
    );
    store.putClassroomAsset(
      PROJECT,
      'conflict',
      'image/png',
      { symbolicRef: 'demo-image' },
      new Uint8Array([1]),
    );
    store.putClassroomAssetBinding(PROJECT, STAGE, 'scene_slide_1', 'image:conflict', 'conflict');
    const pkg = build();
    expect(pkg.unresolvedAssets).toEqual(['demo-image', 'missing-image']);
    expect(readZip(pkg.bytes).some((entry) => entry.path.startsWith('assets/'))).toBe(false);
  });

  it('keeps the full frozen viewport scrollable, including bottom and right edges', () => {
    const html = new TextDecoder().decode(
      readZip(build().bytes).find((entry) => entry.path === 'index.html')!.bytes,
    );
    expect(html).toContain('class="canvas-scroll"');
    expect(html).toContain('width:1000px;height:562.5px');
    expect(html).toContain('.canvas-scroll{max-width:100%;overflow:auto}');
    expect(html).not.toContain('height:520px');
  });

  it('never treats an unbound assets path as an approved offline image', () => {
    const source = {
      ...document,
      scenes: [
        {
          ...document.scenes[0]!,
          content: { canvas: { elements: [{ type: 'image', src: 'assets/../outside.png' }] } },
        },
      ],
    };
    const pkg = build(source);
    const html = new TextDecoder().decode(
      readZip(pkg.bytes).find((entry) => entry.path === 'index.html')!.bytes,
    );
    expect(html).not.toContain('<img');
    expect(pkg.unresolvedAssets).toEqual(['assets/../outside.png']);
  });

  it('reports the host dependency of formal interactive scenes in the offline manifest', () => {
    const pkg = build({
      ...document,
      scenes: [
        {
          id: 'interaction',
          type: 'interactive',
          title: '参数实验',
          order: 0,
          content: { html: '<p>由课堂宿主提供</p>' },
        },
      ],
    });
    expect(pkg.manifest.resources).toContainEqual({
      kind: 'other',
      reference: 'formal-interaction',
      status: 'missing',
      note: '正式参数、关系与排序互动依赖课堂宿主，本静态导出不支持离线运行与提交',
    });
  });
});
