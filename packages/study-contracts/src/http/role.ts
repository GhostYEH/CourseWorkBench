import { z } from 'zod';
import { RECORD_SCOPE } from '../status';
import { ROLE_EXPLANATION } from '../status';
import { ROLE_KIND } from '../status';
import { projectScopeSchema } from './project';

// —— 角色档案（教师与同学配置；不承载掌握事实）——

/**
 * 权限位由服务端按 kind 派生。
 *
 * 写入 schema 里刻意没有这些字段：客户端提交 `permissions` 会被 strict 拒绝，
 * 因此不存在「偏好改成权限」的路径。同学永远不能代表本人作答，AI 身份始终可见。
 */
export const rolePermissionsSchema = z.object({
  whiteboardWrite: z.boolean(),
  answerAsLearner: z.literal(false),
  speak: z.boolean(),
  aiIdentityVisible: z.literal(true),
});
export type RolePermissionsDto = z.infer<typeof rolePermissionsSchema>;

export const roleProfileSchema = z.object({
  profileId: z.string(),
  kind: z.enum(ROLE_KIND),
  name: z.string(),
  persona: z.string(),
  explanation: z.enum(ROLE_EXPLANATION),
  configVersion: z.number().int().positive(),
  recordScope: z.enum(RECORD_SCOPE),
  permissions: rolePermissionsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RoleProfileDto = z.infer<typeof roleProfileSchema>;

const roleProfileFields = {
  name: z.string().min(1).max(40),
  persona: z.string().max(300),
  explanation: z.enum(ROLE_EXPLANATION),
};

export const roleCreateSchema = z
  .object({ scope: projectScopeSchema, kind: z.enum(ROLE_KIND), ...roleProfileFields })
  .strict();
export type RoleCreateInput = z.infer<typeof roleCreateSchema>;

export const roleUpdateSchema = z
  .object({ scope: projectScopeSchema, profileId: z.string().min(1), ...roleProfileFields })
  .strict();
export type RoleUpdateInput = z.infer<typeof roleUpdateSchema>;

export const roleDeleteSchema = z
  .object({ scope: projectScopeSchema, profileId: z.string().min(1) })
  .strict();
export type RoleDeleteInput = z.infer<typeof roleDeleteSchema>;
