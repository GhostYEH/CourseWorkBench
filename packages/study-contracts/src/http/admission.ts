import { z } from 'zod';
import { projectScopeSchema } from './project';

// —— 生成准入 ——

export const admissionCheckSchema = z.object({
  scope: projectScopeSchema,
  knowledgeIds: z.array(z.string()).min(1),
});
export type AdmissionCheckInput = z.infer<typeof admissionCheckSchema>;

export const admissionResultSchema = z.object({
  allowed: z.boolean(),
  /** 允许进入生成的知识点（已核实、未失效、范围合规、前置满足）。 */
  admitted: z.array(z.string()),
  blocked: z.array(
    z.object({
      knowledgeId: z.string(),
      code: z.string(),
      message: z.string(),
      /** 缺什么材料，界面据此显示补材料入口。 */
      missing: z.array(z.string()),
    }),
  ),
});
export type AdmissionResultDto = z.infer<typeof admissionResultSchema>;
