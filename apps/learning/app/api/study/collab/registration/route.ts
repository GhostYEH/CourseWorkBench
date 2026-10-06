/**
 * UID 登记（UID-01 的本地链路占位）。
 *
 * 这里登记的是**本机链路**：`authority` 由服务端写死为 `local_link`，
 * 界面据此仍显示「不能联网邀请」。真正的在线唯一性登记与本人认证由独立
 * 协作服务承担（ADR-0004），本轮不实现、也不冒充。
 *
 * 请求体不能自报他人 UID：登记对象由服务端会话绑定的 learnerUid 决定。
 */

import { z } from 'zod';
import { StudyError, collabRegistrationCommandSchema } from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../../lib/server/http';
import { requireCollabSession } from '../../../../../lib/server/collaboration-access';

export const dynamic = 'force-dynamic';

const querySchema = z.object({ uid: z.string().min(1).max(200).optional() }).strict();

export const GET = route((request: Request) => {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) throw new StudyError('INVALID_ARGUMENT');
  const session = requireCollabSession(request);
  // 只允许查询本人登记（缺省即本人）：别人的登记状态不是可公开枚举的信息。
  const uid = parsed.data.uid ?? session.learnerUid;
  if (uid !== session.learnerUid) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'collab_registration_other_uid' });
  }
  return ok(
    { registration: session.store.getCollaborationRegistration(uid), deduplicated: false },
    { headers: { 'cache-control': 'no-store' } },
  );
});

export const POST = route(async (request: Request) => {
  const body = await parseBody(request, collabRegistrationCommandSchema);
  const session = requireCollabSession(request);
  if (body.uid !== session.learnerUid) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'collab_identity_mismatch' });
  }
  return ok(
    session.store.registerCollaborationUid({
      uid: session.learnerUid,
      displayName: body.displayName,
      requestId: body.requestId,
    }),
  );
});
