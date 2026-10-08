/**
 * 独立协作服务的 HTTP 边界（ADR-0005）。
 *
 * 只做四件事：解析请求、按会话令牌取本人 UID、把请求体交给存储层、按统一信封返回。
 * 业务判定一律在 `@sew/study-domain` 与存储层，路由不自行决定「能不能认证」。
 *
 * 安全口径：
 * - 认证由可验证凭据证明本人；除登记与认证外，所有命令都要求 `Authorization: Bearer`，
 *   身份取自会话，**不接受**请求体自报 UID（请求体里的 uid 必须与会话一致）。
 * - 错误信息不泄露凭据、绝对路径或内部堆栈；凭据 secret 永不回显。
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  StudyError,
  toErrorPayload,
  COLLAB_PROTOCOL_VERSION,
  collabOnlineRegisterCommandSchema,
  collabSessionCommandSchema,
  collabCredentialRevokeCommandSchema,
  collabSceneSyncCommandSchema,
  collabSnapshotUploadSchema,
  collabInvitationCommandSchema,
  collabRegistrationCommandSchema,
  collabRoomCreateCommandSchema,
  collabRoomStartCommandSchema,
  collabMemberReadinessCommandSchema,
  collabMessageAppendSchema,
  collabEventAppendSchema,
  collabTeachingCommandSchema,
  collabTeachingAiCommandSchema,
  type StudyErrorCode,
  type StudyErrorPayload,
} from '@sew/study-contracts';
import type { CollabServiceStore } from '@sew/study-storage';
import { decodeJson } from '@sew/study-storage';

export interface SessionToken {
  token: string;
  uid: string;
  credentialId: string;
  expiresAt: string;
}

export interface CollabServiceContext {
  store: CollabServiceStore;
  protocolVersion: number;
  instanceId: string;
  dev: boolean;
  /** 会话令牌 → 会话。进程内内存态：重启后凭据仍在，但需要重新认证。 */
  sessions: Map<string, SessionToken>;
  now(): number;
}

export interface JsonResponse {
  status: number;
  body: unknown;
}

const HTTP_STATUS: Partial<Record<StudyErrorCode, number>> = {
  PROJECT_NOT_AUTHORIZED: 403,
  PROJECT_GENERATION_STALE: 409,
  VERSION_CONFLICT: 409,
  RUN_TERMINATED: 409,
  NOT_FOUND: 404,
  INVALID_ARGUMENT: 400,
  ROLE_PERMISSION_DENIED: 403,
  INTERNAL: 500,
};

export const ok = (data: unknown): JsonResponse => ({ status: 200, body: { ok: true, data } });

export const fail = (error: unknown): JsonResponse => {
  const payload: StudyErrorPayload = toErrorPayload(error);
  // 服务日志保留原始失败用于诊断，但**不**把凭据或路径带出去。
  if (payload.code === 'INTERNAL') console.error('[collab-service] request failed', error);
  const status = HTTP_STATUS[payload.code] ?? 400;
  return { status, body: { ok: false, error: payload } };
};

const parseJson = (text: string): unknown => {
  const decoded = decodeJson(text, z.unknown(), null, 'collab.request_body');
  if (!decoded.ok) throw new StudyError('INVALID_ARGUMENT', { reason: 'invalid_json' });
  return decoded.value;
};

const validate = <T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  value: unknown,
): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data === undefined) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_input_invalid' });
  }
  return parsed.data;
};

const SESSION_TTL_MS = 12 * 3600 * 1000;

/**
 * 房间命令联合：单条 POST 按 `action` 分派（建房/开始/改准备状态）。
 *
 * 与本地学习服务路由同源——复用 `collabRoom*CommandSchema` 的字段，只补 `action`
 * 判别字段；`assertClaimed` 再保证请求体自报 UID 与会话一致。
 */
const roomCommandSchema = z.discriminatedUnion('action', [
  collabRoomCreateCommandSchema.extend({ action: z.literal('create') }),
  collabRoomStartCommandSchema.extend({ action: z.literal('start') }),
  collabMemberReadinessCommandSchema.extend({ action: z.literal('readiness') }),
]);

/** 从会话令牌解析本人身份；无令牌、令牌未知或已过期一律拒绝。 */
export const requireSession = (
  context: CollabServiceContext,
  authorization: string | null,
): SessionToken => {
  const token = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : '';
  if (!token) throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'collab_session_required' });
  const session = context.sessions.get(token);
  if (!session || Date.parse(session.expiresAt) <= context.now()) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'collab_session_invalid' });
  }
  return session;
};

/** 会话身份与请求体自报 UID 必须一致：知道别人 UID 不能替其操作。 */
const assertClaimed = (session: SessionToken, claimedUid: string): void => {
  if (session.uid !== claimedUid) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'collab_identity_mismatch' });
  }
};

/**
 * 分派一条请求。
 *
 * 路由表：
 * - `GET  /health`：健康检查（无需认证）；
 * - `POST /collab/v1/register`：在线登记（凭据证明本人；无 Bearer）；
 * - `POST /collab/v1/session`：认证换令牌（无 Bearer）；
 * - `POST /collab/v1/credentials/revoke`：吊销凭据（需 Bearer）；
 * - `POST /collab/v1/registrations/read`：读本人登记（需 Bearer）；
 * - 其余命令：邀请/房间/成员/消息/事件/场景同步/快照（需 Bearer）。
 */
export const dispatch = (
  context: CollabServiceContext,
  method: string,
  pathname: string,
  search: URLSearchParams,
  authorization: string | null,
  rawBody: string | null,
  presentedProtocolVersion: string = String(COLLAB_PROTOCOL_VERSION),
): JsonResponse => {
  try {
    if (method === 'GET' && pathname === '/health') {
      return ok({
        ready: true,
        protocolVersion: context.protocolVersion,
        instanceId: context.instanceId,
        dev: context.dev,
      });
    }
    if (pathname.startsWith('/collab/v1/')) {
      if (presentedProtocolVersion !== String(context.protocolVersion)) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_protocol_mismatch' });
      }
      return dispatchCollab(context, method, pathname, search, authorization, rawBody);
    }
    throw new StudyError('NOT_FOUND', { reason: 'collab_route_unknown' });
  } catch (error) {
    return fail(error);
  }
};

const dispatchCollab = (
  context: CollabServiceContext,
  method: string,
  pathname: string,
  search: URLSearchParams,
  authorization: string | null,
  rawBody: string | null,
): JsonResponse => {
  const { store } = context;
  const body = rawBody === null ? {} : parseJson(rawBody);

  // ————————————————— 无需会话的命令 —————————————————
  if (method === 'POST' && pathname === '/collab/v1/register') {
    const command = validate(collabOnlineRegisterCommandSchema, body);
    return ok(store.registerOnline(command));
  }
  if (method === 'POST' && pathname === '/collab/v1/session') {
    const command = validate(collabSessionCommandSchema, body);
    const record = store.verifyCredential(command.credentialId, command.secret);
    if (!record) {
      throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'collab_credential_invalid' });
    }
    // 轮询每次认证都验证凭据，但复用有效会话并清理过期项，避免常驻服务无限积累令牌。
    for (const [existingToken, active] of context.sessions) {
      if (Date.parse(active.expiresAt) <= context.now()) {
        context.sessions.delete(existingToken);
      }
    }
    const existing = [...context.sessions.values()].find(
      (active) => active.credentialId === record.credentialId,
    );
    if (existing) {
      return ok({ session: { ...existing, protocolVersion: context.protocolVersion } });
    }
    // 会话令牌是后续请求的唯一持有凭证，必须是**不可猜测**的随机值：
    // credentialId 是公开句柄、requestId 由客户端生成，用它们拼令牌等于把认证绕过。
    const token = `sess_${randomBytes(32).toString('hex')}`;
    const session: SessionToken = {
      token,
      uid: record.uid,
      credentialId: record.credentialId,
      expiresAt: new Date(context.now() + SESSION_TTL_MS).toISOString(),
    };
    context.sessions.set(token, session);
    return ok({
      session: {
        token,
        uid: session.uid,
        credentialId: session.credentialId,
        protocolVersion: context.protocolVersion,
        expiresAt: session.expiresAt,
      },
    });
  }

  // ————————————————— 需要会话的命令 —————————————————
  const session = requireSession(context, authorization);

  if (method === 'POST' && pathname === '/collab/v1/credentials/revoke') {
    const command = validate(collabCredentialRevokeCommandSchema, body);
    assertClaimed(session, command.actorUid);
    const result = store.revokeCredential(command);
    // 吊销后立即失效该凭据已签发的所有会话：否则旧令牌仍能授权到过期时间。
    for (const [token, active] of context.sessions) {
      if (active.credentialId === command.credentialId) context.sessions.delete(token);
    }
    return ok(result);
  }
  if (method === 'GET' && pathname === '/collab/v1/registrations/read') {
    const registration = store.collaboration.getRegistration(session.uid);
    return ok({ registration, credentials: store.listCredentials(session.uid) });
  }
  if (method === 'POST' && pathname === '/collab/v1/registrations/update') {
    const command = validate(collabRegistrationCommandSchema, body);
    assertClaimed(session, command.uid);
    return ok(
      store.collaboration.register({
        uid: session.uid,
        displayName: command.displayName,
        requestId: command.requestId,
      }),
    );
  }
  if (method === 'POST' && pathname === '/collab/v1/invitations') {
    const command = validate(collabInvitationCommandSchema, body);
    return dispatchInvitation(context, session, command);
  }
  if (method === 'GET' && pathname === '/collab/v1/invitations') {
    const roomId = search.get('roomId');
    const invitations = store.collaboration.listInvitations(session.uid);
    return ok({
      invitations: roomId ? invitations.filter((item) => item.roomId === roomId) : invitations,
    });
  }
  if (method === 'POST' && pathname === '/collab/v1/rooms') {
    const { action, ...rest } = validate(roomCommandSchema, body);
    if (action === 'create') {
      const command = rest as z.infer<typeof collabRoomCreateCommandSchema>;
      assertClaimed(session, command.ownerUid);
      return ok(store.collaboration.createRoom({ ...command, ownerUid: session.uid }));
    }
    if (action === 'start') {
      const command = rest as z.infer<typeof collabRoomStartCommandSchema>;
      assertClaimed(session, command.actorUid);
      return ok(store.collaboration.startRoom({ ...command, actorUid: session.uid }));
    }
    const command = rest as z.infer<typeof collabMemberReadinessCommandSchema>;
    assertClaimed(session, command.uid);
    return ok(store.collaboration.setReadiness({ ...command, uid: session.uid }));
  }
  if (method === 'GET' && pathname === '/collab/v1/rooms') {
    const roomId = requireQuery(search, 'roomId');
    assertRoomMember(store, session.uid, roomId);
    return ok({
      room: store.collaboration.getRoom(roomId),
      members: store.collaboration.listMembers(roomId),
    });
  }
  if (method === 'POST' && pathname === '/collab/v1/messages') {
    const command = validate(collabMessageAppendSchema, body);
    assertClaimed(session, command.senderUid);
    return ok(
      store.collaboration.appendMessage({
        roomId: command.roomId,
        senderUid: session.uid,
        body: command.body,
        requestId: command.requestId,
      }),
    );
  }
  if (method === 'GET' && pathname === '/collab/v1/messages') {
    const roomId = requireQuery(search, 'roomId');
    assertRoomMember(store, session.uid, roomId);
    return ok(store.collaboration.listMessages(roomId, numberQuery(search, 'afterSeq')));
  }
  if (method === 'POST' && pathname === '/collab/v1/events') {
    const command = validate(collabEventAppendSchema, body);
    assertClaimed(session, command.actorUid);
    // 场景切换只能经 `/collab/v1/scene-sync` 的结构化命令推进：这里拒绝 `scene_changed`，
    // 否则会出现「事件说切了场景、房间 current_scene_id 没变」的脱节摘要。
    if (command.kind === 'scene_changed') {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_scene_requires_scene_sync' });
    }
    if (command.kind === 'teacher_output' || command.kind === 'board_action') {
      throw new StudyError('INVALID_ARGUMENT', {
        reason: 'collab_teaching_requires_structured_command',
      });
    }
    return ok(
      store.collaboration.appendEvent({
        roomId: command.roomId,
        eventId: command.eventId,
        kind: command.kind,
        actorUid: session.uid,
        summary: command.summary,
        expectedSeq: command.expectedSeq,
        requestId: command.requestId,
      }),
    );
  }
  if (method === 'GET' && pathname === '/collab/v1/events') {
    const roomId = requireQuery(search, 'roomId');
    assertRoomMember(store, session.uid, roomId);
    return ok(store.collaboration.listEvents(roomId, numberQuery(search, 'afterSeq')));
  }
  if (method === 'POST' && pathname === '/collab/v1/scene-sync') {
    const command = validate(collabSceneSyncCommandSchema, body);
    assertClaimed(session, command.actorUid);
    return ok(store.collaboration.syncScene({ ...command, actorUid: session.uid }));
  }
  if (method === 'POST' && pathname === '/collab/v1/snapshot') {
    const command = validate(collabSnapshotUploadSchema, body);
    assertClaimed(session, command.actorUid);
    return ok(store.collaboration.uploadSnapshot({ ...command, actorUid: session.uid }));
  }
  if (method === 'GET' && pathname === '/collab/v1/snapshot') {
    const roomId = requireQuery(search, 'roomId');
    assertRoomMember(store, session.uid, roomId);
    return ok(store.collaboration.snapshotView(roomId));
  }
  if (method === 'GET' && pathname === '/collab/v1/teaching') {
    const roomId = requireQuery(search, 'roomId');
    assertRoomMember(store, session.uid, roomId);
    return ok(store.collaboration.teachingView(roomId));
  }
  if (method === 'POST' && pathname === '/collab/v1/teaching') {
    const command = validate(collabTeachingCommandSchema, body);
    assertClaimed(session, command.actorUid);
    return ok(store.collaboration.applyTeaching({ ...command, actorUid: session.uid }));
  }
  if (method === 'GET' && pathname === '/collab/v1/teaching-ai') {
    const roomId = requireQuery(search, 'roomId');
    return ok(store.collaboration.teachingAiView(roomId, session.uid));
  }
  if (method === 'POST' && pathname === '/collab/v1/teaching-ai') {
    const command = validate(collabTeachingAiCommandSchema, body);
    assertClaimed(session, command.actorUid);
    if (command.operation.kind === 'record-ai-candidate') {
      throw new StudyError('INVALID_ARGUMENT', {
        reason: 'collab_ai_record_requires_controlled_gateway',
      });
    }
    return ok(store.collaboration.applyTeachingAi({ ...command, actorUid: session.uid }));
  }
  if (method === 'POST' && pathname === '/collab/v1/teaching-ai/candidates') {
    const command = validate(collabTeachingAiCommandSchema, body);
    assertClaimed(session, command.actorUid);
    if (command.operation.kind !== 'record-ai-candidate') {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_ai_candidate_ingress_only' });
    }
    // This endpoint records a pending candidate from the authenticated host gateway. The
    // independent service cannot prove an external model call; origin records that declaration.
    return ok(store.collaboration.recordTeachingAiCandidate({ ...command, actorUid: session.uid }));
  }
  throw new StudyError('NOT_FOUND', { reason: 'collab_route_unknown' });
};

const dispatchInvitation = (
  context: CollabServiceContext,
  session: SessionToken,
  command: ReturnType<typeof collabInvitationCommandSchema.parse>,
): JsonResponse => {
  const { store } = context;
  if (command.action === 'invite') {
    assertClaimed(session, command.inviterUid);
    return ok(
      store.collaboration.invite({
        roomId: command.roomId,
        inviterUid: session.uid,
        inviteeUid: command.inviteeUid,
        lessonId: command.lessonId,
        lessonVersion: command.lessonVersion,
        snapshotDigest: command.snapshotDigest,
        requestId: command.requestId,
      }),
    );
  }
  assertClaimed(session, command.actorUid);
  if (command.action === 'decide') {
    return ok(
      store.collaboration.decide({
        invitationId: command.invitationId,
        actorUid: session.uid,
        decision: command.decision,
        requestId: command.requestId,
      }),
    );
  }
  return ok(
    store.collaboration.revoke({
      invitationId: command.invitationId,
      actorUid: session.uid,
      requestId: command.requestId,
    }),
  );
};

const requireQuery = (search: URLSearchParams, key: string): string => {
  const value = search.get(key);
  if (!value) throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_query_missing', key });
  return value;
};

const numberQuery = (search: URLSearchParams, key: string): number => {
  const raw = search.get(key) ?? '0';
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_query_invalid', key });
  }
  return value;
};

/** 读取房间内容前要求是成员：房间存在时非成员不能读。 */
const assertRoomMember = (store: CollabServiceStore, uid: string, roomId: string): void => {
  if (!store.collaboration.getRoom(roomId)) return;
  const isMember = store.collaboration
    .listMembers(roomId)
    .some((member) => member.uid === uid && member.readiness !== 'left');
  if (!isMember) throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'not_room_member' });
};

export { COLLAB_PROTOCOL_VERSION };
