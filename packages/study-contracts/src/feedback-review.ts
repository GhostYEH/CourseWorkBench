import { z } from 'zod';
import { projectScopeSchema, attemptSchema, evidenceRefSchema } from './api';
import { modelGenerationResultSchema } from './model-connection';

const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(8000);
export const errorTagSchema = z.enum(['concept', 'method', 'calculation', 'reading', 'memory', 'time', 'unknown']);
export const processEvidenceSchema = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: text }).strict();
export const errorConclusionSchema = z.object({ tags: z.array(errorTagSchema).min(1).max(7), explanation: text,
  evidence: z.array(processEvidenceSchema).max(20), uncertainty: text }).strict();
export const feedbackEntrySchema = z.object({ entryId: id, action: z.enum(['propose', 'review', 'correct', 'retry', 'draft', 'confirm', 'complete']),
  origin: z.enum(['manual', 'model']).default('manual'),
  version: z.number().int().positive(), candidateId: id.nullable(), conclusion: errorConclusionSchema.nullable(),
  correction: z.string(), retryAttemptId: id.nullable(), createdAt: z.string().datetime() }).strict();
export const feedbackSnapshotSchema = z.object({ questionId: id, questionRevision: z.number().int().positive(), answerVersion: z.number().int().positive().nullable(),
  stem: z.string(), answer: z.string(), solution: z.string(), rubric: z.string(), originLabel: z.string(),
  knowledgeIds: z.array(id), evidence: z.array(z.object({ knowledgeId: id, revision: z.number().int().nonnegative(),
    references: z.array(evidenceRefSchema.extend({ fingerprint: z.string().optional(), excerpt: z.string().optional() }).strict()) }).strict()),
  answerText: z.string(), processText: z.string() }).strict();
export const feedbackContextSchema = z.object({ attemptId: id, snapshot: feedbackSnapshotSchema, version: z.number().int().nonnegative(),
  entries: z.array(feedbackEntrySchema), canWrite: z.boolean(), blockedReason: z.string().nullable() }).strict();
export const reviewTaskSchema = z.object({ taskId: id, attemptId: id, uid: id, questionId: id, questionRevision: z.number().int().positive(),
  origin: z.enum(['manual', 'model']).default('manual'),
  dueAt: z.string().datetime(), reason: text, status: z.enum(['draft', 'confirmed', 'completed']),
  createdAt: z.string().datetime(), confirmedAt: z.string().datetime().nullable(), completedAt: z.string().datetime().nullable(),
  completionAttemptId: id.nullable(), version: z.number().int().nonnegative(), watermark: z.number().int().nonnegative() }).strict();
const base = { scope: projectScopeSchema.strict(), attemptId: id, expectedVersion: z.number().int().nonnegative(), requestId: id };
export const feedbackReviewCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('propose'), conclusion: errorConclusionSchema }).strict(),
  z.object({ ...base, action: z.literal('review'), candidateId: id.nullable(), conclusion: errorConclusionSchema, semanticReviewed: z.literal(true) }).strict(),
  z.object({ ...base, action: z.literal('correct'), correction: text }).strict(),
  z.object({ ...base, action: z.literal('retry'), retryAttemptId: id }).strict(),
  z.object({ ...base, action: z.literal('draft'), dueAt: z.string().datetime(), reason: text }).strict(),
  z.object({ ...base, action: z.literal('confirm'), taskId: id, semanticReviewed: z.literal(true) }).strict(),
  z.object({ ...base, action: z.literal('complete'), taskId: id, completionAttemptId: id }).strict(),
]);
export const feedbackResultSchema = z.object({ context: feedbackContextSchema, tasks: z.array(reviewTaskSchema), deduplicated: z.boolean() }).strict();
export const feedbackModelInputSchema = z.object({ scope: projectScopeSchema.strict(), attemptId: id,
  expectedVersion: z.number().int().nonnegative(), requestId: id,
  purpose: z.enum(['error_attribution', 'review_suggestion']) }).strict();
export const feedbackModelResultSchema = z.object({ generation: modelGenerationResultSchema, feedback: feedbackResultSchema }).strict();
export const reviewSuggestionOutputSchema = z.object({ dueInDays: z.number().int().min(1).max(30), reason: text }).strict();
export type FeedbackModelInput = z.infer<typeof feedbackModelInputSchema>;
export type FeedbackModelResultDto = z.infer<typeof feedbackModelResultSchema>;
export const personalAttemptSubmitResultSchema = z.object({ attempt: attemptSchema, deduplicated: z.boolean(), forcedSimulation: z.boolean() }).strict();
export type FeedbackReviewCommand = z.infer<typeof feedbackReviewCommandSchema>;
export type FeedbackContextDto = z.infer<typeof feedbackContextSchema>;
export type ReviewTaskDto = z.infer<typeof reviewTaskSchema>;
