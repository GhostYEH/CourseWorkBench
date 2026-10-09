import { z } from 'zod';
import { projectScopeSchema } from './api';

export const generationPipelineStages = [
  'course-draft',
  'outline',
  'courseware',
  'teaching-profile',
] as const;
export const generationPipelineStageSchema = z.enum(generationPipelineStages);
export type GenerationPipelineStage = z.infer<typeof generationPipelineStageSchema>;

export const lessonOutlineCandidateSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    objectives: z
      .array(
        z
          .object({
            text: z.string().trim().min(1).max(500),
            statementIds: z.array(z.string().min(1)).min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    sequence: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(120),
            statementIds: z.array(z.string().min(1)).max(20),
            questionIds: z.array(z.string().min(1)).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(24),
  })
  .strict();
export type LessonOutlineCandidate = z.infer<typeof lessonOutlineCandidateSchema>;

export const teachingProfileCandidateSchema = z
  .object({
    roles: z
      .array(
        z
          .object({
            kind: z.enum(['teacher', 'peer']),
            name: z.string().trim().min(1).max(60),
            purpose: z.string().trim().min(1).max(400),
            explanation: z.enum(['intuitive', 'rigorous', 'concise']),
            statementIds: z.array(z.string().min(1)).min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(3),
    actions: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(100),
            trigger: z.string().trim().min(1).max(300),
            instruction: z.string().trim().min(1).max(800),
            statementIds: z.array(z.string().min(1)).min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    teaching: z
      .object({
        learningMode: z.enum(['beginner', 'review']),
        explanation: z.enum(['intuitive', 'rigorous', 'concise']),
        hintDepth: z.enum(['light', 'stepwise', 'full']),
        exerciseBalance: z.enum(['explanation-first', 'balanced', 'practice-first']),
        selfExplanation: z.boolean(),
        everydayExamples: z.enum(['moderate', 'minimal']),
        extraPreference: z.string().max(500),
      })
      .strict(),
  })
  .strict();
export type TeachingProfileCandidate = z.infer<typeof teachingProfileCandidateSchema>;

export const generationPipelineStageStateSchema = z
  .object({
    stage: generationPipelineStageSchema,
    status: z.enum(['pending', 'running', 'completed', 'failed', 'blocked']),
    attempts: z.number().int().nonnegative(),
    reviewStatus: z.enum([
      'not-required',
      'pending',
      'approved',
      'rejected',
      'adopted',
      'external',
    ]),
    reviewRequestId: z.string().min(1).nullable(),
    requestId: z.string().min(1).nullable(),
    message: z.string().max(500).nullable(),
    startedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    output: z.unknown().nullable(),
  })
  .strict();
export type GenerationPipelineStageState = z.infer<typeof generationPipelineStageStateSchema>;

export const generationPipelineTaskSchema = z
  .object({
    taskId: z.string().min(1),
    projectId: z.string().min(1),
    lessonId: z.string().min(1).nullable(),
    version: z.number().int().positive().nullable(),
    bundleId: z.string().min(1),
    bundleDigest: z.string().min(1),
    roleConfigDigest: z.string().nullable(),
    teachingPreferenceVersion: z.number().int().nonnegative(),
    title: z.string().trim().min(2).max(120),
    statementIds: z.array(z.string().min(1)).min(1).max(200),
    questionIds: z.array(z.string().min(1)).max(200),
    intentDigest: z.string().min(1),
    instruction: z.string().trim().min(2).max(600),
    status: z.enum(['ready', 'running', 'paused', 'blocked', 'failed', 'stopped', 'completed']),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    stages: z.array(generationPipelineStageStateSchema).length(4),
    candidateOnly: z.literal(true),
  })
  .strict();
export type GenerationPipelineTask = z.infer<typeof generationPipelineTaskSchema>;

export const generationPipelineCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      scope: projectScopeSchema,
      action: z.literal('create'),
      requestId: z.string().trim().min(1).max(200),
      bundleId: z.string().min(1),
      bundleDigest: z.string().min(1),
      title: z.string().trim().min(2).max(120),
      statementIds: z.array(z.string().min(1)).min(1).max(200),
      questionIds: z.array(z.string().min(1)).max(200),
      instruction: z.string().trim().min(2).max(600),
    })
    .strict(),
  z
    .object({
      scope: projectScopeSchema,
      action: z.enum(['get', 'continue', 'stop']),
      taskId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      scope: projectScopeSchema,
      action: z.literal('retry'),
      taskId: z.string().min(1),
      stage: generationPipelineStageSchema,
      requestId: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      scope: projectScopeSchema,
      action: z.literal('review'),
      taskId: z.string().min(1),
      stage: z.enum(['course-draft', 'outline', 'teaching-profile']),
      decision: z.enum(['approved', 'rejected']),
      requestId: z.string().trim().min(1).max(200),
    })
    .strict(),
]);
export type GenerationPipelineCommand = z.infer<typeof generationPipelineCommandSchema>;

export const generationPipelineResponseSchema = z
  .object({
    task: generationPipelineTaskSchema,
    replayed: z.boolean(),
  })
  .strict();
export type GenerationPipelineResponse = z.infer<typeof generationPipelineResponseSchema>;
