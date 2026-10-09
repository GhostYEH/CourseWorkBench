import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyError, type PlanPayloadDto } from '@sew/study-contracts';
import { StudyStore, ensureProjectLayout, projectPaths } from '@sew/study-storage';
import { closeProject, openProjectFromDisk } from '../apps/learning/lib/server/service';
import { createModelConnectionRuntime } from '../apps/learning/lib/server/model-connection';
import { runLessonGenerationPipelineCommand } from '../apps/learning/lib/server/lesson-generation-pipeline';
import {
  beginGenerationPipelineStage,
  createGenerationPipelineTask,
  currentGenerationPipelineStage,
  markGenerationPipelineStageReviewed,
  retryGenerationPipelineStage,
  settleGenerationPipelineStage,
  stopGenerationPipelineTask,
} from '../packages/study-domain/src/generation-pipeline';

const makeTask = () =>
  createGenerationPipelineTask({
    taskId: 'gp_test',
    projectId: 'project_test',
    lessonId: null,
    version: null,
    bundleId: 'bundle_test',
    bundleDigest: 'digest_test',
    roleConfigDigest: null,
    teachingPreferenceVersion: 1,
    title: '函数单调性',
    statementIds: ['stmt_1'],
    questionIds: [],
    intentDigest: 'intent_test',
    instruction: '设计一节课程',
  });

describe('lesson generation pipeline durable service', () => {
  let root: string;
  let store: StudyStore;
  let projectId: string;
  let materialId: string;
  let bundleId: string;
  let bundleDigest: string;
  let statementId: string;
  let knowledgeId: string;
  let activeGeneration: number;
  let requests: string[];
  let fetcher: typeof fetch;
  let providerStarted: (() => void) | null;
  let providerStartedPromise: Promise<void>;
  let connection: ReturnType<typeof createModelConnectionRuntime>;

  const providerResponse = (text: string): Response =>
    new Response(
      JSON.stringify({
        model: 'pipeline-fixture',
        choices: [{ message: { content: text } }],
        usage: { total_tokens: 27 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  const deps = (expectedGeneration = activeGeneration) => ({
    store,
    projectId,
    learnerUid: 'pipeline-test-user',
    connection,
    revalidateScope: () => {
      if (expectedGeneration !== activeGeneration) throw new StudyError('PROJECT_GENERATION_STALE');
    },
  });

  const createCommand = (generation = activeGeneration) => ({
    scope: { projectId, generation },
    action: 'create' as const,
    requestId: 'pipeline-create-nonce',
    bundleId,
    bundleDigest,
    title: '增函数课程',
    statementIds: [statementId],
    questionIds: [],
    instruction: '先解释定义，再给出例子',
  });

  const setupProject = (): void => {
    const imported = store.importMaterial({
      projectId,
      displayName: '考纲.md',
      materialType: 'md',
      rawText: '本章要求理解增函数的定义。',
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
      basis: 'pipeline test',
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
    bundleDigest = bundle.digest;
    statementId = bundle.bundle.statements[0]!.statementId;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-generation-pipeline-'));
    ensureProjectLayout(root);
    const session = openProjectFromDisk(root);
    store = session.store;
    projectId = session.projectId;
    activeGeneration = session.generation;
    requests = [];
    providerStarted = null;
    providerStartedPromise = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    fetcher = async (_input, init) => {
      requests.push(typeof init?.body === 'string' ? init.body : '');
      providerStarted?.();
      return providerResponse('生成的课程草案内容。');
    };
    connection = createModelConnectionRuntime({ fetcher });
    connection.configure(
      {
        provider: 'openai-compatible',
        baseUrl: 'https://pipeline.test/v1',
        model: 'pipeline-fixture',
        apiKey: 'pipeline-fixture-key',
      },
      false,
    );
    setupProject();
  });

  afterEach(() => {
    try {
      closeProject();
    } catch {
      /* a durability test may have closed the session store explicitly */
    }
    try {
      store.close();
    } catch {
      /* already closed */
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('reopens durable tasks, replays create by nonce, and rejects an old project generation', async () => {
    const created = await runLessonGenerationPipelineCommand(deps(), createCommand());
    expect(created.task.status).toBe('ready');
    const taskId = created.task.taskId;
    const replay = await runLessonGenerationPipelineCommand(deps(), createCommand());
    expect(replay.replayed).toBe(true);
    expect(replay.task.taskId).toBe(taskId);
    const stageResult = await runLessonGenerationPipelineCommand(deps(), {
      scope: { projectId, generation: activeGeneration },
      action: 'continue',
      taskId,
    });
    expect(stageResult.task.stages[0]?.status, stageResult.task.stages[0]?.message ?? '').toBe(
      'completed',
    );
    const stageReplay = await runLessonGenerationPipelineCommand(deps(), {
      scope: { projectId, generation: activeGeneration },
      action: 'continue',
      taskId,
    });
    expect(stageResult.task.stages[0]?.requestId).toBe(stageReplay.task.stages[0]?.requestId);
    expect(stageReplay.task.stages[0]?.attempts).toBe(1);
    expect(requests).toHaveLength(1);

    store.close();
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    activeGeneration = 5;
    await expect(
      runLessonGenerationPipelineCommand(deps(4), {
        scope: { projectId, generation: 4 },
        action: 'get',
        taskId,
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_GENERATION_STALE' });
    const reopened = await runLessonGenerationPipelineCommand(deps(), {
      scope: { projectId, generation: 5 },
      action: 'get',
      taskId,
    });
    expect(reopened.task.taskId).toBe(taskId);
    expect(reopened.task.stages[0]?.attempts).toBe(1);
    expect((reopened.task.stages[0]?.output as { status?: string } | null)?.status).toBe('pending');
  });

  it('blocks before provider dispatch when frozen source admission changes', async () => {
    const created = await runLessonGenerationPipelineCommand(deps(), createCommand());
    store.importMaterial({
      projectId,
      displayName: '考纲.md',
      materialType: 'md',
      rawText: '材料来源已更新，原核实失效。',
    });
    const blocked = await runLessonGenerationPipelineCommand(deps(), {
      scope: { projectId, generation: activeGeneration },
      action: 'continue',
      taskId: created.task.taskId,
    });
    expect(blocked.task.status).toBe('blocked');
    expect(blocked.task.stages[0]?.status).toBe('blocked');
    expect(requests).toHaveLength(0);
  });
  it('reconciles an abandoned running stage after reopening without redispatch, then permits an explicit new-nonce retry', async () => {
    const created = await runLessonGenerationPipelineCommand(deps(), createCommand());
    const running = beginGenerationPipelineStage(
      created.task,
      'course-draft',
      'interrupted-stage-original-nonce',
    );
    store.classroomKV.set(
      projectId,
      'pipeline-test-user',
      `generation-pipeline:v1:${running.taskId}`,
      running,
    );
    const lease = store.executions.claim({
      projectId,
      key: `generation-pipeline:pipeline-test-user:${running.taskId}`,
      ownerId: 'dead-executor',
      now: Date.now() - 5000,
      ttlMs: 1000,
    });
    expect(lease.expiresAt).toBeLessThan(Date.now());
    store.close();
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    activeGeneration = 5;
    const recovered = await runLessonGenerationPipelineCommand(deps(), {
      scope: { projectId, generation: activeGeneration },
      action: 'get',
      taskId: running.taskId,
    });
    expect(recovered.task.status).toBe('failed');
    expect(recovered.task.stages[0]?.requestId).toBe('interrupted-stage-original-nonce');
    expect(recovered.task.stages[0]?.message).toContain('结果未知');
    expect(requests).toHaveLength(0);
    const retried = await runLessonGenerationPipelineCommand(deps(), {
      scope: { projectId, generation: activeGeneration },
      action: 'retry',
      taskId: running.taskId,
      stage: 'course-draft',
      requestId: 'explicit-new-stage-nonce',
    });
    expect(retried.task.stages[0]?.status, retried.task.stages[0]?.message ?? '').toBe('completed');
    expect(requests).toHaveLength(1);
  });

  it('creates a formal draft only after human approval and replays adoption idempotently', async () => {
    const created = await runLessonGenerationPipelineCommand(deps(), createCommand());
    const candidate = await runLessonGenerationPipelineCommand(deps(), {
      scope: { projectId, generation: activeGeneration },
      action: 'continue',
      taskId: created.task.taskId,
    });
    expect(candidate.task.stages[0]?.reviewStatus).toBe('pending');
    expect(
      (candidate.task.stages[0]?.output as { candidate?: string } | null)?.candidate,
    ).toContain('生成的课程草案内容');
    expect(store.listLessons(projectId)).toHaveLength(0);

    const review = {
      scope: { projectId, generation: activeGeneration },
      action: 'review' as const,
      taskId: created.task.taskId,
      stage: 'course-draft' as const,
      decision: 'approved' as const,
      requestId: 'human-review-course-draft',
    };
    const adopted = await runLessonGenerationPipelineCommand(deps(), review);
    const replay = await runLessonGenerationPipelineCommand(deps(), review);
    expect(adopted.task.lessonId).toBeTruthy();
    expect(adopted.task.stages[0]?.reviewStatus).toBe('approved');
    expect(replay.replayed).toBe(true);
    expect(replay.task.lessonId).toBe(adopted.task.lessonId);
    expect(store.listLessons(projectId)).toHaveLength(1);
  });

  it('stops a dispatched provider call and ignores its late draft response', async () => {
    let release!: (response: Response) => void;
    fetcher = async (_input, init) => {
      requests.push(typeof init?.body === 'string' ? init.body : '');
      providerStarted?.();
      return await new Promise<Response>((resolve) => {
        release = resolve;
      });
    };
    connection = createModelConnectionRuntime({ fetcher });
    connection.configure(
      {
        provider: 'openai-compatible',
        baseUrl: 'https://pipeline.test/v1',
        model: 'pipeline-fixture',
        apiKey: 'pipeline-fixture-key',
      },
      false,
    );
    const created = await runLessonGenerationPipelineCommand(deps(), createCommand());
    const continuing = runLessonGenerationPipelineCommand(deps(), {
      scope: { projectId, generation: activeGeneration },
      action: 'continue',
      taskId: created.task.taskId,
    });
    await providerStartedPromise;
    const stopped = await runLessonGenerationPipelineCommand(deps(), {
      scope: { projectId, generation: activeGeneration },
      action: 'stop',
      taskId: created.task.taskId,
    });
    expect(stopped.task.status).toBe('stopped');
    release(providerResponse('迟到的模型草案不应进入课程。'));
    const late = await continuing;
    expect(late.task.status).toBe('stopped');
    expect(late.task.stages[0]?.output).toBeNull();
    expect(store.listLessons(projectId)).toHaveLength(0);
    expect(requests).toHaveLength(1);
  });

  it('preserves a stop from a second SQLite writer before claiming execution and releases the lease', async () => {
    const created = await runLessonGenerationPipelineCommand(deps(), createCommand());
    const other = StudyStore.open({ file: projectPaths(root).databaseFile });
    const claim = store.executions.claim.bind(store.executions);
    const spy = vi.spyOn(store.executions, 'claim').mockImplementation((input) => {
      other.classroomKV.set(
        projectId,
        'pipeline-test-user',
        `generation-pipeline:v1:${created.task.taskId}`,
        stopGenerationPipelineTask(created.task),
      );
      return claim(input);
    });
    try {
      const result = await runLessonGenerationPipelineCommand(deps(), {
        scope: { projectId, generation: activeGeneration },
        action: 'continue',
        taskId: created.task.taskId,
      });
      expect(result.task.status).toBe('stopped');
      expect(requests).toHaveLength(0);
      expect(
        store.executions.held(
          projectId,
          `generation-pipeline:pipeline-test-user:${created.task.taskId}`,
        ),
      ).toBeNull();
      const reopened = await runLessonGenerationPipelineCommand(deps(), {
        scope: { projectId, generation: activeGeneration },
        action: 'get',
        taskId: created.task.taskId,
      });
      expect(reopened.task.status).toBe('stopped');
    } finally {
      spy.mockRestore();
      other.close();
    }
  });
});

describe('lesson generation pipeline lifecycle', () => {
  it('persists one stage at a time and exposes explicit continuation', () => {
    const task = makeTask();
    expect(currentGenerationPipelineStage(task)?.stage).toBe('course-draft');
    const running = beginGenerationPipelineStage(task, 'course-draft', 'call-1');
    const paused = settleGenerationPipelineStage(running, 'course-draft', {
      ok: true,
      message: '课程草案候选已生成',
      output: { status: 'pending' },
    });
    expect(paused.status).toBe('paused');
    expect(currentGenerationPipelineStage(paused)?.stage).toBe('course-draft');
    expect(paused.stages[1]?.status).toBe('pending');
    expect(() => beginGenerationPipelineStage(paused, 'course-draft', 'call-2')).toThrow();
    const reviewed = markGenerationPipelineStageReviewed(
      paused,
      'course-draft',
      'approved',
      'review-1',
    );
    expect(currentGenerationPipelineStage(reviewed)?.stage).toBe('outline');
    expect(paused.candidateOnly).toBe(true);
  });

  it('keeps a failed stage local and requires a new retry nonce', () => {
    const running = beginGenerationPipelineStage(makeTask(), 'course-draft', 'call-1');
    const failed = settleGenerationPipelineStage(running, 'course-draft', {
      ok: false,
      message: '模型输出无效',
    });
    expect(failed.status).toBe('failed');
    expect(currentGenerationPipelineStage(failed)?.stage).toBe('course-draft');
    expect(() => retryGenerationPipelineStage(failed, 'course-draft', 'call-1')).toThrow();
    const retried = retryGenerationPipelineStage(failed, 'course-draft', 'call-2');
    expect(retried.stages[0]?.requestId).toBe('call-2');
    expect(retried.stages[0]?.status).toBe('failed');
  });

  it('marks missing-material gates as blocked and stops later dispatches', () => {
    const running = beginGenerationPipelineStage(makeTask(), 'course-draft', 'call-1');
    const blocked = settleGenerationPipelineStage(running, 'course-draft', {
      ok: false,
      blocked: true,
      message: '缺少冻结材料',
    });
    expect(blocked.status).toBe('blocked');
    expect(() => beginGenerationPipelineStage(blocked, 'course-draft', 'call-2')).toThrow();
    const stopped = stopGenerationPipelineTask(makeTask());
    expect(stopped.status).toBe('stopped');
    expect(stopGenerationPipelineTask(stopped)).toBe(stopped);
  });
});
