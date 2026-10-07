import { z } from 'zod';
import { learnerUidSchema } from './learner-profile';
import { collabEventSchema, collabText } from './classroom-collaboration';

const id = z.string().min(1).max(200);

/** Public teaching accepts references to frozen reviewed content, never caller-provided prose. */
export const collabTeachingOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('speak'), statementId: id }).strict(),
  z.object({ kind: z.literal('focus'), elementId: id }).strict(),
  z.object({ kind: z.literal('laser'), elementId: id }).strict(),
  z.object({ kind: z.literal('clear-board') }).strict(),
  z.object({ kind: z.literal('undo-board'), actionEventId: id }).strict(),
  z.object({ kind: z.literal('replay-board'), actionEventId: id }).strict(),
  z.object({ kind: z.literal('wait'), targetUid: learnerUidSchema }).strict(),
  z.object({ kind: z.literal('acknowledge'), waitEventId: id }).strict(),
  z.object({ kind: z.literal('release-wait'), waitEventId: id }).strict(),
  z.object({ kind: z.literal('cancel-wait'), waitEventId: id }).strict(),
]);
export type CollabTeachingOperation = z.infer<typeof collabTeachingOperationSchema>;

export const collabTeachingCommandSchema = z
  .object({
    roomId: id,
    actorUid: learnerUidSchema,
    sceneId: id,
    expectedRevision: z.number().int().positive(),
    expectedSeq: z.number().int().positive(),
    eventId: id,
    requestId: id,
    operation: collabTeachingOperationSchema,
  })
  .strict();
export type CollabTeachingCommandInput = z.infer<typeof collabTeachingCommandSchema>;

export const collabTeachingStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    roomId: id,
    sceneId: id,
    board: z
      .object({
        focusElementId: id.nullable(),
        laserElementId: id.nullable(),
        /** Optional for backwards compatibility with already persisted v1 states. */
        history: z
          .object({
            baseline: z
              .object({ focusElementId: id.nullable(), laserElementId: id.nullable() })
              .strict(),
            actions: z
              .array(
                z
                  .object({
                    eventId: id,
                    seq: z.number().int().positive(),
                    kind: z.enum(['focus', 'laser', 'clear-board']),
                    elementId: id.optional(),
                    applied: z.boolean(),
                  })
                  .strict(),
              )
              .max(200),
          })
          .strict()
          .superRefine((history, ctx) => {
            const eventIds = new Set<string>();
            const seqs = new Set<number>();
            let previousSeq = 0;
            history.actions.forEach((action, index) => {
              if (eventIds.has(action.eventId))
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: ['actions', index, 'eventId'],
                  message: 'duplicate eventId',
                });
              if (seqs.has(action.seq))
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: ['actions', index, 'seq'],
                  message: 'duplicate seq',
                });
              if (action.seq <= previousSeq)
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: ['actions', index, 'seq'],
                  message: 'actions must be ordered by seq',
                });
              if (
                (action.kind === 'focus' || action.kind === 'laser') !==
                (action.elementId !== undefined)
              ) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: ['actions', index, 'elementId'],
                  message: 'elementId shape does not match kind',
                });
              }
              eventIds.add(action.eventId);
              seqs.add(action.seq);
              previousSeq = action.seq;
            });
          })
          .optional(),
      })
      .strict(),
    waiting: z
      .object({
        waitEventId: id,
        sceneId: id,
        targetUid: learnerUidSchema,
        acknowledged: z.boolean(),
      })
      .strict()
      .nullable(),
    /** Bounded public transcript. At the limit, further speech is explicitly refused. */
    outputs: z
      .array(
        z
          .object({
            eventId: id,
            seq: z.number().int().positive(),
            sceneId: id,
            statementId: id,
            body: collabText(2000),
            conditions: z.string().max(2000),
            source: z.literal('reviewed_statement'),
            createdAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export type CollabTeachingStateDto = z.infer<typeof collabTeachingStateSchema>;

export const collabTeachingViewSchema = z
  .object({
    state: collabTeachingStateSchema,
    roomRevision: z.number().int().positive(),
    tailSeq: z.number().int().nonnegative(),
  })
  .strict();
export type CollabTeachingViewDto = z.infer<typeof collabTeachingViewSchema>;

export const collabTeachingResultSchema = z
  .object({
    state: collabTeachingStateSchema,
    roomRevision: z.number().int().positive(),
    event: collabEventSchema,
    deduplicated: z.boolean(),
  })
  .strict();
export type CollabTeachingResultDto = z.infer<typeof collabTeachingResultSchema>;
