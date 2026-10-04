import { z } from 'zod';
import { StudyError, classroomBoardCommandSchema } from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../lib/server/http';
import { assertScope } from '../../../../lib/server/service';
import { withRoomTeacher } from '../../../../lib/server/room-teacher';
import { assertRecoveryExecution } from '../../../../lib/server/classroom-recovery-guard';

export const dynamic = 'force-dynamic';
const querySchema = z.object({ projectId: z.string().min(1), generation: z.coerce.number().int().positive(), sessionId: z.string().min(1).max(200) }).strict();

export const GET = route((request: Request) => {
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) throw new StudyError('INVALID_ARGUMENT');
  const session = assertScope(query.data);
  const classroom = session.store.getClassroomSession(query.data.sessionId, session.projectId);
  if (!classroom) throw new StudyError('NOT_FOUND');
  return ok({
    state: session.store.classroomBoardState(session.projectId, classroom.sessionId),
    statementIds: session.store.classroomBoardStatementIds(session.projectId, classroom.sessionId),
    elementIds: session.store.classroomBoardElementIds(session.projectId, classroom.sessionId),
  }, { headers: { 'cache-control': 'no-store' } });
});

/** Actor and review authority are assigned by this trusted local service. */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, classroomBoardCommandSchema);
  const session = assertScope(body.scope);
  const projectId = session.projectId;
  switch (body.action) {
    case 'create':
      return ok(session.store.createClassroomBoardItem({
        projectId, lessonId: body.lessonId, lessonVersion: body.lessonVersion,
        sceneId: body.sceneId, statementIds: body.statementIds,
        content: body.content, actor: 'local_user', requestId: body.requestId,
      }));
    case 'review':
      return ok(session.store.reviewClassroomBoardItem({
        projectId, actor: 'local_user', requestId: body.requestId, itemId: body.itemId,
        expectedVersion: body.expectedVersion, decision: body.decision,
        semanticReviewed: body.semanticReviewed, note: body.note,
      }));
    case 'play': {
      const input = {
        projectId, actor: 'teacher', requestId: body.requestId, sessionId: body.sessionId,
        itemId: body.itemId, expectedVersion: body.expectedVersion, expectedSeq: body.expectedSeq,
      };
      const result = session.store.getClassroomBoardPlayReceipt(input) ?? withRoomTeacher(session, body.sessionId, () => {
        assertRecoveryExecution(session, body.sessionId);
        return session.store.playClassroomBoardItem(input);
      });
      return ok(result);
    }
  }
});
