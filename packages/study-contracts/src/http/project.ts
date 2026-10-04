import { z } from 'zod';

/** 所有领域请求都携带项目身份；服务端据此校验打开代次。 */
export const projectScopeSchema = z.object({
  projectId: z.string().min(1),
  generation: z.number().int().nonnegative(),
});
export type ProjectScope = z.infer<typeof projectScopeSchema>;

/** 项目设置写入：始终与打开项目代次绑定，并至少包含一个设置字段。 */
export const projectSettingsPatchSchema = z
  .object({
    scope: projectScopeSchema,
    displayName: z.string().min(1).max(120).optional(),
    subject: z.string().max(60).optional(),
    goal: z.string().max(500).optional(),
    examDate: z.string().max(20).nullable().optional(),
    dailyMinutes: z.number().int().min(0).max(720).optional(),
    learningMode: z.enum(['beginner', 'review']).optional(),
  })
  .refine(
    (value) => Object.entries(value).some(([key, entry]) => key !== 'scope' && entry !== undefined),
    { message: '至少需要提供一个项目设置字段' },
  );
export type ProjectSettingsPatchInput = z.infer<typeof projectSettingsPatchSchema>;
