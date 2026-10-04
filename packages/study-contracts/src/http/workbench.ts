import { z } from 'zod';

// —— 工作台总览 ——

export const workbenchStateSchema = z.object({
  project: z.object({
    projectId: z.string(),
    displayName: z.string(),
    displayPath: z.string(),
    generation: z.number().int().nonnegative(),
    subject: z.string(),
    goal: z.string(),
    examDate: z.string().nullable(),
    dailyMinutes: z.number().int().nonnegative(),
    learningMode: z.enum(['beginner', 'review']),
  }),
  counts: z.object({
    materials: z.number().int().nonnegative(),
    knowledgeVerified: z.number().int().nonnegative(),
    knowledgePending: z.number().int().nonnegative(),
    knowledgeInvalidated: z.number().int().nonnegative(),
    /** 候选计数不算知识覆盖数。 */
    proposalsPending: z.number().int().nonnegative(),
    questions: z.number().int().nonnegative(),
    attemptsReal: z.number().int().nonnegative(),
    attemptsSimulation: z.number().int().nonnegative(),
  }),
  plan: z.object({
    confirmedVersion: z.number().int().nullable(),
    taskCount: z.number().int().nonnegative(),
  }),
  /** 演示与验收用的准入摘要，不参与学习统计。 */
  admission: z.object({
    readyKnowledge: z.number().int().nonnegative(),
    blockedBySource: z.number().int().nonnegative(),
  }),
});
export type WorkbenchStateDto = z.infer<typeof workbenchStateSchema>;
