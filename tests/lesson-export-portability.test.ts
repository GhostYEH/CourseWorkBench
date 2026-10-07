/**
 * 媒体可移植引用判定（OMA-072，覆盖 PPTX/MP4 导出侧）。
 *
 * 既有 tests/lesson-export.test.ts 已断言 HTML 清单不含盘符与 http(s) URL；本文件把同一口径
 * 推到新的两个导出形态上：PPTX 结构模型与 MP4 渲染任务记录里都不许出现失效 URL、
 * 开发期绝对路径或依赖旧机器/旧浏览器缓存的引用，缺口必须以可见形式登记。
 */

import { describe, expect, it } from 'vitest';
import type { PlanElementDto, PlanSceneDto } from '@sew/study-contracts';
import {
  buildPptxDeck,
  classifyMediaReference,
  isPortableMediaReference,
  redactedReferenceHint,
  type PptxDeck,
  type PptxDeckIdentity,
} from '../packages/study-domain/src/lesson-export-pptx';
import {
  buildMp4RenderPlan,
  createMp4RenderJob,
  applyMp4JobEvent,
  mp4JobResultView,
  normalizeMp4Runtimes,
  recoverMp4Job,
  type Mp4RenderPlan,
  type Mp4RuntimeDeclaration,
} from '../packages/study-domain/src/lesson-export-mp4';
import { scenePlanDigest } from '../packages/study-domain/src/scene-plan';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const PORTABLE = [
  'assets/asset-0.png',
  'assets/sub/dir/font.woff2',
  'data:image/png;base64,iVBORw0KGgo=',
  'data:font/woff2;base64,d09GMgAB',
];

const NON_PORTABLE: Array<{ reference: string; kind: string }> = [
  { reference: 'https://cdn.example.com/a.png', kind: 'external-url' },
  { reference: 'HTTP://example.com/a.png', kind: 'external-url' },
  { reference: '//cdn.example.com/a.png', kind: 'external-url' },
  { reference: 'D:\\temp\\a.png', kind: 'development-path' },
  { reference: 'C:/Users/dev/a.png', kind: 'development-path' },
  { reference: '\\\\server\\share\\a.png', kind: 'development-path' },
  { reference: '/home/dev/a.png', kind: 'development-path' },
  { reference: 'assets\\a.png', kind: 'development-path' },
  { reference: '../outside.png', kind: 'invalid' },
  { reference: 'assets/./a.png', kind: 'invalid' },
  { reference: 'assets//a.png', kind: 'invalid' },
  { reference: 'data:text/html;base64,PHNjcmlwdD4=', kind: 'invalid' },
  { reference: 'data:image/svg+xml;base64,PHN2Zz4=', kind: 'invalid' },
  { reference: '', kind: 'invalid' },
];

const identity = (scenes: PlanSceneDto[]): PptxDeckIdentity => ({
  projectId: 'proj_port',
  lessonId: 'lesson_1',
  lessonVersion: 1,
  bundleId: 'bundle_1',
  title: '可移植性测试课件',
  stageId: 'stage_formal_lesson_1_v1',
  dslVersion: null,
  documentDigest: SHA_A,
  exportedDocumentDigest: SHA_B,
  planDigest: scenePlanDigest({
    lessonId: 'lesson_1',
    lessonVersion: 1,
    bundleId: 'bundle_1',
    scenes,
  }),
});

const deck = (elements: PlanElementDto[]): PptxDeck => {
  const scenes: PlanSceneDto[] = [
    {
      sceneId: 'scene_slide_1',
      kind: 'slide',
      title: '可移植引用',
      statementId: 'st_1',
      questionId: null,
      knowledgeIds: ['kp_1'],
      elements,
      note: '',
    },
  ];
  return buildPptxDeck({
    identity: identity(scenes),
    scenes,
    options: {
      media: new Map([
        [
          'ok-image',
          {
            reference: 'assets/asset-0.png',
            mediaType: 'image/png',
            sha256: SHA_A,
            byteLength: 1234,
          },
        ],
      ]),
    },
  });
};

describe('media portability across export formats (OMA-072)', () => {
  it('classifies every reference shape the same way for pptx and mp4', () => {
    for (const reference of PORTABLE) {
      expect(isPortableMediaReference(reference)).toBe(true);
      expect(['package-relative', 'inline-data']).toContain(classifyMediaReference(reference));
    }
    for (const { reference, kind } of NON_PORTABLE) {
      expect(classifyMediaReference(reference)).toBe(kind);
      expect(isPortableMediaReference(reference)).toBe(false);
    }
  });

  it('keeps pptx artifacts free of dead URLs and development paths while reporting gaps in full', () => {
    const built = deck([
      {
        elementId: 'el_ok',
        kind: 'image',
        text: '',
        assetRef: 'ok-image',
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        style: { fontSize: 12, color: '#232323', bold: false, italic: false, align: 'left' },
      },
      ...['https://cdn.example.com/a.png', 'D:\\dev\\b.png', '../c.png'].map((assetRef, index) => ({
        elementId: `el_bad_${index}`,
        kind: 'image' as const,
        text: '' as const,
        assetRef,
        left: 200,
        top: 0,
        width: 100,
        height: 100,
        style: {
          fontSize: 12,
          color: '#232323',
          bold: false,
          italic: false,
          align: 'left' as const,
        },
      })),
    ]);

    const artifact = JSON.stringify(built.slides);
    expect(artifact).not.toMatch(/https?:\/\//i);
    expect(artifact).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(artifact).not.toContain('..');
    expect(artifact).toContain('assets/asset-0.png');
    // 缺口报告保留完整引用，产物正文只留脱敏文件名
    expect(JSON.stringify(built.issues)).toContain('cdn.example.com');
    expect(built.issues.filter((issue) => issue.code === 'asset-reference-rejected')).toHaveLength(
      3,
    );
    expect(redactedReferenceHint('https://cdn.example.com/a.png')).toBe('a.png');
    expect(redactedReferenceHint('D:\\dev\\b.png')).toBe('b.png');
    expect(redactedReferenceHint('')).toBe('（无法归类的引用）');
  });

  it('rejects non-portable runtime declarations and output paths in mp4 job records', () => {
    const base: Mp4RuntimeDeclaration = {
      kind: 'chromium',
      reference: 'chromium',
      required: true,
      minVersion: '120.0.0',
      expectedDigest: SHA_A,
      actualVersion: '121.0.0',
      actualDigest: SHA_A,
      status: 'available',
      note: '',
    };
    for (const reference of [
      'https://mirror/chromium.zip',
      'D:\\tools\\chrome.exe',
      '/opt/bin/ffmpeg',
      '..\\ffmpeg',
    ]) {
      expect(() => normalizeMp4Runtimes([{ ...base, reference }])).toThrow();
    }
    expect(
      normalizeMp4Runtimes([{ ...base, reference: 'runtimes/chromium/chrome.exe' }]),
    ).toHaveLength(1);
  });

  it('never leaks an absolute output path into the mp4 job result view', () => {
    const scenes: PlanSceneDto[] = [
      {
        sceneId: 'scene_slide_1',
        kind: 'slide',
        title: '可移植输出',
        statementId: 'st_1',
        questionId: null,
        knowledgeIds: ['kp_1'],
        elements: [
          {
            elementId: 'el_text_1',
            kind: 'text',
            text: '正文',
            assetRef: null,
            left: 0,
            top: 0,
            width: 100,
            height: 50,
            style: { fontSize: 20, color: '#232323', bold: false, italic: false, align: 'left' },
          },
        ],
        note: '',
      },
    ];
    const plan: Mp4RenderPlan = buildMp4RenderPlan({
      identity: {
        projectId: 'proj_port',
        lessonId: 'lesson_1',
        lessonVersion: 1,
        bundleId: 'bundle_1',
        title: '可移植输出',
        planDigest: scenePlanDigest({
          lessonId: 'lesson_1',
          lessonVersion: 1,
          bundleId: 'bundle_1',
          scenes,
        }),
        documentDigest: SHA_A,
        exportedDocumentDigest: SHA_B,
      },
      scenes,
      encoding: {
        container: 'mp4',
        videoCodec: 'h264',
        pixelFormat: 'yuv420p',
        width: 1280,
        height: 720,
        fps: 30,
        constantRateFactor: 23,
        fastStart: true,
        audio: null,
      },
      canvas: { viewportSize: 1000, viewportRatio: 0.5625 },
      runtimes: normalizeMp4Runtimes([
        {
          kind: 'chromium',
          reference: 'chromium',
          required: true,
          minVersion: '120',
          expectedDigest: SHA_A,
          actualVersion: '121',
          actualDigest: SHA_A,
          status: 'available',
          note: '',
        },
        {
          kind: 'ffmpeg',
          reference: 'ffmpeg',
          required: true,
          minVersion: '6',
          expectedDigest: SHA_B,
          actualVersion: '7.0',
          actualDigest: SHA_B,
          status: 'available',
          note: '',
        },
      ]),
    });
    expect(classifyMediaReference(`${plan.output.directory}/${plan.output.fileName}`)).toBe(
      'package-relative',
    );
    let job = createMp4RenderJob({
      jobId: 'job_1',
      requestId: 'req_1',
      plan,
      at: '2026-10-07T00:00:00.000Z',
    });
    job = applyMp4JobEvent(job, 'begin-preparation', { at: 'x' }, plan);
    job = applyMp4JobEvent(job, 'resources-verified', { at: 'x', blockingRuntimes: [] }, plan);
    job = applyMp4JobEvent(job, 'begin-capture', { at: 'x' }, plan);
    job = applyMp4JobEvent(
      job,
      'segment-captured',
      { at: 'x', segmentIndex: 0, artifact: { byteLength: 512, sha256: SHA_A } },
      plan,
    );
    job = applyMp4JobEvent(job, 'capture-completed', { at: 'x' }, plan);
    job = applyMp4JobEvent(job, 'begin-encoding', { at: 'x' }, plan);
    // 绝对路径的输出直接拒绝
    expect(() =>
      applyMp4JobEvent(
        job,
        'encoding-completed',
        {
          at: 'x',
          output: {
            fileName: 'D:\\exports\\lesson.mp4',
            byteLength: 10,
            sha256: SHA_A,
            playable: true,
          },
        },
        plan,
      ),
    ).toThrow();
    const done = applyMp4JobEvent(
      job,
      'encoding-completed',
      {
        at: 'x',
        output: {
          fileName: plan.output.fileName,
          byteLength: 40_000,
          sha256: SHA_A,
          playable: true,
        },
      },
      plan,
    );
    const view = mp4JobResultView(done, plan);
    expect(view.destination).toBe(`exports/lesson_1-v1/${plan.output.fileName}`);
    expect(JSON.stringify(view)).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(
      JSON.stringify(
        recoverMp4Job({
          job: done,
          plan,
          runtimes: plan.runtimes,
          actualSegmentDigests: new Map([[0, SHA_A]]),
          outputOnDisk: { exists: true, sha256: SHA_A, byteLength: 40_000 },
          currentPlanDigest: plan.identity.planDigest,
          at: 'x',
        }),
      ),
    ).not.toMatch(/[A-Za-z]:[\\/]/);
  });
});
