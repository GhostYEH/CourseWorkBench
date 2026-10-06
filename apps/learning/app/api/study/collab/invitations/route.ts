/**
 * 邀请生命周期（INVITE-01 的本地链路）。
 *
 * - `GET`：列出与本人相关的邀请（本人发起或本人受邀）。
 * - `POST`：`invite` / `decide` / `revoke` 三种动作。
 *
 * 身份由服务端会话绑定：请求体里的 `inviterUid`/`actorUid` 必须等于会话 UID，
 * 否则拒绝。这样「知道别人 UID」不能用来替别人发邀请或替别人表态。
 * 在线联调（真实双设备）仍由独立协作服务承担，见 ADR-0004。
 */

import { z } from 'zod';
import { StudyError, collabInvitationCommandSchema } from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../../lib/server/http';
import { requireCollabSession } from '../../../../../lib/server/collaboration-access';

export const dynamic = 'force-dynamic';

const querySchema = z.object({ roomId: z.string().min(1).max(200).optional() }).strict();

export const GET = route((request: Request) => {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) throw new StudyError('INVALID_ARGUMENT');
  const session = requireCollabSession(request);
  const invitations = session.store.listCollaborationInvitations(session.learnerUid);
  // 可选按房间过滤：房间视图需要「这个房间的邀请」而不是全部历史。
  const filtered = parsed.data.roomId
    ? invitations.filter((invitation) => invitation.roomId === parsed.data.roomId)
    : invitations;
  return ok({ invitations: filtered, member: null }, { headers: { 'cache-control': 'no-store' } });
});

export const POST = route(async (request: Request) => {
  const body = await parseBody(request, collabInvitationCommandSchema);
  const session = requireCollabSession(request);
  const uid = session.learnerUid;
  if (body.action === 'invite') {
    if (body.inviterUid !== uid) {
      throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'collab_identity_mismatch' });
    }
    return ok(
      session.store.inviteCollaborator({
        roomId: body.roomId,
        inviterUid: uid,
        inviteeUid: body.inviteeUid,
        lessonId: body.lessonId,
        lessonVersion: body.lessonVersion,
        snapshotDigest: body.snapshotDigest,
        requestId: body.requestId,
      }),
    );
  }
  if (body.actorUid !== uid) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'collab_identity_mismatch' });
  }
  if (body.action === 'decide') {
    return ok(
      session.store.decideCollaborationInvitation({
        invitationId: body.invitationId,
        actorUid: uid,
        decision: body.decision,
        requestId: body.requestId,
      }),
    );
  }
  return ok(
    session.store.revokeCollaborationInvitation({
      invitationId: body.invitationId,
      actorUid: uid,
      requestId: body.requestId,
    }),
  );
});
