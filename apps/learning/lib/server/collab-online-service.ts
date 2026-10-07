/**
 * 本地服务作为**受控客户端**连接独立协作服务（ADR-0005）。
 *
 * 分工：
 * - 共享房间/邀请/成员/消息/事件的权威在独立协作服务；
 * - 个人草稿/答案/判分/错题/掌握/材料库留在本地；
 * - 本模块只做「按本地会话绑定身份 → 带凭据/令牌转发命令 → 读回在线视图」，
 *   不自行决定「能不能邀请」（判定在协作服务与领域层）。
 *
 * 凭据只经 `collab-credential-store` 读写的受控边界；渲染层永远拿不到 secret。
 * 只有真实连接与本人认证都成功，视图才把 `online.authenticated` 置为 true，
 * 界面据此才开放在线能力；否则继续显示「不能联网邀请」。
 */

import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  StudyError,
  COLLAB_PROTOCOL_VERSION,
  collabHealthSchema,
  collabCredentialSchema,
  collabRegistrationSchema,
  collabOnlineRegistrationSchema,
  collabRoomSchema,
  collabRoomMemberSchema,
  collabMessageSchema,
  collabEventSchema,
  collabSnapshotViewSchema,
  collabTeachingViewSchema,
  classroomInvitationSchema,
  apiResponses,
  type ClassroomSharedCourseDto,
  type CollabOnlineCommand,
  type CollabOnlineRegistrationDto,
  type CollabOnlineViewDto,
} from '@sew/study-contracts';
import type { Session } from './service';
import { getLearnerProfile } from './learner-profile';
import { readFormalInteractionDefinitions } from './formal-interaction-definition-store';
import {
  clearCollabCredential,
  readCollabCredential,
  writeCollabCredential,
} from './collab-credential-store';
import {
  collabErrorReason,
  collabFetch,
  describeCollabError,
  resolveCollabServiceUrl,
} from './collab-online-client';

const roomViewSchema = z
  .object({ room: collabRoomSchema.nullable(), members: z.array(collabRoomMemberSchema) })
  .strict();
const messagesSchema = z
  .object({ messages: z.array(collabMessageSchema), tailSeq: z.number().int().nonnegative() })
  .strict();
const eventsSchema = z
  .object({ events: z.array(collabEventSchema), tailSeq: z.number().int().nonnegative() })
  .strict();
const invitationsSchema = z.object({ invitations: z.array(classroomInvitationSchema) }).strict();
const registrationsReadSchema = z
  .object({
    registration: collabRegistrationSchema.nullable(),
    credentials: z.array(collabCredentialSchema),
  })
  .strict();
const sessionResultSchema = z
  .object({ session: z.object({ token: z.string().min(1) }).passthrough() })
  .passthrough();

const onlineError = (reason: string, message: string): StudyError =>
  new StudyError('PROJECT_NOT_AUTHORIZED', { reason }, message);

const requireBaseUrl = (): string => {
  const baseUrl = resolveCollabServiceUrl();
  if (!baseUrl) {
    throw onlineError('collab_not_configured', '尚未配置在线协作服务地址，不能联网邀请或同步。');
  }
  return baseUrl;
};

const requireCredential = () => {
  const credential = readCollabCredential();
  if (!credential) {
    throw onlineError('collab_not_registered', '尚未在本机开通在线身份，请先开通在线能力。');
  }
  return credential;
};

/** 用本人凭据换取协作服务会话令牌。令牌只在内存使用，不落盘、不回显。 */
const authenticate = async (
  baseUrl: string,
  credential: { credentialId: string; secret: string },
): Promise<string> => {
  const result = await collabFetch(
    baseUrl,
    {
      method: 'POST',
      path: '/collab/v1/session',
      body: {
        credentialId: credential.credentialId,
        secret: credential.secret,
        requestId: `sess_${randomBytes(8).toString('hex')}`,
      },
    },
    sessionResultSchema,
  );
  return result.session.token;
};

/** 读取本人在线登记并补上公开句柄（登记记录本身不含 credentialId）。 */
const readRegistration = async (
  baseUrl: string,
  token: string,
  credentialId: string,
): Promise<CollabOnlineRegistrationDto | null> => {
  const read = await collabFetch(
    baseUrl,
    { method: 'GET', path: '/collab/v1/registrations/read', token },
    registrationsReadSchema,
  );
  if (!read.registration) return null;
  return collabOnlineRegistrationSchema.parse({ ...read.registration, credentialId });
};

const emptyView = (online: CollabOnlineViewDto['online']): CollabOnlineViewDto => ({
  online,
  invitations: [],
  room: null,
  members: [],
  messages: { messages: [], tailSeq: 0 },
  events: { events: [], tailSeq: 0 },
  snapshot: null,
  teaching: null,
});

/**
 * 读取在线视图：健康检查 → 本人认证 → 读取登记/邀请/房间/消息/事件/快照。
 *
 * 任一步失败都不伪报成功：`online.authenticated` 为 false 时界面继续显示
 * 「不能联网邀请」，`online.error` 给出可读原因。
 */
export const readOnlineView = async (
  session: Session,
  options: { roomId?: string | null; messageAfterSeq?: number; eventAfterSeq?: number } = {},
): Promise<CollabOnlineViewDto> => {
  const baseUrl = resolveCollabServiceUrl();
  if (!baseUrl) {
    return emptyView({
      configured: false,
      connected: false,
      authenticated: false,
      protocolVersion: null,
      registration: null,
      error: '未配置在线协作服务地址（SEW_COLLAB_SERVICE_URL）。',
    });
  }
  let health;
  try {
    health = await collabFetch(baseUrl, { method: 'GET', path: '/health' }, collabHealthSchema);
  } catch (error) {
    return emptyView({
      configured: true,
      connected: false,
      authenticated: false,
      protocolVersion: null,
      registration: null,
      error: describeCollabError(error),
    });
  }
  if (health.protocolVersion !== COLLAB_PROTOCOL_VERSION) {
    return emptyView({
      configured: true,
      connected: true,
      authenticated: false,
      protocolVersion: health.protocolVersion,
      registration: null,
      error: `协作服务协议版本不一致（服务 ${health.protocolVersion}，本机 ${COLLAB_PROTOCOL_VERSION}）。`,
    });
  }
  const credential = readCollabCredential();
  if (!credential) {
    return emptyView({
      configured: true,
      connected: true,
      authenticated: false,
      protocolVersion: health.protocolVersion,
      registration: null,
      error: '尚未在本机开通在线身份。',
    });
  }
  let token: string;
  try {
    token = await authenticate(baseUrl, credential);
  } catch (error) {
    return emptyView({
      configured: true,
      connected: true,
      authenticated: false,
      protocolVersion: health.protocolVersion,
      registration: null,
      error: describeCollabError(error),
    });
  }
  const online: CollabOnlineViewDto['online'] = {
    configured: true,
    connected: true,
    authenticated: true,
    protocolVersion: health.protocolVersion,
    registration: await readRegistration(baseUrl, token, credential.credentialId),
    error: null,
  };
  // 在线登记必须属于当前本地会话本人：否则说明本机凭据指向了另一个身份，
  // 明确失败而不是把别人的在线状态显示成本人的。
  if (!online.registration || online.registration.uid !== session.learnerUid) {
    return emptyView({
      configured: true,
      connected: true,
      authenticated: false,
      protocolVersion: health.protocolVersion,
      registration: null,
      error: '本机在线凭据与当前身份不一致，请在协作服务重新登记。',
    });
  }
  if (credential.pendingRegistration) {
    if (
      credential.pendingRegistration.baseUrl !== baseUrl ||
      credential.pendingRegistration.uid !== session.learnerUid
    ) {
      return emptyView({
        ...online,
        authenticated: false,
        registration: null,
        error: '未确认的在线登记与当前身份或服务不一致。',
      });
    }
    // 认证和权威登记已证明初次写入成功，即使原响应丢失也可结束受控恢复记录。
    writeCollabCredential({
      fileVersion: 1,
      credentialId: credential.credentialId,
      secret: credential.secret,
    });
  }
  const invitations = (
    await collabFetch(
      baseUrl,
      { method: 'GET', path: '/collab/v1/invitations', token },
      invitationsSchema,
    )
  ).invitations;
  const view = emptyView(online);
  view.invitations = invitations;
  const roomId = options.roomId ?? null;
  if (!roomId) return view;
  // 房间读取是尽力而为：尚未成为成员（如刚发出邀请、对方还没接受）时读不到房间内容，
  // 这不是连接/认证失败，视图应正常返回邀请列表而不是整体报错。
  let roomView;
  try {
    roomView = await collabFetch(
      baseUrl,
      { method: 'GET', path: '/collab/v1/rooms', query: { roomId }, token },
      roomViewSchema,
    );
  } catch (error) {
    if (collabErrorReason(error) !== 'not_room_member') {
      view.online.error = describeCollabError(error);
      if (collabErrorReason(error) === 'collab_unreachable') view.online.connected = false;
    }
    return view;
  }
  view.room = roomView.room;
  view.members = roomView.members;
  if (!roomView.room) return view;
  try {
    const [messages, events, snapshot, teaching] = await Promise.all([
      collabFetch(
        baseUrl,
        {
          method: 'GET',
          path: '/collab/v1/messages',
          query: { roomId, afterSeq: options.messageAfterSeq ?? 0 },
          token,
        },
        messagesSchema,
      ),
      collabFetch(
        baseUrl,
        {
          method: 'GET',
          path: '/collab/v1/events',
          query: { roomId, afterSeq: options.eventAfterSeq ?? 0 },
          token,
        },
        eventsSchema,
      ),
      collabFetch(
        baseUrl,
        { method: 'GET', path: '/collab/v1/snapshot', query: { roomId }, token },
        collabSnapshotViewSchema,
      ),
      collabFetch(
        baseUrl,
        { method: 'GET', path: '/collab/v1/teaching', query: { roomId }, token },
        collabTeachingViewSchema,
      ),
    ]);
    view.messages = messages;
    view.events = events;
    view.snapshot = snapshot;
    view.teaching = teaching;
  } catch (error) {
    view.online.error = describeCollabError(error);
    if (collabErrorReason(error) === 'collab_unreachable') view.online.connected = false;
  }
  return view;
};

/**
 * 开通在线身份：首次登记生成新凭据；已有凭据则验证后读回既有登记。
 *
 * 凭据已失效（吊销/未知）时**不**自动重登记——无法凭失效凭据证明归属，
 * 按「无法验证归属的恢复不开放」明确失败。
 */
export const enableOnlineIdentity = async (
  session: Session,
  requestId: string,
): Promise<{
  registration: CollabOnlineRegistrationDto;
  credential: z.infer<typeof collabCredentialSchema>;
  deduplicated: boolean;
}> => {
  const baseUrl = requireBaseUrl();
  const existing = readCollabCredential();
  if (existing && !existing.pendingRegistration) {
    try {
      const token = await authenticate(baseUrl, existing);
      const registration = await readRegistration(baseUrl, token, existing.credentialId);
      if (!registration)
        throw onlineError('collab_registration_missing', '在线登记缺失，请重新开通。');
      if (registration.uid !== session.learnerUid) {
        throw onlineError('collab_identity_mismatch', '本机在线凭据与当前身份不一致。');
      }
      return {
        registration,
        credential: {
          credentialId: existing.credentialId,
          uid: session.learnerUid,
          status: 'active',
          createdAt: new Date().toISOString(),
          revokedAt: null,
        },
        deduplicated: true,
      };
    } catch (error) {
      const reason = collabErrorReason(error);
      if (reason === 'collab_credential_invalid' || reason === 'collab_credential_unknown') {
        throw onlineError(
          'collab_credential_revoked',
          '本机在线凭据已失效，无法自动恢复；请在协作服务重新登记后再开通。',
        );
      }
      throw error;
    }
  }
  // 发送前保存完整登记意图。响应丢失或进程重启后仍以相同凭据和 requestId 重试。
  const activationToken = process.env.SEW_COLLAB_ENROLLMENT_TOKEN?.trim();
  if (!existing && !activationToken?.match(/^[a-f0-9]{64}$/)) {
    throw onlineError(
      'collab_enrollment_required',
      '尚未配置本人的在线激活令牌，请向协作服务管理员获取。',
    );
  }
  const candidate = existing ?? {
    fileVersion: 1 as const,
    credentialId: `cred_${randomBytes(12).toString('hex')}`,
    secret: randomBytes(32).toString('hex'),
    pendingRegistration: {
      uid: session.learnerUid,
      displayName: getLearnerProfile().displayName,
      requestId,
      baseUrl,
      activationToken: activationToken!,
    },
  };
  const pending = candidate.pendingRegistration;
  if (!pending || pending.uid !== session.learnerUid || pending.baseUrl !== baseUrl) {
    throw onlineError('collab_identity_mismatch', '未确认的在线登记与当前身份或服务不一致。');
  }
  writeCollabCredential(candidate);
  const { credentialId, secret } = candidate;
  const result = await collabFetch(
    baseUrl,
    {
      method: 'POST',
      path: '/collab/v1/register',
      body: {
        uid: pending.uid,
        displayName: pending.displayName,
        credentialId,
        secret,
        proof: null,
        activationToken: pending.activationToken,
        requestId: pending.requestId,
      },
    },
    z
      .object({
        registration: collabOnlineRegistrationSchema,
        credential: collabCredentialSchema,
        deduplicated: z.boolean(),
      })
      .strict(),
  );
  writeCollabCredential({ fileVersion: 1, credentialId, secret });
  return result;
};

/** 吊销在线凭据：先请协作服务吊销，再清除本地凭据副本。 */
export const revokeOnlineCredential = async (
  session: Session,
  requestId: string,
): Promise<{ credential: z.infer<typeof collabCredentialSchema>; deduplicated: boolean }> => {
  const baseUrl = requireBaseUrl();
  const credential = requireCredential();
  const token = await authenticate(baseUrl, credential);
  await assertLocalIdentity(session, baseUrl, token, credential.credentialId);
  const result = await collabFetch(
    baseUrl,
    {
      method: 'POST',
      path: '/collab/v1/credentials/revoke',
      token,
      body: { credentialId: credential.credentialId, actorUid: session.learnerUid, requestId },
    },
    apiResponses.collabCredentialRevoke,
  );
  clearCollabCredential();
  return result;
};

/**
 * 执行一条在线命令。
 *
 * 本人 UID 由本地会话绑定，不取自界面；场景命令的课程身份从在线房间读出；
 * `publish-snapshot` 的公共投影由本地冻结课程读出（不信任界面提交的载荷）。
 */
export const runOnlineCommand = async (
  session: Session,
  command: CollabOnlineCommand,
): Promise<unknown> => {
  const baseUrl = requireBaseUrl();
  const credential = requireCredential();
  const token = await authenticate(baseUrl, credential);
  await assertLocalIdentity(session, baseUrl, token, credential.credentialId);
  const uid = session.learnerUid;

  switch (command.action) {
    case 'teaching':
      return collabFetch(
        baseUrl,
        {
          method: 'POST',
          path: '/collab/v1/teaching',
          token,
          body: {
            roomId: command.roomId,
            actorUid: uid,
            sceneId: command.sceneId,
            expectedRevision: command.expectedRevision,
            expectedSeq: command.expectedSeq,
            eventId: command.eventId,
            requestId: command.requestId,
            operation: command.operation,
          },
        },
        apiResponses.collabTeaching,
      );
    case 'invite': {
      const snapshot = freezeLocalSnapshot(
        session,
        uid,
        command.lessonId,
        command.lessonVersion,
        command.requestId,
      );
      if (snapshot.course.documentDigest !== command.snapshotDigest) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_snapshot_mismatch' });
      }
      // 创建、发布、邀请分别持有稳定收据；任何一步丢响应均可从原意图继续。
      await collabFetch(
        baseUrl,
        {
          method: 'POST',
          path: '/collab/v1/rooms',
          token,
          body: {
            action: 'create',
            roomId: command.roomId,
            ownerUid: uid,
            lessonId: command.lessonId,
            lessonVersion: command.lessonVersion,
            snapshotDigest: command.snapshotDigest,
            currentSceneId: [...snapshot.scenes].sort((a, b) => a.order - b.order)[0]!.sceneId,
            requestId: childRequestId(command.requestId, 'room'),
          },
        },
        apiResponses.collabRoom,
      );
      await collabFetch(
        baseUrl,
        {
          method: 'POST',
          path: '/collab/v1/snapshot',
          token,
          body: {
            roomId: command.roomId,
            actorUid: uid,
            snapshot,
            snapshotDigest: command.snapshotDigest,
            requestId: childRequestId(command.requestId, 'snapshot'),
          },
        },
        apiResponses.collabSnapshotUpload,
      );
      return collabFetch(
        baseUrl,
        {
          method: 'POST',
          path: '/collab/v1/invitations',
          token,
          body: {
            action: 'invite',
            roomId: command.roomId,
            inviterUid: uid,
            inviteeUid: command.inviteeUid,
            lessonId: command.lessonId,
            lessonVersion: command.lessonVersion,
            snapshotDigest: command.snapshotDigest,
            requestId: command.requestId,
          },
        },
        apiResponses.collabInvitationWrite,
      );
    }
    case 'decide':
      return collabFetch(
        baseUrl,
        {
          method: 'POST',
          path: '/collab/v1/invitations',
          token,
          body: {
            action: 'decide',
            invitationId: command.invitationId,
            actorUid: uid,
            decision: command.decision,
            requestId: command.requestId,
          },
        },
        apiResponses.collabInvitationWrite,
      );
    case 'revoke':
      return collabFetch(
        baseUrl,
        {
          method: 'POST',
          path: '/collab/v1/invitations',
          token,
          body: {
            action: 'revoke',
            invitationId: command.invitationId,
            actorUid: uid,
            requestId: command.requestId,
          },
        },
        apiResponses.collabInvitationWrite,
      );
    case 'readiness':
      return collabFetch(
        baseUrl,
        {
          method: 'POST',
          path: '/collab/v1/rooms',
          token,
          body: {
            action: 'readiness',
            roomId: command.roomId,
            uid,
            readiness: command.readiness,
            requestId: command.requestId,
          },
        },
        apiResponses.collabMemberWrite,
      );
    case 'start':
      return collabFetch(
        baseUrl,
        {
          method: 'POST',
          path: '/collab/v1/rooms',
          token,
          body: {
            action: 'start',
            roomId: command.roomId,
            actorUid: uid,
            requestId: command.requestId,
          },
        },
        apiResponses.collabRoom,
      );
    case 'message':
      return collabFetch(
        baseUrl,
        {
          method: 'POST',
          path: '/collab/v1/messages',
          token,
          body: {
            roomId: command.roomId,
            senderUid: uid,
            senderType: 'human_learner',
            body: command.body,
            requestId: command.requestId,
          },
        },
        apiResponses.collabMessageWrite,
      );
    case 'scene': {
      const room = await readRemoteRoom(baseUrl, token, command.roomId);
      if (!room) throw new StudyError('NOT_FOUND', { reason: 'collab_room_missing' });
      return collabFetch(
        baseUrl,
        {
          method: 'POST',
          path: '/collab/v1/scene-sync',
          token,
          body: {
            roomId: command.roomId,
            actorUid: uid,
            sceneId: command.sceneId,
            lessonId: room.course.lessonId,
            lessonVersion: room.course.lessonVersion,
            expectedRevision: command.expectedRevision,
            expectedSeq: command.expectedSeq,
            eventId: command.eventId,
            requestId: command.requestId,
          },
        },
        apiResponses.collabSceneSync,
      );
    }
    case 'publish-snapshot':
      return publishSnapshot(session, baseUrl, token, uid, command.roomId, command.requestId);
    default:
      throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_online_action_unknown' });
  }
};

const readRemoteRoom = async (baseUrl: string, token: string, roomId: string) => {
  const view = await collabFetch(
    baseUrl,
    { method: 'GET', path: '/collab/v1/rooms', query: { roomId }, token },
    roomViewSchema,
  );
  return view.room;
};

const childRequestId = (requestId: string, step: string): string =>
  `online-${step}:${createHash('sha256').update(requestId).digest('hex')}`;

const assertLocalIdentity = async (
  session: Session,
  baseUrl: string,
  token: string,
  credentialId: string,
): Promise<void> => {
  const registration = await readRegistration(baseUrl, token, credentialId);
  if (!registration || registration.uid !== session.learnerUid) {
    throw onlineError('collab_identity_mismatch', '本机在线凭据与当前身份不一致。');
  }
};

const freezeLocalSnapshot = (
  session: Session,
  uid: string,
  lessonId: string,
  lessonVersion: number,
  requestId: string,
): ClassroomSharedCourseDto => {
  const local = session.store
    .listLocalClassroomRooms(session.projectId, uid)
    .find(
      (item) => item.course.lessonId === lessonId && item.course.lessonVersion === lessonVersion,
    );
  const localRoomId =
    local?.roomId ??
    session.store.createLocalClassroomRoom(
      {
        projectId: session.projectId,
        lessonId,
        lessonVersion,
        requestId: childRequestId(requestId, 'local-room'),
      },
      uid,
      {
        interactionDefinitions:
          readFormalInteractionDefinitions(session, lessonId, lessonVersion)?.frozen ?? null,
      },
    ).room.roomId;
  return session.store.readClassroomRoomSnapshot(session.projectId, localRoomId, uid);
};

/**
 * 发布共享快照：从本地冻结课程读出公共投影并上传到在线房间。
 *
 * 复验本地投影的课程身份与在线房间冻结的一致后才上传，避免把另一版/另一节课的
 * 投影塞进房间。本地没有对应房间时按与建房相同的冻结路径补建一个本地房间。
 */
const publishSnapshot = async (
  session: Session,
  baseUrl: string,
  token: string,
  uid: string,
  roomId: string,
  requestId: string,
): Promise<unknown> => {
  const room = await readRemoteRoom(baseUrl, token, roomId);
  if (!room) throw new StudyError('NOT_FOUND', { reason: 'collab_room_missing' });
  const { lessonId, lessonVersion } = room.course;
  const snapshot = freezeLocalSnapshot(session, uid, lessonId, lessonVersion, requestId);
  if (
    snapshot.course.lessonId !== room.course.lessonId ||
    snapshot.course.lessonVersion !== room.course.lessonVersion ||
    snapshot.course.documentDigest !== room.course.snapshotDigest
  ) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_snapshot_mismatch' });
  }
  return collabFetch(
    baseUrl,
    {
      method: 'POST',
      path: '/collab/v1/snapshot',
      token,
      body: {
        roomId,
        actorUid: uid,
        snapshot,
        snapshotDigest: snapshot.course.documentDigest,
        requestId,
      },
    },
    apiResponses.collabSnapshotUpload,
  );
};
