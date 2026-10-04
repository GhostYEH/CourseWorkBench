import { z } from 'zod';

export const questionAssessmentMetadataSchema = z.object({
  type: z.enum(['single', 'multiple', 'short_answer']),
  options: z.array(z.object({ value: z.string().trim().min(1).max(80), label: z.string().trim().min(1).max(2000) }).strict()).max(40),
  maxScore: z.number().positive().max(1000),
  answerVersion: z.literal(1),
}).strict();
export const questionAssessmentSchema = questionAssessmentMetadataSchema.extend({
  schemaVersion: z.literal(1), correctAnswers: z.array(z.string().min(1)).max(40),
  rubric: z.string().max(4000),
}).superRefine((value, ctx) => {
  const keys = value.options.map((option) => option.value);
  const unique = new Set(keys);
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (unique.size !== keys.length) fail('选项编号不能重复');
  if (new Set(value.correctAnswers).size !== value.correctAnswers.length) fail('答案编号不能重复');
  if (value.type === 'short_answer') {
    if (keys.length || value.correctAnswers.length || !value.rubric.trim()) fail('简答题须填写评分标准且不能填写选择题选项或答案集');
  } else {
    if (keys.length < 2) fail('选择题至少需要两个选项');
    if (value.correctAnswers.some((answer) => !unique.has(answer))) fail('答案须属于选项');
    if (value.type === 'single' ? value.correctAnswers.length !== 1 : value.correctAnswers.length === 0) fail('答案集与题型不匹配');
  }
});
export type QuestionAssessmentDto = z.infer<typeof questionAssessmentSchema>;
export type QuestionAssessmentMetadataDto = z.infer<typeof questionAssessmentMetadataSchema>;
export const assessmentGradingSchema = z.object({
  status: z.enum(['correct', 'incorrect', 'pending_review']), correct: z.boolean().nullable(),
  earned: z.number().nonnegative().nullable(), maxScore: z.number().nonnegative(),
  answerVersion: z.number().int().positive().nullable(), basis: z.string(),
}).strict().superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (value.earned !== null && value.earned > value.maxScore) fail('得分不能超过总分');
  if (value.status === 'pending_review') {
    if (value.correct !== null || value.earned !== null) fail('待判分记录不能带确定结论或得分');
  } else if (value.correct !== (value.status === 'correct') || value.earned === null) {
    fail('判分状态、正确性与得分不一致');
  }
});
export type AssessmentGradingDto = z.infer<typeof assessmentGradingSchema>;

export const selectedAnswerSetSchema = z.array(z.string().min(1)).min(1).max(40);
