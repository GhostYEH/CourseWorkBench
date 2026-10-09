import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiResponses,
  zeroMediaUsage,
  type MediaGenerationCommandDto,
  type MediaTaskDto,
  type PlanPayloadDto,
} from '@sew/study-contracts';
import {
  openProjectFromDisk,
  closeProject,
  type Session,
} from '../apps/learning/lib/server/service';
import { modelConnection } from '../apps/learning/lib/server/model-connection';
import { GET as getTasks, POST as generate } from '../apps/learning/app/api/study/media/route';
import { POST as review } from '../apps/learning/app/api/study/media/review/route';
import { POST as cancel } from '../apps/learning/app/api/study/media/cancel/route';
import { GET as product } from '../apps/learning/app/api/study/media/products/[assetId]/route';

describe('media HTTP boundaries without a production build', () => {
  let root: string;
  let session: Session;
  let command: MediaGenerationCommandDto;
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  const request = (path: string, body?: unknown) =>
    new Request(`http://localhost/api/study/media${path}`, {
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
  const scope = () => ({ projectId: session.projectId, generation: session.generation });
  const query = () => `?projectId=${session.projectId}&generation=${session.generation}`;
  const generated = async (): Promise<MediaTaskDto> => {
    const response = await generate(request('', command));
    expect(response.status).toBe(200);
    return apiResponses.mediaTask.parse((await response.json()).data).task;
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-media-http-'));
    session = openProjectFromDisk(root);
    const { store, projectId } = session;
    const text = '增函数在同一区间内随自变量增大而增大。';
    const material = store.importMaterial({
      projectId,
      displayName: '考纲.md',
      materialType: 'md',
      rawText: text,
    });
    const proposal = store.createProposal({
      projectId,
      name: '增函数',
      concept: text,
      conditions: '同一区间',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [
        {
          materialId: material.material.materialId,
          revision: 1,
          segmentId: material.segments[0]!.segmentId,
          use: 'concept_basis',
        },
      ],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'user',
    });
    const knowledgeId = store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
    }).knowledgePoint!.knowledgeId;
    const plan: PlanPayloadDto = {
      payloadVersion: 1,
      goal: '掌握增函数',
      examDate: null,
      dailyMinutes: 60,
      tasks: [
        {
          knowledgeId,
          name: '增函数',
          minutes: 30,
          acceptance: '',
          evidence: [
            {
              materialId: material.material.materialId,
              segmentId: material.segments[0]!.segmentId,
            },
          ],
        },
      ],
      gaps: [],
      basis: '测试',
      confirmedTaskKnowledgeIds: [knowledgeId],
    };
    store.savePlanVersion(projectId, 1, 'confirmed', plan);
    const run = store.startPlanRun(projectId).run;
    const bundle = store.buildLessonBundle(
      projectId,
      [{ knowledgeId, text, conditions: '同一区间' }],
      [],
    );
    const lesson = store.createLessonDraft({
      projectId,
      lessonId: null,
      title: '增函数',
      bundleId: bundle.bundleId,
      statementIds: [bundle.bundle.statements[0]!.statementId],
      questionIds: [],
    });
    store.reviewLesson({
      projectId,
      lessonId: lesson.lessonId,
      version: lesson.version,
      decision: 'approved',
      note: '',
    });
    store.publishLesson({ projectId, lessonId: lesson.lessonId, version: lesson.version });
    command = {
      scope: { ...scope(), runId: run.runId },
      requestId: 'http-media-1',
      kind: 'image',
      lessonId: lesson.lessonId,
      provider: 'openai-compatible',
      prompt: '教学函数图',
      workflowId: 'default',
      workflowLocation: 'remote',
      width: 1024,
      height: 1024,
      steps: 20,
      guidance: 7,
      count: 1,
    };
    vi.spyOn(modelConnection, 'status').mockReturnValue({
      configured: true,
      persisted: false,
      provider: 'openai-compatible',
      model: 'fixture',
      baseUrl: 'https://fixture.test',
      lastTest: null,
    });
    vi.spyOn(modelConnection, 'revision').mockReturnValue(0);
    vi.spyOn(modelConnection, 'mediaConfigured').mockReturnValue(true);
    vi.spyOn(modelConnection, 'generateMedia').mockResolvedValue({
      dispatched: true,
      ok: true,
      failureKind: null,
      products: [{ bytes, mime: 'image/png', durationSeconds: null }],
      usage: {
        ...zeroMediaUsage(),
        images: 1,
        tokens: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      },
      usageMeasurement: 'actual',
      elapsedMs: 1,
      message: '测试服务返回真实字节',
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeProject();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves schema-valid candidate and ledger, then requires explicit review', async () => {
    const task = await generated();
    const response = await getTasks(request(query()));
    expect(response.headers.get('cache-control')).toBe('no-store');
    const view = apiResponses.mediaTasks.parse((await response.json()).data);
    expect(view.tasks[0]?.taskId).toBe(task.taskId);
    expect(view.ledger?.total.actual.images).toBe(1);
    const missingConsent = await review(
      request('/review', {
        scope: scope(),
        taskId: task.taskId,
        intent: task.intent,
        decision: 'approved',
        semanticReviewed: false,
      }),
    );
    expect(missingConsent.status).toBe(400);
    const accepted = await review(
      request('/review', {
        scope: scope(),
        taskId: task.taskId,
        intent: task.intent,
        decision: 'approved',
        semanticReviewed: true,
      }),
    );
    expect(apiResponses.mediaTask.parse((await accepted.json()).data).task.review.status).toBe(
      'approved',
    );
  });

  it('allows a rejection without an affirmative semantic approval checkbox', async () => {
    const task = await generated();
    const response = await review(
      request('/review', {
        scope: scope(),
        taskId: task.taskId,
        intent: task.intent,
        decision: 'rejected',
        semanticReviewed: false,
        note: '图像有误',
      }),
    );
    expect(response.status).toBe(200);
    expect(apiResponses.mediaTask.parse((await response.json()).data).task.review.status).toBe(
      'rejected',
    );
  });

  it('product responses contain verified bytes and no private asset metadata', async () => {
    const task = await generated();
    const assetId = task.products[0]!.assetId;
    const response = await product(request(`/products/${assetId}${query()}`), {
      params: Promise.resolve({ assetId }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it('requires project generation on task and byte reads and rejects stale project writes', async () => {
    expect((await getTasks(request(''))).status).toBe(400);
    expect(
      (
        await getTasks(
          request(`?projectId=${session.projectId}&generation=${session.generation + 1}`),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await generate(
          request('', {
            ...command,
            scope: { ...command.scope, generation: session.generation + 1 },
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await product(request('/products/missing'), {
          params: Promise.resolve({ assetId: 'missing' }),
        })
      ).status,
    ).toBe(400);
    expect(modelConnection.generateMedia).not.toHaveBeenCalled();
  });

  it('rejects renderer secrets, malformed input and oversized requests before provider', async () => {
    expect(
      (await generate(request('', { ...command, apiKey: 'renderer-must-not-submit' }))).status,
    ).toBe(400);
    expect((await generate(request('', { ...command, actor: 'teacher' }))).status).toBe(400);
    expect((await generate(request('', { ...command, prompt: 'x'.repeat(70_000) }))).status).toBe(
      400,
    );
    expect(
      (
        await generate(
          new Request('http://localhost/api/study/media', { method: 'POST', body: 'malformed' }),
        )
      ).status,
    ).toBe(400);
    expect(modelConnection.generateMedia).not.toHaveBeenCalled();
  });

  it('rejects foreign and non-media assets, and tampered candidate bytes', async () => {
    session.store.putClassroomAsset(session.projectId, 'plain_asset', 'image/png', {}, bytes);
    expect(
      (
        await product(request(`/products/plain_asset${query()}`), {
          params: Promise.resolve({ assetId: 'plain_asset' }),
        })
      ).status,
    ).toBe(404);
    const task = await generated();
    const assetId = task.products[0]!.assetId;
    expect(() =>
      session.store.putClassroomAsset(
        session.projectId,
        assetId,
        'image/png',
        {},
        Uint8Array.from([8, 9]),
      ),
    ).toThrow();
    writeFileSync(join(root, '.study', 'assets', assetId), Uint8Array.from([8, 9]));
    const response = await product(request(`/products/${assetId}${query()}`), {
      params: Promise.resolve({ assetId }),
    });
    expect(response.status).toBe(409);
  });

  it('binds review to the candidate intent and resolves repeated generation without dispatch', async () => {
    const task = await generated();
    expect((await generated()).taskId).toBe(task.taskId);
    expect(modelConnection.generateMedia).toHaveBeenCalledTimes(1);
    expect(
      (
        await review(
          request('/review', {
            scope: scope(),
            taskId: task.taskId,
            intent: 'b'.repeat(64),
            decision: 'approved',
            semanticReviewed: true,
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await cancel(
          request('/cancel', {
            scope: { ...scope(), generation: session.generation + 1 },
            taskId: task.taskId,
          }),
        )
      ).status,
    ).toBe(409);
  });
});
