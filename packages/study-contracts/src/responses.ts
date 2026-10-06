/** Renderer HTTP responses. Types are inferred only after validating actual JSON. */
import { z } from 'zod';
import {
  attemptGradingContextSchema,
  attemptGradeCandidateSchema,
  attemptGradeReviewSchema,
} from './attempt-grading';
import { learnerProfileSchema } from './learner-profile';
import {
  classroomBoardStateSchema,
  classroomBoardItemResultSchema,
  classroomBoardPlayResultSchema,
} from './classroom-board';
import {
  classroomInvitationSchema,
  classroomRoomSchema,
  classroomSharedCourseSchema,
} from './classroom-room';
import {
  collabEventSchema,
  collabMessageSchema,
  collabRegistrationSchema,
  collabRoomMemberSchema,
  collabRoomSchema,
} from './classroom-collaboration';
import {
  collabCredentialSchema,
  collabOnlineRegistrationSchema,
  collabSceneSyncResultSchema,
  collabSessionSchema,
  collabSnapshotViewSchema,
} from './collaboration-service';
import {
  admissionResultSchema,
  assetReclaimReportSchema,
  assetReclaimResultSchema,
  questionSchema,
  questionListItemSchema,
  attemptSchema,
  knowledgePointSchema,
  materialRawViewSchema,
  materialSchema,
  preferencesSchema,
  proposalSchema,
  roleProfileSchema,
  segmentSchema,
  syllabusCoverageSchema,
  syllabusItemSchema,
  teachingPreferenceSchema,
  workbenchStateSchema,
} from './api';
import { planPayloadSchema, runSnapshotSchema } from './plan';
import { modelGenerationResultSchema } from './model-connection';
import {
  evidenceBundleRowSchema,
  lessonReviewRecordSchema,
  lessonVersionSchema,
  LESSON_STATUS,
  formalLessonDocumentSchema,
  statementRevisionCandidateSchema,
} from './lesson';
import {
  scenePlanSchema,
  scenePlanReceiptSchema,
  scenePlanMergePreviewSchema,
  coursewareCandidateSchema,
} from './scene-plan';
import {
  PEER_ENGAGEMENT,
  classroomPeerScheduleSchema,
  classroomPeerTurnSchema,
  classroomSessionSchema,
  classroomStateSchema,
  explanationCardSchema,
} from './teaching';
import { recoveryCheckpointSchema } from './recovery';
import { lessonExportResultSchema } from './lesson-export';

export const apiErrorPayloadSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    pending: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const apiEnvelopeSchema = <S extends z.ZodTypeAny>(data: S) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }).strict(),
    z.object({ ok: z.literal(false), error: apiErrorPayloadSchema }).strict(),
  ]);

/** Upstream RuntimeStore errors use { error }, without the study envelope. */
export const runtimeApiFailureSchema = z
  .object({
    error: apiErrorPayloadSchema.omit({ pending: true }),
  })
  .strict();

const classroomLinkSchema = z
  .object({
    lessonId: z.string(),
    projectId: z.string(),
    lessonVersion: z.number().int().positive(),
    stageId: z.string().nullable(),
    stageDocumentVersion: z.number().int().nullable(),
    documentDigest: z.string().nullable(),
    evidenceBundleId: z.string().nullable(),
    status: z.enum(LESSON_STATUS),
    statusNote: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

const reviewedQuizPayloadSchema = z
  .object({
    payloadVersion: z.literal(1),
    phase: z.literal('reviewed'),
    answers: z.record(z.string(), z.unknown()),
    results: z
      .array(
        z
          .object({
            questionId: z.string(),
            correct: z.boolean().nullable(),
            status: z.enum(['correct', 'incorrect', 'pending_review']),
            earned: z.number().nonnegative().nullable(),
            maxScore: z.number().nonnegative().optional(),
            answerVersion: z.number().int().positive().nullable().optional(),
            basis: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/**
 * 本地服务到在线协作服务的受控客户端视图（ADR-0005）。
 *
 * `online` 说明真实连接与本人认证是否都成功：只有 `connected && authenticated`
 * 才开放在线能力；离线或未配置时给出原因，界面据此继续显示「不能联网邀请」。
 * `registration` 只含公开句柄，**不含** secret。
 */
export const collabOnlineViewSchema = z
  .object({
    online: z
      .object({
        configured: z.boolean(),
        connected: z.boolean(),
        authenticated: z.boolean(),
        protocolVersion: z.number().int().positive().nullable(),
        registration: collabOnlineRegistrationSchema.nullable(),
        error: z.string().nullable(),
      })
      .strict(),
    invitations: z.array(classroomInvitationSchema),
    room: collabRoomSchema.nullable(),
    members: z.array(collabRoomMemberSchema),
    messages: z
      .object({ messages: z.array(collabMessageSchema), tailSeq: z.number().int().nonnegative() })
      .strict(),
    events: z
      .object({ events: z.array(collabEventSchema), tailSeq: z.number().int().nonnegative() })
      .strict(),
    snapshot: collabSnapshotViewSchema.nullable(),
  })
  .strict();
export type CollabOnlineViewDto = z.infer<typeof collabOnlineViewSchema>;

/** 在线命令写入后的视图回执：命令结论与刷新后的在线视图一起返回。 */
export const collabOnlineWriteSchema = z
  .object({
    commandRequestId: z.string().min(1).max(200),
    view: collabOnlineViewSchema,
    deduplicated: z.boolean(),
    notice: z.string(),
  })
  .strict();
export type CollabOnlineWriteDto = z.infer<typeof collabOnlineWriteSchema>;

export const apiResponses = {
  learnerProfile: learnerProfileSchema,
  classroomBoardContext: z
    .object({
      state: classroomBoardStateSchema,
      statementIds: z.array(z.string().min(1)),
      elementIds: z.array(z.string().min(1)).default([]),
    })
    .strict(),
  classroomBoardItem: classroomBoardItemResultSchema,
  classroomBoardPlay: classroomBoardPlayResultSchema,
  classroomRooms: z
    .object({
      rooms: z.array(classroomRoomSchema),
      snapshot: classroomSharedCourseSchema.nullable(),
    })
    .strict(),
  classroomRoomWrite: z.object({ room: classroomRoomSchema, deduplicated: z.boolean() }).strict(),
  /** UID 登记（本地链路占位）。 */
  collabRegistration: z
    .object({ registration: collabRegistrationSchema.nullable(), deduplicated: z.boolean() })
    .strict(),
  /** 邀请生命周期：列表与单条写入共用同一形状。 */
  collabInvitations: z
    .object({
      invitations: z.array(classroomInvitationSchema),
      /** 接受邀请时一并返回建立的成员记录；其余情况为 null。 */
      member: collabRoomMemberSchema.nullable().default(null),
    })
    .strict(),
  collabInvitationWrite: z
    .object({
      invitation: classroomInvitationSchema,
      member: collabRoomMemberSchema.nullable().default(null),
      deduplicated: z.boolean(),
    })
    .strict(),
  collabRoom: z.object({ room: collabRoomSchema, deduplicated: z.boolean() }).strict(),
  /** 房间读取：房间本身可能尚未建立（仅邀请阶段），因此为 nullable。 */
  collabRoomView: z
    .object({
      room: collabRoomSchema.nullable(),
      members: z.array(collabRoomMemberSchema),
    })
    .strict(),
  collabMemberWrite: z
    .object({ member: collabRoomMemberSchema, deduplicated: z.boolean() })
    .strict(),
  /** 按游标读取：`tailSeq` 供客户端下次增量使用。 */
  collabMessages: z
    .object({ messages: z.array(collabMessageSchema), tailSeq: z.number().int().nonnegative() })
    .strict(),
  collabMessageWrite: z
    .object({ message: collabMessageSchema, deduplicated: z.boolean() })
    .strict(),
  collabEvents: z
    .object({ events: z.array(collabEventSchema), tailSeq: z.number().int().nonnegative() })
    .strict(),
  collabEventWrite: z.object({ event: collabEventSchema, deduplicated: z.boolean() }).strict(),
  /** 在线登记（UID-01 在线部分）：公开句柄与状态，绝不含 secret。 */
  collabOnlineRegistration: z
    .object({
      registration: collabOnlineRegistrationSchema,
      credential: collabCredentialSchema,
      deduplicated: z.boolean(),
    })
    .strict(),
  /** 在线认证：换取会话令牌；令牌只在受控边界使用，不在界面展示。 */
  collabSession: z.object({ session: collabSessionSchema }).strict(),
  /** 凭据吊销：返回吊销后的凭据状态。 */
  collabCredentialRevoke: z
    .object({ credential: collabCredentialSchema, deduplicated: z.boolean() })
    .strict(),
  /** 结构化场景同步（SYNC-01 在线部分）：推进后的房间与事务内事件。 */
  collabSceneSync: collabSceneSyncResultSchema,
  /** 共享快照上传/下载（ROOM-01 双端消费者）：房间冻结的公共投影。 */
  collabSnapshot: collabSnapshotViewSchema,
  collabSnapshotUpload: z
    .object({
      roomId: z.string().min(1).max(200),
      snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
      deduplicated: z.boolean(),
    })
    .strict(),
  /** 本地服务到在线协作服务的受控客户端视图（ADR-0005）。 */
  collabOnlineView: z.object({ view: collabOnlineViewSchema }).strict(),
  /** 在线命令写入后的视图回执：命令结论与刷新后的在线视图一起返回。 */
  collabOnlineWrite: collabOnlineWriteSchema,
  collabOnlineConfirmation: z.object({ confirmed: z.literal(true) }).strict(),
  attemptGradingContext: attemptGradingContextSchema,
  attemptGradeReview: z
    .object({
      context: attemptGradingContextSchema,
      review: attemptGradeReviewSchema,
      deduplicated: z.boolean(),
    })
    .strict(),
  attemptGradeCandidate: z
    .object({
      context: attemptGradingContextSchema,
      candidate: attemptGradeCandidateSchema,
      deduplicated: z.boolean(),
    })
    .strict(),
  attemptGradeReject: z
    .object({
      context: attemptGradingContextSchema,
      candidate: attemptGradeCandidateSchema,
      deduplicated: z.boolean(),
    })
    .strict(),
  project: workbenchStateSchema,
  questionCreate: z
    .object({ question: questionSchema, forgedExamClaim: z.boolean(), downgraded: z.boolean() })
    .strict(),
  questions: z.object({ questions: z.array(questionListItemSchema) }).strict(),
  materialImport: z
    .object({
      material: materialSchema,
      segments: z.array(segmentSchema),
      invalidated: z.array(
        z
          .object({
            knowledgeId: z.string(),
            name: z.string(),
            affectedMaterialIds: z.array(z.string()),
          })
          .strict(),
      ),
    })
    .strict(),
  materialRaw: materialRawViewSchema,
  examVerification: z
    .object({
      materialId: z.string(),
      revision: z.number().int().positive(),
      verifiedAt: z.string(),
    })
    .strict(),
  proposal: z.object({ proposal: proposalSchema }).strict(),
  review: z
    .object({
      proposal: proposalSchema,
      knowledgePoint: knowledgePointSchema.nullable(),
      requiresSemanticReview: z.boolean(),
    })
    .strict(),
  admission: admissionResultSchema,
  syllabusCreate: z.object({ item: syllabusItemSchema, coverage: syllabusCoverageSchema }).strict(),
  roleWrite: z
    .object({ profile: roleProfileSchema.nullable(), profiles: z.array(roleProfileSchema) })
    .strict(),
  appearanceWrite: z.object({ appearance: preferencesSchema }).strict(),
  teachingWrite: z.object({ teaching: teachingPreferenceSchema }).strict(),
  planWrite: z
    .object({
      version: z.number().int().positive(),
      status: z.enum(['draft', 'confirmed']),
      plan: planPayloadSchema,
    })
    .strict(),
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
  lessonRevisionPropose: z
    .object({
      /** 生成失败时为 null，失败原因在 generation.message 里；成功时给出待核候选。 */
      candidate: statementRevisionCandidateSchema.nullable(),
      generation: modelGenerationResultSchema,
      deduplicated: z.boolean(),
    })
    .strict(),
  lessonRevisionApply: z
    .object({
      candidate: statementRevisionCandidateSchema,
      /** 通过并派生时给出新草案版本；拒绝时为 null。 */
      lesson: lessonVersionSchema.nullable(),
      deduplicated: z.boolean(),
    })
    .strict(),
  /** 场景计划保存（OMA-021、OMA-022）：返回推进 revision 后的权威计划与事务内回执。 */
  lessonScenePlan: z
    .object({
      plan: scenePlanSchema,
      receipt: scenePlanReceiptSchema,
      deduplicated: z.boolean().default(false),
    })
    .strict(),
  /** 跨版本计划差异与合并预览（OMA-005、OMA-022）：只读，不写入计划。 */
  lessonScenePlanMerge: z
    .object({
      merge: scenePlanMergePreviewSchema,
    })
    .strict(),
  /** 完整课件候选生成（OMA-006）：失败时 candidate 为 null，原因在 generation.message。 */
  lessonCoursewarePropose: z
    .object({
      candidate: coursewareCandidateSchema.nullable(),
      generation: modelGenerationResultSchema,
      deduplicated: z.boolean(),
    })
    .strict(),
  /**
   * 完整课件候选处置：通过时给出写入后的场景计划，拒绝时为 null。
   *
   * `planConflict` 在计划已被别处推进且未确认覆盖时给出当前计划，界面据此显示版本比较；
   * 此时响应是 409，`candidate`/`plan` 都不代表已写入。
   */
  lessonCoursewareApply: z
    .object({
      candidate: coursewareCandidateSchema,
      plan: scenePlanSchema.nullable(),
      receipt: scenePlanReceiptSchema,
      deduplicated: z.boolean(),
    })
    .strict(),
  explanationWrite: z.object({ card: explanationCardSchema }).strict(),
  classroomSession: z
    .object({
      session: classroomSessionSchema,
      /** 本次动作中止了多少个在途 provider 请求；缺省表示当时没有正在执行的调用。 */
      abortedCalls: z.number().int().nonnegative().default(0),
    })
    .strict(),
  classroomAdvance: z
    .object({
      session: classroomSessionSchema,
      deduplicated: z.boolean(),
      abortedCalls: z.number().int().nonnegative().default(0),
    })
    .strict(),
  classroomState: z.object({ state: classroomStateSchema.nullable() }).strict(),
  /**
   * AI 同学命令的响应（PEER-01）。
   *
   * `turn` 只在 `peer-turn` 时有值；开关同学时只回会话与同学运行态。
   * `peers` 给出服务端判定的上限与实际轮内条数，界面不自行推算。
   */
  classroomPeer: z
    .object({
      session: classroomSessionSchema,
      peers: z
        .object({
          enabled: z.boolean(),
          engagement: z.enum(PEER_ENGAGEMENT),
          turnCeiling: z.number().int().nonnegative(),
          turnsThisRound: z.number().int().nonnegative(),
        })
        .strict(),
      /** 服务端判定的同学调度结论：界面据此刷新按钮可用性，不自行重算用户优先。 */
      schedule: classroomPeerScheduleSchema,
      turn: classroomPeerTurnSchema.nullable().default(null),
    })
    .strict(),
  /** 四层恢复核对结论（RESUME-01）。只读，不含任何 provider 调用。 */
  recovery: z.object({ checkpoint: recoveryCheckpointSchema }).strict(),
  /** 课件自包含导出（OMA-068/069/070/072）：产物落项目 exports/，逐项给出摘要与缺口。 */
  lessonExport: z.object({ export: lessonExportResultSchema }).strict(),
  classroomPlay: z
    .object({
      card: explanationCardSchema.nullable(),
      deduplicated: z.boolean(),
      session: classroomSessionSchema,
      playedIds: z.array(z.string()),
    })
    .strict(),
  modelGenerate: modelGenerationResultSchema,
  classroomDemo: z.object({ stageId: z.string().min(1), lessonId: z.string().min(1) }).strict(),
  classroomAssets: z
    .object({
      stageId: z.string().min(1),
      assets: z.array(
        z
          .object({
            symbolicRef: z.string().min(1),
            assetId: z.string().min(1),
            mediaType: z.string().min(1),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      ),
    })
    .strict(),
  classroomPosition: z
    .object({
      stageId: z.string().min(1),
      currentSceneId: z.string().min(1),
      revision: z.number().int().nonnegative(),
    })
    .strict(),
  classroomLearner: z.object({ learnerKey: z.string().min(1) }).strict(),
  quizSubmit: z
    .object({
      attempt: attemptSchema,
      deduplicated: z.boolean(),
      record: z
        .object({
          id: z.string().min(1),
          sessionId: z.string().min(1),
          seq: z.number().int().nonnegative(),
          sceneId: z.string().optional(),
          actionIndex: z.number().int().nonnegative().optional(),
          subAnchor: z.string().optional(),
          createdAt: z.string(),
          payload: reviewedQuizPayloadSchema,
        })
        .strict(),
    })
    .strict(),
} as const;
