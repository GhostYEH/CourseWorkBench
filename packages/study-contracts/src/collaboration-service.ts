/**
 * 独立协作服务的在线合同（UID-01 / ROOM-01 / INVITE-01 / SYNC-01 / CHAT-01 的在线部分）。
 *
 * 与 `classroom-collaboration.ts` 的分工：
 * - `classroom-collaboration.ts` 定「两台设备见面时互相承认的命令形状」——邀请/消息/
 *   事件/房间/成员/准备；本机链路与在线链路**共用**这套形状，不另立方言。
 * - 本文件只补「在线」才需要的东西：协议版本与健康检查、本人凭据登记/认证/吊销/恢复、
 *   场景同步命令与房间快照上传/下载的请求形状。
 *
 * 设计要点（见 docs/adr/0005-online-collaboration-service.md）：
 * - UID 是公开标识，**不是**登录凭据；认证由可验证的 `credentialId + secret` 证明本人，
 *   请求体自报身份一律拒绝。
 * - 凭据只留在受控服务/原生配置边界，**不进**浏览器存储、日志、项目快照或导出。
 * - 共享快照只发送经过合同校验的公共投影，剔除测验答案、排序正确顺序、关系正确目标、
 *   评分依据与私人观察；字节/资源摘要与冻结课程版本必须复验。
 */

import { z } from 'zod';
import { learnerUidSchema } from './learner-profile';
import { classroomSharedCourseSchema } from './classroom-room';
import {
  collabText,
  COLLAB_MESSAGE_MAX_LENGTH,
  collabEventSchema,
} from './classroom-collaboration';

const id = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** 凭据秘密：32 字节随机值的十六进制表示（64 位小写十六进制）。 */
const secret = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * 协作协议版本。客户端与服务端握手时必须一致；不一致明确拒绝，不猜测兼容。
 * 变更共享命令形状或认证语义时递增。
 */
export const COLLAB_PROTOCOL_VERSION = 1;

/** 协作服务健康检查与握手：端口、协议版本、实例标识、是否开发模式。 */
export const collabHealthSchema = z
  .object({
    ready: z.literal(true),
    protocolVersion: z.number().int().positive(),
    instanceId: id,
    dev: z.boolean(),
  })
  .strict();
export type CollabHealthDto = z.infer<typeof collabHealthSchema>;

/**
 * 在线登记状态。
 *
 * 与 `collabRegistrationSchema`（本机链路占位，`authority` 固定 `local_link`）的区别：
 * 这里的 `authority` 是 `online`，表示由独立协作服务按凭据认证后的登记。
 * `credentialId` 是公开句柄（可出示），`secret` 本身永不回传、永不落库。
 */
export const collabOnlineRegistrationSchema = z
  .object({
    uid: learnerUidSchema,
    displayName: collabText(80),
    authority: z.literal('online'),
    credentialId: id,
    revision: z.number().int().positive(),
    registeredAt: z.string().datetime(),
  })
  .strict();
export type CollabOnlineRegistrationDto = z.infer<typeof collabOnlineRegistrationSchema>;

/** 凭据记录（服务端持有；对外只暴露句柄与状态，绝不暴露 `secret` 或哈希）。 */
export const collabCredentialSchema = z
  .object({
    credentialId: id,
    uid: learnerUidSchema,
    status: z.enum(['active', 'revoked']),
    createdAt: z.string().datetime(),
    revokedAt: z.string().datetime().nullable(),
  })
  .strict();
export type CollabCredentialDto = z.infer<typeof collabCredentialSchema>;

/**
 * 在线登记命令。
 *
 * 首次登记：管理员按 UID 预置一次性 activationToken，客户端生成 credentialId 与 secret；
 * 服务端验证并原子消耗激活令牌，只存秘密哈希。
 * 追加/轮换凭据：同一 UID 必须带一个**已存在的有效凭据**证明归属（`proofCredentialId`
 * + `proofSecret`），否则拒绝——知道 UID 不能替他人登记。
 */
export const collabOnlineRegisterCommandSchema = z
  .object({
    uid: learnerUidSchema,
    displayName: collabText(80),
    credentialId: id,
    secret,
    /** 首次登记由服务管理员线下签发，绑定该 UID；不能用公开 UID 抢注。 */
    activationToken: secret.optional(),
    /** 追加/轮换时证明本人归属；首次登记为 null。 */
    proof: z.object({ credentialId: id, secret }).strict().nullable().default(null),
    requestId: id,
  })
  .strict();
export type CollabOnlineRegisterCommandInput = z.infer<typeof collabOnlineRegisterCommandSchema>;

/** 认证命令：用凭据换取服务端会话令牌。 */
export const collabSessionCommandSchema = z
  .object({
    credentialId: id,
    secret,
    requestId: id,
  })
  .strict();
export type CollabSessionCommandInput = z.infer<typeof collabSessionCommandSchema>;

/** 会话结果：令牌只在内存/受控边界使用，不在界面展示。 */
export const collabSessionSchema = z
  .object({
    token: id,
    uid: learnerUidSchema,
    credentialId: id,
    protocolVersion: z.number().int().positive(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type CollabSessionDto = z.infer<typeof collabSessionSchema>;

/** 吊销凭据命令：只有本人（已认证会话）能吊销自己的凭据。 */
export const collabCredentialRevokeCommandSchema = z
  .object({
    credentialId: id,
    actorUid: learnerUidSchema,
    requestId: id,
  })
  .strict();
export type CollabCredentialRevokeCommandInput = z.infer<
  typeof collabCredentialRevokeCommandSchema
>;

/**
 * 结构化场景同步命令（SYNC-01 在线部分）。
 *
 * 取代「只有 summary 的摘要事件」：目标 `sceneId`、课程身份、房间 `revision`、
 * `expectedSeq` 与唯一教师执行权都由服务复验，场景转换、房间状态与事件收据
 * 在**同一事务**内原子提交。
 */
export const collabSceneSyncCommandSchema = z
  .object({
    roomId: id,
    actorUid: learnerUidSchema,
    sceneId: id,
    lessonId: id,
    lessonVersion: z.number().int().positive(),
    /** 客户端读到的房间版本；服务端已推进即拒绝（乐观并发）。 */
    expectedRevision: z.number().int().positive(),
    /** 客户端读到的权威尾序号；服务端推进场景会追加一条 `scene_changed` 事件。 */
    expectedSeq: z.number().int().positive(),
    eventId: id,
    requestId: id,
  })
  .strict();
export type CollabSceneSyncCommandInput = z.infer<typeof collabSceneSyncCommandSchema>;

/** 场景同步结果：推进后的房间与事务内事件。 */
export const collabSceneSyncResultSchema = z
  .object({
    room: z
      .object({
        roomId: id,
        status: z.enum(['ready', 'active', 'ended']),
        revision: z.number().int().positive(),
        currentSceneId: id,
        updatedAt: z.string().datetime(),
      })
      .strict(),
    event: collabEventSchema,
    deduplicated: z.boolean(),
  })
  .strict();
export type CollabSceneSyncResultDto = z.infer<typeof collabSceneSyncResultSchema>;

/**
 * 共享快照上传命令（ROOM-01 的双端消费者）。
 *
 * `snapshot` 必须是通过 `classroomSharedCourseSchema` 校验的公共投影；服务端
 * 复验 `snapshotDigest` 与邀请时冻结的课程身份一致后才写入，不接收任意载荷。
 */
export const collabSnapshotUploadSchema = z
  .object({
    roomId: id,
    actorUid: learnerUidSchema,
    snapshot: classroomSharedCourseSchema,
    snapshotDigest: digest,
    requestId: id,
  })
  .strict();
export type CollabSnapshotUploadInput = z.infer<typeof collabSnapshotUploadSchema>;

/** 快照下载结果：房间冻结的那一份公共投影与摘要。 */
export const collabSnapshotViewSchema = z
  .object({
    roomId: id,
    snapshotDigest: digest,
    snapshot: classroomSharedCourseSchema.nullable(),
  })
  .strict();
export type CollabSnapshotViewDto = z.infer<typeof collabSnapshotViewSchema>;

/**
 * 界面→本地服务的在线命令（ADR-0005 的受控客户端入口）。
 *
 * 这一层只表达「用户想做什么」；本人 UID 与（场景命令的）课程身份由本地服务按会话与
 * 在线房间补齐，不由界面自报。`publish-snapshot` 的载荷（公共投影）也由本地服务从
 * 本地冻结课程读出，界面只发起意图。
 */
export const collabOnlineCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enable'), requestId: id }).strict(),
  z.object({ action: z.literal('revoke-credential'), requestId: id }).strict(),
  z
    .object({
      action: z.literal('invite'),
      roomId: id,
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
      decision: z.enum(['accepted', 'rejected']),
      requestId: id,
    })
    .strict(),
  z.object({ action: z.literal('revoke'), invitationId: id, requestId: id }).strict(),
  z
    .object({
      action: z.literal('readiness'),
      roomId: id,
      readiness: z.enum(['pending', 'ready', 'left']),
      requestId: id,
    })
    .strict(),
  z.object({ action: z.literal('start'), roomId: id, requestId: id }).strict(),
  z
    .object({
      action: z.literal('message'),
      roomId: id,
      body: collabText(COLLAB_MESSAGE_MAX_LENGTH),
      requestId: id,
    })
    .strict(),
  z
    .object({
      action: z.literal('scene'),
      roomId: id,
      sceneId: id,
      expectedRevision: z.number().int().positive(),
      expectedSeq: z.number().int().positive(),
      eventId: id,
      requestId: id,
    })
    .strict(),
  z.object({ action: z.literal('publish-snapshot'), roomId: id, requestId: id }).strict(),
]);
export type CollabOnlineCommand = z.infer<typeof collabOnlineCommandSchema>;
