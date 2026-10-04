/** Renderer HTTP responses. Types are inferred only after validating actual JSON. */
import { z } from 'zod';
import {
  admissionResultSchema, assetReclaimReportSchema, assetReclaimResultSchema,
  attemptSchema, knowledgePointSchema, materialRawViewSchema, materialSchema,
  preferencesSchema, proposalSchema, roleProfileSchema, segmentSchema,
  syllabusCoverageSchema, syllabusItemSchema, teachingPreferenceSchema, workbenchStateSchema,
} from './api';
import { planPayloadSchema, runSnapshotSchema } from './plan';
import { evidenceBundleRowSchema, lessonVersionSchema, LESSON_STATUS } from './lesson';

export const apiErrorPayloadSchema = z.object({
  code: z.string().min(1), message: z.string(), pending: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const apiEnvelopeSchema = <S extends z.ZodTypeAny>(data: S) => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data }).strict(),
  z.object({ ok: z.literal(false), error: apiErrorPayloadSchema }).strict(),
]);

/** Upstream RuntimeStore errors use { error }, without the study envelope. */
export const runtimeApiFailureSchema = z.object({
  error: apiErrorPayloadSchema.omit({ pending: true }),
}).strict();

const classroomLinkSchema = z.object({
  lessonId: z.string(), projectId: z.string(), lessonVersion: z.number().int().positive(),
  stageId: z.string().nullable(), stageDocumentVersion: z.number().int().nullable(),
  documentDigest: z.string().nullable(), evidenceBundleId: z.string().nullable(),
  status: z.enum(LESSON_STATUS), createdAt: z.string(), updatedAt: z.string(),
}).strict();

const reviewedQuizPayloadSchema = z.object({
  payloadVersion: z.literal(1), phase: z.literal('reviewed'),
  answers: z.record(z.string(), z.unknown()),
  results: z.array(z.object({
    questionId: z.string(), correct: z.boolean(),
    status: z.enum(['correct', 'incorrect']), earned: z.number().nonnegative(),
  }).strict()).min(1),
}).strict();

export const apiResponses = {
  project: workbenchStateSchema,
  materialImport: z.object({
    material: materialSchema, segments: z.array(segmentSchema),
    invalidated: z.array(z.object({
      knowledgeId: z.string(), name: z.string(), affectedMaterialIds: z.array(z.string()),
    }).strict()),
  }).strict(),
  materialRaw: materialRawViewSchema,
  examVerification: z.object({ materialId: z.string(), revision: z.number().int().positive(), verifiedAt: z.string() }).strict(),
  proposal: z.object({ proposal: proposalSchema }).strict(),
  review: z.object({
    proposal: proposalSchema, knowledgePoint: knowledgePointSchema.nullable(), requiresSemanticReview: z.boolean(),
  }).strict(),
  admission: admissionResultSchema,
  syllabusCreate: z.object({ item: syllabusItemSchema, coverage: syllabusCoverageSchema }).strict(),
  roleWrite: z.object({ profile: roleProfileSchema.nullable(), profiles: z.array(roleProfileSchema) }).strict(),
  appearanceWrite: z.object({ appearance: preferencesSchema }).strict(),
  teachingWrite: z.object({ teaching: teachingPreferenceSchema }).strict(),
  planWrite: z.object({ version: z.number().int().positive(), status: z.enum(['draft', 'confirmed']), plan: planPayloadSchema }).strict(),
  runStart: z.object({ snapshot: runSnapshotSchema, deduplicated: z.boolean() }).strict(),
  assetReport: assetReclaimReportSchema,
  assetReclaim: assetReclaimResultSchema,
  lessonBundle: evidenceBundleRowSchema,
  lessonDraft: z.object({ lesson: lessonVersionSchema }).strict(),
  lessonPublish: z.object({ lesson: lessonVersionSchema, link: classroomLinkSchema }).strict(),
  classroomDemo: z.object({ stageId: z.string().min(1), lessonId: z.string().min(1) }).strict(),
  classroomAssets: z.object({
    stageId: z.string().min(1), assets: z.array(z.object({
      symbolicRef: z.string().min(1), assetId: z.string().min(1), mediaType: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict()),
  }).strict(),
  classroomPosition: z.object({ stageId: z.string().min(1), currentSceneId: z.string().min(1), revision: z.number().int().nonnegative() }).strict(),
  classroomLearner: z.object({ learnerKey: z.string().min(1) }).strict(),
  quizSubmit: z.object({
    attempt: attemptSchema, deduplicated: z.boolean(),
    record: z.object({
      id: z.string().min(1), sessionId: z.string().min(1), seq: z.number().int().nonnegative(),
      sceneId: z.string().optional(), actionIndex: z.number().int().nonnegative().optional(),
      subAnchor: z.string().optional(), createdAt: z.string(), payload: reviewedQuizPayloadSchema,
    }).strict(),
  }).strict(),
} as const;
