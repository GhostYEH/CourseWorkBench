import { z } from 'zod';
import { projectScopeSchema } from './api';
import { learnerUidSchema } from './learner-profile';
import { pblBindingSchema } from './formal-interaction-pbl';

/** Only a request to the guarded provider, never client-authored AI output. */
export const pblMentorCommandSchema = z
  .object({
    scope: projectScopeSchema,
    binding: pblBindingSchema,
    actorUid: learnerUidSchema,
    requestId: z.string().trim().min(1).max(200),
    kind: z.enum(['feedback', 'assessment', 'contribution']),
    roleId: z.string().min(1).max(200),
    taskId: z.string().min(1).max(200),
    milestoneId: z.string().min(1).max(200).nullable(),
    artifactIds: z.array(z.string().min(1).max(200)).min(1).max(20),
    question: z.string().trim().min(1).max(1000),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (new Set(input.artifactIds).size !== input.artifactIds.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['artifactIds'], message: '产物不能重复' });
    if (input.kind === 'assessment' && input.milestoneId === null)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['milestoneId'],
        message: '评价必须选择里程碑',
      });
  });
export type PblMentorCommandInput = z.infer<typeof pblMentorCommandSchema>;
