import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { newId, type CoursewareProposeInput, type PlanPayloadDto } from '@sew/study-contracts';
import { StudyStore, ensureProjectLayout, projectPaths } from '@sew/study-storage';
import { createModelConnectionRuntime } from '../apps/learning/lib/server/model-connection';
import { generateCourseware } from '../apps/learning/lib/server/lesson-courseware-model';

/**
 * 受 guard 约束的完整课件候选生成（LESSON-02 / OMA-006）。
 *
 * 固定四件事：① 正常路径产出待核候选，不写入任何场景计划；② 同一 requestId 重试不再调用 provider；
 * ③ 没有 run / 未配置模型 / 基线已发布都在 provider 之前阻断；④ 模型越界（绑定包外陈述）被拒。
 */
describe('受 guard 约束的完整课件候选生成（注入假 fetcher）', () => {
  let root: string;
  let store: StudyStore;
  let projectId: string;
  let materialId: string;
  let knowledgeId: string;
  let bundleId = '';
  let statementId = '';
  let lessonId = '';
  let lessonVersion = 1;
  let requests: string[] = [];
  let responder: () => Response | Promise<Response>;

  const okResponder = (content: unknown): Response =>
    new Response(
      JSON.stringify({
        model: 'fixture-model',
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { total_tokens: 42 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  const connection = () => {
    const runtime = createModelConnectionRuntime({
      fetcher: async (_url, init) => {
        requests.push(typeof init?.body === 'string' ? init.body : '');
        return responder();
      },
    });
    runtime.configure(
      {
        provider: 'openai-compatible',
        baseUrl: 'https://courseware.test/v1',
        model: 'fixture-model',
        apiKey: 'courseware-fixture-key-not-a-secret',
      },
      false,
    );
    return runtime;
  };

  const input = (over: Partial<CoursewareProposeInput> = {}): CoursewareProposeInput => ({
    scope: { projectId, generation: 1 },
    action: 'propose-courseware',
    requestId: 'req-courseware-1',
    lessonId,
    version: lessonVersion,
    instruction: '先定义后测验',
    ...over,
  });

  beforeEach(() => {
    requests = [];
    responder = () =>
      okResponder({
        scenes: [
          {
            kind: 'slide',
            title: '定义',
            statementId,
            questionId: null,
            elements: [{ text: '增函数的定义' }],
          },
        ],
      });
    root = mkdtempSync(join(tmpdir(), 'sew-courseware-model-'));
    ensureProjectLayout(root);
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    projectId = newId<'project'>('proj');
    store.createProject({ projectId, displayName: '数学', subject: '数学', dailyMinutes: 60 });
    const imported = store.importMaterial({
      projectId,
      displayName: '考纲.md',
      materialType: 'md',
      rawText: '本章要求理解增函数的定义。\n\n第二条范围说明。',
    });
    materialId = imported.material.materialId;
    const proposal = store.createProposal({
      projectId,
      name: '增函数定义',
      concept: '区间内任取 x1 < x2 都有 f(x1) < f(x2)',
      conditions: '同一区间 D 内',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [{ materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'user',
    });
    knowledgeId = store.applyReview({
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
          evidence: [{ materialId, segmentId: 'S001' }],
        },
      ],
      gaps: [],
      basis: '测试计划',
      confirmedTaskKnowledgeIds: [knowledgeId],
    };
    store.savePlanVersion(projectId, 1, 'confirmed', payload);
    store.startPlanRun(projectId);
    const bundle = store.buildLessonBundle(
      projectId,
      [{ knowledgeId, text: '增函数的定义', conditions: '同一区间 D 内' }],
      [],
    );
    bundleId = bundle.bundleId;
    statementId = bundle.bundle.statements[0]!.statementId;
    const lesson = store.createLessonDraft({
      projectId,
      lessonId: null,
      title: '函数单调性',
      bundleId,
      statementIds: [statementId],
      questionIds: [],
    });
    lessonId = lesson.lessonId;
    lessonVersion = lesson.version;
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  const generate = (over: Partial<CoursewareProposeInput> = {}) =>
    generateCourseware({ store, projectId, connection: connection() }, input(over));

  it('正常路径产出待核候选，不写入场景计划', async () => {
    const result = await generate();
    expect(result.candidate).not.toBeNull();
    expect(result.candidate!.status).toBe('pending');
    expect(result.candidate!.scenes).toHaveLength(1);
    expect(result.candidate!.scenes[0]!.knowledgeIds).toEqual([knowledgeId]);
    expect(result.deduplicated).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toContain('courseware-fixture-key');
    // 候选落待核区，但计划还没写入。
    expect(store.listProjectCoursewareCandidates(projectId)).toHaveLength(1);
    expect(store.getScenePlan(projectId, lessonId, lessonVersion)).toBeNull();
  });

  it('同一 requestId 重试返回既有候选，不再调用 provider', async () => {
    const first = await generate();
    const second = await generate();
    expect(second.deduplicated).toBe(true);
    expect(second.candidate!.candidateId).toBe(first.candidate!.candidateId);
    expect(requests).toHaveLength(1);
    expect(store.listProjectCoursewareCandidates(projectId)).toHaveLength(1);
  });

  it('没有 run 时在 provider 之前阻断', async () => {
    store.updateRunState(store.getLatestRun()!.runId, 'completed');
    await expect(generate()).rejects.toThrow(/任务已终止/);
    expect(requests).toHaveLength(0);
  });

  it('未配置模型连接时给出明确原因，且不发出请求', async () => {
    const unconfigured = createModelConnectionRuntime({
      fetcher: async () => {
        throw new Error('不应被调用');
      },
    });
    await expect(
      generateCourseware({ store, projectId, connection: unconfigured }, input()),
    ).rejects.toThrow(/尚未配置模型连接/);
    expect(requests).toHaveLength(0);
  });

  it('模型绑定包外陈述时不落候选，只记失败', async () => {
    responder = () =>
      okResponder({
        scenes: [
          {
            kind: 'slide',
            title: '越界',
            statementId: 'stmt_not_in_version',
            questionId: null,
            elements: [],
          },
        ],
      });
    const result = await generate();
    expect(result.candidate).toBeNull();
    expect(store.listProjectCoursewareCandidates(projectId)).toHaveLength(0);
  });

  it('模型输出不是合法 JSON 时不落候选', async () => {
    responder = () =>
      new Response(
        JSON.stringify({
          model: 'fixture-model',
          choices: [{ message: { content: '不是 JSON' } }],
          usage: { total_tokens: 7 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const result = await generate();
    expect(result.candidate).toBeNull();
    expect(store.listProjectCoursewareCandidates(projectId)).toHaveLength(0);
  });

  it('确定失败的响应丢失后读取相同失败回执，明确换nonce才开启新调用', async () => {
    responder = () =>
      okResponder({
        scenes: [
          { kind: 'slide', title: '越界', statementId: 'unknown', questionId: null, elements: [] },
        ],
      });
    const first = await generate();
    expect(first.generation.callState).toBe('failed');
    const replay = await generate();
    expect(replay).toEqual({ ...first, deduplicated: true });
    expect(requests).toHaveLength(1);
    responder = () =>
      okResponder({
        scenes: [{ kind: 'slide', title: '修正', statementId, questionId: null, elements: [] }],
      });
    const retry = await generate({ requestId: 'req-courseware-new-attempt' });
    expect(retry.candidate).not.toBeNull();
    expect(requests).toHaveLength(2);
    expect(store.listModelUsageCalls(projectId)).toHaveLength(2);
  });

  it('provider已派发但结果未知时保留预占，重复核对回执不会重发', async () => {
    responder = () => {
      throw new Error('fixture network lost after dispatch');
    };
    const first = await generate();
    expect(first.candidate).toBeNull();
    expect(first.generation.callState).toBe('started');
    const call = store.getModelUsageCall(projectId, input().requestId)!;
    expect(call.accountedTokens).toBeNull();
    expect(call.tokenMeasurement).toBe('unknown');
    const reserved = store.modelCallUsage(call.runId).tokens;
    expect(reserved).toBeGreaterThan(0);
    const second = await generate();
    expect(second).toEqual({ ...first, deduplicated: true });
    expect(requests).toHaveLength(1);
    expect(store.modelCallUsage(call.runId).tokens).toBe(reserved);
  });

  it('重启后已派发的台账没有结果或回执，读取未知状态而不是nonce冲突或再次调用', async () => {
    const intent = createHash('sha256')
      .update(
        JSON.stringify({
          lessonId,
          version: lessonVersion,
          instruction: input().instruction,
        }),
      )
      .digest('hex');
    const runId = store.getLatestRun()!.runId;
    store.startModelUsageCall(
      {
        projectId,
        runId,
        requestId: input().requestId,
        purpose: 'courseware_generation',
        intent,
        sessionId: null,
        roundIndex: null,
        reservedTokens: 800,
        provider: 'openai-compatible',
        requestedModel: 'fixture-model',
      },
      { maxCalls: 8, maxTokens: 20_000, maxWallClockMs: 600_000 },
    );
    // Recovery must work even if the lesson is no longer a draft or the model is unconfigured.
    store.reviewLesson({
      projectId,
      lessonId,
      version: lessonVersion,
      decision: 'approved',
      note: 'ok',
    });
    store.publishLesson({ projectId, lessonId, version: lessonVersion });
    const result = await generateCourseware(
      { store, projectId, connection: createModelConnectionRuntime() },
      input(),
    );
    expect(result.generation.callState).toBe('started');
    expect(result.deduplicated).toBe(true);
    expect(result.candidate).toBeNull();
    expect(requests).toHaveLength(0);
    expect(store.getModelUsageCall(projectId, input().requestId)!.state).toBe('started');
    expect(store.modelCallUsage(runId).tokens).toBe(800);
  });

  it('取消后的迟到provider结果不落候选，同nonce恢复失败回执', async () => {
    let release!: (response: Response) => void;
    let providerStarted!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    responder = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
        providerStarted();
      });
    const controller = new AbortController();
    const pending = generateCourseware(
      { store, projectId, connection: connection() },
      input(),
      controller.signal,
    );
    await dispatched;
    controller.abort();
    release(
      okResponder({
        scenes: [{ kind: 'slide', title: '迟到', statementId, questionId: null, elements: [] }],
      }),
    );
    const result = await pending;
    expect(result.candidate).toBeNull();
    expect(result.generation.callState).toBe('failed');
    expect((await generate()).generation).toEqual(result.generation);
    expect(requests).toHaveLength(1);
    expect(store.listProjectCoursewareCandidates(projectId)).toHaveLength(0);
  });

  it('provider派发前的guard失败有可重放回执，改变nonce才重新判定', async () => {
    const runtime = createModelConnectionRuntime();
    await expect(
      generateCourseware({ store, projectId, connection: runtime }, input()),
    ).rejects.toMatchObject({
      code: 'MODEL_NOT_CONFIGURED',
      details: { receiptState: 'failed' },
    });
    const replay = await generate();
    expect(replay.generation.callState).toBe('failed');
    expect(replay.deduplicated).toBe(true);
    expect(requests).toHaveLength(0);
    expect((await generate({ requestId: 'configured-new-attempt' })).candidate).not.toBeNull();
    expect(requests).toHaveLength(1);
  });

  it('基线版本已发布时拒绝生成候选', async () => {
    store.reviewLesson({
      projectId,
      lessonId,
      version: lessonVersion,
      decision: 'approved',
      note: 'ok',
    });
    store.publishLesson({ projectId, lessonId, version: lessonVersion });
    await expect(generate()).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});
