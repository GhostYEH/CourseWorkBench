/**
 * 协作权威存储（INVITE-01 / SYNC-01 / CHAT-01，ADR-0004）。
 *
 * 这一层持有「两端共用的那份状态」：UID 登记占位、邀请生命周期、共享房间、
 * 成员准备状态、权威序号事件与课内消息。它与本地 `classroom_rooms` 的分工是：
 *
 * - 本地房间（`ClassroomRoomRepository`）＝个人运行记录与冻结课程副本；
 * - 协作房间（本文件）＝两端共用的房间状态与公共事件。
 *
 * 两者都只保存流程状态，个人草稿/答案/判分/掌握不进这里。判定一律委托
 * `@sew/study-domain` 的 `collaboration.ts`，本层不自行决定「能不能邀请」。
 *
 * 本机链路与在线协作共用这一套合同；区别只在数据由谁持有、地址由谁提供，
 * 因此本文件不出现任何网络调用，也不声称在线已通。
 */

import { z } from 'zod';
import {
  StudyError,
  classroomSharedCourseSchema,
  collabEventSchema,
  collabMessageSchema,
  collabRegistrationSchema,
  collabRoomMemberSchema,
  collabRoomSchema,
  collabText,
  COLLAB_EVENT_KINDS,
  type ClassroomSharedCourseDto,
  type CollabEventDto,
  type CollabMessageDto,
  type CollabRegistrationDto,
  type CollabRoomDto,
  type CollabRoomMemberDto,
  type CollabSnapshotViewDto,
} from '@sew/study-contracts';
import {
  assertCollabEventAppendable,
  assertCollabInvitationCreatable,
  assertCollabInvitationDecidable,
  assertCollabInvitationRevocable,
  assertCollabMessageWritable,
  assertCollabResyncCursor,
  assertCollabRoomStartable,
  assertCollabSceneSyncable,
  assertCollabSnapshotUploadable,
  assertCollabTeacherEventAllowed,
  canonicalJson,
  fingerprintOf,
  type CollabInvitationFacts,
  type CollabReadiness,
} from '@sew/study-domain';
import type { SqlDatabase } from '../driver';
import { encodeJson } from '../json-codec';
import { readRequiredJsonColumn, type Row } from './types';

/** 协作命令的动作名；与收据表 action 列同源。 */
export type CollabAction =
  | 'register'
  | 'invite'
  | 'decide'
  | 'revoke'
  | 'create-room'
  | 'start-room'
  | 'readiness'
  | 'message'
  | 'event'
  | 'sync-scene'
  | 'snapshot';

export interface RegisterInput {
  uid: string;
  displayName: string;
  requestId: string;
}
export interface InviteInput {
  roomId: string;
  inviterUid: string;
  inviteeUid: string;
  lessonId: string;
  lessonVersion: number;
  snapshotDigest: string;
  requestId: string;
  /** 由调用方按可信时钟给出，便于测试固定时间；缺省用当前时间。 */
  now?: string;
}
export interface InvitationDecisionInput {
  invitationId: string;
  actorUid: string;
  decision: 'accepted' | 'rejected';
  requestId: string;
  now?: string;
}
export interface InvitationRevokeInput {
  invitationId: string;
  actorUid: string;
  requestId: string;
  now?: string;
}
export interface CreateCollabRoomInput {
  roomId: string;
  ownerUid: string;
  lessonId: string;
  lessonVersion: number;
  snapshotDigest: string;
  currentSceneId: string;
  requestId: string;
}
export interface MemberReadinessInput {
  roomId: string;
  uid: string;
  readiness: CollabReadiness;
  requestId: string;
}
export interface StartCollabRoomInput {
  roomId: string;
  actorUid: string;
  requestId: string;
}
export interface AppendMessageInput {
  roomId: string;
  senderUid: string;
  body: string;
  requestId: string;
  now?: string;
}
export interface AppendEventInput {
  roomId: string;
  eventId: string;
  kind: CollabEventDto['kind'];
  actorUid: string;
  summary: string;
  expectedSeq: number;
  requestId: string;
  now?: string;
}
/**
 * 结构化场景同步（SYNC-01 在线部分）。
 *
 * 与「只有 summary 的 appendEvent」不同：这里把目标 `sceneId`、课程身份与房间
 * `revision` 一起提交，服务端复验后在**同一事务**内推进 `current_scene_id`、
 * 房间 `revision` 与 `scene_changed` 事件收据。
 */
export interface SyncSceneInput {
  roomId: string;
  actorUid: string;
  sceneId: string;
  lessonId: string;
  lessonVersion: number;
  expectedRevision: number;
  expectedSeq: number;
  eventId: string;
  /** 由调用方按可信时钟给出，便于测试固定时间；缺省用当前时间。 */
  now?: string;
  requestId: string;
}
export interface SyncSceneResult {
  room: {
    roomId: string;
    status: CollabRoomDto['status'];
    revision: number;
    currentSceneId: string;
    updatedAt: string;
  };
  event: CollabEventDto;
  deduplicated: boolean;
}

const id = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const registerSchema = z.object({ uid: id, displayName: collabText(80), requestId: id }).strict();
const inviteSchema = z
  .object({
    roomId: id,
    inviterUid: id,
    inviteeUid: id,
    lessonId: id,
    lessonVersion: z.number().int().positive(),
    snapshotDigest: digest,
    requestId: id,
    now: z.string().optional(),
  })
  .strict();
const decideSchema = z
  .object({
    invitationId: id,
    actorUid: id,
    decision: z.enum(['accepted', 'rejected']),
    requestId: id,
    now: z.string().optional(),
  })
  .strict();
const revokeSchema = z
  .object({ invitationId: id, actorUid: id, requestId: id, now: z.string().optional() })
  .strict();
const roomSchema = z
  .object({
    roomId: id,
    ownerUid: id,
    lessonId: id,
    lessonVersion: z.number().int().positive(),
    snapshotDigest: digest,
    currentSceneId: id,
    requestId: id,
  })
  .strict();
const readinessSchema = z
  .object({
    roomId: id,
    uid: id,
    readiness: z.enum(['pending', 'ready', 'left']),
    requestId: id,
  })
  .strict();
const startRoomSchema = z.object({ roomId: id, actorUid: id, requestId: id }).strict();
const messageSchema = z
  .object({
    roomId: id,
    senderUid: id,
    body: collabText(2000),
    requestId: id,
    now: z.string().optional(),
  })
  .strict();
const eventSchema = z
  .object({
    roomId: id,
    eventId: id,
    kind: z.enum(COLLAB_EVENT_KINDS),
    actorUid: id,
    summary: collabText(500),
    expectedSeq: z.number().int().positive(),
    requestId: id,
    now: z.string().optional(),
  })
  .strict();
const syncSceneSchema = z
  .object({
    roomId: id,
    actorUid: id,
    sceneId: id,
    lessonId: id,
    lessonVersion: z.number().int().positive(),
    expectedRevision: z.number().int().positive(),
    expectedSeq: z.number().int().positive(),
    eventId: id,
    requestId: id,
    now: z.string().optional(),
  })
  .strict();
const snapshotUploadSchema = z
  .object({
    roomId: id,
    actorUid: id,
    snapshot: classroomSharedCourseSchema,
    snapshotDigest: digest,
    requestId: id,
  })
  .strict();

const validate = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_input_invalid' });
  return parsed.data;
};

/** 邀请的存储形状：领域判定用的 facts 加上 `updatedAt`，与响应合同一致。 */
export interface StoredInvitation extends CollabInvitationFacts {
  updatedAt: string;
}

/**
 * 协作仓库的构造选项。
 *
 * `authority` 决定登记写入的权威来源：本机链路（`StudyStore` 默认）写 `local_link`，
 * 独立协作服务写 `online`。两者共用同一份记录与判定，不另立一套登记形状。
 */
export interface CollaborationRepositoryOptions {
  authority?: 'local_link' | 'online';
}

export class CollaborationRepository {
  private readonly authority: 'local_link' | 'online';

  constructor(
    private readonly db: SqlDatabase,
    options: CollaborationRepositoryOptions = {},
  ) {
    this.authority = options.authority ?? 'local_link';
  }

  private now(input?: string): string {
    return input ?? new Date().toISOString();
  }

  /**
   * 幂等读回收据。
   *
   * 同一 requestId 必须对应同一 action、同一 actor 与同一意图；否则说明这个
   * 编号被复用到了另一笔业务上，必须拒绝而不是返回旧结果。
   */
  private retry<T>(
    requestId: string,
    action: CollabAction,
    actorUid: string,
    intent: unknown,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): T | null {
    if (!requestId.trim() || requestId.length > 200)
      throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_request_id_invalid' });
    const row = this.db
      .prepare('SELECT * FROM collab_command_receipts WHERE request_id=?')
      .get(requestId) as Row | undefined;
    if (!row) return null;
    if (
      row['action'] !== action ||
      row['actor_uid'] !== actorUid ||
      row['intent_json'] !== encodeJson(intent)
    ) {
      throw new StudyError('VERSION_CONFLICT', { reason: 'collab_request_reused' });
    }
    return readRequiredJsonColumn(
      row['result_json'],
      schema,
      'collab_command_receipts.result_json',
      {
        reason: 'collab_receipt_invalid',
      },
    );
  }

  private receipt(
    requestId: string,
    action: CollabAction,
    actorUid: string,
    intent: unknown,
    result: unknown,
  ): void {
    this.db
      .prepare(
        'INSERT INTO collab_command_receipts (request_id, action, actor_uid, intent_json, result_json, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        requestId,
        action,
        actorUid,
        encodeJson(intent),
        encodeJson(result),
        new Date().toISOString(),
      );
  }

  // ————————————————————— 登记（UID-01 的本地链路占位） —————————————————————

  /**
   * 登记 UID。
   *
   * `authority` 由构造选项决定：本机链路写死 `local_link`（不是在线登记，
   * 界面据此不能联网邀请）；独立协作服务写 `online`。同一 UID 重复登记返回既有记录；
   * 改名推进 revision。
   */
  register(raw: RegisterInput): { registration: CollabRegistrationDto; deduplicated: boolean } {
    const input = validate(registerSchema, raw);
    return this.db.transaction(() => {
      const prior = this.retry(
        input.requestId,
        'register',
        input.uid,
        input,
        collabRegistrationSchema,
      );
      if (prior) return { registration: prior, deduplicated: true };
      const now = new Date().toISOString();
      const existing = this.getRegistration(input.uid);
      if (
        existing &&
        existing.displayName !== input.displayName &&
        existing.revision >= Number.MAX_SAFE_INTEGER
      ) {
        throw new StudyError('INTERNAL', { reason: 'collab_registration_revision_exhausted' });
      }
      const registration = collabRegistrationSchema.parse({
        uid: input.uid,
        displayName: input.displayName,
        authority: this.authority,
        revision: existing ? existing.revision + 1 : 1,
        registeredAt: existing ? existing.registeredAt : now,
      });
      this.db
        .prepare(
          `INSERT INTO collab_registrations (uid, display_name, authority, revision, registered_at, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(uid) DO UPDATE SET display_name=excluded.display_name, revision=excluded.revision, updated_at=excluded.updated_at`,
        )
        .run(
          registration.uid,
          registration.displayName,
          registration.authority,
          registration.revision,
          registration.registeredAt,
          now,
        );
      this.receipt(input.requestId, 'register', input.uid, input, registration);
      return { registration, deduplicated: false };
    });
  }

  getRegistration(uid: string): CollabRegistrationDto | null {
    const row = this.db.prepare('SELECT * FROM collab_registrations WHERE uid=?').get(uid) as
      Row | undefined;
    if (!row) return null;
    const parsed = collabRegistrationSchema.safeParse({
      uid: row['uid'],
      displayName: row['display_name'],
      authority: row['authority'],
      revision: Number(row['revision']),
      registeredAt: row['registered_at'],
    });
    if (!parsed.success)
      throw new StudyError('INTERNAL', { reason: 'collab_registration_corrupt' });
    return parsed.data;
  }

  isRegistered(uid: string): boolean {
    return this.getRegistration(uid) !== null;
  }

  // ——————————————————————————— 邀请 ———————————————————————————

  private readInvitation(invitationId: string): StoredInvitation | null {
    const row = this.db
      .prepare('SELECT * FROM collab_invitations WHERE invitation_id=?')
      .get(invitationId) as Row | undefined;
    if (!row) return null;
    const parsed = z
      .object({
        invitationId: id,
        roomId: id,
        inviterUid: id,
        inviteeUid: id,
        lessonId: id,
        lessonVersion: z.number().int().positive(),
        snapshotDigest: digest,
        status: z.enum(['pending', 'accepted', 'rejected', 'revoked', 'expired']),
        createdAt: z.string(),
        expiresAt: z.string(),
        updatedAt: z.string(),
      })
      .safeParse({
        invitationId: row['invitation_id'],
        roomId: row['room_id'],
        inviterUid: row['inviter_uid'],
        inviteeUid: row['invitee_uid'],
        lessonId: row['lesson_id'],
        lessonVersion: Number(row['lesson_version']),
        snapshotDigest: row['snapshot_digest'],
        status: row['status'],
        createdAt: row['created_at'],
        expiresAt: row['expires_at'],
        updatedAt: row['updated_at'],
      });
    if (!parsed.success) throw new StudyError('INTERNAL', { reason: 'collab_invitation_corrupt' });
    return parsed.data;
  }

  /**
   * 读邀请时按时间推进过期状态。
   *
   * 过期是「当前事实」，但历史状态本身不改写：只有仍为 `pending` 且已过期的
   * 记录在读取时显示为 `expired`。这样既不会让过期的邀请被接受，也不会把
   * 已接受的历史结论倒回去。
   */
  private withExpiry(facts: StoredInvitation, now: string): StoredInvitation {
    if (facts.status === 'pending' && Date.parse(now) >= Date.parse(facts.expiresAt)) {
      return { ...facts, status: 'expired' };
    }
    return facts;
  }

  getInvitation(invitationId: string, now?: string): StoredInvitation | null {
    const facts = this.readInvitation(invitationId);
    return facts ? this.withExpiry(facts, this.now(now)) : null;
  }

  listInvitations(uid: string, now?: string): StoredInvitation[] {
    const rows = this.db
      .prepare(
        'SELECT invitation_id FROM collab_invitations WHERE inviter_uid=? OR invitee_uid=? ORDER BY rowid DESC',
      )
      .all(uid, uid) as Row[];
    return rows
      .map((row) => this.getInvitation(String(row['invitation_id']), now))
      .filter((facts): facts is StoredInvitation => facts !== null);
  }

  /** 发起邀请：写入 pending 记录并返回；同一 requestId 重试读回既有邀请。 */
  invite(raw: InviteInput): { invitation: StoredInvitation; deduplicated: boolean } {
    const input = validate(inviteSchema, raw);
    const now = this.now(input.now);
    return this.db.transaction(() => {
      const room = this.readRoom(input.roomId);
      if (room) {
        this.assertCurrentMember(input.roomId, input.inviterUid);
        if (room.ownerUid !== input.inviterUid) {
          throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'collab_room_owner_mismatch' });
        }
      }
      const prior = this.retry(input.requestId, 'invite', input.inviterUid, input, z.unknown());
      if (prior) {
        const found = this.getInvitation((prior as { invitationId: string }).invitationId, now);
        if (!found) throw new StudyError('INTERNAL', { reason: 'collab_invitation_missing' });
        return { invitation: found, deduplicated: true };
      }
      assertCollabInvitationCreatable({
        inviterUid: input.inviterUid,
        inviteeUid: input.inviteeUid,
        lessonId: input.lessonId,
        lessonVersion: input.lessonVersion,
        snapshotDigest: input.snapshotDigest,
        inviterRegistered: this.isRegistered(input.inviterUid),
      });
      // 邀请对象必须已在本机链路登记：否则对方「存在与否」无从判断，
      // 也不能把不存在 UID 的邀请写成待接受状态。
      if (!this.isRegistered(input.inviteeUid)) {
        throw new StudyError('NOT_FOUND', { reason: 'collab_invitee_not_registered' });
      }
      this.assertInvitationRoomAvailable(input, now);
      const expiresAt = new Date(Date.parse(now) + 48 * 3600 * 1000).toISOString();
      const invitationId = `inv_${Date.parse(now).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      this.db
        .prepare(
          `INSERT INTO collab_invitations (invitation_id, room_id, inviter_uid, invitee_uid, lesson_id, lesson_version, snapshot_digest, status, created_at, expires_at, updated_at)
         VALUES (?,?,?,?,?,?,?, 'pending', ?, ?, ?)`,
        )
        .run(
          invitationId,
          input.roomId,
          input.inviterUid,
          input.inviteeUid,
          input.lessonId,
          input.lessonVersion,
          input.snapshotDigest,
          now,
          expiresAt,
          now,
        );
      const invitation = this.readInvitation(invitationId);
      if (!invitation) throw new StudyError('INTERNAL', { reason: 'collab_invitation_missing' });
      this.receipt(input.requestId, 'invite', input.inviterUid, input, invitation);
      return { invitation, deduplicated: false };
    });
  }

  /**
   * 邀请表态：只有受邀本人、只有 pending、未过期才能接受/拒绝。
   *
   * 接受时在同一事务里建立房间成员记录：两人进入同一房间。
   * 重复接受按收据读回既有成员，不产生第二份成员记录。
   */
  decide(raw: InvitationDecisionInput): {
    invitation: StoredInvitation;
    member: CollabRoomMemberDto | null;
    deduplicated: boolean;
  } {
    const input = validate(decideSchema, raw);
    const now = this.now(input.now);
    return this.db.transaction(() => {
      const facts = this.readInvitation(input.invitationId);
      if (facts && this.getMember(facts.roomId, input.actorUid)?.readiness === 'left') {
        throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'not_room_member' });
      }
      const prior = this.retry(input.requestId, 'decide', input.actorUid, input, z.unknown());
      if (prior) {
        const found = this.getInvitation((prior as { invitationId: string }).invitationId, now);
        if (!found) throw new StudyError('INTERNAL', { reason: 'collab_invitation_missing' });
        const member =
          input.decision === 'accepted'
            ? this.assertCurrentMember(found.roomId, input.actorUid)
            : null;
        return {
          invitation: found,
          member,
          deduplicated: true,
        };
      }
      if (!facts) throw new StudyError('NOT_FOUND', { reason: 'collab_invitation_missing' });
      assertCollabInvitationDecidable({
        invitation: facts,
        actorUid: input.actorUid,
        decision: input.decision,
        now,
      });
      if (input.decision === 'accepted') {
        this.assertInvitationRoomAvailable(facts, now, facts.invitationId);
      }
      this.db
        .prepare('UPDATE collab_invitations SET status=?, updated_at=? WHERE invitation_id=?')
        .run(input.decision, now, input.invitationId);
      let member: CollabRoomMemberDto | null = null;
      if (input.decision === 'accepted') {
        // 房间行可能在发起邀请时已预留；没有则此时建立（owner = 发起人）。
        this.ensureRoom(facts, now);
        member = this.upsertMember(facts.roomId, input.actorUid, 'participant', 'pending', now);
      }
      const invitation = this.readInvitation(input.invitationId);
      if (!invitation) throw new StudyError('INTERNAL', { reason: 'collab_invitation_missing' });
      this.receipt(input.requestId, 'decide', input.actorUid, input, invitation);
      return { invitation, member, deduplicated: false };
    });
  }

  /** 撤销邀请：只有发起人、只有 pending 能撤销。 */
  revoke(raw: InvitationRevokeInput): { invitation: StoredInvitation; deduplicated: boolean } {
    const input = validate(revokeSchema, raw);
    const now = this.now(input.now);
    return this.db.transaction(() => {
      const facts = this.readInvitation(input.invitationId);
      if (facts && this.getMember(facts.roomId, input.actorUid)?.readiness === 'left') {
        throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'not_room_member' });
      }
      const prior = this.retry(input.requestId, 'revoke', input.actorUid, input, z.unknown());
      if (prior) {
        const found = this.getInvitation((prior as { invitationId: string }).invitationId, now);
        if (!found) throw new StudyError('INTERNAL', { reason: 'collab_invitation_missing' });
        return { invitation: found, deduplicated: true };
      }
      if (!facts) throw new StudyError('NOT_FOUND', { reason: 'collab_invitation_missing' });
      // 撤销前先按读取时间把 pending 折算为 expired：过期的邀请不能撤销（与判定注释一致），
      // 不能拿原始 pending 状态绕过「已过期只能重新邀请」。
      assertCollabInvitationRevocable({
        invitation: this.withExpiry(facts, now),
        actorUid: input.actorUid,
      });
      this.db
        .prepare('UPDATE collab_invitations SET status=?, updated_at=? WHERE invitation_id=?')
        .run('revoked', now, input.invitationId);
      const invitation = this.readInvitation(input.invitationId);
      if (!invitation) throw new StudyError('INTERNAL', { reason: 'collab_invitation_missing' });
      this.receipt(input.requestId, 'revoke', input.actorUid, input, invitation);
      return { invitation, deduplicated: false };
    });
  }

  // ——————————————————————————— 房间 ———————————————————————————

  private readRoom(roomId: string): CollabRoomDto | null {
    const row = this.db.prepare('SELECT * FROM collab_rooms WHERE room_id=?').get(roomId) as
      Row | undefined;
    if (!row) return null;
    const parsed = collabRoomSchema.safeParse({
      schemaVersion: 1,
      roomId: row['room_id'],
      ownerUid: row['owner_uid'],
      status: row['status'],
      revision: Number(row['revision']),
      currentSceneId: row['current_scene_id'],
      course: {
        lessonId: row['lesson_id'],
        lessonVersion: Number(row['lesson_version']),
        snapshotDigest: row['snapshot_digest'],
      },
      createdAt: row['created_at'],
      updatedAt: row['updated_at'],
    });
    if (!parsed.success) throw new StudyError('INTERNAL', { reason: 'collab_room_corrupt' });
    return parsed.data;
  }

  getRoom(roomId: string): CollabRoomDto | null {
    return this.readRoom(roomId);
  }

  /** 在发起及接受的写事务内复核房间归属，过期邀请不继续占用房间。 */
  private assertInvitationRoomAvailable(
    facts: Pick<
      CollabInvitationFacts,
      'roomId' | 'inviterUid' | 'inviteeUid' | 'lessonId' | 'lessonVersion' | 'snapshotDigest'
    >,
    now: string,
    invitationId?: string,
  ): void {
    const existing = this.readRoom(facts.roomId);
    if (existing) {
      if (existing.ownerUid !== facts.inviterUid) {
        throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'collab_room_owner_mismatch' });
      }
      if (existing.status !== 'ready') {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_room_not_joinable' });
      }
      if (
        existing.course.lessonId !== facts.lessonId ||
        existing.course.lessonVersion !== facts.lessonVersion ||
        existing.course.snapshotDigest !== facts.snapshotDigest
      ) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_room_course_changed' });
      }
      const members = this.listMembers(facts.roomId);
      if (
        members.length > 2 ||
        !members.some((member) => member.uid === facts.inviterUid && member.role === 'owner') ||
        members.some(
          (member) =>
            member.readiness === 'left' ||
            (member.uid !== facts.inviterUid && member.uid !== facts.inviteeUid) ||
            (member.uid === facts.inviteeUid && member.role !== 'participant'),
        )
      ) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_room_members_mismatch' });
      }
    }
    for (const existingInvitation of this.reservingInvitations(facts.roomId, now)) {
      if (existingInvitation.invitationId !== invitationId) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_room_invitation_exists' });
      }
    }
  }

  private reservingInvitations(roomId: string, now: string): StoredInvitation[] {
    const rows = this.db
      .prepare(
        "SELECT invitation_id FROM collab_invitations WHERE room_id=? AND status IN ('pending','accepted')",
      )
      .all(roomId) as Row[];
    return rows
      .map((row) => this.getInvitation(String(row['invitation_id']), now))
      .filter(
        (invitation): invitation is StoredInvitation =>
          invitation !== null &&
          (invitation.status === 'pending' || invitation.status === 'accepted'),
      );
  }

  private ensureRoom(facts: CollabInvitationFacts, now: string): CollabRoomDto {
    this.assertInvitationRoomAvailable(facts, now, facts.invitationId);
    const existing = this.readRoom(facts.roomId);
    if (existing) return existing;
    return this.createRoomRow({
      roomId: facts.roomId,
      ownerUid: facts.inviterUid,
      lessonId: facts.lessonId,
      lessonVersion: facts.lessonVersion,
      snapshotDigest: facts.snapshotDigest,
      currentSceneId: 'scene_1',
    });
  }

  private createRoomRow(input: {
    roomId: string;
    ownerUid: string;
    lessonId: string;
    lessonVersion: number;
    snapshotDigest: string;
    currentSceneId: string;
  }): CollabRoomDto {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO collab_rooms (room_id, owner_uid, status, revision, current_scene_id, lesson_id, lesson_version, snapshot_digest, created_at, updated_at)
       VALUES (?,?, 'ready', 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.roomId,
        input.ownerUid,
        input.currentSceneId,
        input.lessonId,
        input.lessonVersion,
        input.snapshotDigest,
        now,
        now,
      );
    this.upsertMember(input.roomId, input.ownerUid, 'owner', 'pending', now);
    const room = this.readRoom(input.roomId);
    if (!room) throw new StudyError('INTERNAL', { reason: 'collab_room_missing' });
    return room;
  }

  /** 建房：房主显式建立共享房间（也可由接受邀请时的 ensureRoom 建立）。 */
  createRoom(raw: CreateCollabRoomInput): { room: CollabRoomDto; deduplicated: boolean } {
    const input = validate(roomSchema, raw);
    return this.db.transaction(() => {
      if (this.readRoom(input.roomId)) this.assertCurrentMember(input.roomId, input.ownerUid);
      const prior = this.retry(input.requestId, 'create-room', input.ownerUid, input, z.unknown());
      if (prior) {
        const room = this.readRoom((prior as { roomId: string }).roomId);
        if (!room) throw new StudyError('INTERNAL', { reason: 'collab_room_missing' });
        return { room, deduplicated: true };
      }
      const existing = this.readRoom(input.roomId);
      if (existing) throw new StudyError('VERSION_CONFLICT', { reason: 'collab_room_exists' });
      const reservations = this.reservingInvitations(input.roomId, new Date().toISOString());
      if (reservations.length > 1) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_room_invitation_exists' });
      }
      for (const invitation of reservations) {
        if (invitation.inviterUid !== input.ownerUid) {
          throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'collab_room_owner_mismatch' });
        }
        if (
          invitation.lessonId !== input.lessonId ||
          invitation.lessonVersion !== input.lessonVersion ||
          invitation.snapshotDigest !== input.snapshotDigest
        ) {
          throw new StudyError('VERSION_CONFLICT', { reason: 'collab_room_course_changed' });
        }
      }
      const room = this.createRoomRow(input);
      this.receipt(input.requestId, 'create-room', input.ownerUid, input, room);
      return { room, deduplicated: false };
    });
  }

  private getMember(roomId: string, uid: string): CollabRoomMemberDto | null {
    const row = this.db
      .prepare('SELECT * FROM collab_room_members WHERE room_id=? AND uid=?')
      .get(roomId, uid) as Row | undefined;
    if (!row) return null;
    const parsed = collabRoomMemberSchema.safeParse({
      roomId: row['room_id'],
      uid: row['uid'],
      role: row['role'],
      readiness: row['readiness'],
      joinedAt: row['joined_at'],
      updatedAt: row['updated_at'],
    });
    if (!parsed.success) throw new StudyError('INTERNAL', { reason: 'collab_member_corrupt' });
    return parsed.data;
  }

  /** 历史成员仍保留在表内，但退出后不再具有读写或收据重放权限。 */
  private assertCurrentMember(roomId: string, uid: string): CollabRoomMemberDto {
    const member = this.getMember(roomId, uid);
    if (!member || member.readiness === 'left') {
      throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'not_room_member' });
    }
    return member;
  }

  listMembers(roomId: string): CollabRoomMemberDto[] {
    const rows = this.db
      .prepare('SELECT * FROM collab_room_members WHERE room_id=? ORDER BY role, uid')
      .all(roomId) as Row[];
    return rows.map((row) => {
      const parsed = collabRoomMemberSchema.safeParse({
        roomId: row['room_id'],
        uid: row['uid'],
        role: row['role'],
        readiness: row['readiness'],
        joinedAt: row['joined_at'],
        updatedAt: row['updated_at'],
      });
      if (!parsed.success) throw new StudyError('INTERNAL', { reason: 'collab_member_corrupt' });
      return parsed.data;
    });
  }

  private upsertMember(
    roomId: string,
    uid: string,
    role: 'owner' | 'participant',
    readiness: CollabReadiness,
    now: string,
  ): CollabRoomMemberDto {
    this.db
      .prepare(
        `INSERT INTO collab_room_members (room_id, uid, role, readiness, joined_at, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(room_id, uid) DO UPDATE SET readiness=excluded.readiness, updated_at=excluded.updated_at`,
      )
      .run(roomId, uid, role, readiness, now, now);
    const member = this.getMember(roomId, uid);
    if (!member) throw new StudyError('INTERNAL', { reason: 'collab_member_missing' });
    return member;
  }

  /** 成员准备状态：只有成员本人能改自己的准备状态。 */
  setReadiness(raw: MemberReadinessInput): { member: CollabRoomMemberDto; deduplicated: boolean } {
    const input = validate(readinessSchema, raw);
    return this.db.transaction(() => {
      const room = this.readRoom(input.roomId);
      if (!room) throw new StudyError('NOT_FOUND', { reason: 'collab_room_missing' });
      const existing = this.getMember(input.roomId, input.uid);
      if (!existing) throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'not_room_member' });
      const prior = this.retry(
        input.requestId,
        'readiness',
        input.uid,
        input,
        collabRoomMemberSchema,
      );
      if (existing.readiness === 'left') {
        // 仅允许重放已成功的退出确认，不能借旧 ready 收据恢复身份。
        if (prior && input.readiness === 'left') return { member: existing, deduplicated: true };
        throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'not_room_member' });
      }
      if (prior) return { member: prior, deduplicated: true };
      if (room.status === 'ended') throw new StudyError('RUN_TERMINATED', { reason: 'room_ended' });
      const now = new Date().toISOString();
      const member = this.upsertMember(
        input.roomId,
        input.uid,
        existing.role,
        input.readiness,
        now,
      );
      if (input.readiness === 'left' && existing.role === 'owner') {
        this.db
          .prepare(
            "UPDATE collab_rooms SET status='ended', revision=revision+1, updated_at=? WHERE room_id=?",
          )
          .run(now, input.roomId);
      }
      this.receipt(input.requestId, 'readiness', input.uid, input, member);
      return { member, deduplicated: false };
    });
  }

  /**
   * 开始共同课堂：房主在两人都 ready 后把房间从 `ready` 推进到 `active`。
   *
   * 复用 `assertCollabRoomStartable` 的判定：成员恰为邀请双方、都已 ready、课程版本/摘要
   * 与邀请一致，且只有房主能点开始。判定通过才推进状态；`room_ended` 与「人数不符」
   * 都在判定里拒绝，不会出现「单方面开课」。
   */
  startRoom(raw: StartCollabRoomInput): { room: CollabRoomDto; deduplicated: boolean } {
    const input = validate(startRoomSchema, raw);
    return this.db.transaction(() => {
      const room = this.readRoom(input.roomId);
      if (!room) throw new StudyError('NOT_FOUND', { reason: 'collab_room_missing' });
      this.assertCurrentMember(input.roomId, input.actorUid);
      const prior = this.retry(input.requestId, 'start-room', input.actorUid, input, z.unknown());
      if (prior) {
        const room = this.readRoom((prior as { roomId: string }).roomId);
        if (!room) throw new StudyError('INTERNAL', { reason: 'collab_room_missing' });
        return { room, deduplicated: true };
      }
      if (room.status !== 'ready') {
        throw new StudyError('VERSION_CONFLICT', {
          reason: 'collab_room_not_startable',
          status: room.status,
        });
      }
      // 成员构成与课程版本以**已接受的邀请**为准：房主不能凭建房单方面开课。
      const accepted = this.db
        .prepare(
          "SELECT invitation_id FROM collab_invitations WHERE room_id=? AND status='accepted' ORDER BY updated_at DESC LIMIT 1",
        )
        .get(input.roomId) as Row | undefined;
      if (!accepted) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_room_not_startable' });
      }
      const invitation = this.readInvitation(String(accepted['invitation_id']));
      if (!invitation) throw new StudyError('INTERNAL', { reason: 'collab_invitation_missing' });
      assertCollabRoomStartable({
        inviterUid: invitation.inviterUid,
        inviteeUid: invitation.inviteeUid,
        lessonId: invitation.lessonId,
        lessonVersion: invitation.lessonVersion,
        snapshotDigest: invitation.snapshotDigest,
        actorUid: input.actorUid,
        members: this.listMembers(input.roomId).map((member) => ({
          uid: member.uid,
          readiness: member.readiness,
        })),
        course: room.course,
      });
      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE collab_rooms SET status='active', revision=revision+1, updated_at=? WHERE room_id=?",
        )
        .run(now, input.roomId);
      const started = this.readRoom(input.roomId);
      if (!started) throw new StudyError('INTERNAL', { reason: 'collab_room_missing' });
      this.receipt(input.requestId, 'start-room', input.actorUid, input, started);
      return { room: started, deduplicated: false };
    });
  }

  // ——————————————————————————— 消息 ———————————————————————————

  private tailSeq(table: 'collab_room_events' | 'collab_room_messages', roomId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(seq) AS tail FROM ${table} WHERE room_id=?`)
      .get(roomId) as Row | undefined;
    const tail = row?.['tail'];
    return typeof tail === 'number' ? tail : Number(tail ?? 0);
  }

  /** 按游标读取消息：返回 (afterSeq, tailSeq] 区间，重连据此补齐。 */
  listMessages(
    roomId: string,
    afterSeq: number,
  ): { messages: CollabMessageDto[]; tailSeq: number } {
    const tailSeq = this.tailSeq('collab_room_messages', roomId);
    assertCollabResyncCursor({ afterSeq, tailSeq });
    const rows = this.db
      .prepare('SELECT * FROM collab_room_messages WHERE room_id=? AND seq>? ORDER BY seq')
      .all(roomId, afterSeq) as Row[];
    return { messages: rows.map((row) => this.mapMessage(row)), tailSeq };
  }

  private mapMessage(row: Row): CollabMessageDto {
    const parsed = collabMessageSchema.safeParse({
      messageId: row['message_id'],
      roomId: row['room_id'],
      seq: Number(row['seq']),
      senderUid: row['sender_uid'],
      senderType: row['sender_type'],
      body: row['body'],
      dedupKey: row['dedup_key'],
      createdAt: row['created_at'],
    });
    if (!parsed.success) throw new StudyError('INTERNAL', { reason: 'collab_message_corrupt' });
    return parsed.data;
  }

  /**
   * 追加课内消息。
   *
   * 只有房间成员能发，且身份写死为真人；AI 同学与教师输出不经这条写入口。
   * 权威序号由服务端按追加顺序分配，客户端不能指定。
   */
  appendMessage(raw: AppendMessageInput): { message: CollabMessageDto; deduplicated: boolean } {
    const input = validate(messageSchema, raw);
    const now = this.now(input.now);
    return this.db.transaction(() => {
      const room = this.readRoom(input.roomId);
      if (!room) throw new StudyError('NOT_FOUND', { reason: 'collab_room_missing' });
      this.assertCurrentMember(input.roomId, input.senderUid);
      const prior = this.retry(
        input.requestId,
        'message',
        input.senderUid,
        input,
        collabMessageSchema,
      );
      if (prior) return { message: prior, deduplicated: true };
      assertCollabMessageWritable({
        roomId: input.roomId,
        senderUid: input.senderUid,
        senderType: 'human_learner',
        body: input.body,
        memberUids: this.listMembers(input.roomId)
          .filter((member) => member.readiness !== 'left')
          .map((member) => member.uid),
        roomEnded: room.status === 'ended',
      });
      const seq = this.tailSeq('collab_room_messages', input.roomId) + 1;
      const message = collabMessageSchema.parse({
        messageId: `msg_${seq}_${Date.parse(now).toString(36)}`,
        roomId: input.roomId,
        seq,
        senderUid: input.senderUid,
        senderType: 'human_learner',
        body: input.body,
        dedupKey: input.requestId,
        createdAt: now,
      });
      this.db
        .prepare(
          `INSERT INTO collab_room_messages (room_id, seq, message_id, sender_uid, sender_type, body, dedup_key, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          message.roomId,
          message.seq,
          message.messageId,
          message.senderUid,
          message.senderType,
          message.body,
          message.dedupKey,
          message.createdAt,
        );
      this.receipt(input.requestId, 'message', input.senderUid, input, message);
      return { message, deduplicated: false };
    });
  }

  // ——————————————————————————— 事件 ———————————————————————————

  /** 按游标读取事件：返回 (afterSeq, tailSeq] 区间。 */
  listEvents(roomId: string, afterSeq: number): { events: CollabEventDto[]; tailSeq: number } {
    const tailSeq = this.tailSeq('collab_room_events', roomId);
    assertCollabResyncCursor({ afterSeq, tailSeq });
    const rows = this.db
      .prepare('SELECT * FROM collab_room_events WHERE room_id=? AND seq>? ORDER BY seq')
      .all(roomId, afterSeq) as Row[];
    return { events: rows.map((row) => this.mapEvent(row)), tailSeq };
  }

  private mapEvent(row: Row): CollabEventDto {
    const parsed = collabEventSchema.safeParse({
      eventId: row['event_id'],
      roomId: row['room_id'],
      seq: Number(row['seq']),
      kind: row['kind'],
      actorUid: row['actor_uid'],
      summary: row['summary'],
      createdAt: row['created_at'],
    });
    if (!parsed.success) throw new StudyError('INTERNAL', { reason: 'collab_event_corrupt' });
    return parsed.data;
  }

  /**
   * 追加房间事件。
   *
   * `expectedSeq` 必须恰好等于 `tailSeq + 1`（乐观并发）；教师输出与场景切换
   * 只允许房主，白板动作允许成员。重复提交按收据读回，不推进序号。
   */
  appendEvent(raw: AppendEventInput): { event: CollabEventDto; deduplicated: boolean } {
    const input = validate(eventSchema, raw);
    const now = this.now(input.now);
    return this.db.transaction(() => {
      const room = this.readRoom(input.roomId);
      if (!room) throw new StudyError('NOT_FOUND', { reason: 'collab_room_missing' });
      this.assertCurrentMember(input.roomId, input.actorUid);
      const prior = this.retry(input.requestId, 'event', input.actorUid, input, collabEventSchema);
      if (prior) return { event: prior, deduplicated: true };
      const members = this.listMembers(input.roomId);
      const memberUids = members
        .filter((member) => member.readiness !== 'left')
        .map((member) => member.uid);
      const tailSeq = this.tailSeq('collab_room_events', input.roomId);
      assertCollabTeacherEventAllowed({
        kind: input.kind as CollabEventDto['kind'],
        actorUid: input.actorUid,
        ownerUid: room.ownerUid,
        memberUids,
      });
      assertCollabEventAppendable({
        kind: input.kind as CollabEventDto['kind'],
        expectedSeq: input.expectedSeq,
        tailSeq,
        roomEnded: room.status === 'ended',
        actorIsMember: memberUids.includes(input.actorUid),
      });
      const event = collabEventSchema.parse({
        eventId: input.eventId,
        roomId: input.roomId,
        seq: tailSeq + 1,
        kind: input.kind,
        actorUid: input.actorUid,
        summary: input.summary,
        createdAt: now,
      });
      this.db
        .prepare(
          'INSERT INTO collab_room_events (room_id, seq, event_id, kind, actor_uid, summary, created_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          event.roomId,
          event.seq,
          event.eventId,
          event.kind,
          event.actorUid,
          event.summary,
          event.createdAt,
        );
      this.receipt(input.requestId, 'event', input.actorUid, input, event);
      return { event, deduplicated: false };
    });
  }

  // ————————————————— 结构化场景同步（SYNC-01 在线部分） —————————————————

  /**
   * 结构化场景同步：目标 `sceneId` + 课程身份 + 房间 `revision` + `expectedSeq`。
   *
   * 与 `appendEvent` 的差别：这里把「切到哪个场景」当成房间状态的一部分，在**同一
   * 事务**内推进 `current_scene_id`、房间 `revision` 与 `scene_changed` 事件收据，
   * 不再用只有 `summary` 的摘要代替同步。唯一教师执行权、课程身份、房间版本与序号
   * 都由 `assertCollabSceneSyncable` 复验；目标场景必须属于房间冻结的快照。
   */
  syncScene(raw: SyncSceneInput): SyncSceneResult {
    const input = validate(syncSceneSchema, raw);
    const now = this.now(input.now);
    return this.db.transaction(() => {
      const room = this.readRoom(input.roomId);
      if (!room) throw new StudyError('NOT_FOUND', { reason: 'collab_room_missing' });
      this.assertCurrentMember(input.roomId, input.actorUid);
      const prior = this.retry(input.requestId, 'sync-scene', input.actorUid, input, z.unknown());
      if (prior) return { ...(prior as Omit<SyncSceneResult, 'deduplicated'>), deduplicated: true };
      const members = this.listMembers(input.roomId);
      const memberUids = members
        .filter((member) => member.readiness !== 'left')
        .map((member) => member.uid);
      const snapshot = this.readSnapshot(input.roomId);
      assertCollabSceneSyncable({
        actorUid: input.actorUid,
        ownerUid: room.ownerUid,
        memberUids,
        roomStatus: room.status,
        roomCourse: { lessonId: room.course.lessonId, lessonVersion: room.course.lessonVersion },
        commandCourse: { lessonId: input.lessonId, lessonVersion: input.lessonVersion },
        roomRevision: room.revision,
        expectedRevision: input.expectedRevision,
        sceneId: input.sceneId,
        snapshotSceneIds: snapshot?.snapshot.scenes.map((scene) => scene.sceneId) ?? [],
        expectedSeq: input.expectedSeq,
        tailSeq: this.tailSeq('collab_room_events', input.roomId),
      });
      const event = collabEventSchema.parse({
        eventId: input.eventId,
        roomId: input.roomId,
        seq: this.tailSeq('collab_room_events', input.roomId) + 1,
        kind: 'scene_changed',
        actorUid: input.actorUid,
        summary: `进入场景 ${input.sceneId}`,
        createdAt: now,
      });
      this.db
        .prepare(
          'INSERT INTO collab_room_events (room_id, seq, event_id, kind, actor_uid, summary, created_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          event.roomId,
          event.seq,
          event.eventId,
          event.kind,
          event.actorUid,
          event.summary,
          event.createdAt,
        );
      const next = {
        ...room,
        currentSceneId: input.sceneId,
        // 房间状态不因场景推进而改变：开课由 start 单独决定，推进只允许发生在 active。
        status: room.status,
        revision: room.revision + 1,
        updatedAt: now,
      };
      this.db
        .prepare(
          'UPDATE collab_rooms SET status=?, revision=?, current_scene_id=?, updated_at=? WHERE room_id=?',
        )
        .run(next.status, next.revision, next.currentSceneId, next.updatedAt, input.roomId);
      const result: SyncSceneResult = {
        room: {
          roomId: next.roomId,
          status: next.status,
          revision: next.revision,
          currentSceneId: next.currentSceneId,
          updatedAt: next.updatedAt,
        },
        event,
        deduplicated: false,
      };
      this.receipt(input.requestId, 'sync-scene', input.actorUid, input, {
        room: result.room,
        event: result.event,
      });
      return result;
    });
  }

  // ————————————————— 共享快照（ROOM-01 双端消费者） —————————————————

  /** 快照正文的规范化内容哈希：与上传端声明的摘要解耦，用于拒绝内容被换掉的投影。 */
  private snapshotContentDigest(snapshot: ClassroomSharedCourseDto): string {
    return fingerprintOf(canonicalJson(snapshot));
  }

  private readSnapshot(
    roomId: string,
  ): { snapshotDigest: string; snapshot: ClassroomSharedCourseDto } | null {
    const row = this.db
      .prepare('SELECT * FROM collab_room_snapshots WHERE room_id=?')
      .get(roomId) as Row | undefined;
    if (!row) return null;
    const snapshot = readRequiredJsonColumn(
      row['snapshot_json'],
      classroomSharedCourseSchema,
      'collab_room_snapshots.snapshot_json',
      { reason: 'collab_snapshot_invalid' },
    );
    // 读取时复验内容哈希：存储被外部改写时拒绝使用，而不是把被换过的投影当权威。
    if (this.snapshotContentDigest(snapshot) !== String(row['content_digest'])) {
      throw new StudyError('INTERNAL', { reason: 'collab_snapshot_content_mismatch' });
    }
    return { snapshotDigest: String(row['snapshot_digest']), snapshot };
  }

  /**
   * 上传共享快照（公共投影）。
   *
   * 只接收经 `classroomSharedCourseSchema` 校验的公共投影；`snapshotDigest` 必须与
   * 邀请时冻结的课程摘要一致，且服务端对投影正文**复算**内容哈希后落库——避免上传端
   * 声明一个摘要、却塞进内容不同的投影。同一房间重复上传同一内容幂等。
   */
  uploadSnapshot(raw: {
    roomId: string;
    actorUid: string;
    snapshot: ClassroomSharedCourseDto;
    snapshotDigest: string;
    requestId: string;
  }): { roomId: string; snapshotDigest: string; deduplicated: boolean } {
    const input = validate(snapshotUploadSchema, raw);
    return this.db.transaction(() => {
      const room = this.readRoom(input.roomId);
      if (!room) throw new StudyError('NOT_FOUND', { reason: 'collab_room_missing' });
      const memberUids = this.listMembers(input.roomId)
        .filter((member) => member.readiness !== 'left')
        .map((member) => member.uid);
      assertCollabSnapshotUploadable({
        actorUid: input.actorUid,
        ownerUid: room.ownerUid,
        memberUids,
        roomEnded: room.status === 'ended',
        roomCourse: room.course,
        snapshotCourse: {
          lessonId: input.snapshot.course.lessonId,
          lessonVersion: input.snapshot.course.lessonVersion,
          documentDigest: input.snapshot.course.documentDigest,
        },
        snapshotDigest: input.snapshotDigest,
      });
      const prior = this.retry(input.requestId, 'snapshot', input.actorUid, input, z.unknown());
      if (prior) {
        const stored = prior as { roomId: string; snapshotDigest: string };
        return { ...stored, deduplicated: true };
      }
      const now = new Date().toISOString();
      const contentDigest = this.snapshotContentDigest(input.snapshot);
      const existing = this.readSnapshot(input.roomId);
      if (existing && this.snapshotContentDigest(existing.snapshot) !== contentDigest) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_snapshot_frozen' });
      }
      this.db
        .prepare(
          `INSERT INTO collab_room_snapshots (room_id, snapshot_digest, content_digest, snapshot_json, updated_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(room_id) DO UPDATE SET snapshot_digest=excluded.snapshot_digest, content_digest=excluded.content_digest, snapshot_json=excluded.snapshot_json, updated_at=excluded.updated_at`,
        )
        .run(input.roomId, input.snapshotDigest, contentDigest, encodeJson(input.snapshot), now);
      const result = { roomId: input.roomId, snapshotDigest: input.snapshotDigest };
      this.receipt(input.requestId, 'snapshot', input.actorUid, input, result);
      return { ...result, deduplicated: false };
    });
  }

  /** 读取共享快照：返回房间冻结的公共投影与摘要；尚未上传时为 null。 */
  snapshotView(roomId: string): CollabSnapshotViewDto {
    const room = this.readRoom(roomId);
    if (!room) throw new StudyError('NOT_FOUND', { reason: 'collab_room_missing' });
    const stored = this.readSnapshot(roomId);
    return {
      roomId,
      snapshotDigest: stored?.snapshotDigest ?? room.course.snapshotDigest,
      snapshot: stored?.snapshot ?? null,
    };
  }
}
