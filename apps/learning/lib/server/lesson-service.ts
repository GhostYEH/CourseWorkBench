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
  type StatementRevisionCandidateDto,
} from '@sew/study-contracts';
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
]);

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
