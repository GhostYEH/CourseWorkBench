import { z } from 'zod';
import {
  StudyError,
  lessonBundleBuildSchema,
  lessonDraftSchema,
  lessonPublishSchema,
} from '@sew/study-contracts';
import { parseBody, route, ok } from '../../../../lib/server/http';
import { assertScope, requireSession } from '../../../../lib/server/service';
import { toLessonVersionDto } from '../../../../lib/server/dto';

export const dynamic = 'force-dynamic';

const bodySchema = z.discriminatedUnion('action', [
  lessonBundleBuildSchema,
  lessonDraftSchema,
  lessonPublishSchema,
]);

/** 证据包与课程版本读取；页面访问不写入任何课程事实。 */
export const GET = route(() => {
  const session = requireSession();
  const projectId = session.projectId;
  const lessons = session.store.listLessons(projectId);
  return ok({
    bundles: session.store.listEvidenceBundles(projectId).map((row) => ({
      bundleId: row.bundleId,
      digest: row.digest,
      frozenAt: row.frozenAt,
      bundle: row.bundle,
    })),
    lessons: lessons.map(toLessonVersionDto),
    versions: lessons.flatMap((lesson) => session.store.listLessonVersions(lesson.lessonId, projectId).map(toLessonVersionDto)),
    links: lessons
      .map((lesson) => session.store.getLessonClassroomLink(lesson.lessonId, projectId))
      .filter((link): link is NonNullable<typeof link> => link !== null),
  });
});

/**
 * 冻结证据包、创建课程草案版本或发布课程。
 *
 * 发布只复核准入结论；来源在此之后失效不会改写已发布课程，而是让课堂入口按准入受阻。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  const session = assertScope(body.scope);
  const projectId = session.projectId;

  if (body.action === 'build-bundle') {
    const bundle = session.store.buildLessonBundle(projectId, body.statements, body.questionIds);
    return ok({ bundleId: bundle.bundleId, digest: bundle.digest, frozenAt: bundle.frozenAt, bundle: bundle.bundle });
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
