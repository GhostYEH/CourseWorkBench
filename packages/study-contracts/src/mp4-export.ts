import { z } from 'zod';
import { projectScopeSchema } from './api';
import { lessonExportResultSchema } from './lesson-export';

const id = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime();
export const mp4RuntimeSchema = z
  .object({
    kind: z.enum([
      'chromium',
      'ffmpeg',
      'font',
      'formula-runtime',
      'narration-audio',
      'media-decoder',
    ]),
    reference: id,
    required: z.boolean(),
    minVersion: id.nullable(),
    expectedDigest: digest.nullable(),
    actualVersion: id.nullable(),
    actualDigest: digest.nullable(),
    status: z.enum(['available', 'missing', 'mismatched']),
    note: z.string().max(1000),
  })
  .strict();
export const mp4EncodingSchema = z
  .object({
    container: z.literal('mp4'),
    videoCodec: z.literal('h264'),
    pixelFormat: z.literal('yuv420p'),
    width: z
      .number()
      .int()
      .min(320)
      .max(1920)
      .refine((value) => value % 2 === 0),
    height: z
      .number()
      .int()
      .min(180)
      .max(1080)
      .refine((value) => value % 2 === 0),
    fps: z.number().int().min(1).max(60),
    constantRateFactor: z.number().int().min(0).max(51),
    fastStart: z.literal(true),
    audio: z
      .object({ codec: z.literal('aac'), sampleRate: z.number().int().positive() })
      .strict()
      .nullable(),
  })
  .strict();
export const mp4PlanSchema = z
  .object({
    planVersion: z.literal(1),
    format: z.literal('mp4'),
    generatedAt: timestamp,
    identity: z
      .object({
        projectId: id,
        lessonId: id,
        lessonVersion: z.number().int().positive(),
        bundleId: id,
        title: id,
        planDigest: digest.nullable(),
        documentDigest: digest.nullable(),
        exportedDocumentDigest: digest.nullable(),
      })
      .strict(),
    encoding: mp4EncodingSchema,
    canvas: z
      .object({ viewportSize: z.number().positive(), viewportRatio: z.number().positive() })
      .strict(),
    segments: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            sceneId: id,
            sceneKind: z.enum(['slide', 'quiz', 'interactive', 'pbl']),
            title: id,
            startMs: z.number().int().nonnegative(),
            durationMs: z.number().int().positive(),
            sceneDigest: digest,
          })
          .strict(),
      )
      .min(1)
      .max(48),
    totalDurationMs: z.number().int().positive().max(3600000),
    runtimes: z.array(mp4RuntimeSchema).max(100),
    output: z.object({ directory: id, fileName: id }).strict(),
    digest,
  })
  .strict();
const jobState = z.enum([
  'draft',
  'queued',
  'preparing',
  'blocked',
  'capturing',
  'encoding',
  'succeeded',
  'failed',
  'cancelled',
]);
export const mp4JobSchema = z
  .object({
    jobId: id,
    state: jobState,
    planDigest: digest,
    requestedAt: timestamp,
    updatedAt: timestamp,
    requestId: id,
    attempts: z.number().int().nonnegative().max(10),
    maxAttempts: z.number().int().min(1).max(10),
    nextSegmentIndex: z.number().int().nonnegative().max(48),
    completedSegments: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            byteLength: z
              .number()
              .int()
              .positive()
              .max(256 * 1024 ** 2),
            sha256: digest,
          })
          .strict(),
      )
      .max(48),
    failure: z
      .object({
        class: z.enum([
          'runtime-missing',
          'runtime-mismatch',
          'browser-crash',
          'encoder-crashed',
          'disk-full',
          'timeout',
          'result-unknown',
          'artifact-digest-mismatch',
          'plan-drift',
          'cancelled-by-user',
        ]),
        message: z.string().max(1000),
        occurredAt: timestamp,
        segmentIndex: z.number().int().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
    delivery: z
      .object({
        status: z.enum(['none', 'partial', 'delivered']),
        fileName: id.nullable(),
        byteLength: z.number().int().positive().nullable(),
        sha256: digest.nullable(),
        playable: z.boolean(),
      })
      .strict(),
    events: z
      .array(
        z
          .object({
            state: jobState,
            event: z.enum([
              'enqueue',
              'begin-preparation',
              'resources-verified',
              'resources-unavailable',
              'begin-capture',
              'segment-captured',
              'capture-completed',
              'begin-encoding',
              'encoding-completed',
              'output-reconciled',
              'fail',
              'cancel',
              'requeue',
            ]),
            at: timestamp,
            note: z.string().max(1000),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();
const evidenceSchema = z
  .object({
    mode: z.literal('closed-scene-projection'),
    interactionPreserved: z.literal(false),
    audioPresent: z.literal(false),
    container: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.split(',').includes('mp4')),
    videoCodec: z.literal('h264'),
    pixelFormat: z.literal('yuv420p'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationSeconds: z.number().positive(),
    frameCount: z.number().int().positive(),
    decodedFrames: z.number().int().positive(),
    ffprobeVerified: z.literal(true),
    fullDecodeVerified: z.literal(true),
  })
  .strict();
export const mp4TaskSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: id,
    intent: digest,
    revision: z.number().int().nonnegative(),
    bundleDigest: id,
    stageId: id,
    dslVersion: id,
    plan: mp4PlanSchema,
    job: mp4JobSchema,
    result: lessonExportResultSchema.nullable(),
    prepared: z
      .object({ result: lessonExportResultSchema, evidence: evidenceSchema })
      .strict()
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.projectId !== value.plan.identity.projectId ||
      value.plan.digest !== value.job.planDigest ||
      value.job.nextSegmentIndex !== value.job.completedSegments.length ||
      value.job.completedSegments.some((segment, index) => segment.index !== index) ||
      value.job.nextSegmentIndex > value.plan.segments.length ||
      (value.job.state === 'succeeded') !== (value.result !== null)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MP4 task identities/checkpoints/result disagree',
      });
    for (const result of [value.result, value.prepared?.result])
      if (
        result &&
        (result.format !== 'mp4' ||
          result.projectId !== value.projectId ||
          result.lessonId !== value.plan.identity.lessonId ||
          result.lessonVersion !== value.plan.identity.lessonVersion ||
          result.manifest.documentDigest !== value.plan.identity.documentDigest ||
          result.manifest.exportedDocumentDigest !== value.plan.identity.exportedDocumentDigest ||
          result.manifest.bundleDigest !== value.bundleDigest)
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'MP4 artifact identity disagrees with frozen source',
        });
    if (
      value.prepared &&
      (value.prepared.evidence.width !== value.plan.encoding.width ||
        value.prepared.evidence.height !== value.plan.encoding.height ||
        value.prepared.evidence.decodedFrames !== value.prepared.evidence.frameCount ||
        Math.abs(value.prepared.evidence.durationSeconds - value.plan.totalDurationMs / 1000) >
          Math.max(1, 2 / value.plan.encoding.fps))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MP4 decode evidence disagrees with plan',
      });
    if (
      value.result &&
      (!value.prepared ||
        value.result.sha256 !== value.prepared.result.sha256 ||
        value.result.sha256 !== value.job.delivery.sha256 ||
        value.result.byteLength !== value.job.delivery.byteLength)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MP4 published bytes disagree with durable decoded receipt',
      });
  });
export type Mp4TaskDto = z.infer<typeof mp4TaskSchema>;
export const mp4StartSchema = z
  .object({
    scope: projectScopeSchema,
    requestId: id,
    lessonId: id,
    version: z.number().int().positive(),
  })
  .strict();
export const mp4ActionSchema = z
  .object({
    scope: projectScopeSchema,
    jobId: id,
    action: z.enum(['cancel', 'resume']),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
