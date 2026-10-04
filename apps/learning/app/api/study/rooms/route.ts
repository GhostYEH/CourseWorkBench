import { z } from 'zod';
import { StudyError, classroomRoomCreateSchema, classroomRoomCommandSchema } from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../lib/server/http';
import { assertScope } from '../../../../lib/server/service';
import { abortActiveModelCalls } from '../../../../lib/server/model-call';
import { readFormalInteractionDefinitions } from '../../../../lib/server/formal-interaction-definition-store';
import { assertRecoveryExecution } from '../../../../lib/server/classroom-recovery-guard';

export const dynamic = 'force-dynamic';
const querySchema = z.object({ projectId: z.string().min(1), generation: z.coerce.number().int().positive(), roomId: z.string().min(1).max(200).optional() }).strict();
export const GET = route((request: Request) => {
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) throw new StudyError('INVALID_ARGUMENT');
  const session = assertScope(query.data);
  return ok({
    rooms: session.store.listLocalClassroomRooms(session.projectId, session.learnerUid),
    snapshot: query.data.roomId ? session.store.readClassroomRoomSnapshot(session.projectId, query.data.roomId, session.learnerUid) : null,
  }, { headers: { 'cache-control': 'no-store' } });
});
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, classroomRoomCreateSchema);
  const session = assertScope(body.scope);
  // 正式互动的公开定义由这里读取（完整复验：分区编号、DSL 版本、记录摘要、证据包摘要、
  // 审核人、陈述范围）。存储层只接受这份已复验结果，不自己再读一份更弱的版本——
  // 否则共享出去的定义与本地课堂看到的可能来自两条强度不同的校验路径。
  const interactionDefinitions = readFormalInteractionDefinitions(session, body.lessonId, body.lessonVersion);
  return ok(session.store.createLocalClassroomRoom({
    projectId: session.projectId, lessonId: body.lessonId, lessonVersion: body.lessonVersion, requestId: body.requestId,
  }, session.learnerUid, { interactionDefinitions: interactionDefinitions?.frozen ?? null }));
});
export const PATCH = route(async (request: Request) => {
  const body = await parseBody(request, classroomRoomCommandSchema);
  const session = assertScope(body.scope);
  const input = { projectId: session.projectId, roomId: body.roomId, expectedRevision: body.expectedRevision, requestId: body.requestId };
  let boundSessionId: string | null = null;
  const result = session.store.transaction(() => {
    const existing = session.store.getOpenClassroomSession(session.projectId);
    const room = existing ? session.store.getClassroomRoomForSession(session.projectId, existing.sessionId, session.learnerUid) : null;
    const changed = body.action === 'scene'
      ? session.store.setClassroomRoomScene({ ...input, sceneId: body.sceneId }, session.learnerUid)
      : session.store.closeClassroomRoom(input, session.learnerUid);
    if (existing && room?.roomId === body.roomId && !changed.deduplicated) {
      boundSessionId = existing.sessionId;
      if (body.action === 'scene') {
        assertRecoveryExecution(session, existing.sessionId);
        session.store.advanceClassroomScene(session.projectId, existing.sessionId, body.sceneId, `room-scene:${body.requestId}`);
      }
      else session.store.closeClassroomSession(session.projectId, existing.sessionId, 'completed', '课堂房间已结束');
    }
    return changed;
  });
  if (boundSessionId) abortActiveModelCalls({ projectId: session.projectId, sessionId: boundSessionId, reason: '课堂房间已切换或结束' });
  return ok(result);
});
