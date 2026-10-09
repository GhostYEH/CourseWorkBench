/**
 * 课程完成页与学习反馈（OMA-033）。
 *
 * 完成状态**只依据本人提交**：未作答不自动标完成，AI/模拟分区不计入。反馈把「客观题判分事实」
 * 与「待人工/模型核对的候选」分开，且明确标注未核实，不更新掌握结论。
 */

import { z } from 'zod';
import { projectScopeSchema } from './api';

const id = z.string().trim().min(1).max(200);

/** 单个知识点的完成事实：依据本人真实提交的题目与判分。 */
export const completionKnowledgeSchema = z
  .object({
    knowledgeId: id,
    /** 本知识点绑定的题目数（来自本版本计划/课件）。 */
    questionCount: z.number().int().nonnegative(),
    /** 本人已提交（真实分区）的题目数。 */
    answeredCount: z.number().int().nonnegative(),
    /** 本人已提交且判为正确（客观题精确判分）的题目数。 */
    correctCount: z.number().int().nonnegative(),
    /** 是否有待人工/模型核对的语义评分候选。 */
    pendingReview: z.boolean(),
    /** 完成状态：只有本人答完全部题目才算 `completed`。 */
    status: z.enum(['not_started', 'in_progress', 'completed']),
  })
  .strict();
export type CompletionKnowledgeDto = z.infer<typeof completionKnowledgeSchema>;

export const courseCompletionSchema = z
  .object({
    lessonId: id,
    lessonVersion: z.number().int().positive(),
    /** 本课程版本引用的知识点完成事实。 */
    knowledge: z.array(completionKnowledgeSchema).max(500),
    totals: z
      .object({
        knowledgeCount: z.number().int().nonnegative(),
        questionCount: z.number().int().nonnegative(),
        answeredCount: z.number().int().nonnegative(),
        correctCount: z.number().int().nonnegative(),
      })
      .strict(),
    /** 整课完成状态：全部知识点 completed 才算 completed；未作答不自动完成。 */
    status: z.enum(['not_started', 'in_progress', 'completed']),
    /** 是否有待核对反馈（不改变完成事实，只提示）。 */
    pendingFeedback: z.number().int().nonnegative(),
    generatedAt: z.string(),
  })
  .strict();
export type CourseCompletionDto = z.infer<typeof courseCompletionSchema>;

/** 读取完成页：只读，不写任何事实。查询参数为扁平的 projectId/generation/lessonId/version。 */
export const courseCompletionQuerySchema = projectScopeSchema
  .extend({
    generation: z.coerce.number().int().nonnegative(),
    lessonId: id,
    version: z.coerce.number().int().positive(),
  })
  .strict();
export type CourseCompletionQueryInput = z.infer<typeof courseCompletionQuerySchema>;
