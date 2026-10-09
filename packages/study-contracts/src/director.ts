import { z } from 'zod';
import { projectScopeSchema } from './api';

const id = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const directorStepSchema = z
  .object({
    stepId: id,
    sceneId: id,
    sceneType: z.enum(['slide', 'quiz', 'interactive', 'pbl']),
    role: z.enum(['teacher', 'peer', 'learner']),
    roleProfileId: id.nullable(),
    roleName: z.string().max(100),
    statementIds: z.array(id).max(40),
    state: z.enum([
      'queued',
      'started',
      'pending_review',
      'approved',
      'rejected',
      'delivered',
      'skipped',
      'failed',
      'unknown',
      'awaiting_learner',
    ]),
    generationRequestId: id,
    candidate: z
      .object({
        text: z.string().min(2).max(4000),
        explanationId: id.nullable(),
        digest,
        review: z.enum(['pending', 'approved', 'rejected']),
        reviewNote: z.string().max(1000),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type DirectorStepDto = z.infer<typeof directorStepSchema>;

export const directorStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    directorId: id,
    projectId: id,
    learnerUid: id,
    sessionId: id,
    runId: id,
    lessonId: id,
    lessonVersion: z.number().int().positive(),
    bundleDigest: digest,
    documentDigest: digest,
    roleDigest: digest,
    stageId: id,
    sceneIds: z.array(id).min(1).max(48),
    sceneIndex: z.number().int().nonnegative().max(47),
    state: z.enum([
      'ready',
      'running',
      'paused',
      'awaiting_review',
      'awaiting_learner',
      'unknown',
      'completed',
      'stopped',
    ]),
    steps: z.array(directorStepSchema).min(1).max(144),
    message: z.string().max(1000),
    receipts: z.array(z.object({ requestId: id, intent: digest }).strict()).max(1000),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type DirectorStateDto = z.infer<typeof directorStateSchema>;
const base = { scope: projectScopeSchema, sessionId: id, requestId: id };
export const directorCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('start') }).strict(),
  z.object({ ...base, action: z.literal('continue') }).strict(),
  z.object({ ...base, action: z.literal('pause') }).strict(),
  z.object({ ...base, action: z.literal('stop') }).strict(),
  z
    .object({
      ...base,
      action: z.literal('review'),
      stepId: id,
      candidateDigest: digest,
      decision: z.enum(['approved', 'rejected']),
      semanticReviewed: z.boolean(),
      note: z.string().trim().max(1000).default(''),
    })
    .strict(),
]);
export type DirectorCommandDto = z.infer<typeof directorCommandSchema>;
export const directorViewSchema = z.object({ director: directorStateSchema.nullable() }).strict();
