/**
 * 共享房间与成员准备状态（ROOM-01 / INVITE-01 的本地链路）。
 *
 * - `GET`：读取房间与成员（房间可能尚未建立，只有邀请阶段）。
 * - `POST`：`create` 建房 / `start` 开始共同课堂 / `readiness` 改本人准备状态。
 *
 * 房间固定课程版本与快照摘要；建房命令里的 `ownerUid`、开始命令里的 `actorUid` 必须等于
 * 会话 UID。准备状态只有成员本人能改自己的，服务端按会话 UID 判定。读取房间与成员同样
 * 要求是房间成员（房间未建立时没有可读内容）。
 */

import { z } from 'zod';
import {
  StudyError,
  collabMemberReadinessCommandSchema,
  collabRoomCreateCommandSchema,
  collabRoomStartCommandSchema,
} from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../../lib/server/http';
import { requireCollabSession } from '../../../../../lib/server/collaboration-access';
import { assertCollabRoomMember } from '../../../../../lib/server/collaboration-access';

export const dynamic = 'force-dynamic';

const querySchema = z.object({ roomId: z.string().min(1).max(200) }).strict();
const bodySchema = z.discriminatedUnion('action', [
  collabRoomCreateCommandSchema.extend({ action: z.literal('create') }),
  collabRoomStartCommandSchema.extend({ action: z.literal('start') }),
  collabMemberReadinessCommandSchema.extend({ action: z.literal('readiness') }),
]);

export const GET = route((request: Request) => {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) throw new StudyError('INVALID_ARGUMENT');
  const session = requireCollabSession(request);
  // 读取也要过成员校验：房间存在时只有成员能读，避免「知道 roomId 就能读」。
  assertCollabRoomMember(session, parsed.data.roomId);
  return ok(
    {
      room: session.store.getCollaborationRoom(parsed.data.roomId),
      members: session.store.listCollaborationMembers(parsed.data.roomId),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
});

export const POST = route(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  const session = requireCollabSession(request);
  const uid = session.learnerUid;
  if (body.action === 'create') {
    if (body.ownerUid !== uid) {
      throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'collab_identity_mismatch' });
    }
    return ok(
      session.store.createCollaborationRoom({
        roomId: body.roomId,
        ownerUid: uid,
        lessonId: body.lessonId,
        lessonVersion: body.lessonVersion,
        snapshotDigest: body.snapshotDigest,
        currentSceneId: body.currentSceneId,
        requestId: body.requestId,
      }),
    );
  }
  if (body.action === 'start') {
    if (body.actorUid !== uid) {
      throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'collab_identity_mismatch' });
    }
    return ok(
      session.store.startCollaborationRoom({
        roomId: body.roomId,
        actorUid: uid,
        requestId: body.requestId,
      }),
    );
  }
  if (body.uid !== uid) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'collab_identity_mismatch' });
  }
  return ok(
    session.store.setCollaborationMemberReadiness({
      roomId: body.roomId,
      uid,
      readiness: body.readiness,
      requestId: body.requestId,
    }),
  );
});
