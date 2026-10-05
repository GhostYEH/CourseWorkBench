import { z } from 'zod';
import {
  StudyError,
  lessonBundleBuildSchema,
  lessonDocumentAssembleSchema,
  lessonDraftSchema,
  lessonPublishSchema,
  lessonReviewSchema,
  lessonWithdrawSchema,
  statementRevisionApplySchema,
  scenePlanSaveSchema,
  coursewareApplySchema,
  GENERATED_ID_PATTERN,
  type StatementRevisionCandidateDto,
  type CoursewareCandidateDto,
  type ScenePlanDto,
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

/** Course commands retain their source, review, cancellation and publication rules. */
export const executeLessonCommand = (body: z.infer<typeof lessonCommandSchema>) => {
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
    const lesson = session.store.getLessonVersion(body.lessonId, body.version, projectId);
    if (!lesson)
      throw new StudyError('NOT_FOUND', { lessonId: body.lessonId, version: body.version });
    const scenes = groundScenes(session, lesson, body.scenes, body.requestId);
    const plan = session.store.transaction(() =>
      session.store.saveScenePlan({
        projectId,
        lessonId: body.lessonId,
        lessonVersion: body.version,
        bundleId: lesson.bundleId,
        scenes,
        origin: 'deterministic',
        baseRevision: body.baseRevision,
      }),
    );
    return { plan };
  }

  if (body.action === 'apply-courseware') {
    // 幂等：同 requestId 与意图重试返回既有处置结果，不重复写入计划。
    const intent = JSON.stringify({
      candidateId: body.candidateId,
      decision: body.decision,
      note: body.note,
    });
    const previous = session.store.coursewareReceipt(projectId, body.requestId, 'apply', intent);
    if (previous) return { ...(previous.result as Record<string, unknown>), deduplicated: true };
    const result = session.store.transaction(() => {
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
      });
      const payload = {
        candidate: applied.candidate as CoursewareCandidateDto,
        plan: applied.plan as ScenePlanDto | null,
        deduplicated: false,
      };
      session.store.saveCoursewareReceipt(projectId, body.requestId, 'apply', intent, payload);
      return payload;
    });
    return result;
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
