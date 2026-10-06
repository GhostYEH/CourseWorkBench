/**
 * 双人共同课堂的协作合同（INVITE-01 / SYNC-01 / CHAT-01）。
 *
 * 这一层只定「两台设备见面时互相承认的形状」，不决定网络怎么连：
 * - 邀请：谁能邀谁、谁能接受/拒绝/撤销、过期算谁的；
 * - 消息：课内真人文字交流的存放形状（发送者身份由服务端绑定，不由客户端自报）；
 * - 事件：场景同步与成员变化的权威序号形状（重连按游标补齐）。
 *
 * 存储形态沿用 `classroomInvitationSchema`（见 classroom-room.ts），这里只补
 * 「发起/表态/撤销/发消息/追加事件/建房/准备状态」的命令与结果形状。
 * 地址/协议/部署方案见 docs/adr/0004-collaboration-service.md：本机链路已在
 * 本地服务实现（可本机回归），真正的在线唯一性登记、本人认证与实时分发
 * 由独立协作服务承担，尚未联调，本地单人房间不代替它。
 */

import { z } from 'zod';
import { learnerUidSchema } from './learner-profile';

const id = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/**
 * 协作内容文本：不能为空/纯空白、不能超长、不能带本地路径。
 *
 * 导出让存储层复用同一份判定，避免「HTTP 入口拒绝路径、直连 store 却放行」的口径分裂。
 */
export const collabText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, '协作内容不能为空')
    .refine(
      (value) =>
        !/(?:[a-z]:[\\/]|file:\/\/|\\\\[^\\]|(?:^|[\s"'(=])\/(?:Users|home|tmp|var|etc|mnt|private|opt)\/)/i.test(
          value,
        ),
      '协作内容不能含本地文件路径',
    );

/** 邀请有效期：48 小时。过期后不能接受，只能重新邀请。 */
export const COLLAB_INVITATION_TTL_MS = 48 * 3600 * 1000;

/**
 * UID 在协作服务里的登记状态（UID-01）。
 *
 * `authority` 区分两种登记来源：
 * - `local_link`：本机同进程协作链路，**不是**在线登记，界面据此显示「不能联网邀请」；
 * - `online`：独立协作服务按凭据认证后的在线登记（见
 *   `collaboration-service.ts` 的 `collabOnlineRegistrationSchema`），
 *   只有它才允许联网邀请。
 *
 * 本机链路的写入路径（`CollaborationRepository` 默认构造）始终写 `local_link`，
 * 在线服务的存储写 `online`；两者共用同一份记录形状，不另立方言。
 */
export const collabRegistrationSchema = z
  .object({
    uid: learnerUidSchema,
    displayName: collabText(80),
    authority: z.enum(['local_link', 'online']),
    revision: z.number().int().positive(),
    registeredAt: z.string().datetime(),
  })
  .strict();
export type CollabRegistrationDto = z.infer<typeof collabRegistrationSchema>;

/** 登记命令：displayName 由本人档案给出，UID 由服务端会话绑定（请求体不能自报他人 UID）。 */
export const collabRegistrationCommandSchema = z
  .object({
    uid: learnerUidSchema,
    displayName: collabText(80),
    requestId: id,
  })
  .strict();
export type CollabRegistrationCommandInput = z.infer<typeof collabRegistrationCommandSchema>;

/** 成员在准备页的状态（INVITE-01 → SYNC-01 的衔接）。 */
export const COLLAB_READINESS = ['pending', 'ready', 'left'] as const;
export type CollabReadinessValue = (typeof COLLAB_READINESS)[number];

export const collabRoomMemberSchema = z
  .object({
    roomId: id,
    uid: learnerUidSchema,
    role: z.enum(['owner', 'participant']),
    readiness: z.enum(COLLAB_READINESS),
    joinedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CollabRoomMemberDto = z.infer<typeof collabRoomMemberSchema>;

/**
 * 共享房间的权威状态（ROOM-01 的在线部分）。
 *
 * 与本地 `classroom_rooms` 的区别：这里是**协作服务**持有的共享房间，
 * 承载两端共用的课程版本/摘要与当前场景；本地房间仍是个人运行记录。
 * 两者都绑定同一份冻结课程摘要，但权威归属不同（《规划书》7.6）。
 */
export const collabRoomSchema = z
  .object({
    schemaVersion: z.literal(1),
    roomId: id,
    ownerUid: learnerUidSchema,
    status: z.enum(['ready', 'active', 'ended']),
    revision: z.number().int().positive(),
    currentSceneId: id,
    course: z
      .object({
        lessonId: id,
        lessonVersion: z.number().int().positive(),
        snapshotDigest: digest,
      })
      .strict(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CollabRoomDto = z.infer<typeof collabRoomSchema>;

/** 建房命令：课程版本与摘要由邀请/建房时冻结，之后不跟随草案换版。 */
export const collabRoomCreateCommandSchema = z
  .object({
    roomId: id,
    ownerUid: learnerUidSchema,
    lessonId: id,
    lessonVersion: z.number().int().positive(),
    snapshotDigest: digest,
    currentSceneId: id,
    requestId: id,
  })
  .strict();
export type CollabRoomCreateCommandInput = z.infer<typeof collabRoomCreateCommandSchema>;

/** 成员准备状态命令：只有成员本人能改自己的准备状态。 */
export const collabMemberReadinessCommandSchema = z
  .object({
    roomId: id,
    uid: learnerUidSchema,
    readiness: z.enum(['pending', 'ready', 'left']),
    requestId: id,
  })
  .strict();
export type CollabMemberReadinessCommandInput = z.infer<typeof collabMemberReadinessCommandSchema>;

/**
 * 开始共同课堂（INVITE-01 准备页 → SYNC-01）。
 *
 * 只有房主能点开始；服务端复验「成员恰为邀请双方且都已 ready」后把房间置为 `active`。
 * 房间版本与快照摘要不因开始而改变（仍绑定邀请时冻结的那一版）。
 */
export const collabRoomStartCommandSchema = z
  .object({
    roomId: id,
    actorUid: learnerUidSchema,
    requestId: id,
  })
  .strict();
export type CollabRoomStartCommandInput = z.infer<typeof collabRoomStartCommandSchema>;

/** 课内文字消息正文上限：2000 字，与课堂讨论区的展示约束对齐。 */
export const COLLAB_MESSAGE_MAX_LENGTH = 2000;

/** 房间事件种类：只收录「另一端必须知道」的公共变化，不收录私人答案与判分。 */
export const COLLAB_EVENT_KINDS = [
  'scene_changed',
  'teacher_output',
  'board_action',
  'member_joined',
  'member_left',
] as const;
export type CollabEventKind = (typeof COLLAB_EVENT_KINDS)[number];

/** 邀请发起（INVITE-01）：roomId 由服务端在发起时预留，房间行在对方接受后才建立。 */
export const collabInvitationCreateSchema = z
  .object({
    roomId: id,
    inviterUid: learnerUidSchema,
    inviteeUid: learnerUidSchema,
    lessonId: id,
    lessonVersion: z.number().int().positive(),
    snapshotDigest: digest,
    requestId: id,
  })
  .strict();
export type CollabInvitationCreateInput = z.infer<typeof collabInvitationCreateSchema>;

/** 邀请表态（INVITE-01）：只有受邀本人能接受/拒绝，发起人不能替对方表态。 */
export const collabInvitationDecisionSchema = z
  .object({
    invitationId: id,
    actorUid: learnerUidSchema,
    decision: z.enum(['accepted', 'rejected']),
    requestId: id,
  })
  .strict();
export type CollabInvitationDecisionInput = z.infer<typeof collabInvitationDecisionSchema>;

/** 邀请撤销（INVITE-01）：只有发起人能在对方表态前撤销。 */
export const collabInvitationRevokeSchema = z
  .object({
    invitationId: id,
    actorUid: learnerUidSchema,
    requestId: id,
  })
  .strict();
export type CollabInvitationRevokeInput = z.infer<typeof collabInvitationRevokeSchema>;

/** 邀请命令联合：单条 POST 按 action 分派，避免为三种动作各开一个端点。 */
export const collabInvitationCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('invite'),
      roomId: id,
      inviterUid: learnerUidSchema,
      inviteeUid: learnerUidSchema,
      lessonId: id,
      lessonVersion: z.number().int().positive(),
      snapshotDigest: digest,
      requestId: id,
    })
    .strict(),
  z
    .object({
      action: z.literal('decide'),
      invitationId: id,
      actorUid: learnerUidSchema,
      decision: z.enum(['accepted', 'rejected']),
      requestId: id,
    })
    .strict(),
  z
    .object({
      action: z.literal('revoke'),
      invitationId: id,
      actorUid: learnerUidSchema,
      requestId: id,
    })
    .strict(),
]);
export type CollabInvitationCommand = z.infer<typeof collabInvitationCommandSchema>;

/**
 * 课内消息的存放形状（CHAT-01）。
 *
 * `senderType` 保留真人/AI/教师三种取值供**展示**区分，但经由本命令写入的
 * 只允许 `human_learner`：AI 同学的发言走既有 peer_turn 路径、教师输出走
 * 租约执行路径，它们在讨论区的展示由读取侧合并，不经聊天写入口伪造。
 */
export const collabMessageSchema = z
  .object({
    messageId: id,
    roomId: id,
    /** 房间内的权威序号：服务端按追加顺序分配，重连按它补齐。 */
    seq: z.number().int().positive(),
    senderUid: learnerUidSchema,
    senderType: z.enum(['human_learner', 'teacher_ai', 'peer_ai']),
    body: collabText(COLLAB_MESSAGE_MAX_LENGTH),
    /** 去重键：同一 requestId 重试读回既有消息，不追加第二条。 */
    dedupKey: id,
    createdAt: z.string().datetime(),
  })
  .strict();
export type CollabMessageDto = z.infer<typeof collabMessageSchema>;

/** 课内消息追加（CHAT-01）：发送者身份由服务端会话绑定，请求体不能自报他人。 */
export const collabMessageAppendSchema = z
  .object({
    roomId: id,
    senderUid: learnerUidSchema,
    senderType: z.literal('human_learner'),
    body: collabText(COLLAB_MESSAGE_MAX_LENGTH),
    requestId: id,
  })
  .strict();
export type CollabMessageAppendInput = z.infer<typeof collabMessageAppendSchema>;

/**
 * 房间事件的存放形状（SYNC-01）。
 *
 * `summary` 只写「发生了什么」（如「进入场景 3」），不写私人答案、判分与
 * 掌握结论；`seq` 是房间内的单调权威序号，迟到/重复提交按它去重与归并。
 */
export const collabEventSchema = z
  .object({
    eventId: id,
    roomId: id,
    seq: z.number().int().positive(),
    kind: z.enum(COLLAB_EVENT_KINDS),
    actorUid: learnerUidSchema,
    summary: collabText(500),
    createdAt: z.string().datetime(),
  })
  .strict();
export type CollabEventDto = z.infer<typeof collabEventSchema>;

/** 房间事件追加（SYNC-01）：`expectedSeq` 做乐观并发，序号不对即拒绝。 */
export const collabEventAppendSchema = z
  .object({
    roomId: id,
    eventId: id,
    kind: z.enum(COLLAB_EVENT_KINDS),
    actorUid: learnerUidSchema,
    summary: collabText(500),
    expectedSeq: z.number().int().positive(),
    requestId: id,
  })
  .strict();
export type CollabEventAppendInput = z.infer<typeof collabEventAppendSchema>;
