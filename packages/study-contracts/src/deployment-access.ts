/**
 * 共享部署的访问码与部署能力接口（OMA-083）。
 *
 * 目标：让一个自托管部署可以**明确授权**外部成员接入，同时保证私密项目默认不公开、访问码只存哈希、
 * 可撤销、可设有效期。设计要点：
 * - 访问码是**高熵一次性/限时**凭据，数据库只保存 SHA-256 哈希；明文仅在签发时返回一次。
 * - 访问码只授予「登记/接入」能力，**不**代替本人凭据认证；接入后仍需正常登记本人凭据。
 * - 明确 scope：`join`（加入部署）、`guest`（只读访客）——不默认授予管理或发布权限。
 * - 撤销/过期后立即失效；纯判定函数与 HTTP 层共用同一份规则。
 */

import { z } from 'zod';

export const DEPLOYMENT_ACCESS_SCOPES = ['join', 'guest'] as const;
export type DeploymentAccessScope = (typeof DEPLOYMENT_ACCESS_SCOPES)[number];

/** 访问码前缀，便于识别与日志脱敏。 */
export const DEPLOYMENT_ACCESS_CODE_PREFIX = 'sewac_';
/** 访问码有效期上限（天）。 */
export const DEPLOYMENT_ACCESS_MAX_TTL_DAYS = 90;
/** 默认有效期（天）。 */
export const DEPLOYMENT_ACCESS_DEFAULT_TTL_DAYS = 7;

const id = z.string().trim().min(1).max(200);
const date = z.string().datetime();

/** 访问码的公开元数据：绝不含明文或哈希。 */
export const deploymentAccessCodeSchema = z
  .object({
    codeId: id,
    label: z.string().trim().min(1).max(80),
    projectId: id,
    scopes: z.array(z.enum(DEPLOYMENT_ACCESS_SCOPES)).min(1).max(DEPLOYMENT_ACCESS_SCOPES.length),
    createdAt: date,
    expiresAt: date,
    revokedAt: date.nullable(),
    /** 已使用次数；访问码可复用直到过期或撤销。 */
    usedCount: z.number().int().nonnegative(),
  })
  .strict();
export type DeploymentAccessCodeDto = z.infer<typeof deploymentAccessCodeSchema>;

/** 签发返回：公开元数据 + 仅此一次的明文访问码。 */
export const deploymentAccessCodeIssuedSchema = z
  .object({
    code: deploymentAccessCodeSchema,
    /** 明文访问码；签发后服务端不再保存。 */
    secret: z.string().min(32).max(200),
  })
  .strict();
export type DeploymentAccessCodeIssuedDto = z.infer<typeof deploymentAccessCodeIssuedSchema>;

export const deploymentAccessCodeViewSchema = z
  .object({
    codes: z.array(deploymentAccessCodeSchema).max(256),
    issued: deploymentAccessCodeIssuedSchema.nullable().default(null),
    deduplicated: z.boolean().default(false),
  })
  .strict();
export type DeploymentAccessCodeViewDto = z.infer<typeof deploymentAccessCodeViewSchema>;

/** 管理命令（本机认证 session 专用）：签发/撤销/列出访问码。 */
export const deploymentAccessCodeCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('issue'),
      requestId: id,
      label: z.string().trim().min(1).max(80),
      scopes: z.array(z.enum(DEPLOYMENT_ACCESS_SCOPES)).min(1).max(DEPLOYMENT_ACCESS_SCOPES.length),
      ttlDays: z
        .number()
        .int()
        .min(1)
        .max(DEPLOYMENT_ACCESS_MAX_TTL_DAYS)
        .default(DEPLOYMENT_ACCESS_DEFAULT_TTL_DAYS),
    })
    .strict(),
  z.object({ action: z.literal('revoke'), requestId: id, codeId: id }).strict(),
  z.object({ action: z.literal('list') }).strict(),
]);
export type DeploymentAccessCodeCommand = z.infer<typeof deploymentAccessCodeCommandSchema>;

/** 用访问码换取「部署接入授权」的请求：访问码 + 本人 UID + 目的 scope。 */
export const deploymentRedeemSchema = z
  .object({
    codeId: id.nullable(),
    /** 明文访问码；服务端按哈希反查。 */
    secret: z.string().min(32).max(200),
    uid: id,
    scope: z.enum(DEPLOYMENT_ACCESS_SCOPES),
    requestId: id,
  })
  .strict();
export type DeploymentRedeemInput = z.infer<typeof deploymentRedeemSchema>;

/** 兑换结果：授权事实（不含访问码明文）。 */
export const deploymentRedeemResultSchema = z
  .object({
    codeId: id,
    projectId: id,
    uid: id,
    scope: z.enum(DEPLOYMENT_ACCESS_SCOPES),
    redeemedAt: date,
  })
  .strict();
export type DeploymentRedeemResultDto = z.infer<typeof deploymentRedeemResultSchema>;

/** 部署能力接口：供宿主扩展点查询「本部署是否开放接入、开放了哪些 scope」。 */
export const deploymentCapabilitySchema = z
  .object({
    projectId: id,
    /** 是否至少有一个当前有效的访问码。 */
    open: z.boolean(),
    /** 当前有效访问码允许的 scope 并集。 */
    scopes: z.array(z.enum(DEPLOYMENT_ACCESS_SCOPES)),
    /** 私密项目默认不公开：为真时任何访问码都不应开放对外接入。 */
    privateByDefault: z.boolean(),
  })
  .strict();
export type DeploymentCapabilityDto = z.infer<typeof deploymentCapabilitySchema>;
