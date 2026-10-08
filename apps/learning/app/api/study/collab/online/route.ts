/**
 * 在线协作的受控客户端入口（ADR-0005）。
 *
 * - `GET`：读取在线视图（连接/认证状态、本人登记、邀请、当前房间、消息与事件）。
 * - `POST`：执行一条在线命令（开通身份、吊销凭据、邀请、准备、开始、发言、场景同步、
 *   发布共享快照），命令结论与刷新后的在线视图一起返回。
 *
 * 身份一律由本地会话绑定：界面不自报 UID；场景命令的课程身份与共享快照的载荷由本地
 * 服务补齐/读出，不信任界面提交。在线不可用或未认证时视图明确标出原因，界面据此继续
 * 显示「不能联网邀请」，不把失败说成成功。
 */

import { z } from 'zod';
import {
  StudyError,
  collabOnlineCommandSchema,
  type CollabOnlineCommand,
} from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../../lib/server/http';
import { requireCollabSession } from '../../../../../lib/server/collaboration-access';
import {
  enableOnlineIdentity,
  readOnlineView,
  revokeOnlineCredential,
  runOnlineCommand,
} from '../../../../../lib/server/collab-online-service';
import {
  prepareOnlineCommand,
  confirmOnlineCommand,
} from '../../../../../lib/server/collab-command-outbox';

export const dynamic = 'force-dynamic';

const querySchema = z
  .object({
    roomId: z.string().min(1).max(200).optional(),
    messageAfterSeq: z.coerce.number().int().nonnegative().default(0),
    eventAfterSeq: z.coerce.number().int().nonnegative().default(0),
  })
  .strict();

export const GET = route(async (request: Request) => {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) throw new StudyError('INVALID_ARGUMENT');
  const session = requireCollabSession(request);
  const view = await readOnlineView(session, {
    roomId: parsed.data.roomId ?? null,
    messageAfterSeq: parsed.data.messageAfterSeq,
    eventAfterSeq: parsed.data.eventAfterSeq,
  });
  return ok({ view }, { headers: { 'cache-control': 'no-store' } });
});

/** 命令结果里可能带 `deduplicated`：读回既有结果时提示「没有重复写入」。 */
const deduplicatedOf = (result: unknown): boolean =>
  typeof result === 'object' &&
  result !== null &&
  'deduplicated' in result &&
  Boolean((result as { deduplicated: unknown }).deduplicated);

export const POST = route(async (request: Request) => {
  const input = await parseBody(request, collabOnlineCommandSchema);
  const session = requireCollabSession(request);
  const body = prepareOnlineCommand(session, input);
  let result: unknown;
  const roomId: string | null = 'roomId' in body ? body.roomId : null;
  try {
    if (body.action === 'enable') {
      result = await enableOnlineIdentity(session, body.requestId);
    } else if (body.action === 'revoke-credential') {
      result = await revokeOnlineCredential(session, body.requestId);
    } else {
      result = await runOnlineCommand(session, body as CollabOnlineCommand, request.signal);
    }
  } catch (error) {
    // Sequence/revision rejection proves no side effect; a fresh scene intent may use the refreshed state.
    if (
      error instanceof StudyError &&
      ['collab_event_seq_mismatch', 'collab_room_revision_mismatch'].includes(
        String(error.details?.['reason']),
      )
    ) {
      confirmOnlineCommand(session, body.requestId);
    }
    throw error;
  }
  const view = await readOnlineView(session, { roomId });
  const deduplicated = deduplicatedOf(result);
  return ok({
    view,
    deduplicated,
    commandRequestId: body.requestId,
    notice: deduplicated ? '读回既有结果，没有重复写入。' : '已提交，服务端结论已读回。',
  });
});
