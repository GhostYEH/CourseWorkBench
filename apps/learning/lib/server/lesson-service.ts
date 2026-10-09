import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  StudyError,
  coursewareCandidateSchema,
  lessonBundleBuildSchema,
  lessonDocumentAssembleSchema,
  lessonDraftSchema,
  lessonPublishSchema,
  lessonReviewSchema,
  lessonWithdrawSchema,
  statementRevisionApplySchema,
  scenePlanSaveSchema,
  scenePlanMergeSchema,
  coursewareApplySchema,
  scenePlanPatchApplySchema,
  scenePlanPatchPreviewInputSchema,
  scenePlanDraftSaveSchema,
  scenePlanDraftDiscardSchema,
  scenePlanPatchPreviewSchema,
  scenePlanPatchCandidateSchema,
  scenePlanSchema,
  GENERATED_ID_PATTERN,
  type StatementRevisionCandidateDto,
  type CoursewareCandidateDto,
  type ScenePlanDto,
  type ScenePlanReceiptDto,
  type PlanSceneDto,
} from '@sew/study-contracts';
import {
  assertPlanGrounded,
  applyScenePlanPatch,
  applyMergeResolutions,
  diffScenePlans,
  digestOfScenePlan,
  formalInteractionSceneId,
  pblProjectSceneId,
  mergeScenePlans,
  outlineOrderedScenes,
  planSceneDigest,
} from '@sew/study-domain';
import { assertScope, type Session } from './service';
import { toLessonReviewDto, toLessonVersionDto } from './dto';
import { attachFormalLessonDocument } from './classroom-service';
import { readFormalInteractionDefinitions } from './formal-interaction-definition-store';
import { readPblDefinition } from './pbl-definition-store';
import { assertFormalLessonImage, approvedFormalLessonImageRefs } from './formal-lesson-assets';
import { abortActiveModelCalls } from './model-call';

export const lessonCommandSchema = z.discriminatedUnion('action', [
  lessonBundleBuildSchema,
  lessonDraftSchema,
  lessonDocumentAssembleSchema,
  lessonReviewSchema,
  lessonPublishSchema,
  lessonWithdrawSchema,
  statementRevisionApplySchema,
  scenePlanSaveSchema,
  scenePlanMergeSchema,
  coursewareApplySchema,
  scenePlanPatchApplySchema,
  scenePlanPatchPreviewInputSchema,
  scenePlanDraftSaveSchema,
  scenePlanDraftDiscardSchema,
]);

/** 计划里的场景编号由服务端按内容派生：同一份（证据包 + 场景）重复保存得到同一编号。 */
const stableSceneId = (kind: string, index: number, seed: string): string => {
  const hash = [...seed].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 7);
  return `scene_${kind}_${index.toString(36)}${hash.toString(36)}`.slice(0, 60);
};

/**
 * 目标版本还没有计划时，从它的冻结证据包派生确定性初始计划骨架。
 *
 * 与界面「逐场景勾选派生」的口径一致：每个已选陈述一个幻灯片场景（`scene_slide_<statementId>`）、
 * 每道已选题目一个测验场景（`scene_quiz_<questionId>`），知识点由服务端从绑定对象沿用；正文留空，
 * 由用户编辑或模型候选补齐。跨版本合并的骨架必须来自这里，而不是拿来源版本的计划冒充目标版本。
 *
 * 本版本**已审核**的正式互动定义也进入默认计划（用稳定的 `formalInteractionSceneId`）：
 * 默认计划与冻结定义一一对应，于是「计划里少了某互动场景」只有两种可能——用户在计划里显式
 * 删除（计划即权威，不会被自动加回），或定义在计划之后才冻结（漏装配，装配时明确报告未生成）。
 * 两者可区分，不会把「用户删掉的」当成「漏掉的」静默补回。
 */
export const initialPlanScenes = (
  session: Session,
  lesson: {
    lessonId?: string;
    bundleId: string;
    statementIds: string[];
    questionIds: string[];
    version?: number;
  },
): PlanSceneDto[] => {
  const bundleRow = session.store.getEvidenceBundle(session.projectId, lesson.bundleId);
  if (!bundleRow) throw new StudyError('INTERNAL', { bundleId: lesson.bundleId });
  const statements = new Map(bundleRow.bundle.statements.map((item) => [item.statementId, item]));
  const questions = new Map(bundleRow.bundle.questions.map((item) => [item.questionId, item]));
  const frozen =
    lesson.lessonId !== undefined && lesson.version !== undefined
      ? readFormalInteractionDefinitions(session, lesson.lessonId, lesson.version)
      : null;
  const pbl =
    lesson.lessonId !== undefined && lesson.version !== undefined
      ? readPblDefinition(session, lesson.lessonId, lesson.version)
      : null;
  return [
    ...lesson.statementIds
      .map((statementId, index): PlanSceneDto | null => {
        const statement = statements.get(statementId);
        if (!statement) return null;
        return {
          sceneId: `scene_slide_${statementId}`.slice(0, 60),
          kind: 'slide',
          title: `陈述 ${index + 1}`,
          statementId,
          questionId: null,
          knowledgeIds: [statement.knowledgeId],
          elements: [],
          note: '',
        };
      })
      .filter((scene): scene is PlanSceneDto => scene !== null),
    ...lesson.questionIds
      .map((questionId, index): PlanSceneDto | null => {
        const question = questions.get(questionId);
        if (!question) return null;
        return {
          sceneId: `scene_quiz_${questionId}`.slice(0, 60),
          kind: 'quiz',
          title: `独立测验 ${index + 1}`,
          statementId: null,
          questionId,
          knowledgeIds: [...question.knowledgeIds],
          elements: [],
          note: '',
        };
      })
      .filter((scene): scene is PlanSceneDto => scene !== null),
    ...(frozen?.frozen.definitions ?? []).map((definition): PlanSceneDto => ({
      sceneId: formalInteractionSceneId(definition.id),
      kind: 'interactive',
      title: definition.title,
      statementId: null,
      questionId: null,
      knowledgeIds: [],
      elements: [],
      note: '',
    })),
    ...(pbl
      ? [
          {
            sceneId: pblProjectSceneId(pbl.frozen.definition.id),
            kind: 'pbl' as const,
            title: pbl.frozen.definition.title,
            statementId: null,
            questionId: null,
            knowledgeIds: [],
            elements: [],
            note: '',
          },
        ]
      : []),
  ];
};

/** 把候选/客户端提交的场景规范化为权威形状：知识点由服务端从绑定对象沿用。 */
const groundScenes = (
  session: Session,
  lesson: {
    lessonId: string;
    version: number;
    bundleId: string;
    statementIds: string[];
    questionIds: string[];
  },
  scenes: PlanSceneDto[],
  seed: string,
): PlanSceneDto[] => {
  const bundle = session.store.getEvidenceBundle(session.projectId, lesson.bundleId);
  if (!bundle) throw new StudyError('INTERNAL', { bundleId: lesson.bundleId });
  const statements = new Map(bundle.bundle.statements.map((item) => [item.statementId, item]));
  const questions = new Map(bundle.bundle.questions.map((item) => [item.questionId, item]));
  // 本版本已审核的正式互动定义：互动场景必须绑定它们的稳定编号（`formalInteractionSceneId`）。
  const frozen = readFormalInteractionDefinitions(session, lesson.lessonId, lesson.version);
  const definitionSceneIds = new Set(
    (frozen?.frozen.definitions ?? []).map((definition) => formalInteractionSceneId(definition.id)),
  );
  const pblDefinition = readPblDefinition(session, lesson.lessonId, lesson.version);
  const pblSceneId = pblDefinition ? pblProjectSceneId(pblDefinition.frozen.definition.id) : null;
  // 客户端提交的知识点只作核对：与服务端从绑定对象派生的结果不一致即拒绝，
  // 不能靠自报知识点扩大这节课的范围；留空表示「交由服务端派生」。
  const checkDeclared = (declared: string[], expected: string[]): void => {
    if (declared.length === 0) return;
    const left = [...new Set(declared)].sort();
    const right = [...new Set(expected)].sort();
    if (left.length !== right.length || left.some((id, index) => id !== right[index])) {
      throw new StudyError('KNOWLEDGE_SCOPE_INVALID', {
        reason: 'plan_knowledge_mismatch',
        declared,
        expected: right,
      });
    }
  };
  const normalized = scenes.map((scene, index) => {
    const sceneId = GENERATED_ID_PATTERN.test(scene.sceneId)
      ? scene.sceneId
      : stableSceneId(scene.kind, index, seed);
    if (scene.kind === 'slide') {
      const statement = scene.statementId ? statements.get(scene.statementId) : undefined;
      const expected = statement ? [statement.knowledgeId] : [];
      checkDeclared(scene.knowledgeIds, expected);
      for (const element of scene.elements) {
        if (element.kind === 'image')
          assertFormalLessonImage(session, element.assetRef ?? '', lesson.lessonId, bundle.digest);
      }
      return { ...scene, sceneId, knowledgeIds: expected };
    }
    if (scene.kind === 'quiz') {
      const question = scene.questionId ? questions.get(scene.questionId) : undefined;
      const expected = question ? [...question.knowledgeIds] : [];
      checkDeclared(scene.knowledgeIds, expected);
      return { ...scene, sceneId, knowledgeIds: expected };
    }
    if (scene.kind === 'interactive') {
      // 互动场景的编号必须是本版本已审核定义派生出来的稳定编号：客户端不能自造一个
      // 「看起来像互动」的场景来绕过定义审核与来源绑定。
      if (!definitionSceneIds.has(sceneId)) {
        throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING', {
          reason: 'interactive_definition_missing',
          sceneId,
        });
      }
      checkDeclared(scene.knowledgeIds, []);
      return { ...scene, sceneId, knowledgeIds: [] };
    }
    if (scene.kind === 'pbl') {
      if (!pblDefinition || sceneId !== pblSceneId) {
        throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING', {
          reason: 'pbl_definition_missing_or_scene_mismatch',
          sceneId,
        });
      }
      if (scene.statementId !== null || scene.questionId !== null || scene.elements.length > 0) {
        throw new StudyError('INVALID_ARGUMENT', { reason: 'pbl_scene_shape_invalid', sceneId });
      }
      checkDeclared(scene.knowledgeIds, []);
      return { ...scene, sceneId, knowledgeIds: [] };
    }
    checkDeclared(scene.knowledgeIds, []);
    return { ...scene, sceneId, knowledgeIds: [] };
  });
  assertPlanGrounded(normalized, {
    bundle: bundle.bundle,
    statementIds: lesson.statementIds,
    questionIds: lesson.questionIds,
  });
  return normalized;
};

/** Read-only catalog assembly belongs to the application, independently of HTTP. */
export const readLessonCatalog = (session: Session) => {
  const catalog = session.store.readLessonCatalog(session.projectId);
  return {
    bundles: catalog.bundles.map(({ bundleId, digest, frozenAt, bundle }) => ({
      bundleId,
      digest,
      frozenAt,
      bundle,
    })),
    lessons: catalog.lessons.map(toLessonVersionDto),
    versions: catalog.versions.map(toLessonVersionDto),
    reviews: catalog.reviews.map(toLessonReviewDto),
    links: catalog.links,
    /** 场景计划与完整课件候选：页面据此渲染编辑器与待核候选，按版本在前端取用。 */
    scenePlans: session.store.listProjectScenePlans(session.projectId),
    coursewareCandidates: session.store.listProjectCoursewareCandidates(session.projectId),
    scenePlanPatchCandidates: session.store.listProjectScenePlanPatchCandidates(session.projectId),
    scenePlanDrafts: catalog.versions
      .map((version) =>
        session.store.getScenePlanDraft(session.projectId, version.lessonId, version.version),
      )
      .filter((draft): draft is NonNullable<typeof draft> => draft !== null),
  };
};

/** 单条候选是权威记录，直接返回；用于 apply 响应，避免二次映射漂移。 */
const asCandidate = (candidate: StatementRevisionCandidateDto): StatementRevisionCandidateDto =>
  candidate;

/**
 * 计划命令的四态回执语义（LESSON-02）。
 *
 * 回执与业务写入在**同一事务**内落库，因此「提交成功但响应丢失」后重发同 requestId
 * 得到同一结论，不会因重发而推进第二个 revision。四态分别是：
 * - `completed`：业务已提交，回执里带权威结果；重发读回同一结果（`deduplicated: true`）。
 * - `failed`：确定失败（校验/冲突/权限），事务回滚、没有任何业务写入；重发读回同一条失败，
 *   调用方必须换新 requestId 才能真正重试——不能让重发悄悄变成一次成功。
 * - `cancelled`：调用方在提交前取消，同样没有业务写入；语义与 `failed` 一致但原因不同。
 * - `unknown`：外部结果未知（例如 provider 已派发但结果未能确认）。**不写入业务结果**，
 *   保留预占且不自动重发；调用方需人工核对用量记录后再决定。
 */
type PlanReceiptAction = 'save-scene-plan' | 'apply-courseware';

/**
 * 回执里保存的**业务结果**形状（不含 receipt 自身，避免自引用）。
 *
 * 重放时按这两个 schema 复验：损坏的回执被拒绝重放，而不是把坏数据当成成功返回。
 */
const scenePlanReceiptResultSchema = z.object({ plan: scenePlanSchema }).strict();
const coursewareReceiptResultSchema = z
  .object({ candidate: coursewareCandidateSchema, plan: scenePlanSchema.nullable() })
  .strict();
/** 受限补丁处置回执的业务结果形状：候选 + 计划 + 应用预览（逐条结论）。 */
const scenePlanPatchReceiptResultSchema = z
  .object({
    candidate: scenePlanPatchCandidateSchema,
    plan: scenePlanSchema.nullable(),
    preview: scenePlanPatchPreviewSchema,
  })
  .strict();
/**
 * 已存在的回执 → 响应。
 *
 * - `completed`：按 requestId 重放既有结果。结果来自权威库，但仍按当前合同重新校验：
 *   回执内容若损坏（被外部改写），这里就**拒绝重放**，而不是把坏数据当成成功返回。
 * - `failed` / `cancelled` / `unknown`：三态都代表「没有业务写入」，按已记录的错误码与原因
 *   重放同一结论，不重新执行一遍写入。`unknown` 额外保留「不自动重发」的语义。
 */
const receiptOutcome = (
  receipt: ScenePlanReceiptDto,
  deduplicated: boolean,
  schema: z.ZodType<Record<string, unknown>>,
): Record<string, unknown> => {
  if (receipt.state === 'completed') {
    const replayed = schema.safeParse(receipt.result);
    if (!replayed.success) {
      throw new StudyError('INTERNAL', {
        reason: 'scene_plan_receipt_corrupt',
        requestId: receipt.requestId,
      });
    }
    return { ...replayed.data, receipt, deduplicated };
  }
  throw new StudyError(
    (receipt.errorCode as StudyError['code'] | null) ?? 'VERSION_CONFLICT',
    {
      reason:
        receipt.errorReason ??
        (receipt.state === 'unknown' ? 'plan_result_unknown' : 'plan_request_replayed'),
      requestId: receipt.requestId,
      receiptState: receipt.state,
    },
    receipt.message,
  );
};

/**
 * 确定失败是否应记入回执。
 *
 * 领域错误（非 `INTERNAL`）是「可判定的业务拒绝」：可以安全地记成 `failed` 并重放，
 * 调用方换新 requestId 重试即可。非领域错误与 `INTERNAL` 属于无法断言业务结论的故障，
 * 必须记成 `unknown`（不写业务结果、拒绝自动重发），而不是伪装成一次可重试的确定失败。
 */
const isDeterministicFailure = (error: unknown): error is StudyError =>
  error instanceof StudyError && error.code !== 'INTERNAL';

/**
 * 把一次失败写进回执（`failed` 或 `unknown`），保留错误合同并返回确定的回执状态。
 *
 * 注意：业务事务此时已回滚，回执必须用**新事务**落库——它记录的是「这次请求没有产生业务
 * 写入」这一结论本身，而不是业务数据的一部分。回执写入失败时不掩盖原始错误。
 *
 * `failed` 与 `unknown` 的区别：前者是**可判定的业务拒绝**（校验/冲突/权限），调用方换新
 * requestId 重试即可；后者是非业务故障（内部错误、存储异常），无法断言业务结论，因此记成
 * `unknown` 让同一 requestId 的重发**重放同一条非结论**，而不是悄悄重新执行一次。
 */
const recordFailedPlanReceipt = (
  session: Session,
  projectId: string,
  requestId: string,
  action: PlanReceiptAction,
  intent: string,
  error: unknown,
): never => {
  const deterministic = isDeterministicFailure(error);
  let recorded = false;
  try {
    session.store.transaction(() =>
      session.store.saveScenePlanReceipt({
        projectId,
        requestId,
        action,
        intent,
        state: deterministic ? 'failed' : 'unknown',
        result: null,
        message: deterministic
          ? error.message
          : '结果未能确认：命令未产生可判定的业务结论，已保留记录且不会自动重发。',
        errorCode: deterministic ? error.code : 'INTERNAL',
        errorReason: deterministic
          ? typeof error.details?.['reason'] === 'string'
            ? (error.details['reason'] as string)
            : null
          : 'plan_result_unknown',
      }),
    );
    recorded = true;
  } catch {
    /* 保留原始失败，不因回执写入失败而改变结论 */
  }
  if (recorded && deterministic) {
    throw new StudyError(error.code, { ...error.details, requestId, receiptState: 'failed' });
  }
  throw error;
};

/** 调用方在提交前取消：同样没有业务写入，但语义与「确定失败」不同，单独记录。 */
const recordCancelledPlanReceipt = (
  session: Session,
  projectId: string,
  requestId: string,
  action: PlanReceiptAction,
  intent: string,
): boolean => {
  try {
    session.store.transaction(() =>
      session.store.saveScenePlanReceipt({
        projectId,
        requestId,
        action,
        intent,
        state: 'cancelled',
        result: null,
        message: '本次请求在提交前被取消，未产生任何业务写入。',
        errorCode: 'RUN_TERMINATED',
        errorReason: 'request_cancelled',
      }),
    );
    return true;
  } catch {
    /* 取消记录失败不改变「没有业务写入」这一事实 */
    return false;
  }
};

/**
 * 受限补丁的逐项预览（OMA-023 的只读核心）。
 *
 * 从当前计划与候选操作算出「每条操作可应用/被拒绝」以及应用可应用操作后的计划内容与摘要。
 * 生成、只读预览与人工处置三处共用同一份判定，避免界面与服务端口径分裂。
 */
const scenePlanPatchPreviewFor = (
  session: Session,
  candidate: {
    lessonId: string;
    baseVersion: number;
    ops: Parameters<typeof applyScenePlanPatch>[1];
  },
  nextElementId: (opIndex: number) => string,
  selectedOpIndexes?: readonly number[],
) => {
  const lesson = session.store.getLessonVersion(
    candidate.lessonId,
    candidate.baseVersion,
    session.projectId,
  );
  if (!lesson)
    throw new StudyError('NOT_FOUND', {
      lessonId: candidate.lessonId,
      version: candidate.baseVersion,
    });
  const current = session.store.getScenePlan(session.projectId, candidate.lessonId, lesson.version);
  if (!current) {
    throw new StudyError('NOT_FOUND', {
      reason: 'scene_plan_patch_requires_plan',
      lessonId: candidate.lessonId,
      version: lesson.version,
    });
  }
  const bundleRow = session.store.getEvidenceBundle(session.projectId, lesson.bundleId);
  if (!bundleRow) throw new StudyError('INTERNAL', { bundleId: lesson.bundleId });
  const approvedAssetRefs = approvedFormalLessonImageRefs(
    session,
    candidate.lessonId,
    bundleRow.digest,
  );
  const outcome = applyScenePlanPatch(
    current.scenes,
    candidate.ops,
    { approvedAssetRefs, nextElementId },
    selectedOpIndexes,
  );
  const applicableIndexes = outcome.results
    .filter((result) => result.status === 'applicable')
    .map((result) => result.index);
  const applicableSet = new Set(applicableIndexes);
  // 选择语义：未提供即采用全部可应用操作；提供时只把「选中的可应用」写入结果。
  const selectedIndexes =
    selectedOpIndexes === undefined ? applicableIndexes : [...selectedOpIndexes];
  const selectedApplicable = selectedIndexes.filter((index) => applicableSet.has(index));
  const preview = scenePlanPatchPreviewSchema.parse({
    baseRevision: current.revision,
    baseDigest: current.digest,
    results: outcome.results,
    applicableCount: applicableIndexes.length,
    selectedCount: selectedIndexes.length,
    appliedCount: selectedApplicable.length,
    rejectedCount: outcome.results.filter((result) => result.status === 'rejected').length,
    scenes: outcome.scenes,
    digest: digestOfScenePlan({
      lessonId: candidate.lessonId,
      lessonVersion: lesson.version,
      bundleId: lesson.bundleId,
      scenes: outcome.scenes,
    }),
  });
  return { lesson, bundleRow, current, outcome, preview };
};

/** Course commands retain their source, review, cancellation and publication rules. */
export const executeLessonCommand = (
  body: z.infer<typeof lessonCommandSchema>,
  signal?: AbortSignal,
) => {
  const session = assertScope(body.scope);
  const projectId = session.projectId;

  if (body.action === 'build-bundle') {
    const bundle = session.store.buildLessonBundle(projectId, body.statements, body.questionIds);
    return {
      bundleId: bundle.bundleId,
      digest: bundle.digest,
      frozenAt: bundle.frozenAt,
      bundle: bundle.bundle,
    };
  }

  if (body.action === 'attach-document') {
    const document = attachFormalLessonDocument(session, body.lessonId, body.version);
    return { document };
  }

  if (body.action === 'review') {
    const review = session.store.reviewLesson({
      projectId,
      lessonId: body.lessonId,
      version: body.version,
      decision: body.decision,
      note: body.note,
    });
    return { review: toLessonReviewDto(review) };
  }

  if (body.action === 'withdraw') {
    // 课程停用后课堂已不可教：先中止本项目在途的模型请求，再落库撤回结果。
    abortActiveModelCalls({ projectId, reason: '课程已撤回或停用' });
    const lesson = session.store.withdrawLesson({
      projectId,
      lessonId: body.lessonId,
      reason: body.reason,
    });
    return {
      lesson: toLessonVersionDto(lesson),
      link: session.store.getLessonClassroomLink(body.lessonId, projectId),
    };
  }

  if (body.action === 'apply-statement-revision') {
    // 幂等：同 requestId 与意图重试返回既有处置结果，不重复派生版本。
    const intent = JSON.stringify({
      candidateId: body.candidateId,
      decision: body.decision,
      note: body.note,
    });
    const previous = session.store.statementRevisionReceipt(
      projectId,
      body.requestId,
      'apply',
      intent,
    );
    if (previous) return { ...(previous.result as Record<string, unknown>), deduplicated: true };
    const result = session.store.transaction(() => {
      const applied = session.store.applyStatementRevision({
        projectId,
        candidateId: body.candidateId,
        decision: body.decision,
        note: body.note,
        reviewedBy: session.learnerUid,
      });
      const payload = {
        candidate: asCandidate(applied.candidate),
        lesson: applied.lesson ? toLessonVersionDto(applied.lesson) : null,
        deduplicated: false,
      };
      session.store.saveStatementRevisionReceipt(
        projectId,
        body.requestId,
        'apply',
        intent,
        payload,
      );
      return payload;
    });
    return result;
  }

  if (body.action === 'save-scene-plan') {
    // 幂等：同 requestId 与意图重试读回既有回执，不重复推进 revision。
    // 回执与业务写入在同一事务内落库，因此「提交成功但响应丢失」后重发得到同一结果。
    const intent = JSON.stringify({
      lessonId: body.lessonId,
      version: body.version,
      baseRevision: body.baseRevision,
      scenes: body.scenes,
    });
    const previous = session.store.scenePlanReceipt(
      projectId,
      body.requestId,
      'save-scene-plan',
      intent,
    );
    if (previous) return receiptOutcome(previous, true, scenePlanReceiptResultSchema);
    // 提交前取消：记录 cancelled 回执，不留业务写入，也不让重发变成一次执行。
    if (signal?.aborted) {
      const recorded = recordCancelledPlanReceipt(
        session,
        projectId,
        body.requestId,
        'save-scene-plan',
        intent,
      );
      throw new StudyError('RUN_TERMINATED', {
        reason: 'request_cancelled',
        requestId: body.requestId,
        ...(recorded ? { receiptState: 'cancelled' } : {}),
      });
    }
    try {
      return session.store.transaction(() => {
        const lesson = session.store.getLessonVersion(body.lessonId, body.version, projectId);
        if (!lesson)
          throw new StudyError('NOT_FOUND', { lessonId: body.lessonId, version: body.version });
        const scenes = groundScenes(session, lesson, body.scenes, body.requestId);
        const plan = session.store.saveScenePlan({
          projectId,
          lessonId: body.lessonId,
          lessonVersion: body.version,
          bundleId: lesson.bundleId,
          scenes,
          origin: 'deterministic',
          baseRevision: body.baseRevision,
        });
        const payload = { plan, deduplicated: false };
        const receipt = session.store.saveScenePlanReceipt({
          projectId,
          requestId: body.requestId,
          action: 'save-scene-plan',
          intent,
          state: 'completed',
          result: { plan },
          message: '',
        });
        return { ...payload, receipt };
      });
    } catch (error) {
      // 确定失败：事务已回滚，没有任何业务写入。记下同 requestId 的失败回执，
      // 使重发得到同一结论（可查询、可重放），而不是换一个「重试成功」的结果。
      return recordFailedPlanReceipt(
        session,
        projectId,
        body.requestId,
        'save-scene-plan',
        intent,
        error,
      );
    }
  }

  if (body.action === 'apply-courseware') {
    // 幂等：同 requestId 与意图重试读回既有回执，不重复写入计划。
    const intent = JSON.stringify({
      candidateId: body.candidateId,
      decision: body.decision,
      note: body.note,
      expectedPlanRevision: body.expectedPlanRevision ?? null,
      override: body.override,
    });
    const previous = session.store.scenePlanReceipt(
      projectId,
      body.requestId,
      'apply-courseware',
      intent,
    );
    if (previous) return receiptOutcome(previous, true, coursewareReceiptResultSchema);
    if (signal?.aborted) {
      const recorded = recordCancelledPlanReceipt(
        session,
        projectId,
        body.requestId,
        'apply-courseware',
        intent,
      );
      throw new StudyError('RUN_TERMINATED', {
        reason: 'request_cancelled',
        requestId: body.requestId,
        ...(recorded ? { receiptState: 'cancelled' } : {}),
      });
    }
    try {
      return session.store.transaction(() => {
        const candidate = session.store.getCoursewareCandidate(projectId, body.candidateId);
        if (!candidate) throw new StudyError('NOT_FOUND', { candidateId: body.candidateId });
        const lesson = session.store.getLessonVersion(
          candidate.lessonId,
          candidate.baseVersion,
          projectId,
        );
        if (!lesson) {
          throw new StudyError('NOT_FOUND', {
            lessonId: candidate.lessonId,
            version: candidate.baseVersion,
          });
        }
        // 通过时把候选场景规范化后写入计划；拒绝时不触碰计划。
        const scenes =
          body.decision === 'approved'
            ? groundScenes(session, lesson, candidate.scenes, body.requestId)
            : null;
        const applied = session.store.applyCoursewareCandidate({
          projectId,
          candidateId: body.candidateId,
          decision: body.decision,
          note: body.note,
          reviewedBy: session.learnerUid,
          scenes,
          ...(body.expectedPlanRevision === undefined
            ? {}
            : { expectedPlanRevision: body.expectedPlanRevision }),
          override: body.override,
        });
        const payload = {
          candidate: applied.candidate as CoursewareCandidateDto,
          plan: applied.plan as ScenePlanDto | null,
          deduplicated: false,
        };
        const receipt = session.store.saveScenePlanReceipt({
          projectId,
          requestId: body.requestId,
          action: 'apply-courseware',
          intent,
          state: 'completed',
          result: { candidate: applied.candidate, plan: applied.plan },
          message: '',
        });
        return { ...payload, receipt };
      });
    } catch (error) {
      return recordFailedPlanReceipt(
        session,
        projectId,
        body.requestId,
        'apply-courseware',
        intent,
        error,
      );
    }
  }

  if (body.action === 'save-scene-plan-draft') {
    // 持久编辑草稿（OMA-024）：工作副本，按 (project,lesson,version) 覆盖写，天然幂等（同请求重发得到同一草稿）。
    // 草稿不参与教学/审核，因此不写业务回执表；基线与当前计划一致才接受，避免把旧编辑盖到新 revision 上。
    return session.store.transaction(() => {
      const lesson = session.store.getLessonVersion(body.lessonId, body.version, projectId);
      if (!lesson)
        throw new StudyError('NOT_FOUND', { lessonId: body.lessonId, version: body.version });
      if (lesson.status !== 'draft') {
        throw new StudyError('STEP_ALREADY_COMMITTED', {
          status: lesson.status,
          reason: 'scene_plan_draft_base_not_draft',
        });
      }
      const current = session.store.getScenePlan(projectId, body.lessonId, body.version);
      if ((current?.revision ?? 0) !== body.baseRevision) {
        throw new StudyError('VERSION_CONFLICT', {
          reason: 'scene_plan_draft_base_stale',
          expected: current?.revision ?? 0,
          received: body.baseRevision,
        });
      }
      const scenes = groundScenes(session, lesson, body.scenes, body.requestId);
      const draft = session.store.saveScenePlanDraft({
        projectId,
        lessonId: body.lessonId,
        lessonVersion: body.version,
        baseRevision: body.baseRevision,
        baseDigest: current?.digest ?? null,
        scenes,
        ...(body.expectedDraftRevision === undefined
          ? {}
          : { expectedDraftRevision: body.expectedDraftRevision }),
      });
      return { draft, deduplicated: false };
    });
  }

  if (body.action === 'discard-scene-plan-draft') {
    session.store.discardScenePlanDraft(projectId, body.lessonId, body.version);
    return { discarded: true };
  }

  if (body.action === 'preview-scene-plan-patch') {
    // 只读预览：逐条判定候选操作并按**当前选择**算出应用后的计划，不写入任何计划；天然幂等。
    const candidate = session.store.getScenePlanPatchCandidate(projectId, body.candidateId);
    if (!candidate) throw new StudyError('NOT_FOUND', { candidateId: body.candidateId });
    const { preview } = scenePlanPatchPreviewFor(
      session,
      candidate,
      (opIndex) =>
        `el_text_${createHash('sha256')
          .update(`${body.candidateId}:${opIndex}`)
          .digest('hex')
          .slice(0, 24)}`,
      body.selectedOpIndexes,
    );
    return { candidate, preview };
  }

  if (body.action === 'apply-scene-plan-patch') {
    // 幂等：同 requestId 与意图重试读回既有回执，不重复写入计划。
    const intent = JSON.stringify({
      candidateId: body.candidateId,
      decision: body.decision,
      note: body.note,
      selectedOpIndexes: body.selectedOpIndexes ?? null,
      expectedPlanRevision: body.expectedPlanRevision ?? null,
      override: body.override,
    });
    const previous = session.store.scenePlanPatchReceipt(
      projectId,
      body.requestId,
      'apply',
      intent,
    );
    if (previous) {
      if (previous.state === 'completed') {
        const replayed = scenePlanPatchReceiptResultSchema.safeParse(previous.result);
        if (!replayed.success)
          throw new StudyError('INTERNAL', {
            reason: 'scene_plan_patch_receipt_corrupt',
            requestId: body.requestId,
          });
        return { ...replayed.data, deduplicated: true };
      }
      throw new StudyError(
        (previous.errorCode as StudyError['code'] | null) ?? 'VERSION_CONFLICT',
        {
          reason: previous.errorReason ?? 'scene_plan_patch_result_unknown',
          requestId: body.requestId,
          receiptState: previous.state,
        },
        previous.message,
      );
    }
    if (signal?.aborted) {
      session.store.transaction(() =>
        session.store.saveScenePlanPatchReceipt({
          projectId,
          requestId: body.requestId,
          action: 'apply',
          intent,
          state: 'cancelled',
          result: null,
          message: '本次补丁处置在提交前被取消，未产生任何业务写入。',
          errorCode: 'RUN_TERMINATED',
          errorReason: 'request_cancelled',
        }),
      );
      throw new StudyError('RUN_TERMINATED', {
        reason: 'request_cancelled',
        requestId: body.requestId,
        receiptState: 'cancelled',
      });
    }
    try {
      return session.store.transaction(() => {
        const candidate = session.store.getScenePlanPatchCandidate(projectId, body.candidateId);
        if (!candidate) throw new StudyError('NOT_FOUND', { candidateId: body.candidateId });
        if (candidate.status !== 'pending') {
          throw new StudyError('STEP_ALREADY_COMMITTED', {
            status: candidate.status,
            reason: 'scene_plan_patch_already_decided',
          });
        }
        const { lesson, current, outcome, preview } = scenePlanPatchPreviewFor(
          session,
          candidate,
          // 元素编号种子统一用 candidateId，与生成、只读预览一致：审核者看到的计划与写入结果逐字相同。
          (opIndex) =>
            `el_text_${createHash('sha256')
              .update(`${candidate.candidateId}:${opIndex}`)
              .digest('hex')
              .slice(0, 24)}`,
          body.selectedOpIndexes,
        );
        if (lesson.status !== 'draft') {
          throw new StudyError('STEP_ALREADY_COMMITTED', {
            status: lesson.status,
            reason: 'scene_plan_patch_base_not_draft',
          });
        }
        // 审批所依据的计划基线必须与**客户端这次确认的**计划一致。
        //
        // `override` 只豁免「候选自身基线过期」，不能豁免「用户这次确认的计划修订已经变化」：
        // 提交的 `expectedPlanRevision`（缺省时取候选基线）必须等于当前权威 revision，否则拒绝写入、
        // 不改变候选成功状态，要求重新比较后再确认。绝不能用刚读取的 `current.revision` 替换客户端
        // 预期值——那等于用新 revision 给旧确认背书，会让旧候选静默覆盖更晚的计划。
        const confirmedRevision = body.expectedPlanRevision ?? candidate.basePlanRevision;
        if (body.decision === 'approved' && confirmedRevision !== current.revision) {
          throw new StudyError('VERSION_CONFLICT', {
            reason: 'plan_revision_stale',
            expected: confirmedRevision,
            received: current.revision,
            candidatePlanRevision: candidate.basePlanRevision,
          });
        }
        // 未显式覆盖时，候选自身的计划基线（revision + digest）也必须与当前一致。
        if (
          body.decision === 'approved' &&
          !body.override &&
          (current.revision !== candidate.basePlanRevision ||
            current.digest !== candidate.basePlanDigest)
        ) {
          throw new StudyError('VERSION_CONFLICT', {
            reason: 'plan_revision_stale',
            expected: candidate.basePlanRevision,
            received: current.revision,
            candidatePlanRevision: candidate.basePlanRevision,
          });
        }
        const scenes =
          body.decision === 'approved'
            ? groundScenes(session, lesson, outcome.scenes, body.requestId)
            : null;
        const applied = session.store.applyScenePlanPatchCandidate({
          projectId,
          candidateId: body.candidateId,
          decision: body.decision,
          note: body.note,
          reviewedBy: session.learnerUid,
          scenes,
          expectedPlanRevision: confirmedRevision,
          override: body.override,
        });
        const payload = {
          candidate: applied.candidate,
          plan: applied.plan,
          preview,
        };
        session.store.saveScenePlanPatchReceipt({
          projectId,
          requestId: body.requestId,
          action: 'apply',
          intent,
          state: 'completed',
          result: payload,
          message: '',
        });
        return { ...payload, deduplicated: false };
      });
    } catch (error) {
      if (isDeterministicFailure(error)) {
        let recorded = false;
        try {
          session.store.transaction(() =>
            session.store.saveScenePlanPatchReceipt({
              projectId,
              requestId: body.requestId,
              action: 'apply',
              intent,
              state: 'failed',
              result: null,
              message: error.message,
              errorCode: error.code,
              errorReason:
                typeof error.details?.['reason'] === 'string'
                  ? (error.details['reason'] as string)
                  : null,
            }),
          );
          recorded = true;
        } catch {
          /* 保留原始失败 */
        }
        if (recorded)
          throw new StudyError(error.code, {
            ...error.details,
            requestId: body.requestId,
            receiptState: 'failed',
          });
      }
      throw error;
    }
  }

  if (body.action === 'merge-scene-plans') {
    // 只读预览：比较来源版本与目标草案版本的计划，算出增/删/改/序、冲突与大纲缺口，
    // 不写入任何计划。写回走 save-scene-plan，版本与审核语义不变；重复调用结果一致。
    if (body.fromVersion === body.toVersion) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'merge_same_version' });
    }
    const target = session.store.getLessonVersion(body.lessonId, body.toVersion, projectId);
    if (!target)
      throw new StudyError('NOT_FOUND', { lessonId: body.lessonId, version: body.toVersion });
    const source = session.store.getLessonVersion(body.lessonId, body.fromVersion, projectId);
    if (!source)
      throw new StudyError('NOT_FOUND', { lessonId: body.lessonId, version: body.fromVersion });
    const baseVersion = body.baseVersion ?? body.fromVersion;
    const base = session.store.getLessonVersion(body.lessonId, baseVersion, projectId);
    if (!base) throw new StudyError('NOT_FOUND', { lessonId: body.lessonId, version: baseVersion });
    const sourcePlan = session.store.getScenePlan(projectId, body.lessonId, body.fromVersion);
    if (!sourcePlan) {
      throw new StudyError('NOT_FOUND', {
        reason: 'merge_source_plan_missing',
        version: body.fromVersion,
      });
    }
    const targetPlan = session.store.getScenePlan(projectId, body.lessonId, body.toVersion);
    // 目标版本还没有计划时，从它自己的证据包派生确定性骨架作为合并落点，而不是拿来源冒充目标。
    const currentScenes = targetPlan?.scenes ?? initialPlanScenes(session, target);
    if (currentScenes.length === 0) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'merge_target_plan_empty' });
    }
    /**
     * 共同祖先的选择（决定「哪些改动可以安全并入」）：
     * - 显式给出 `baseVersion` → 用那一版计划当祖先；
     * - 未给出、且目标版本**已有**计划 → 以来源版本为祖先。此时「来源相对自己的改动」为空，
     *   合并不会静默覆盖目标版本已有的编辑；差异照常报告，交给用户决定要不要显式覆盖；
     * - 未给出、且目标版本**没有**计划 → 以目标骨架为祖先。此时祖先与当前一致，来源版本的
     *   全部内容都会被并入——这正是「派生新草案后把旧版本计划带过来」的主用例，目标没有可丢的内容。
     */
    const basePlan = body.baseVersion
      ? session.store.getScenePlan(projectId, body.lessonId, body.baseVersion)
      : targetPlan
        ? sourcePlan
        : null;
    if (body.baseVersion && !basePlan) {
      throw new StudyError('NOT_FOUND', {
        reason: 'merge_base_plan_missing',
        version: body.baseVersion,
      });
    }
    const baseScenes = basePlan?.scenes ?? currentScenes;
    const resolvedBaseVersion = basePlan ? (body.baseVersion ?? body.fromVersion) : body.toVersion;
    // 差异按「目标当前 → 来源版本」算：新增=来源独有，删除=目标独有，修改=两侧都有但内容不同。
    const diff = diffScenePlans(currentScenes, sourcePlan.scenes);
    const merged = mergeScenePlans({
      base: baseScenes,
      incoming: sourcePlan.scenes,
      current: currentScenes,
    });
    if (merged.scenes.length === 0) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'merge_result_empty' });
    }
    // 逐项冲突决议：全部冲突都有决议时才改变合并结果；否则保持默认（保留目标内容）。
    const resolvedScenes = body.resolutions
      ? applyMergeResolutions({
          merged,
          incoming: sourcePlan.scenes,
          current: currentScenes,
          resolutions: body.resolutions,
        })
      : merged.scenes;
    const outline = outlineOrderedScenes(resolvedScenes, target.statementIds);
    const bySource = new Map(sourcePlan.scenes.map((scene) => [scene.sceneId, scene]));
    const byCurrent = new Map(currentScenes.map((scene) => [scene.sceneId, scene]));
    const entry = (sceneId: string) => {
      const scene = bySource.get(sceneId) ?? byCurrent.get(sceneId)!;
      return {
        sceneId,
        kind: scene.kind,
        title: scene.title,
        inSource: bySource.has(sceneId),
        inTarget: byCurrent.has(sceneId),
      };
    };
    return {
      merge: {
        baseVersion: resolvedBaseVersion,
        fromVersion: body.fromVersion,
        toVersion: body.toVersion,
        diff: {
          added: diff.added.map(entry),
          removed: diff.removed.map(entry),
          modified: diff.modified.map(entry),
          reordered: diff.reordered,
        },
        conflicts: merged.conflicts.map((conflict) => ({
          sceneId: conflict.sceneId,
          reason: conflict.reason,
          incomingDigest: bySource.has(conflict.sceneId)
            ? planSceneDigest(bySource.get(conflict.sceneId)!)
            : null,
          currentDigest: byCurrent.has(conflict.sceneId)
            ? planSceneDigest(byCurrent.get(conflict.sceneId)!)
            : null,
        })),
        outlineMissingStatementIds: outline.missing,
        outlineUnmatchedStatementIds: outline.unmatched,
        mergedScenes: resolvedScenes,
        mergedDigest: digestOfScenePlan({
          lessonId: body.lessonId,
          lessonVersion: body.toVersion,
          bundleId: target.bundleId,
          scenes: resolvedScenes,
        }),
      },
    };
  }

  if (body.action === 'draft') {
    const source = body.lessonId
      ? session.store.listLessonVersions(body.lessonId, projectId)[0]
      : null;
    if (body.lessonId && !source) {
      throw new StudyError('NOT_FOUND', { lessonId: body.lessonId });
    }
    // 带 requestId 时按意图幂等：重试返回既有版本，不追加第二个草案版本。
    const intent = JSON.stringify({
      lessonId: body.lessonId,
      bundleId: body.bundleId,
      title: body.title,
      statementIds: [...body.statementIds].sort(),
      questionIds: [...body.questionIds].sort(),
    });
    if (body.requestId) {
      const previous = session.store.lessonDraftReceipt(projectId, body.requestId, intent);
      if (previous) {
        const existing = session.store.getLessonVersion(
          previous.lessonId,
          previous.version,
          projectId,
        );
        if (!existing)
          throw new StudyError('INTERNAL', { reason: 'draft_receipt_missing_version' });
        return { lesson: toLessonVersionDto(existing) };
      }
    }
    return session.store.transaction(() => {
      const lesson = session.store.createLessonDraft({
        projectId,
        lessonId: body.lessonId,
        title: body.title,
        bundleId: body.bundleId,
        statementIds: body.statementIds,
        questionIds: body.questionIds,
      });
      if (body.requestId) {
        session.store.saveLessonDraftReceipt(
          projectId,
          body.requestId,
          intent,
          lesson.lessonId,
          lesson.version,
        );
      }
      return { lesson: toLessonVersionDto(lesson) };
    });
  }

  const lesson = session.store.publishLesson({
    projectId,
    lessonId: body.lessonId,
    version: body.version,
  });
  return {
    lesson: toLessonVersionDto(lesson),
    link: session.store.getLessonClassroomLink(body.lessonId, projectId),
  };
};
