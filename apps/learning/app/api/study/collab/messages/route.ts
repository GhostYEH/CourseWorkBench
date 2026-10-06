/**
 * 课内消息（CHAT-01 的本地链路）。
 *
 * - `GET`：按 `afterSeq` 游标取 `(afterSeq, tailSeq]` 增量，重连据此补齐。
 * - `POST`：追加一条真人消息；身份由会话绑定，AI 同学与教师不经此入口。
 *
 * 消息不更新知识与掌握：这里只负责权威存放、去重与读回。
 */

import { z } from 'zod';
import { StudyError, collabMessageAppendSchema } from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../../lib/server/http';
import { requireCollabSession } from '../../../../../lib/server/collaboration-access';
import { assertCollabRoomMember } from '../../../../../lib/server/collaboration-access';

export const dynamic = 'force-dynamic';

const querySchema = z
  .object({
    roomId: z.string().min(1).max(200),
    afterSeq: z.coerce.number().int().nonnegative().default(0),
  })
  .strict();

export const GET = route((request: Request) => {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) throw new StudyError('INVALID_ARGUMENT');
  const session = requireCollabSession(request);
  // 读取也要过成员校验：房间存在时只有成员能读，避免「知道 roomId 就能读」。
  assertCollabRoomMember(session, parsed.data.roomId);
  return ok(session.store.listCollaborationMessages(parsed.data.roomId, parsed.data.afterSeq), {
    headers: { 'cache-control': 'no-store' },
  });
});

export const POST = route(async (request: Request) => {
  const body = await parseBody(request, collabMessageAppendSchema);
  const session = requireCollabSession(request);
  if (body.senderUid !== session.learnerUid) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'collab_identity_mismatch' });
  }
  return ok(
    session.store.appendCollaborationMessage({
      roomId: body.roomId,
      senderUid: session.learnerUid,
      body: body.body,
      requestId: body.requestId,
    }),
  );
});
