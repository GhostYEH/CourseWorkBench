import { ok, route } from '../../../../../lib/server/http';
import { scopedRequest } from '../../../../../lib/server/scoped-request';
import { assertScope } from '../../../../../lib/server/service';
import { loadRenderableFormalDocument } from '../../../../../lib/server/classroom-service';
import { readFormalLessonImages } from '../../../../../lib/server/formal-lesson-assets';
import { StudyError } from '@sew/study-contracts';

export const dynamic = 'force-dynamic';
export const GET = route(
  async (request: Request, context: { params: Promise<{ stageId: string }> }) => {
    const { scope } = scopedRequest(request, () => new StudyError('INVALID_ARGUMENT'));
    const { stageId } = await context.params;
    const session = assertScope(scope);
    const stored = session.store.getClassroomDocument(session.projectId, stageId);
    if (!stored || stored.recordScope !== 'formal' || !stored.lessonId)
      throw new StudyError('NOT_FOUND');
    const document = loadRenderableFormalDocument(session, stored.lessonId);
    if (!document || document.stageId !== stageId) throw new StudyError('VERSION_CONFLICT');
    const ready = session.store.assertLessonClassroomReady(stored.lessonId, session.projectId);
    return ok(
      {
        stageId,
        assets: readFormalLessonImages(
          session,
          stageId,
          document.document,
          stored.lessonId,
          ready.lesson.bundleDigest,
        ),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  },
);
