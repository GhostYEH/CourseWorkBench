import { z } from 'zod';
import { projectScopeSchema } from './api';
import { assessmentGradingSchema } from './assessment';

const text = z.string().trim().min(1).max(8000);
const version = z.number().int().nonnegative();
export const attemptGradeCandidateSchema = z.object({
  candidateId: z.string().min(1), attemptId: z.string().min(1), questionRevision: z.number().int().positive(),
  answerVersion: z.number().int().positive(), expectedReviewVersion: version,
  proposedEarned: z.number().nonnegative().nullable(), basis: text, uncertainty: text,
  status: z.enum(['pending', 'approved', 'rejected']), requestedModel: z.string().nullable(),
  runId: z.string().min(1), createdAt: z.string(), reviewNote: z.string(),
}).strict();
export const attemptGradeReviewSchema = z.object({
  reviewId: z.string().min(1), attemptId: z.string().min(1), reviewVersion: z.number().int().positive(),
  questionRevision: z.number().int().positive(), answerVersion: z.number().int().positive(),
  grading: assessmentGradingSchema, basis: text, uncertainty: text,
  source: z.enum(['manual', 'model_reviewed']), candidateId: z.string().nullable(),
  reviewer: z.literal('local_user'), masteryApplied: z.boolean(), createdAt: z.string(),
  appliedKnowledgeIds: z.array(z.string()).optional(), skippedKnowledgeIds: z.array(z.string()).optional(),
}).strict().refine(value => {
  if (value.appliedKnowledgeIds === undefined && value.skippedKnowledgeIds === undefined) return true; // Existing v17 history.
  if (!value.appliedKnowledgeIds || !value.skippedKnowledgeIds) return false;
  const all = [...value.appliedKnowledgeIds, ...value.skippedKnowledgeIds];
  return value.masteryApplied === (value.appliedKnowledgeIds.length > 0) && new Set(all).size === all.length;
}, 'Invalid mastery application facts');
export const attemptGradingContextSchema = z.object({
  attemptId: z.string(), questionId: z.string(), questionRevision: z.number().int().positive(), answerVersion: z.number().int().positive(),
  stem: z.string(), answerText: z.string(), processText: z.string(), referenceAnswer: z.string(), solution: z.string(), rubric: z.string(),
  maxScore: z.number().positive(), submissionGrading: assessmentGradingSchema, effectiveGrading: assessmentGradingSchema,
  currentReviewVersion: version, reviews: z.array(attemptGradeReviewSchema), candidates: z.array(attemptGradeCandidateSchema),
  knowledgeIds: z.array(z.string()), canReview: z.boolean(), reviewBlockedReason: z.string().nullable(),
}).strict();
const base = { scope: projectScopeSchema.strict(), attemptId: z.string().min(1), expectedReviewVersion: version, requestId: z.string().trim().min(1).max(200) };
export const attemptGradingCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('generate') }).strict(),
  z.object({ ...base, action: z.literal('review'), earned: z.number().nonnegative().max(1000), basis: text, uncertainty: text,
    semanticReviewed: z.literal(true), candidateId: z.string().min(1).nullable() }).strict(),
  z.object({ ...base, action: z.literal('reject'), candidateId: z.string().min(1), note: text }).strict(),
]);
export type AttemptGradeCandidateDto = z.infer<typeof attemptGradeCandidateSchema>;
export type AttemptGradeReviewDto = z.infer<typeof attemptGradeReviewSchema>;
export type AttemptGradingContextDto = z.infer<typeof attemptGradingContextSchema>;
export type AttemptGradingCommand = z.infer<typeof attemptGradingCommandSchema>;
