import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as serializer from '../apps/learning/lib/server/pptx-serializer';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiResponses, type PlanPayloadDto } from '@sew/study-contracts';
import { readZip } from '@sew/study-storage';
import { POST as lessonsPost } from '../apps/learning/app/api/study/lessons/route';
import { POST as exportPost } from '../apps/learning/app/api/study/lessons/export/route';
import { GET as download } from '../apps/learning/app/api/study/lessons/export/download/route';
import {
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';

/**
 * 课件导出的 HTTP 边界（OMA-068/069/070/072）。
 *
 * 固定四类真实用户场景：
 * ① 已审核发布且已挂接课件 → 导出成功，产物落项目 exports/，可被 ZIP 读取且清单自洽；
 * ② 未发布 / 已撤回 → 导出被整节阻断，不产出文件；
 * ③ 旧代次写入被拒（项目切换后旧页面不能导出当前项目）；
 * ④ 进程重开 → 已发布课程仍可再次导出。
 */

describe('课件导出 HTTP 边界', () => {
  let root: string;
  let session: Session;
  let lessonId = '';
  let lessonVersion = 1;
  const scope = () => ({ projectId: session.projectId, generation: session.generation });

  const post = (body: Record<string, unknown>) =>
    lessonsPost(
      new Request('http://127.0.0.1/api/study/lessons', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: scope(), ...body }),
      }),
    );

  const exportRequest = (
    scopeOverride?: Record<string, number | string>,
    format = 'html',
    signal?: AbortSignal,
  ) =>
    exportPost(
      new Request('http://127.0.0.1/api/study/lessons/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          scope: scopeOverride ?? scope(),
          action: 'export-lesson',
          lessonId,
          version: lessonVersion,
          format,
        }),
      }),
    );

  const errorOf = async (
    response: Response,
  ): Promise<{ code: string; details?: Record<string, unknown> }> =>
    ((await response.json()) as { error: { code: string; details?: Record<string, unknown> } })
      .error;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-lesson-export-http-'));
    session = openProjectFromDisk(root);
    const projectId = session.projectId;
    const imported = session.store.importMaterial({
      projectId,
      displayName: '考纲.md',
      materialType: 'md',
      rawText: '本章要求理解增函数的定义。\n\n第二条范围说明。',
    });
    const proposal = session.store.createProposal({
      projectId,
      name: '增函数定义',
      concept: '区间内任取 x1 < x2 都有 f(x1) < f(x2)',
      conditions: '同一区间 D 内',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [
        {
          materialId: imported.material.materialId,
          revision: 1,
          segmentId: imported.segments[0]!.segmentId,
          use: 'concept_basis',
        },
      ],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'user',
    });
    const knowledgeId = session.store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
    }).knowledgePoint!.knowledgeId;
    const payload: PlanPayloadDto = {
      payloadVersion: 1,
      goal: '掌握本章',
      examDate: null,
      dailyMinutes: 60,
      tasks: [
        {
          knowledgeId,
          name: '增函数定义',
          minutes: 30,
          acceptance: '',
          evidence: [
            {
              materialId: imported.material.materialId,
              segmentId: imported.segments[0]!.segmentId,
            },
          ],
        },
      ],
      gaps: [],
      basis: '测试计划',
      confirmedTaskKnowledgeIds: [knowledgeId],
    };
    session.store.savePlanVersion(projectId, 1, 'confirmed', payload);
    session.store.startPlanRun(projectId);
    const bundle = session.store.buildLessonBundle(
      projectId,
      [{ knowledgeId, text: '增函数的定义', conditions: '同一区间 D 内' }],
      [],
    );
    const statementId = bundle.bundle.statements[0]!.statementId;
    const lesson = session.store.createLessonDraft({
      projectId,
      lessonId: null,
      title: '函数单调性',
      bundleId: bundle.bundleId,
      statementIds: [statementId],
      questionIds: [],
    });
    lessonId = lesson.lessonId;
    lessonVersion = lesson.version;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeProject();
    rmSync(root, { recursive: true, force: true });
  });

  const publishCurrent = async (): Promise<void> => {
    expect(
      (
        await post({
          action: 'review',
          lessonId,
          version: lessonVersion,
          decision: 'approved',
          note: '按计划审核',
        })
      ).status,
    ).toBe(200);
    expect((await post({ action: 'publish', lessonId, version: lessonVersion })).status).toBe(200);
    expect(
      (await post({ action: 'attach-document', lessonId, version: lessonVersion })).status,
    ).toBe(200);
  };

  it('① 已发布课程导出成功，产物可读且清单自洽', async () => {
    await publishCurrent();
    const response = await exportRequest();
    expect(response.status).toBe(200);
    const data = ((await response.json()) as { data: { export: unknown } }).data;
    expect(apiResponses.lessonExport.safeParse(data).success).toBe(true);
    const result = data.export as {
      destination: string;
      fileName: string;
      sha256: string;
      byteLength: number;
      manifest: {
        entries: Array<{ path: string; sha256: string }>;
        documentDigest: string;
        exportedDocumentDigest: string;
      };
      unresolvedAssets: string[];
    };
    expect(result.destination).toBe(`exports/${result.fileName}`);
    expect(result.destination).not.toMatch(/[A-Za-z]:\\/);
    expect(result.manifest.exportedDocumentDigest).toMatch(/^[a-f0-9]{64}$/);

    const file = join(root, 'exports', result.fileName);
    expect(existsSync(file)).toBe(true);
    const bytes = readFileSync(file);
    expect(bytes.byteLength).toBe(result.byteLength);
    const entries = readZip(new Uint8Array(bytes));
    const paths = entries.map((entry) => entry.path);
    expect(paths).toContain('index.html');
    expect(paths).toContain('manifest.json');
    for (const entry of result.manifest.entries) {
      expect(paths).toContain(entry.path);
    }
  });

  it('② 未发布时导出被阻断，不产出文件；撤回后同样阻断', async () => {
    const blocked = await exportRequest();
    expect(blocked.status).toBe(403);
    expect((await errorOf(blocked)).code).toBe('CLASSROOM_LESSON_NOT_REVIEWED');

    await publishCurrent();
    expect((await exportRequest()).status).toBe(200);

    // 撤回后课堂已不可教，导出同样阻断。
    expect((await post({ action: 'withdraw', lessonId, reason: '停用' })).status).toBe(200);
    const withdrawn = await exportRequest();
    expect(withdrawn.status).toBe(403);
    expect((await errorOf(withdrawn)).code).toBe('CLASSROOM_LESSON_NOT_REVIEWED');
  });

  it('③ 旧代次导出被拒', async () => {
    await publishCurrent();
    const stale = await exportRequest({
      projectId: session.projectId,
      generation: session.generation + 9,
    });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).code).toBe('PROJECT_GENERATION_STALE');
  });

  it('④ 进程重开后仍可再次导出', async () => {
    await publishCurrent();
    expect((await exportRequest()).status).toBe(200);
    const projectId = session.projectId;
    closeProject();
    session = openProjectFromDisk(root);
    expect(session.projectId).toBe(projectId);
    const again = await exportRequest();
    expect(again.status).toBe(200);
  });

  it('exports a real PPTX with frozen default body and verifies every part plus the downloaded bytes', async () => {
    await publishCurrent();
    const response = await exportRequest(undefined, 'pptx');
    const json = await response.json();
    expect(response.status, JSON.stringify(json)).toBe(200);
    const result = apiResponses.lessonExport.parse(json.data).export;
    const bytes = readFileSync(join(root, 'exports', result.fileName));
    const parts = readZip(bytes, { allowEmptyDirectories: true });
    const xml = parts
      .filter((part) => /^ppt\/slides\/slide\d+\.xml$/.test(part.path))
      .map((part) => Buffer.from(part.bytes).toString('utf8'))
      .join('');
    expect(xml).toContain('增函数的定义');
    expect(xml).toContain('同一区间 D 内');
    expect(xml).not.toContain('&lt;p');
    expect(xml).toContain('<p:sp>');
    for (const entry of result.manifest.entries) {
      const part = parts.find((part) => part.path === entry.path)!;
      expect(part.bytes.byteLength).toBe(entry.byteLength);
      expect(createHash('sha256').update(part.bytes).digest('hex')).toBe(entry.sha256);
    }
    const query = new URLSearchParams({
      projectId: session.projectId,
      generation: String(session.generation),
      lessonId,
      version: String(lessonVersion),
      format: 'pptx',
      sha256: result.sha256,
    });
    const delivered = await download(
      new Request(`http://localhost/api/study/lessons/export/download?${query}`),
    );
    expect(delivered.status).toBe(200);
    expect(delivered.headers.get('content-type')).toContain('presentationml');
    const deliveredBytes = Buffer.from(await delivered.arrayBuffer());
    expect(deliveredBytes.byteLength).toBe(bytes.byteLength);
    expect(createHash('sha256').update(deliveredBytes).digest('hex')).toBe(result.sha256);
    writeFileSync(join(root, 'exports', result.fileName), 'corrupted');
    expect(
      (await download(new Request(`http://localhost/api/study/lessons/export/download?${query}`)))
        .status,
    ).toBe(409);
  });

  it('blocks unpublished and cancelled PPTX exports without creating artifacts', async () => {
    expect((await exportRequest(undefined, 'pptx')).status).toBe(403);
    await publishCurrent();
    const controller = new AbortController();
    controller.abort();
    expect((await exportRequest(undefined, 'pptx', controller.signal)).status).toBe(409);
    expect(existsSync(join(root, 'exports', `lesson-${lessonId}-v1.pptx`))).toBe(false);
  });

  it('rechecks publication after async serialization and refuses a withdrawn lesson', async () => {
    await publishCurrent();
    const original = serializer.serializeEditablePptx;
    vi.spyOn(serializer, 'serializeEditablePptx').mockImplementationOnce(async (...args) => {
      const bytes = await original(...args);
      expect((await post({ action: 'withdraw', lessonId, reason: '审核人撤回' })).status).toBe(200);
      return bytes;
    });
    expect((await exportRequest(undefined, 'pptx')).status).toBe(403);
    expect(existsSync(join(root, 'exports', `lesson-${lessonId}-v1.pptx`))).toBe(false);
  });
});
