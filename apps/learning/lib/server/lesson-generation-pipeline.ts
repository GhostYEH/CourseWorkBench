import { createHash } from 'node:crypto';
import {
  StudyError,
  newId,
  type ModelChatMessage,
  lessonDraftSchema,
  lessonVersionSchema,
  scenePlanSaveSchema,
  roleProfileSchema,
  teachingPreferenceSchema,
} from '@sew/study-contracts';
import {
  assertModelCallAdmitted,
  reserveSharedModelTokens,
  sharedModelDeadlineMs,
  assertSharedModelSettlement,
  settlementMeasurement,
} from '@sew/study-domain';
import {
  DEFAULT_MODEL_CALL_LIMITS,
  registerActiveProjectModelCall,
  withExclusiveProjectModelCall,
  type ModelCallDeps,
} from './model-call';
import { generateCourseware } from './lesson-courseware-model';
import { abortActiveModelCalls, generateGuarded } from './model-call';
import { executeLessonCommand } from './lesson-service';
import { decodeJson } from '@sew/study-storage';
import {
  beginGenerationPipelineStage,
  createGenerationPipelineTask,
  currentGenerationPipelineStage,
  markGenerationPipelineStageReviewed,
  retryGenerationPipelineStage,
  settleGenerationPipelineStage,
  stopGenerationPipelineTask,
} from '../../../../packages/study-domain/src/generation-pipeline';
import {
  generationPipelineCommandSchema,
  generationPipelineResponseSchema,
  generationPipelineTaskSchema,
  lessonOutlineCandidateSchema,
  teachingProfileCandidateSchema,
  type GenerationPipelineCommand,
  type GenerationPipelineResponse,
  type GenerationPipelineStage,
  type GenerationPipelineTask,
} from '../../../../packages/study-contracts/src/generation-pipeline';
import type { EvidenceBundleDto } from '@sew/study-contracts';

const KEY_PREFIX = 'generation-pipeline:v1:';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const taskIdFor = (projectId: string, requestId: string): string =>
  `gp_${hash(`${projectId}:${requestId}`).slice(0, 24)}`;
const stageRequestId = (task: GenerationPipelineTask, stage: GenerationPipelineStage): string => {
  const item = task.stages.find((candidate) => candidate.stage === stage)!;
  return `gp-call-${hash(`${task.taskId}:${stage}:${item.attempts + 1}`).slice(0, 40)}`;
};
const keyOf = (taskId: string): string => `${KEY_PREFIX}${taskId}`;
const leaseKey = (deps: ModelCallDeps, taskId: string): string =>
  `generation-pipeline:${deps.learnerUid ?? 'owner'}:${taskId}`;
const activeStages = new Map<string, AbortController>();
const activeStageKey = (deps: ModelCallDeps, taskId: string): string =>
  `${deps.projectId}:${leaseKey(deps, taskId)}`;

const readTask = (deps: ModelCallDeps, taskId: string): GenerationPipelineTask =>
  deps.store.transaction(() => {
    const value = deps.store.classroomKV.get<unknown>(
      deps.projectId,
      deps.learnerUid ?? '',
      keyOf(taskId),
    );
    if (!value) throw new StudyError('NOT_FOUND', { taskId });
    const parsed = generationPipelineTaskSchema.safeParse(value);
    if (!parsed.success || parsed.data.projectId !== deps.projectId) {
      throw new StudyError('INTERNAL', { reason: 'generation_pipeline_state_invalid' });
    }
    const task = parsed.data;
    const running = task.stages.find((stage) => stage.status === 'running');
    if (
      task.status === 'running' &&
      running &&
      !deps.store.executions.held(deps.projectId, leaseKey(deps, taskId))
    ) {
      const failed = settleGenerationPipelineStage(task, running.stage, {
        ok: false,
        message:
          '执行租约已失效，阶段结果未知；原请求不会自动重派。检查用量记录后，可明确使用新请求重试。',
      });
      deps.store.classroomKV.set(deps.projectId, deps.learnerUid ?? '', keyOf(taskId), failed);
      return failed;
    }
    return task;
  });

const saveTask = (deps: ModelCallDeps, task: GenerationPipelineTask): GenerationPipelineTask => {
  const parsed = generationPipelineTaskSchema.parse({
    ...task,
    updatedAt: new Date().toISOString(),
  });
  deps.store.classroomKV.set(deps.projectId, deps.learnerUid ?? '', keyOf(task.taskId), parsed);
  return parsed;
};

const evidenceFor = (
  deps: ModelCallDeps,
  task: GenerationPipelineTask,
): {
  lesson: ReturnType<ModelCallDeps['store']['getLessonVersion']>;
  bundle: EvidenceBundleDto;
  statements: EvidenceBundleDto['statements'];
  questions: EvidenceBundleDto['questions'];
} => {
  deps.revalidateScope?.();
  const row = deps.store.getEvidenceBundle(deps.projectId, task.bundleId);
  if (!row || row.digest !== task.bundleDigest)
    throw new StudyError('MATERIAL_RAW_UNVERIFIED', {
      reason: 'generation_pipeline_bundle_missing',
    });
  const statementIds = new Set(task.statementIds);
  const questionIds = new Set(task.questionIds);
  const statements = row.bundle.statements.filter((item) => statementIds.has(item.statementId));
  const questions = row.bundle.questions.filter((item) => questionIds.has(item.questionId));
  if (
    statements.length !== statementIds.size ||
    questions.length !== questionIds.size ||
    statements.length === 0
  ) {
    throw new StudyError('MATERIAL_RAW_UNVERIFIED', {
      reason: 'generation_pipeline_selected_source_changed',
    });
  }
  const lesson =
    task.lessonId && task.version
      ? deps.store.getLessonVersion(task.lessonId, task.version, deps.projectId)
      : null;
  if (task.lessonId || task.version) {
    if (!lesson || lesson.status !== 'draft')
      throw new StudyError('VERSION_CONFLICT', { reason: 'generation_pipeline_lesson_not_draft' });
    if (
      lesson.bundleId !== task.bundleId ||
      lesson.bundleDigest !== task.bundleDigest ||
      JSON.stringify([...lesson.statementIds].sort()) !==
        JSON.stringify([...task.statementIds].sort()) ||
      JSON.stringify([...lesson.questionIds].sort()) !==
        JSON.stringify([...task.questionIds].sort())
    ) {
      throw new StudyError('VERSION_CONFLICT', {
        reason: 'generation_pipeline_lesson_source_changed',
      });
    }
  }
  const run = deps.store.getLatestRun();
  if (!run)
    throw new StudyError('PLAN_NOT_CONFIRMED', { reason: 'generation_pipeline_run_missing' });
  const referencedKnowledgeIds = [
    ...new Set([
      ...statements.map((item) => item.knowledgeId),
      ...questions.flatMap((item) => item.knowledgeIds),
    ]),
  ];
  assertModelCallAdmitted({
    purpose: lesson ? 'courseware_generation' : 'lesson_draft',
    run: { state: run.state, frozen: run.frozen },
    currentKnowledgeTableDigest: deps.store.knowledgeTableDigest(),
    referencedKnowledgeIds,
    admittedKnowledgeIds: new Set(
      deps.store.checkAdmission(referencedKnowledgeIds, 'formal').admitted,
    ),
    lesson: null,
    usage: deps.store.modelCallUsage(run.runId),
    limits: deps.limits ?? DEFAULT_MODEL_CALL_LIMITS,
  });
  return { lesson, bundle: row.bundle, statements, questions };
};

const candidatePrompt = (
  stage: 'outline' | 'teaching-profile',
  bundle: EvidenceBundleDto,
  statements: ReturnType<typeof evidenceFor>['statements'],
  questions: ReturnType<typeof evidenceFor>['questions'],
  instruction: string,
): ModelChatMessage[] => {
  const schema =
    stage === 'outline'
      ? '{"title":"课程大纲标题","objectives":[{"text":"目标","statementIds":["已提供的陈述ID"]}],"sequence":[{"title":"条目","statementIds":["已提供的陈述ID"],"questionIds":["已提供的题目ID"]}]}'
      : '{"roles":[{"kind":"teacher|peer","name":"角色名称","purpose":"人格提示","explanation":"intuitive|rigorous|concise","statementIds":["已提供的陈述ID"]}],"actions":[{"title":"动作标题","trigger":"触发条件","instruction":"供教师参考的提示文本","statementIds":["已提供的陈述ID"]}],"teaching":{"learningMode":"beginner|review","explanation":"intuitive|rigorous|concise","hintDepth":"light|stepwise|full","exerciseBalance":"explanation-first|balanced|practice-first","selfExplanation":true,"everydayExamples":"moderate|minimal","extraPreference":""}}';
  return [
    {
      role: 'system',
      content: `你是课程设计助手。只能依据给定的冻结课程材料生成 JSON 候选，不得补充外部事实、虚构来源 ID 或声称候选已审核。输出必须严格符合示例形状：${schema}`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        subject: bundle.subject,
        sourceStatements: statements.map(({ statementId, knowledgeId, text, conditions }) => ({
          statementId,
          knowledgeId,
          text,
          conditions,
        })),
        sourceQuestions: questions.map(({ questionId, knowledgeIds, snapshot }) => ({
          questionId,
          knowledgeIds,
          stem: snapshot?.stem ?? '',
        })),
        instruction,
        requestedCandidate: stage,
      }),
    },
  ];
};

const generateCandidate = async (
  deps: ModelCallDeps,
  task: GenerationPipelineTask,
  stage: 'outline' | 'teaching-profile',
  requestId: string,
  signal?: AbortSignal,
): Promise<{ candidate: unknown; message: string }> => {
  if (signal?.aborted) throw new StudyError('RUN_TERMINATED', { reason: 'request_aborted' });
  const source = evidenceFor(deps, task);
  const basePlan =
    stage === 'outline' && task.lessonId && task.version
      ? deps.store.getScenePlan(deps.projectId, task.lessonId, task.version)
      : null;
  const basePlanRevision = basePlan?.revision ?? 0;
  const basePlanDigest = basePlan?.digest ?? null;
  const run = deps.store.getLatestRun()!;
  const connection = deps.connection.status();
  if (!connection.configured) throw new StudyError('MODEL_NOT_CONFIGURED');
  const intent = hash(
    JSON.stringify({
      taskId: task.taskId,
      stage,
      instruction: task.instruction,
      bundleDigest: task.bundleDigest,
    }),
  );
  const prior = deps.store.getModelUsageCall(deps.projectId, requestId, intent);
  if (prior)
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'generation_pipeline_stage_call_already_dispatched',
      requestId,
    });
  const messages = candidatePrompt(
    stage,
    source.bundle,
    source.statements,
    source.questions,
    task.instruction,
  );
  const limits = deps.limits ?? DEFAULT_MODEL_CALL_LIMITS;
  const usage = deps.store.modelCallUsage(run.runId);
  const reservation = reserveSharedModelTokens(messages, limits.maxTokens - usage.tokens);
  const deadline = sharedModelDeadlineMs(limits, usage);
  if (signal?.aborted) throw new StudyError('RUN_TERMINATED', { reason: 'request_aborted' });
  deps.store.startModelUsageCall(
    {
      projectId: deps.projectId,
      runId: run.runId,
      requestId,
      purpose: 'courseware_generation',
      intent,
      sessionId: null,
      roundIndex: null,
      roleProfileId: null,
      peerTurnIndex: null,
      reservedTokens: reservation.reservedTokens,
      provider: connection.provider ?? null,
      requestedModel: connection.model ?? null,
    },
    limits,
  );
  const controller = new AbortController();
  const unregister = registerActiveProjectModelCall(deps.projectId, controller);
  const onAbort = (): void => controller.abort('用户停止了生成');
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort('共享执行时间已用满'), deadline);
  const startedAt = performance.now();
  let outcome;
  try {
    outcome = await deps.connection.generate(messages, {
      maxTokens: reservation.maxTokens,
      signal: controller.signal,
      route: 'courseware',
    });
  } catch {
    outcome = {
      dispatched: true,
      ok: false,
      message: '调用失败，用量未知',
      text: null,
      totalTokens: 0,
      providerTokens: null,
      elapsedMs: 0,
      requestedModel: connection.model ?? null,
    };
  } finally {
    clearTimeout(timer);
    unregister();
    signal?.removeEventListener('abort', onAbort);
  }
  let settlementFailure: unknown;
  try {
    deps.revalidateScope?.();
    deps.verifyExecutionLease?.();
    if (controller.signal.aborted || signal?.aborted) throw new StudyError('RUN_TERMINATED');
    const latestRun = deps.store.getLatestRun();
    if (!latestRun || latestRun.runId !== run.runId || latestRun.state !== run.state) {
      throw new StudyError('VERSION_CONFLICT', { reason: 'generation_pipeline_run_changed' });
    }
    evidenceFor(deps, task);
    if (stage === 'outline' && task.lessonId && task.version) {
      const currentPlan = deps.store.getScenePlan(deps.projectId, task.lessonId, task.version);
      if (
        (currentPlan?.revision ?? 0) !== basePlanRevision ||
        (currentPlan?.digest ?? null) !== basePlanDigest
      ) {
        throw new StudyError('VERSION_CONFLICT', {
          reason: 'generation_pipeline_outline_plan_changed',
        });
      }
    }
    const currentConnection = deps.connection.status();
    if (
      currentConnection.provider !== connection.provider ||
      currentConnection.model !== connection.model
    ) {
      throw new StudyError('VERSION_CONFLICT', { reason: 'generation_pipeline_model_changed' });
    }
  } catch (error) {
    settlementFailure = error;
  }
  const elapsedMs = Math.max(
    Math.ceil(performance.now() - startedAt),
    Math.round(outcome.elapsedMs),
  );
  const measurement = settlementMeasurement({
    dispatched: outcome.dispatched,
    providerTokens: outcome.providerTokens ?? null,
    estimatedTokens:
      outcome.dispatched && outcome.providerTokens === undefined && outcome.totalTokens > 0
        ? outcome.totalTokens
        : null,
  });
  const accounted = measurement.accountedTokens;
  assertSharedModelSettlement(
    limits,
    deps.store.modelCallUsage(run.runId, undefined, requestId),
    accounted ?? reservation.reservedTokens,
    elapsedMs,
  );
  let candidate: unknown;
  let message: string;
  let ok = false;
  try {
    if (settlementFailure) throw settlementFailure;
    if (!outcome.dispatched || !outcome.ok || !outcome.text)
      throw new Error('模型没有返回候选正文');
    const validStatementIds = new Set(source.statements.map((item) => item.statementId));
    const validQuestionIds = new Set(source.questions.map((item) => item.questionId));
    let parsed: unknown;
    let references: string[];
    if (stage === 'outline') {
      const decoded = decodeJson(
        outcome.text,
        lessonOutlineCandidateSchema.nullable(),
        null,
        `generation-pipeline.${stage}`,
      );
      if (!decoded.ok || !decoded.value) throw new Error(decoded.error ?? '大纲候选结构无效');
      const outline = decoded.value;
      references = [
        ...outline.objectives.flatMap((item) => item.statementIds),
        ...outline.sequence.flatMap((item) => item.statementIds),
      ];
      if (
        outline.sequence.flatMap((item) => item.questionIds).some((id) => !validQuestionIds.has(id))
      ) {
        throw new Error('大纲引用了未选中的题目');
      }
      parsed = outline;
    } else {
      const decoded = decodeJson(
        outcome.text,
        teachingProfileCandidateSchema.nullable(),
        null,
        `generation-pipeline.${stage}`,
      );
      if (!decoded.ok || !decoded.value) throw new Error(decoded.error ?? '角色候选结构无效');
      const profile = decoded.value;
      const teacherCount = profile.roles.filter((role) => role.kind === 'teacher').length;
      const peerCount = profile.roles.filter((role) => role.kind === 'peer').length;
      if (teacherCount > 1 || peerCount > 2) throw new Error('角色数量超过系统既有配置上限');
      references = [
        ...profile.roles.flatMap((item) => item.statementIds),
        ...profile.actions.flatMap((item) => item.statementIds),
      ];
      parsed = profile;
    }
    if (!references.length || references.some((id) => !validStatementIds.has(id)))
      throw new Error('候选引用了未选中的陈述');
    candidate = {
      candidateId: `gpc_${hash(requestId).slice(0, 24)}`,
      status: 'pending',
      candidate: parsed,
      ...(stage === 'outline'
        ? {
            basePlanRevision,
            basePlanDigest,
          }
        : {}),
    };
    ok = true;
    message = stage === 'outline' ? '已生成待核大纲候选。' : '已生成待核授课角色与动作候选。';
  } catch (error) {
    message = `候选未保存：${error instanceof Error ? error.message : '输出格式无效'}`.slice(
      0,
      500,
    );
  }
  deps.store.transaction(() => {
    if (ok) {
      try {
        deps.verifyExecutionLease?.();
      } catch (error) {
        if (!(error instanceof StudyError) || error.code !== 'VERSION_CONFLICT') throw error;
        ok = false;
        candidate = undefined;
        message = '执行租约失效，迟到正文已丢弃；仅保存调用用量。';
      }
    }
    if (outcome.dispatched)
      deps.store.appendNextRunEvent(run.runId, {
        type: 'model_call',
        purpose: 'courseware_generation',
        requestId,
        usageSource: 'model',
        ok,
        totalTokens: accounted ?? 0,
        message,
      });
    deps.store.settleModelUsageCall(deps.projectId, requestId, {
      state: ok ? 'completed' : 'failed',
      accountedTokens: accounted,
      providerTokens: outcome.providerTokens ?? null,
      tokenMeasurement: measurement.measurement,
      returnedModel: outcome.returnedModel ?? null,
      elapsedMs,
      result: null,
    });
    const currentUsage = deps.store.modelCallUsage(run.runId);
    deps.store.saveModelUsageCallResult(deps.projectId, requestId, {
      requestId,
      callState: ok ? 'completed' : 'failed',
      ok,
      message,
      totalTokens: accounted ?? 0,
      providerTokens: outcome.providerTokens ?? null,
      estimatedCost: null,
      elapsedMs,
      pendingExplanationId: null,
      ...(ok && typeof outcome.text === 'string' ? { text: outcome.text } : {}),
      usage: {
        callsUsed: currentUsage.calls,
        tokensUsed: currentUsage.tokens,
        maxCalls: limits.maxCalls,
        maxTokens: limits.maxTokens,
      },
      remainingCalls: Math.max(0, limits.maxCalls - currentUsage.calls),
      remainingTokens: Math.max(0, limits.maxTokens - currentUsage.tokens),
    });
  });
  if (!ok)
    throw new StudyError(
      'INVALID_ARGUMENT',
      { reason: 'generation_pipeline_candidate_invalid', message, requestId },
      message,
    );
  return { candidate, message };
};

const response = (task: GenerationPipelineTask, replayed = false): GenerationPipelineResponse =>
  generationPipelineResponseSchema.parse({ task, replayed });

const pendingCandidate = (
  task: GenerationPipelineTask,
  stage: GenerationPipelineStage,
): Record<string, unknown> => {
  const value = task.stages.find((item) => item.stage === stage)?.output;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'generation_pipeline_candidate_missing',
      stage,
    });
  const record = value as Record<string, unknown>;
  if (record['status'] !== 'pending' || !record['candidate'])
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'generation_pipeline_candidate_not_pending',
      stage,
    });
  return record;
};

const reviewOutput = (
  task: GenerationPipelineTask,
  stage: GenerationPipelineStage,
  status: string,
): GenerationPipelineTask => ({
  ...task,
  stages: task.stages.map((item) =>
    item.stage === stage && item.output && typeof item.output === 'object'
      ? { ...item, output: { ...(item.output as Record<string, unknown>), status } }
      : item,
  ),
});

const outlineScenes = (task: GenerationPipelineTask, candidate: unknown, seed: string) => {
  const outline = lessonOutlineCandidateSchema.parse(candidate);
  const statementIds = new Set(task.statementIds);
  const questionIds = new Set(task.questionIds);
  const invalid = outline.sequence.some(
    (item) =>
      item.statementIds.some((id) => !statementIds.has(id)) ||
      item.questionIds.some((id) => !questionIds.has(id)),
  );
  if (invalid)
    throw new StudyError('SOURCE_MISSING', {
      reason: 'generation_pipeline_outline_source_changed',
    });
  const scenes = outline.sequence.flatMap((item, index) => [
    ...item.statementIds.map((statementId, bindingIndex) => ({
      sceneId: `scene_slide_${hash(`${seed}:${index}:${bindingIndex}:${statementId}`).slice(0, 24)}`,
      kind: 'slide' as const,
      title: item.title,
      statementId,
      questionId: null,
      knowledgeIds: [],
      elements: [],
      note: outline.objectives
        .filter((objective) => objective.statementIds.includes(statementId))
        .map((objective) => objective.text)
        .join('\n')
        .slice(0, 500),
    })),
    ...item.questionIds.map((questionId, bindingIndex) => ({
      sceneId: `scene_quiz_${hash(`${seed}:${index}:${bindingIndex}:${questionId}`).slice(0, 24)}`,
      kind: 'quiz' as const,
      title: item.title,
      statementId: null,
      questionId,
      knowledgeIds: [],
      elements: [],
      note: '',
    })),
  ]);
  if (scenes.length === 0)
    throw new StudyError('INVALID_ARGUMENT', { reason: 'generation_pipeline_outline_empty' });
  return scenes;
};

const assertDerivedRolePermissions = (
  profile: ReturnType<ModelCallDeps['store']['createRoleProfile']>,
): void => {
  const parsed = roleProfileSchema.parse(profile);
  const expected =
    parsed.kind === 'teacher'
      ? { whiteboardWrite: true, answerAsLearner: false, speak: true, aiIdentityVisible: true }
      : { whiteboardWrite: false, answerAsLearner: false, speak: true, aiIdentityVisible: true };
  if (JSON.stringify(parsed.permissions) !== JSON.stringify(expected)) {
    throw new StudyError('ROLE_PERMISSION_DENIED', {
      reason: 'generation_pipeline_role_permissions_mismatch',
    });
  }
};

const approveTeachingProfile = (
  deps: ModelCallDeps,
  task: GenerationPipelineTask,
  candidate: unknown,
  reviewRequestId: string,
): GenerationPipelineTask => {
  const parsed = teachingProfileCandidateSchema.parse(candidate);
  if (
    parsed.roles.filter((item) => item.kind === 'teacher').length > 1 ||
    parsed.roles.filter((item) => item.kind === 'peer').length > 2
  ) {
    throw new StudyError('ROLE_LIMIT_REACHED');
  }
  const actions = parsed.actions.map(
    (item) =>
      `${item.title}（${item.trigger}）：${item.instruction}（依据 ${item.statementIds.join('、')}）`,
  );
  const extraPreference = [parsed.teaching.extraPreference, ...actions]
    .filter(Boolean)
    .join('\n')
    .slice(0, 500);
  const teaching = teachingPreferenceSchema.parse({ ...parsed.teaching, extraPreference });
  return deps.store.transaction(() => {
    if (
      deps.store.roleConfigDigest('formal') !== task.roleConfigDigest ||
      deps.store.readTeachingPreference<unknown>(deps.projectId).version !==
        task.teachingPreferenceVersion
    ) {
      throw new StudyError('VERSION_CONFLICT', {
        reason: 'generation_pipeline_teaching_config_changed',
      });
    }
    const existing = deps.store.listRoleProfiles('formal');
    const claimed = new Set<string>();
    const adopted = parsed.roles.map((role) => {
      const match = existing.find(
        (item) => item.kind === role.kind && !claimed.has(item.profileId),
      );
      const profile = match
        ? deps.store.updateRoleProfile(
            match.profileId,
            {
              name: role.name.slice(0, 40),
              persona: role.purpose.slice(0, 300),
              explanation: role.explanation,
            },
            'formal',
          )
        : deps.store.createRoleProfile(
            role.kind,
            {
              name: role.name.slice(0, 40),
              persona: role.purpose.slice(0, 300),
              explanation: role.explanation,
            },
            'formal',
          );
      claimed.add(profile.profileId);
      assertDerivedRolePermissions(profile);
      return profile;
    });
    const version = deps.store.writeTeachingPreference(deps.projectId, teaching);
    const withAdoption = {
      ...task,
      stages: task.stages.map((item) =>
        item.stage === 'teaching-profile' && item.output && typeof item.output === 'object'
          ? {
              ...item,
              output: {
                ...(item.output as Record<string, unknown>),
                status: 'adopted',
                adoptedProfileIds: adopted.map((profile) => profile.profileId),
                teachingPreferenceVersion: version,
              },
            }
          : item,
      ),
    };
    const marked = markGenerationPipelineStageReviewed(
      withAdoption,
      'teaching-profile',
      'approved',
      reviewRequestId,
    );
    return saveTask(deps, marked);
  });
};

const reviewPipelineStage = async (
  deps: ModelCallDeps,
  task: GenerationPipelineTask,
  command: Extract<GenerationPipelineCommand, { action: 'review' }>,
  signal?: AbortSignal,
): Promise<GenerationPipelineResponse> => {
  const target = task.stages.find((item) => item.stage === command.stage);
  if (!target) throw new StudyError('NOT_FOUND', { stage: command.stage });
  if (target.reviewStatus !== 'pending') {
    if (
      target.reviewRequestId === command.requestId ||
      target.reviewStatus === command.decision ||
      target.reviewStatus === 'adopted'
    ) {
      return response(task, true);
    }
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'generation_pipeline_candidate_already_reviewed',
      stage: command.stage,
    });
  }
  const candidateRecord = pendingCandidate(task, command.stage);
  if (command.decision === 'rejected') {
    const rejected = markGenerationPipelineStageReviewed(
      task,
      command.stage,
      'rejected',
      command.requestId,
    );
    return response(saveTask(deps, reviewOutput(rejected, command.stage, 'rejected')));
  }

  let updated: GenerationPipelineTask;
  if (command.stage === 'course-draft') {
    evidenceFor(deps, task);
    const parsed = (await executeLessonCommand(
      lessonDraftSchema.parse({
        scope: command.scope,
        action: 'draft',
        requestId: `gp-adopt-${hash(`${task.taskId}:course-draft`).slice(0, 40)}`,
        lessonId: null,
        bundleId: task.bundleId,
        title: task.title,
        statementIds: task.statementIds,
        questionIds: task.questionIds,
      }),
      signal,
    )) as { lesson?: unknown };
    const lesson = lessonVersionSchema.parse(parsed.lesson);
    updated = {
      ...task,
      lessonId: lesson.lessonId,
      version: lesson.version,
      stages: task.stages.map((item) =>
        item.stage === 'course-draft'
          ? {
              ...item,
              output: {
                ...candidateRecord,
                status: 'adopted',
                lessonId: lesson.lessonId,
                version: lesson.version,
              },
            }
          : item,
      ),
    };
  } else if (command.stage === 'outline') {
    evidenceFor(deps, task);
    if (!task.lessonId || !task.version)
      throw new StudyError('VERSION_CONFLICT', { reason: 'generation_pipeline_draft_not_created' });
    const currentPlan = deps.store.getScenePlan(deps.projectId, task.lessonId, task.version);
    const expectedRevision = Number(candidateRecord['basePlanRevision']);
    const expectedDigest = candidateRecord['basePlanDigest'] ?? null;
    if (
      (currentPlan?.revision ?? 0) !== expectedRevision ||
      (currentPlan?.digest ?? null) !== expectedDigest
    ) {
      throw new StudyError('VERSION_CONFLICT', {
        reason: 'generation_pipeline_outline_plan_changed',
      });
    }
    const scenes = outlineScenes(task, candidateRecord['candidate'], command.requestId);
    await executeLessonCommand(
      scenePlanSaveSchema.parse({
        scope: command.scope,
        action: 'save-scene-plan',
        requestId: `gp-adopt-${hash(`${task.taskId}:outline`).slice(0, 40)}`,
        lessonId: task.lessonId,
        version: task.version,
        baseRevision: expectedRevision,
        scenes,
      }),
      signal,
    );
    updated = reviewOutput(task, command.stage, 'adopted');
  } else {
    evidenceFor(deps, task);
    const adopted = approveTeachingProfile(
      deps,
      task,
      candidateRecord['candidate'],
      command.requestId,
    );
    return response(adopted);
  }
  const marked = markGenerationPipelineStageReviewed(
    updated,
    command.stage,
    'approved',
    command.requestId,
  );
  return response(saveTask(deps, marked));
};

export const runLessonGenerationPipelineCommand = async (
  deps: ModelCallDeps,
  raw: GenerationPipelineCommand,
  signal?: AbortSignal,
): Promise<GenerationPipelineResponse> => {
  const command = generationPipelineCommandSchema.parse(raw);
  if (command.scope.projectId !== deps.projectId) throw new StudyError('PROJECT_NOT_AUTHORIZED');
  deps.revalidateScope?.();
  if (command.action === 'create') {
    const taskId = taskIdFor(deps.projectId, command.requestId);
    const intentDigest = hash(
      JSON.stringify({
        bundleId: command.bundleId,
        bundleDigest: command.bundleDigest,
        title: command.title,
        statementIds: [...command.statementIds].sort(),
        questionIds: [...command.questionIds].sort(),
        instruction: command.instruction,
      }),
    );
    const prior = deps.store.classroomKV.get<unknown>(
      deps.projectId,
      deps.learnerUid ?? '',
      keyOf(taskId),
    );
    if (prior) {
      const task = generationPipelineTaskSchema.parse(prior);
      if (task.intentDigest !== intentDigest)
        throw new StudyError('VERSION_CONFLICT', { reason: 'generation_pipeline_nonce_reused' });
      return response(task, true);
    }
    const bundleRow = deps.store.getEvidenceBundle(deps.projectId, command.bundleId);
    const preference = deps.store.readTeachingPreference<unknown>(deps.projectId);
    const task = createGenerationPipelineTask({
      taskId,
      projectId: deps.projectId,
      lessonId: null,
      version: null,
      bundleId: command.bundleId,
      bundleDigest: command.bundleDigest,
      roleConfigDigest: deps.store.roleConfigDigest('formal'),
      teachingPreferenceVersion: preference.version,
      title: command.title,
      statementIds: [...new Set(command.statementIds)],
      questionIds: [...new Set(command.questionIds)],
      intentDigest,
      instruction: command.instruction,
    });
    let saved = task;
    let blockedMessage: string | null = null;
    if (!bundleRow || bundleRow.digest !== command.bundleDigest) {
      blockedMessage = '冻结材料包不存在或摘要不匹配，需先恢复材料来源。';
    } else {
      try {
        evidenceFor(deps, task);
      } catch (error) {
        blockedMessage = error instanceof Error ? error.message : '冻结来源或课程准入校验未通过';
      }
    }
    if (blockedMessage) {
      saved = generationPipelineTaskSchema.parse({
        ...task,
        status: 'blocked',
        stages: task.stages.map((item) =>
          item.stage === 'course-draft'
            ? {
                ...item,
                status: 'blocked',
                message: blockedMessage,
                completedAt: new Date().toISOString(),
              }
            : item,
        ),
      });
    }
    saveTask(deps, saved);
    return response(saved);
  }
  const task = readTask(deps, command.taskId);
  if (command.action === 'get') return response(task, true);
  if (command.action === 'stop') {
    const stopped = deps.store.transaction(() => {
      const latest = readTask(deps, task.taskId);
      const lease = deps.store.executions.held(deps.projectId, leaseKey(deps, task.taskId));
      if (lease) deps.store.executions.release(lease);
      return saveTask(deps, stopGenerationPipelineTask(latest));
    });
    activeStages.get(activeStageKey(deps, task.taskId))?.abort('课程生成任务已停止');
    if (task.stages.some((stage) => stage.status === 'running'))
      abortActiveModelCalls({ projectId: deps.projectId, reason: '课程生成任务已停止' });
    return response(stopped);
  }
  if (command.action === 'review') return reviewPipelineStage(deps, task, command, signal);
  if (command.action === 'retry') {
    const saved = deps.store.transaction(() =>
      saveTask(
        deps,
        retryGenerationPipelineStage(readTask(deps, task.taskId), command.stage, command.requestId),
      ),
    );
    return executeCurrentStage(deps, saved, command.scope.generation, signal);
  }
  return executeCurrentStage(deps, task, command.scope.generation, signal);
};

const executeCurrentStage = async (
  deps: ModelCallDeps,
  task: GenerationPipelineTask,
  scopeGeneration: number,
  signal?: AbortSignal,
): Promise<GenerationPipelineResponse> => {
  const current = currentGenerationPipelineStage(task);
  if (!current) return response({ ...task, status: 'completed' }, true);
  if (
    task.status === 'stopped' ||
    task.status === 'failed' ||
    current.status === 'running' ||
    current.status === 'blocked' ||
    current.status === 'completed'
  )
    return response(task, true);
  const perform = async (): Promise<GenerationPipelineResponse> => {
    const fresh = readTask(deps, task.taskId);
    const stage = currentGenerationPipelineStage(fresh);
    if (
      !stage ||
      fresh.status === 'stopped' ||
      fresh.status === 'failed' ||
      stage.stage !== current.stage ||
      stage.status === 'running'
    )
      return response(fresh, true);
    const requestId = stage.requestId ?? stageRequestId(fresh, stage.stage);
    let lease = deps.store.executions.claim({
      projectId: deps.projectId,
      key: leaseKey(deps, task.taskId),
      ownerId: newId('pipeline_executor'),
      now: Date.now(),
      ttlMs: 120_000,
    });
    const stageController = new AbortController();
    const activeKey = activeStageKey(deps, task.taskId);
    activeStages.set(activeKey, stageController);
    const abortStage = (): void => stageController.abort('生成任务已停止');
    signal?.addEventListener('abort', abortStage, { once: true });
    if (signal?.aborted) abortStage();
    const guardedDeps: ModelCallDeps = {
      ...deps,
      verifyExecutionLease: () => {
        deps.verifyExecutionLease?.();
        deps.store.executions.assert(lease);
      },
    };
    const heartbeat = setInterval(() => {
      try {
        deps.revalidateScope?.();
        lease = deps.store.executions.renew(lease, Date.now(), 120_000);
      } catch {
        clearInterval(heartbeat);
        stageController.abort('执行租约失效');
      }
    }, 10_000);
    let running = fresh;
    try {
      guardedDeps.verifyExecutionLease?.();
      if (stageController.signal.aborted) throw new StudyError('RUN_TERMINATED');
      running = deps.store.executions.withLease(lease, () => {
        const latest = readTask(deps, task.taskId);
        const latestStage = currentGenerationPipelineStage(latest);
        if (
          latest.status === 'stopped' ||
          latest.status === 'failed' ||
          !latestStage ||
          latestStage.stage !== stage.stage ||
          latestStage.status === 'running' ||
          latest.updatedAt !== fresh.updatedAt
        )
          throw new StudyError('VERSION_CONFLICT', { reason: 'generation_pipeline_stage_changed' });
        return saveTask(deps, beginGenerationPipelineStage(latest, stage.stage, requestId));
      });
      let output: unknown;
      let message: string;
      if (stage.stage === 'course-draft') {
        const source = evidenceFor(deps, fresh);
        const generated = await generateGuarded(
          guardedDeps,
          {
            scope: { projectId: deps.projectId, generation: scopeGeneration },
            requestId,
            purpose: 'lesson_draft',
            bundleId: fresh.bundleId,
            lessonId: null,
            instruction: `${fresh.instruction}\n仅为本次拟建课程选取这些已冻结陈述：${source.statements.map((item) => item.statementId).join('、')}；题目：${source.questions.map((item) => item.questionId).join('、') || '无'}。`,
          },
          stageController.signal,
        );
        if (!generated.ok || !generated.text)
          throw new StudyError(
            'INVALID_ARGUMENT',
            { reason: 'generation_pipeline_course_draft_failed', message: generated.message },
            generated.message,
          );
        output = {
          candidateId: `gpc_${hash(requestId).slice(0, 24)}`,
          status: 'pending',
          candidate: generated.text,
        };
        message = '已生成课程内容草案候选；审核通过后才会创建新的课程草案版本。';
      } else if (stage.stage === 'courseware') {
        evidenceFor(deps, fresh);
        if (!fresh.lessonId || !fresh.version)
          throw new StudyError('VERSION_CONFLICT', {
            reason: 'generation_pipeline_draft_not_created',
          });
        const result = await generateCourseware(
          guardedDeps,
          {
            scope: { projectId: deps.projectId, generation: scopeGeneration },
            action: 'propose-courseware',
            requestId,
            lessonId: fresh.lessonId,
            version: fresh.version,
            instruction: fresh.instruction,
          },
          stageController.signal,
        );
        if (!result.candidate)
          throw new StudyError(
            'INVALID_ARGUMENT',
            { reason: 'generation_pipeline_courseware_failed', message: result.generation.message },
            result.generation.message,
          );
        output = {
          candidateId: result.candidate.candidateId,
          status: result.candidate.status,
          sceneCount: result.candidate.scenes.length,
        };
        message = '已生成待核课件候选；需在课件候选区人工审核。';
      } else {
        const made = await generateCandidate(
          guardedDeps,
          fresh,
          stage.stage,
          requestId,
          stageController.signal,
        );
        output = made.candidate;
        message = made.message;
      }
      const latestTask = readTask(deps, task.taskId);
      if (latestTask.status === 'stopped') return response(latestTask, true);
      const completed = settleGenerationPipelineStage(running, stage.stage, {
        ok: true,
        message,
        output,
      });
      return response(deps.store.executions.withLease(lease, () => saveTask(deps, completed)));
    } catch (error) {
      // A replacement executor owns the task now. Only model accounting may settle.
      try {
        guardedDeps.verifyExecutionLease?.();
      } catch {
        return response(readTask(deps, task.taskId), true);
      }
      const latestTask = readTask(deps, task.taskId);
      if (latestTask.status === 'stopped') return response(latestTask, true);
      const blocked =
        error instanceof StudyError &&
        [
          'KNOWLEDGE_INVALIDATED',
          'KNOWLEDGE_NOT_VERIFIED',
          'PLAN_NOT_CONFIRMED',
          'MATERIAL_RAW_UNVERIFIED',
          'VERSION_CONFLICT',
        ].includes(error.code);
      const message = error instanceof Error ? error.message : '阶段生成失败';
      const failed = settleGenerationPipelineStage(running, stage.stage, {
        ok: false,
        message,
        blocked,
      });
      return response(deps.store.executions.withLease(lease, () => saveTask(deps, failed)));
    } finally {
      clearInterval(heartbeat);
      signal?.removeEventListener('abort', abortStage);
      if (activeStages.get(activeKey) === stageController) activeStages.delete(activeKey);
      try {
        deps.revalidateScope?.();
        deps.store.executions.release(lease);
      } catch {
        /* expiry or closed project fences the old executor */
      }
    }
  };
  // These existing guarded services already own this project-wide guard.
  return current.stage === 'courseware' || current.stage === 'course-draft'
    ? perform()
    : withExclusiveProjectModelCall(deps.projectId, perform);
};
