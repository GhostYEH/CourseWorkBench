import { z } from 'zod';
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
  coursewareApplySchema,
  scenePlanSchema,
  GENERATED_ID_PATTERN,
  type StatementRevisionCandidateDto,
  type CoursewareCandidateDto,
  type ScenePlanDto,
  type ScenePlanReceiptDto,
  type PlanSceneDto,
} from '@sew/study-contracts';
import { assertPlanGrounded } from '@sew/study-domain';
import { assertScope, type Session } from './service';
import { toLessonReviewDto, toLessonVersionDto } from './dto';
import { attachFormalLessonDocument } from './classroom-service';
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
  coursewareApplySchema,
]);

/** 计划里的场景编号由服务端按内容派生：同一份（证据包 + 场景）重复保存得到同一编号。 */
const stableSceneId = (kind: string, index: number, seed: string): string => {
  const hash = [...seed].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 7);
  return `scene_${kind}_${index.toString(36)}${hash.toString(36)}`.slice(0, 60);
};

/** 把候选/客户端提交的场景规范化为权威形状：知识点由服务端从绑定对象沿用。 */
const groundScenes = (
  session: Session,
  lesson: { bundleId: string; statementIds: string[]; questionIds: string[] },
  scenes: PlanSceneDto[],
  seed: string,
): PlanSceneDto[] => {
  const bundle = session.store.getEvidenceBundle(session.projectId, lesson.bundleId);
  if (!bundle) throw new StudyError('INTERNAL', { bundleId: lesson.bundleId });
  const statements = new Map(bundle.bundle.statements.map((item) => [item.statementId, item]));
  const questions = new Map(bundle.bundle.questions.map((item) => [item.questionId, item]));
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
      return { ...scene, sceneId, knowledgeIds: expected };
    }
    if (scene.kind === 'quiz') {
      const question = scene.questionId ? questions.get(scene.questionId) : undefined;
      const expected = question ? [...question.knowledgeIds] : [];
      checkDeclared(scene.knowledgeIds, expected);
      return { ...scene, sceneId, knowledgeIds: expected };
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
