/** Renderer HTTP responses. Types are inferred only after validating actual JSON. */
import { z } from 'zod';
import { attemptGradingContextSchema, attemptGradeCandidateSchema, attemptGradeReviewSchema } from './attempt-grading';
import { learnerProfileSchema } from './learner-profile';
import { classroomBoardStateSchema, classroomBoardItemResultSchema, classroomBoardPlayResultSchema } from './classroom-board';
import { classroomRoomSchema, classroomSharedCourseSchema } from './classroom-room';
import {
  admissionResultSchema, assetReclaimReportSchema, assetReclaimResultSchema,
  questionSchema, questionListItemSchema, attemptSchema, knowledgePointSchema, materialRawViewSchema, materialSchema,
  preferencesSchema, proposalSchema, roleProfileSchema, segmentSchema,
  syllabusCoverageSchema, syllabusItemSchema, teachingPreferenceSchema, workbenchStateSchema,
} from './api';
import { planPayloadSchema, runSnapshotSchema } from './plan';
import { modelGenerationResultSchema } from './model-connection';
import {
  evidenceBundleRowSchema, lessonReviewRecordSchema, lessonVersionSchema, LESSON_STATUS,
  formalLessonDocumentSchema, statementRevisionCandidateSchema,
} from './lesson';
import {
  PEER_ENGAGEMENT, classroomPeerTurnSchema, classroomSessionSchema, classroomStateSchema, explanationCardSchema,
} from './teaching';
import { recoveryCheckpointSchema } from './recovery';

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
  status: z.enum(LESSON_STATUS), statusNote: z.string(), createdAt: z.string(), updatedAt: z.string(),
}).strict();

const reviewedQuizPayloadSchema = z.object({
  payloadVersion: z.literal(1), phase: z.literal('reviewed'),
  answers: z.record(z.string(), z.unknown()),
  results: z.array(z.object({
    questionId: z.string(), correct: z.boolean().nullable(),
    status: z.enum(['correct', 'incorrect', 'pending_review']), earned: z.number().nonnegative().nullable(),
    maxScore: z.number().nonnegative().optional(), answerVersion: z.number().int().positive().nullable().optional(), basis: z.string().optional(),
  }).strict()).min(1),
}).strict();

export const apiResponses = {
  learnerProfile: learnerProfileSchema,
  classroomBoardContext: z.object({ state: classroomBoardStateSchema, statementIds: z.array(z.string().min(1)), elementIds: z.array(z.string().min(1)).default([]) }).strict(),
  classroomBoardItem: classroomBoardItemResultSchema,
  classroomBoardPlay: classroomBoardPlayResultSchema,
  classroomRooms: z.object({ rooms: z.array(classroomRoomSchema), snapshot: classroomSharedCourseSchema.nullable() }).strict(),
  classroomRoomWrite: z.object({ room: classroomRoomSchema, deduplicated: z.boolean() }).strict(),
  attemptGradingContext: attemptGradingContextSchema,
  attemptGradeReview: z.object({ context: attemptGradingContextSchema, review: attemptGradeReviewSchema, deduplicated: z.boolean() }).strict(),
  attemptGradeCandidate: z.object({ context: attemptGradingContextSchema, candidate: attemptGradeCandidateSchema, deduplicated: z.boolean() }).strict(),
  attemptGradeReject: z.object({ context: attemptGradingContextSchema, candidate: attemptGradeCandidateSchema, deduplicated: z.boolean() }).strict(),
  project: workbenchStateSchema,
  questionCreate: z.object({ question: questionSchema, forgedExamClaim: z.boolean(), downgraded: z.boolean() }).strict(),
  questions: z.object({ questions: z.array(questionListItemSchema) }).strict(),
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
  lessonReview: z.object({ review: lessonReviewRecordSchema }).strict(),
  lessonWithdraw: z.object({ lesson: lessonVersionSchema, link: classroomLinkSchema }).strict(),
  lessonDocument: z.object({ document: formalLessonDocumentSchema }).strict(),
  /** 陈述正文改写候选（LESSON-02）：候选只落待核区，通过后才派生新草案版本。 */
  lessonRevisionPropose: z.object({
    /** 生成失败时为 null，失败原因在 generation.message 里；成功时给出待核候选。 */
    candidate: statementRevisionCandidateSchema.nullable(),
    generation: modelGenerationResultSchema,
    deduplicated: z.boolean(),
  }).strict(),
  lessonRevisionApply: z.object({
    candidate: statementRevisionCandidateSchema,
    /** 通过并派生时给出新草案版本；拒绝时为 null。 */
    lesson: lessonVersionSchema.nullable(),
    deduplicated: z.boolean(),
  }).strict(),
  explanationWrite: z.object({ card: explanationCardSchema }).strict(),
  classroomSession: z.object({
    session: classroomSessionSchema,
    /** 本次动作中止了多少个在途 provider 请求；缺省表示当时没有正在执行的调用。 */
    abortedCalls: z.number().int().nonnegative().default(0),
  }).strict(),
  classroomAdvance: z.object({
    session: classroomSessionSchema,
    deduplicated: z.boolean(),
    abortedCalls: z.number().int().nonnegative().default(0),
  }).strict(),
  classroomState: z.object({ state: classroomStateSchema.nullable() }).strict(),
  /**
   * AI 同学命令的响应（PEER-01）。
   *
   * `turn` 只在 `peer-turn` 时有值；开关同学时只回会话与同学运行态。
   * `peers` 给出服务端判定的上限与实际轮内条数，界面不自行推算。
   */
  classroomPeer: z.object({
    session: classroomSessionSchema,
    peers: z.object({
      enabled: z.boolean(),
      engagement: z.enum(PEER_ENGAGEMENT),
      turnCeiling: z.number().int().nonnegative(),
      turnsThisRound: z.number().int().nonnegative(),
    }).strict(),
    turn: classroomPeerTurnSchema.nullable().default(null),
  }).strict(),
  /** 四层恢复核对结论（RESUME-01）。只读，不含任何 provider 调用。 */
  recovery: z.object({ checkpoint: recoveryCheckpointSchema }).strict(),
  classroomPlay: z.object({
    card: explanationCardSchema.nullable(),
    deduplicated: z.boolean(),
    session: classroomSessionSchema,
    playedIds: z.array(z.string()),
  }).strict(),
  modelGenerate: modelGenerationResultSchema,
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
