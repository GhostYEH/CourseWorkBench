import { z } from 'zod';
import { assessmentGradingSchema } from '../assessment';
import { ACTOR_TYPE } from '../status';
import { ATTEMPT_KIND } from '../status';
import { MASTERY_STATUS } from '../status';
import { RECORD_SCOPE } from '../status';
import { projectScopeSchema } from './project';

// —— 作答 ——

export const attemptSubmitSchema = z.object({
  scope: projectScopeSchema,
  questionId: z.string().min(1),
  /** 客户端生成的幂等键：重复请求读取既有收据，不重复写入。 */
  idempotencyKey: z.string().min(8),
  actorType: z.enum(ACTOR_TYPE),
  answerText: z.string().default(''),
  /** 解题过程；缺失时通常无法确定具体错因。 */
  processText: z.string().default(''),
  kind: z.enum(ATTEMPT_KIND).default('real'),
});
export type AttemptSubmitInput = z.infer<typeof attemptSubmitSchema>;

export const attemptSchema = z.object({
  questionRevision: z.number().int().positive().nullable().default(null),
  answerVersion: z.number().int().positive().nullable().default(null),
  grading: assessmentGradingSchema.nullable().default(null),
  recordScope: z.enum(RECORD_SCOPE),
  attemptId: z.string(),
  questionId: z.string(),
  kind: z.enum(ATTEMPT_KIND),
  actorType: z.enum(ACTOR_TYPE),
  answerText: z.string(),
  processText: z.string(),
  submittedAt: z.string(),
  deduplicated: z.boolean(),
  /** 真实作答才可能更新掌握状态；模拟作答始终为 null。 */
  masteryAfter: z.enum(MASTERY_STATUS).nullable(),
  /** 缺少过程时允许待确认。 */
  attributionStatus: z.enum(['pending_process', 'proposed']),
});
export type AttemptDto = z.infer<typeof attemptSchema>;
