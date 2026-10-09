import { z } from 'zod';
import { projectScopeSchema } from './api';
import {
  mediaGenerationCommandSchema,
  mediaProductRefSchema,
  mediaUsageObservationSchema,
  mediaUsageLedgerSchema,
  mediaUsageQuantitiesSchema,
} from './media-generation';

/** Persistent candidate identity is distinct from authorization to use it in a lesson. */
export const mediaTaskSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1).max(200),
    intent: z.string().regex(/^[a-f0-9]{64}$/),
    command: mediaGenerationCommandSchema,
    lessonVersion: z.number().int().positive(),
    bundleDigest: z.string().regex(/^[a-f0-9]{64}$/),
    knowledgeDigest: z.string().regex(/^[a-f0-9]{64}$/),
    observation: mediaUsageObservationSchema,
    products: z.array(mediaProductRefSchema).max(16),
    review: z
      .object({
        status: z.enum(['pending_review', 'approved', 'rejected']),
        note: z.string().max(1000),
        reviewedAt: z.string().nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const observation = value.observation;
    if (
      value.taskId !== observation.taskId ||
      value.command.requestId !== observation.requestId ||
      value.command.scope.projectId !== observation.projectId ||
      value.command.scope.runId !== observation.runId ||
      value.command.kind !== observation.kind
    )
      context.addIssue({ code: 'custom', message: '媒体任务身份不一致' });
    if (
      (observation.state === 'completed'
        ? value.products.length === 0
        : value.products.length !== 0) ||
      value.products.some(
        (product) => product.taskId !== value.taskId || product.kind !== value.command.kind,
      )
    )
      context.addIssue({ code: 'custom', message: '媒体任务状态与产物不一致' });
    if ((observation.state === 'failed') !== (observation.failureKind !== null))
      context.addIssue({ code: 'custom', message: '媒体任务失败原因不一致' });
    if (
      value.review.status === 'approved' &&
      (observation.state !== 'completed' || value.review.reviewedAt === null)
    )
      context.addIssue({ code: 'custom', message: '审核必须绑定已完成的真实产物' });
  });
export type MediaTaskDto = z.infer<typeof mediaTaskSchema>;

export const mediaTaskReviewCommandSchema = z
  .object({
    scope: projectScopeSchema,
    taskId: z.string().min(1).max(200),
    intent: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(['approved', 'rejected']),
    semanticReviewed: z.boolean(),
    note: z.string().trim().max(1000).default(''),
  })
  .strict();
export type MediaTaskReviewCommand = z.infer<typeof mediaTaskReviewCommandSchema>;

export const mediaTaskCancelCommandSchema = z
  .object({
    scope: projectScopeSchema,
    taskId: z.string().min(1).max(200),
  })
  .strict();

export const mediaTasksViewSchema = z
  .object({
    tasks: z.array(mediaTaskSchema),
    ledger: mediaUsageLedgerSchema.nullable(),
    limits: mediaUsageQuantitiesSchema,
    runId: z.string().nullable(),
  })
  .strict();
export type MediaTasksViewDto = z.infer<typeof mediaTasksViewSchema>;
