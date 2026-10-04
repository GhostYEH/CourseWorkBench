import { z } from 'zod';

export const LEGACY_LOCAL_LEARNER_KEY = 'sew:classroom:owner:v1';
export const learnerUidSchema = z.string().regex(/^uid_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

/** Local stable learner identity. It is neither a login credential nor an online registration. */
export const learnerProfileSchema = z.object({
  schemaVersion: z.literal(1),
  uid: learnerUidSchema,
  displayName: z.string().trim().min(1).max(80),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  registrationStatus: z.literal('local_only'),
  canInvite: z.literal(false),
}).strict();

export type LearnerProfileDto = z.infer<typeof learnerProfileSchema>;

/** UID is a read precondition, never a value the client can assign to an identity. */
export const learnerProfileUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  expectedUid: learnerUidSchema,
  expectedRevision: z.number().int().positive(),
}).strict();

export type LearnerProfileUpdateInput = z.infer<typeof learnerProfileUpdateSchema>;
