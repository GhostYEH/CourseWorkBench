/**
 * Pro 外部任务 API 的凭据与合同（OMA-017）。
 *
 * 外部调用者（脚本、其他工作台）通过**高熵 bearer token** 访问一个受控子集，而不是本机桌面
 * 会话凭据。设计要点：
 * - token 只在**创建时展示一次**明文；数据库只保存 SHA-256 哈希，列表/读取永不回显 secret 或哈希。
 * - token 绑定 owner（本人 uid）与 projectId，携带有效期与 action scopes；可撤销、可轮换。
 * - 外部**最小 scope 只 read/create/send**：不默认授予工具执行、审核或发布权限。
 * - 项目 ID 与 generation 不是凭据：外部命令不携带 scope，服务端从 token 解析归属，再与当前
 *   打开项目核对。
 */

import { z } from 'zod';
import { projectScopeSchema } from './api';

/** 外部 token 允许授予的最小 action scopes。刻意不含工具执行/审核/发布。 */
export const PRO_EXTERNAL_SCOPES = ['read', 'create', 'send'] as const;
export type ProExternalScope = (typeof PRO_EXTERNAL_SCOPES)[number];

/** 外部 bearer token 前缀；便于识别与日志脱敏。 */
export const PRO_EXTERNAL_TOKEN_PREFIX = 'sewpro_';
/** token 有效期上限（天）。 */
export const PRO_EXTERNAL_MAX_TTL_DAYS = 365;
/** 默认有效期（天）。 */
export const PRO_EXTERNAL_DEFAULT_TTL_DAYS = 30;

const id = z.string().trim().min(1).max(200);
const date = z.string().datetime();

/** token 的公开元数据：绝不含 secret 或哈希。 */
export const proExternalTokenSchema = z
  .object({
    tokenId: id,
    label: z.string().trim().min(1).max(80),
    projectId: id,
    ownerUid: id,
    scopes: z.array(z.enum(PRO_EXTERNAL_SCOPES)).min(1).max(PRO_EXTERNAL_SCOPES.length),
    createdAt: date,
    expiresAt: date,
    /** 撤销时间；未撤销为 null。 */
    revokedAt: date.nullable(),
  })
  .strict();
export type ProExternalTokenDto = z.infer<typeof proExternalTokenSchema>;

/** 创建/轮换返回：公开元数据 + **仅此一次**的明文 token。 */
export const proExternalTokenIssuedSchema = z
  .object({
    token: proExternalTokenSchema,
    /** 明文 bearer token；创建后服务端不再保存，界面必须提示用户立即保存。 */
    secret: z.string().min(32).max(200),
  })
  .strict();
export type ProExternalTokenIssuedDto = z.infer<typeof proExternalTokenIssuedSchema>;

/** token 管理命令（本机认证 session 专用）。 */
export const proExternalTokenCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...{ scope: projectScopeSchema, requestId: id },
      action: z.literal('create'),
      label: z.string().trim().min(1).max(80),
      scopes: z.array(z.enum(PRO_EXTERNAL_SCOPES)).min(1).max(PRO_EXTERNAL_SCOPES.length),
      ttlDays: z.number().int().min(1).max(PRO_EXTERNAL_MAX_TTL_DAYS).default(PRO_EXTERNAL_DEFAULT_TTL_DAYS),
    })
    .strict(),
  z
    .object({
      ...{ scope: projectScopeSchema, requestId: id },
      action: z.literal('rotate'),
      tokenId: id,
      ttlDays: z.number().int().min(1).max(PRO_EXTERNAL_MAX_TTL_DAYS).default(PRO_EXTERNAL_DEFAULT_TTL_DAYS),
    })
    .strict(),
  z
    .object({
      ...{ scope: projectScopeSchema, requestId: id },
      action: z.literal('revoke'),
      tokenId: id,
    })
    .strict(),
  z.object({ ...{ scope: projectScopeSchema }, action: z.literal('list') }).strict(),
]);
export type ProExternalTokenCommand = z.infer<typeof proExternalTokenCommandSchema>;

export const proExternalTokensViewSchema = z
  .object({
    tokens: z.array(proExternalTokenSchema).max(256),
    /** 创建/轮换时给出一次性明文；其余情况为 null。 */
    issued: proExternalTokenIssuedSchema.nullable().default(null),
    deduplicated: z.boolean().default(false),
  })
  .strict();
export type ProExternalTokensViewDto = z.infer<typeof proExternalTokensViewSchema>;

/**
 * 外部任务命令：**不携带 scope**，服务端从 bearer token 解析 projectId/owner，再与当前打开项目核对。
 * 动作被收口到最小 scope 能表达的范围：读会话、创建会话、发送消息。工具执行/审核/接管等
 * 不在合同里，外部调用者无从表达。
 */
export const proExternalCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), requestId: id }).strict(),
  z.object({ action: z.literal('get'), requestId: id, sessionId: id }).strict(),
  z
    .object({
      action: z.literal('create'),
      requestId: id,
      title: z.string().trim().min(1).max(120),
    })
    .strict(),
  z
    .object({
      action: z.literal('send'),
      requestId: id,
      sessionId: id,
      expectedRevision: z.number().int().nonnegative(),
      content: z.string().trim().min(1).max(4000),
      bundleId: id,
      bundleDigest: z.string().regex(/^[a-f0-9]{64}$/),
      skillIds: z.array(id).max(24),
    })
    .strict(),
]);
export type ProExternalCommand = z.infer<typeof proExternalCommandSchema>;

/** 每个外部动作所需的 scope（服务端据此判定 token 是否越权）。 */
export const PRO_EXTERNAL_ACTION_SCOPE: Record<ProExternalCommand['action'], ProExternalScope> = {
  list: 'read',
  get: 'read',
  create: 'create',
  send: 'send',
};
