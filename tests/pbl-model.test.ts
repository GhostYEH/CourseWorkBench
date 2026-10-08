import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pblProjectStateSchema,
  type PblMentorCommandInput,
  type PblProjectDefinitionDto,
} from '@sew/study-contracts';
import { pblArtifactIdFromRecord, pblHash, pblProjectSceneId } from '@sew/study-domain';
import { attachFormalLessonDocument } from '../apps/learning/lib/server/classroom-service';
import {
  commandPblProject,
  readPblContext,
  reviewPblDefinition,
} from '../apps/learning/lib/server/pbl-service';
import { generatePblMentor, pblMentorPrompt } from '../apps/learning/lib/server/pbl-model';
import type { ModelCallDeps } from '../apps/learning/lib/server/model-call';
import {
  createModelConnectionRuntime,
  type ModelGenerateOutcome,
} from '../apps/learning/lib/server/model-connection';
import {
  assertScope,
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';
import { POST } from '../apps/learning/app/api/study/pbl/mentor/route';

const roots: string[] = [];
afterEach(() => {
  closeProject();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const outcome = (
  text: string,
  extra: Partial<ModelGenerateOutcome> = {},
): ModelGenerateOutcome => ({
  dispatched: true,
  ok: true,
  message: 'fixture',
  text,
  totalTokens: 91,
  providerTokens: 91,
  requestedModel: 'fixture-model',
  returnedModel: 'fixture-model',
  elapsedMs: 2,
  ...extra,
});

function fixture(options: { noRun?: boolean; noSubmission?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sew-pbl-model-'));
  roots.push(root);
  const session = openProjectFromDisk(root);
  const store = session.store;
  const material = store.importMaterial({
    projectId: session.projectId,
    displayName: '来源',
    materialType: 'txt',
    rawText: '线性函数在正斜率时递增，需说明定义与适用条件。',
  }).material;
  const proposal = store.createProposal({
    projectId: session.projectId,
    name: '线性函数',
    concept: '正斜率对应递增',
    conditions: '同一区间',
    scopeStatus: 'in_syllabus',
    prerequisites: [],
    evidence: [
      { materialId: material.materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' },
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
  store.savePlanVersion(session.projectId, 1, 'confirmed', {
    payloadVersion: 1,
    goal: '研究函数',
    examDate: null,
    dailyMinutes: 30,
    tasks: [
      {
        knowledgeId,
        name: '函数',
        minutes: 30,
        acceptance: '',
        evidence: [{ materialId: material.materialId, segmentId: 'S001' }],
      },
    ],
    gaps: [],
    basis: '人工确认',
    confirmedTaskKnowledgeIds: [knowledgeId],
  });
  if (!options.noRun) store.startPlanRun(session.projectId);
  const bundle = store.buildLessonBundle(
    session.projectId,
    [{ knowledgeId, text: '正斜率对应递增', conditions: '同一区间' }],
    [],
  );
  const statementId = bundle.bundle.statements[0]!.statementId;
  const lesson = store.createLessonDraft({
    projectId: session.projectId,
    lessonId: null,
    title: '函数探究',
    bundleId: bundle.bundleId,
    statementIds: [statementId],
    questionIds: [],
  });
  const definition: PblProjectDefinitionDto = {
    id: 'pbl_function',
    title: '校园数据模型',
    statementIds: [statementId],
    background: '用来源支持的模型解释校园数据。',
    authenticContext: {
      audience: '校园社团',
      problem: '为给定数据建立解释',
      constraints: ['仅使用已审核来源'],
    },
    goals: [{ id: 'goal', statement: '说明模型', successDescription: '提交模型报告' }],
    projectChecks: [],
    roles: [
      {
        id: 'learner',
        name: '本人',
        kind: 'learner',
        responsibilities: ['交付报告'],
        memberUid: session.learnerUid,
      },
      {
        id: 'mentor',
        name: '导师',
        kind: 'mentor',
        responsibilities: ['逐条反馈'],
        memberUid: null,
      },
      {
        id: 'peer',
        name: '同行',
        kind: 'peer_ai',
        responsibilities: ['给出建议'],
        memberUid: null,
      },
    ],
    tasks: [
      {
        id: 'task',
        title: '提交报告',
        phase: '分析',
        statementIds: [statementId],
        outcome: '说明定义和条件',
        artifactKinds: ['report'],
        roleIds: ['learner'],
        milestoneIds: ['milestone'],
        checks: [
          {
            id: 'task-length',
            kind: 'deliverable_min_length',
            label: '正文40字',
            expectation: '至少40字',
            minChars: 40,
            artifactKind: 'report',
          },
        ],
      },
    ],
    milestones: [
      {
        id: 'milestone',
        title: '报告验收',
        statementIds: [statementId],
        order: 1,
        taskIds: ['task'],
        rubricIds: ['rubric'],
        checks: [
          {
            id: 'milestone-length',
            kind: 'deliverable_min_length',
            label: '正文40字',
            expectation: '至少40字',
            minChars: 40,
            artifactKind: 'report',
          },
        ],
      },
    ],
    rubrics: [
      {
        id: 'rubric',
        criterion: 'PRIVATE_RUBRIC_detail',
        levels: [
          { level: 'exemplary', descriptor: '条理清楚' },
          { level: 'adequate', descriptor: '基本完整' },
          { level: 'developing', descriptor: '继续完善' },
        ],
      },
    ],
    cadenceDays: null,
  };
  const scope = { projectId: session.projectId, generation: session.generation };
  reviewPblDefinition(session, {
    operation: 'review',
    scope,
    lessonId: lesson.lessonId,
    lessonVersion: 1,
    semanticReviewed: true,
    reviewNote: '逐项审核项目、依据与判定条件',
    definition,
    binding: {
      version: 1,
      stageId: `stage_formal_${lesson.lessonId}_v1`,
      definitionId: definition.id,
      definitionDigest: pblHash(definition),
      documentDigest: 'draft',
    },
  });
  store.reviewLesson({
    projectId: session.projectId,
    lessonId: lesson.lessonId,
    version: 1,
    decision: 'approved',
    note: '核对课程与PBL',
  });
  store.publishLesson({ projectId: session.projectId, lessonId: lesson.lessonId, version: 1 });
  const document = attachFormalLessonDocument(session, lesson.lessonId, 1);
  let state = readPblContext(session, document.stageId, definition.id).state;
  commandPblProject(session, {
    operation: 'task',
    scope,
    binding: state.binding,
    actorUid: session.learnerUid,
    intent: 'open',
    taskId: 'task',
    roleId: 'learner',
    reportedStatus: 'in_progress',
    report: '开始本人任务',
    nonce: 'open',
  });
  if (!options.noSubmission)
    state = commandPblProject(session, {
      operation: 'submit',
      scope,
      binding: state.binding,
      actorUid: session.learnerUid,
      deliverable: {
        taskId: 'task',
        milestoneId: null,
        artifactKind: 'report',
        artifactTitle: '本人报告',
        artifactText: '本人产物仅12字尚未完整',
        assetRefs: [],
        goalIds: ['goal'],
      },
      nonce: 'submission',
    }) as typeof state;
  const artifact = state.ownSubmissions[0]?.payload;
  const input: PblMentorCommandInput = {
    scope,
    binding: state.binding,
    actorUid: session.learnerUid,
    requestId: 'mentor-request',
    kind: 'feedback',
    roleId: 'mentor',
    taskId: 'task',
    milestoneId: null,
    artifactIds:
      artifact?.kind === 'deliverable' ? [pblArtifactIdFromRecord(artifact)] : ['missing'],
    question: '需要怎样完善？',
  };
  const output = () =>
    JSON.stringify({
      points: [
        {
          artifactId: input.artifactIds[0],
          observation: '报告尚短',
          suggestion: '补充定义与适用条件',
        },
      ],
    });
  const generate = vi.fn<ModelCallDeps['connection']['generate']>(async () => outcome(output()));
  const deps = (current: Session = session) => ({
    session: current,
    store: current.store,
    projectId: current.projectId,
    learnerUid: current.learnerUid,
    connection: {
      status: () => ({
        configured: true,
        persisted: false,
        provider: 'openai-compatible' as const,
        baseUrl: 'https://fixture.invalid/v1',
        model: 'fixture-model',
        lastTest: null,
      }),
      generate,
    },
    revalidateScope: () => {
      assertScope({ projectId: current.projectId, generation: current.generation });
    },
  });
  return { root, session, store, scope, document, input, output, generate, deps, material, lesson };
}

describe('PBL 真实数据模型接入', () => {
  it('作者定义允许连字符、中文和长编号，计划场景编号仍稳定且不会截断碰撞', () => {
    const ids = ['pbl-default-template', '校园项目', 'a'.repeat(199), 'a'.repeat(198) + 'b'];
    const scenes = ids.map(pblProjectSceneId);
    expect(new Set(scenes).size).toBe(ids.length);
    scenes.forEach((scene, index) => {
      expect(scene).toMatch(/^[a-z0-9_]{1,60}$/);
      expect(scene).toBe(pblProjectSceneId(ids[index]!));
    });
  });
  it('逐条引用真实本人产物、私有反馈重启可读，丢响应重试只支付一次', async () => {
    const f = fixture();
    const state = await generatePblMentor(f.deps(), f.input);
    expect(pblProjectStateSchema.safeParse(state).success).toBe(true);
    expect(state.feedback).toHaveLength(1);
    expect(state.feedback[0]!.payload.actorType).toBe('teacher_ai');
    expect(state.count).toBe(1);
    expect(state.milestones[0]!.reached).toBe(false);
    expect(f.store.listModelUsageCalls(f.session.projectId)[0]!.purpose).toBe('pbl_guidance');
    const messages = f.generate.mock.calls[0];
    expect(messages).toBeDefined();
    const prompt = JSON.stringify(
      pblMentorPrompt(
        readPblContext(f.session, f.document.stageId, f.input.binding.definitionId),
        f.input,
      ),
    );
    expect(prompt).toContain('本人产物');
    expect(prompt).not.toContain('PRIVATE_RUBRIC_detail');
    closeProject();
    const reopened = openProjectFromDisk(f.root);
    const replay = await generatePblMentor(f.deps(reopened), {
      ...f.input,
      scope: { projectId: reopened.projectId, generation: reopened.generation },
    });
    expect(replay.feedback[0]!.id).toBe(state.feedback[0]!.id);
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(reopened.store.modelCallUsage(reopened.store.getLatestRun()!.runId).calls).toBe(1);
    const originalRunId = reopened.store.getLatestRun()!.runId;
    reopened.store.updateRunState(originalRunId, 'cancelled', '本人停止');
    const confirmed = reopened.store.getConfirmedPlan(reopened.projectId)!;
    reopened.store.savePlanVersion(
      reopened.projectId,
      confirmed.version + 1,
      'confirmed',
      confirmed.payload,
    );
    reopened.store.startPlanRun(reopened.projectId);
    const receiptReplay = await generatePblMentor(f.deps(reopened), {
      ...f.input,
      scope: { projectId: reopened.projectId, generation: reopened.generation },
    });
    expect(receiptReplay.feedback[0]!.id).toBe(state.feedback[0]!.id);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it('评价候选与人工采纳不改确定性结论，AI贡献与本人提交计数分开', async () => {
    const f = fixture();
    f.generate.mockImplementation(async () =>
      outcome(
        JSON.stringify({
          candidates: [
            {
              rubricId: 'rubric',
              judgement: 'exemplary',
              rationale: '仅是描述性候选',
              basisArtifactIds: f.input.artifactIds,
            },
          ],
        }),
      ),
    );
    const assessment = await generatePblMentor(f.deps(), {
      ...f.input,
      kind: 'assessment',
      milestoneId: 'milestone',
    });
    expect(assessment.assessments).toHaveLength(1);
    const record = assessment.assessments[0]!.payload;
    if (record.kind !== 'assessment') throw new Error('missing assessment');
    const accepted = commandPblProject(f.session, {
      operation: 'acceptEvaluation',
      scope: f.scope,
      binding: assessment.binding,
      actorUid: f.session.learnerUid,
      assessmentNonce: record.nonce,
      acceptedCandidateIds: record.candidates.map((candidate) => candidate.candidateId),
      nonce: 'accept',
    });
    expect('milestones' in accepted && accepted.milestones[0]!.reached).toBe(false);
    f.generate.mockImplementation(async () => outcome(JSON.stringify({ content: 'AI参考建议' })));
    const contribution = await generatePblMentor(f.deps(), {
      ...f.input,
      kind: 'contribution',
      roleId: 'peer',
      requestId: 'peer-request',
    });
    expect(contribution.tasks[0]!.ownSubmissionCount).toBe(1);
    expect(contribution.tasks[0]!.aiContributionCount).toBe(1);
    expect(contribution.count).toBe(1);
    expect(JSON.stringify(contribution.definition)).not.toContain('rubric');
  });

  it.each(['identity', 'artifact', 'binding', 'seat', 'milestone'] as const)(
    '拒绝 %s 伪造且不发出provider请求',
    async (variant) => {
      const f = fixture();
      const input = { ...f.input };
      if (variant === 'identity') input.actorUid = 'uid_00000000-0000-4000-8000-000000000001';
      if (variant === 'artifact') input.artifactIds = ['not-owned'];
      if (variant === 'binding') input.binding = { ...input.binding, documentDigest: 'stale' };
      if (variant === 'seat') input.roleId = 'learner';
      if (variant === 'milestone') input.milestoneId = 'foreign';
      await expect(generatePblMentor(f.deps(), input)).rejects.toBeDefined();
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.store.listModelUsageCalls(f.session.projectId)).toHaveLength(0);
    },
  );

  it('无run/无真实交付/共享预算已满均在provider前阻断', async () => {
    const f = fixture({ noRun: true });
    await expect(generatePblMentor(f.deps(), f.input)).rejects.toMatchObject({
      code: 'PLAN_NOT_CONFIRMED',
    });
    expect(f.generate).not.toHaveBeenCalled();
    f.store.startPlanRun(f.session.projectId);
    await expect(
      generatePblMentor(
        { ...f.deps(), limits: { maxCalls: 0, maxTokens: 20_000, maxWallClockMs: 600_000 } },
        f.input,
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    await expect(
      generatePblMentor(f.deps(), { ...f.input, artifactIds: ['not-submitted'] }),
    ).rejects.toBeDefined();
    expect(f.generate).not.toHaveBeenCalled();
  });

  it('nonce复用改变问题拒绝；无效模型输出失败仍计入用量，同请求不重发', async () => {
    const f = fixture();
    f.generate.mockImplementation(async () =>
      outcome(
        JSON.stringify({
          points: [{ artifactId: 'foreign', observation: '猜测', suggestion: '通过' }],
        }),
      ),
    );
    await expect(generatePblMentor(f.deps(), f.input)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(f.store.listModelUsageCalls(f.session.projectId)[0]!.state).toBe('failed');
    expect(f.store.modelCallUsage(f.store.getLatestRun()!.runId).tokens).toBe(91);
    await expect(generatePblMentor(f.deps(), f.input)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    await expect(
      generatePblMentor(f.deps(), { ...f.input, question: '更换问题' }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(
      readPblContext(f.session, f.document.stageId, f.input.binding.definitionId).state.feedback,
    ).toHaveLength(0);
  });

  it('HTTP真实作用域拒绝无头部与伪造代次，无缓存且不生成模型内容', async () => {
    const f = fixture();
    const missing = await POST(
      new Request('http://localhost/api/study/pbl/mentor', {
        method: 'POST',
        body: JSON.stringify(f.input),
      }),
    );
    expect(missing.status).toBe(400);
    expect(missing.headers.get('cache-control')).toBe('no-store');
    const stale = await POST(
      new Request('http://localhost/api/study/pbl/mentor', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sew-project-id': f.session.projectId,
          'x-sew-generation': String(f.session.generation),
        },
        body: JSON.stringify({
          ...f.input,
          scope: { ...f.scope, generation: f.scope.generation + 1 },
        }),
      }),
    );
    expect((await stale.json()).error.code).toBe('PROJECT_GENERATION_STALE');
  });

  it('预取消不调provider；在途取消仍记实际用量但不写导师反馈', async () => {
    const f = fixture();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(generatePblMentor(f.deps(), f.input, cancelled.signal)).rejects.toMatchObject({
      code: 'RUN_TERMINATED',
    });
    expect(f.generate).not.toHaveBeenCalled();
    const active = new AbortController();
    f.generate.mockImplementation(async () => {
      active.abort();
      return outcome(f.output());
    });
    await expect(generatePblMentor(f.deps(), f.input, active.signal)).rejects.toMatchObject({
      code: 'RUN_TERMINATED',
    });
    expect(f.store.modelCallUsage(f.store.getLatestRun()!.runId).tokens).toBe(91);
    expect(
      readPblContext(f.session, f.document.stageId, f.input.binding.definitionId).state.feedback,
    ).toHaveLength(0);
  });

  it('真实ModelConnectionRuntime传输路径严格JSON生成后落库，出站不带rubric或密钥回显', async () => {
    const f = fixture();
    const requests: RequestInit[] = [];
    const connection = createModelConnectionRuntime({
      fetcher: (async (_url, init) => {
        requests.push(init!);
        return new Response(
          JSON.stringify({
            model: 'transport-model',
            choices: [{ message: { content: f.output() } }],
            usage: { total_tokens: 67 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });
    connection.configure(
      {
        provider: 'openai-compatible',
        baseUrl: 'https://fixture.invalid/v1',
        model: 'fixture-model',
        apiKey: 'fixture-secret',
      },
      false,
    );
    const result = await generatePblMentor({ ...f.deps(), connection }, f.input);
    expect(requests).toHaveLength(1);
    expect(String(requests[0]!.body)).not.toContain('PRIVATE_RUBRIC_detail');
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    expect(result.feedback).toHaveLength(1);
    expect(f.store.listModelUsageCalls(f.session.projectId)[0]!.providerTokens).toBe(67);
  });

  it('run在途取消会真正中止provider signal，未知用量保留预占', async () => {
    const f = fixture();
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.generate.mockImplementation(async (_messages, options) => {
      started();
      await new Promise<void>((resolve) =>
        options!.signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
      return outcome(f.output(), { providerTokens: null, totalTokens: 0 });
    });
    const result = generatePblMentor(f.deps(), f.input);
    await dispatched;
    f.store.updateRunState(f.store.getLatestRun()!.runId, 'cancelled', '本人停止');
    await expect(result).rejects.toMatchObject({ code: 'RUN_TERMINATED' });
    const call = f.store.listModelUsageCalls(f.session.projectId)[0]!;
    expect(call.state).toBe('failed');
    expect(call.tokenMeasurement).toBe('unknown');
    expect(f.store.modelCallUsage(call.runId).tokens).toBe(call.reservedTokens);
    expect(
      readPblContext(f.session, f.document.stageId, f.input.binding.definitionId).state.feedback,
    ).toHaveLength(0);
  });

  it('provider已结算但写候选失败时，只恢复已记账正文，不再次支付', async () => {
    const f = fixture();
    const append = vi.spyOn(f.store.runtime, 'appendRecord').mockImplementationOnce(() => {
      throw new Error('fixture write outage');
    });
    await expect(generatePblMentor(f.deps(), f.input)).rejects.toThrow('fixture write outage');
    append.mockRestore();
    expect(f.store.listModelUsageCalls(f.session.projectId)[0]!.state).toBe('completed');
    const restored = await generatePblMentor(f.deps(), f.input);
    expect(restored.feedback).toHaveLength(1);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it('原 run 取消后即使已有新 run，也不允许用已结算正文补写 PBL 候选', async () => {
    const f = fixture();
    const originalRunId = f.store.getLatestRun()!.runId;
    const append = vi.spyOn(f.store.runtime, 'appendRecord').mockImplementationOnce(() => {
      throw new Error('fixture write outage');
    });
    await expect(generatePblMentor(f.deps(), f.input)).rejects.toThrow('fixture write outage');
    append.mockRestore();

    const call = f.store.listModelUsageCalls(f.session.projectId)[0]!;
    expect(call).toMatchObject({ runId: originalRunId, state: 'completed' });
    expect(f.store.modelCallUsage(originalRunId).tokens).toBe(91);
    f.store.updateRunState(originalRunId, 'cancelled', '本人停止');
    const confirmed = f.store.getConfirmedPlan(f.session.projectId)!;
    f.store.savePlanVersion(
      f.session.projectId,
      confirmed.version + 1,
      'confirmed',
      confirmed.payload,
    );
    const nextRun = f.store.startPlanRun(f.session.projectId).run;
    expect(nextRun.runId).not.toBe(originalRunId);

    await expect(generatePblMentor(f.deps(), f.input)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.store.modelCallUsage(originalRunId).tokens).toBe(91);
    expect(f.store.listModelUsageCalls(f.session.projectId)).toHaveLength(1);
    expect(
      readPblContext(f.session, f.document.stageId, f.input.binding.definitionId).state.feedback,
    ).toHaveLength(0);
  });
});
