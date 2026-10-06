/**
 * 房间事件（SYNC-01 的本地链路）。
 *
 * - `GET`：按 `afterSeq` 游标取 `(afterSeq, tailSeq]` 增量，重连补齐。
 * - `POST`：追加公共事件（场景切换 / 教师输出 / 白板动作 / 成员进出）。
 *
 * 序号是房间内的权威单调序号，`expectedSeq` 做乐观并发；教师输出与场景切换
 * 只允许房主（`assertCollabTeacherEventAllowed`），白板动作允许成员。
 * 事件摘要只写「发生了什么」，不含私人答案、判分与掌握结论。
 */

import { z } from 'zod';
import { StudyError, collabEventAppendSchema } from '@sew/study-contracts';
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
  return ok(session.store.listCollaborationEvents(parsed.data.roomId, parsed.data.afterSeq), {
    headers: { 'cache-control': 'no-store' },
  });
});

export const POST = route(async (request: Request) => {
  const body = await parseBody(request, collabEventAppendSchema);
  const session = requireCollabSession(request);
  if (body.actorUid !== session.learnerUid) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'collab_identity_mismatch' });
  }
  return ok(
    session.store.appendCollaborationEvent({
      roomId: body.roomId,
      eventId: body.eventId,
      kind: body.kind,
      actorUid: session.learnerUid,
      summary: body.summary,
      expectedSeq: body.expectedSeq,
      requestId: body.requestId,
    }),
  );
});
