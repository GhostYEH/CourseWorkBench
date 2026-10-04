import { z } from 'zod';
import {
  StudyError,
  lessonBundleBuildSchema,
  lessonDraftSchema,
  lessonPublishSchema,
  lessonReviewSchema,
  lessonWithdrawSchema,
} from '@sew/study-contracts';
import { parseBody, route, ok } from '../../../../lib/server/http';
import { assertScope, requireSession } from '../../../../lib/server/service';
import { toLessonReviewDto, toLessonVersionDto } from '../../../../lib/server/dto';

export const dynamic = 'force-dynamic';

const bodySchema = z.discriminatedUnion('action', [
  lessonBundleBuildSchema,
  lessonDraftSchema,
  lessonReviewSchema,
  lessonPublishSchema,
  lessonWithdrawSchema,
]);

/** 证据包与课程版本读取；页面访问不写入任何课程事实。 */
export const GET = route(() => {
  const session = requireSession();
  const projectId = session.projectId;
  const lessons = session.store.listLessons(projectId);
  const versions = lessons.flatMap((lesson) => session.store.listLessonVersions(lesson.lessonId, projectId));
  return ok({
    bundles: session.store.listEvidenceBundles(projectId).map((row) => ({
      bundleId: row.bundleId,
      digest: row.digest,
      frozenAt: row.frozenAt,
      bundle: row.bundle,
    })),
    lessons: lessons.map(toLessonVersionDto),
    versions: versions.map(toLessonVersionDto),
    reviews: versions
      .map((version) => session.store.getLessonReview(version.lessonId, version.version, projectId))
      .filter((review): review is NonNullable<typeof review> => review !== null)
      .map(toLessonReviewDto),
    links: lessons
      .map((lesson) => session.store.getLessonClassroomLink(lesson.lessonId, projectId))
      .filter((link): link is NonNullable<typeof link> => link !== null),
  });
});

/**
 * 冻结证据包、创建课程草案版本、审核、发布或撤回课程。
 *
 * 审核与发布都复核准入：来源失效在审核入口就阻断，不等到发布才发现。
 * 发布之后的来源更新不改写已发布课程，而是让课堂入口按准入受阻。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  const session = assertScope(body.scope);
  const projectId = session.projectId;

  if (body.action === 'build-bundle') {
    const bundle = session.store.buildLessonBundle(projectId, body.statements, body.questionIds);
    return ok({ bundleId: bundle.bundleId, digest: bundle.digest, frozenAt: bundle.frozenAt, bundle: bundle.bundle });
  }

  if (body.action === 'review') {
    const review = session.store.reviewLesson({
      projectId,
      lessonId: body.lessonId,
      version: body.version,
      decision: body.decision,
      note: body.note,
    });
    return ok({ review: toLessonReviewDto(review) });
  }

  if (body.action === 'withdraw') {
    const lesson = session.store.withdrawLesson({ projectId, lessonId: body.lessonId, reason: body.reason });
    return ok({ lesson: toLessonVersionDto(lesson), link: session.store.getLessonClassroomLink(body.lessonId, projectId) });
  }

  if (body.action === 'draft') {
    const source = body.lessonId
      ? session.store.listLessonVersions(body.lessonId, projectId)[0]
      : null;
    if (body.lessonId && !source) {
      throw new StudyError('NOT_FOUND', { lessonId: body.lessonId });
    }
    const lesson = session.store.createLessonDraft({
      projectId,
      lessonId: body.lessonId,
      title: body.title,
      bundleId: body.bundleId,
      statementIds: body.statementIds,
      questionIds: body.questionIds,
    });
    return ok({ lesson: toLessonVersionDto(lesson) });
  }

  const lesson = session.store.publishLesson({
    projectId,
    lessonId: body.lessonId,
    version: body.version,
  });
  return ok({
    lesson: toLessonVersionDto(lesson),
    link: session.store.getLessonClassroomLink(body.lessonId, projectId),
  });
});
