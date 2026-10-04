/**
 * 课堂教师侧合同（《规划书》6.2 / 6.4，TEACH-01）。
 *
 * 正式连续授课只使用**已审核讲解卡**：卡片文本与它引用的证据包陈述一起冻结，
 * 模型实时产生的新内容一律按 `model_generated` 进入待核区，未经语义审核不得播报。
 * 课堂动作按确定性 step key 去重，重复请求读回既有收据，不重复执行。
 */

import { z } from 'zod';
import { GENERATED_ID_PATTERN } from './ids';
import { MODEL_CALL_PURPOSE } from './status';
import { projectScopeSchema } from './api';

/** 卡片用途：讲解陈述内容，或只提问不讲解。 */
export const EXPLANATION_KIND = ['explain', 'prompt'] as const;
export type ExplanationKind = (typeof EXPLANATION_KIND)[number];

/** 文本来源。模型产生的内容即使后来被批准，来源标记也不改写。 */
export const EXPLANATION_ORIGIN = ['teacher_authored', 'model_generated'] as const;
export type ExplanationOrigin = (typeof EXPLANATION_ORIGIN)[number];

/** 审核状态。只有 approved 可被课堂播放。 */
export const EXPLANATION_STATUS = ['draft', 'approved', 'rejected'] as const;
export type ExplanationStatus = (typeof EXPLANATION_STATUS)[number];

export const CLASSROOM_SESSION_STATUS = ['in_class', 'awaiting_learner', 'completed', 'cancelled'] as const;
export type ClassroomSessionStatus = (typeof CLASSROOM_SESSION_STATUS)[number];

/** 可提交收据的课堂动作。白板动作在 BOARD-01 追加，共用同一张收据表。 */
export const CLASSROOM_ACTION_KINDS = [
  'card_played', 'scene_advanced', 'handback', 'learner_answered', 'model_call', 'session_closed',
] as const;
export type ClassroomActionKind = (typeof CLASSROOM_ACTION_KINDS)[number];

/**
 * 每轮与整节课上限（《规划书》6.4）。初始值按建议配置，真实试运行后再调；
 * 「等待本人」的时间不计执行时限，所以这里没有墙钟计时项。
 */
export const CLASSROOM_ROUND_LIMITS = { maxCallsPerRound: 4, maxPeerTurnsPerRound: 2 } as const;
export const CLASSROOM_LESSON_MAX_CALLS = 24;

const idField = z.string().regex(GENERATED_ID_PATTERN);
const lessonIdField = z.string().min(1);

export const explanationCardSchema = z
  .object({
    explanationId: idField,
    projectId: z.string().min(1),
    lessonId: lessonIdField,
    lessonVersion: z.number().int().positive(),
    sceneId: z.string().min(1).max(120),
    /** 场景内播放顺序，由服务端按当前最大值追加，客户端不能指定。 */
    position: z.number().int().nonnegative(),
    kind: z.enum(EXPLANATION_KIND),
    origin: z.enum(EXPLANATION_ORIGIN),
    status: z.enum(EXPLANATION_STATUS),
    text: z.string().min(2).max(4000),
    /** 卡片依据的证据包陈述编号；空列表的讲解卡不能通过审核。 */
    statementIds: z.array(z.string().min(1)),
    reviewNote: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type ExplanationCardDto = z.infer<typeof explanationCardSchema>;

export const classroomSessionSchema = z
  .object({
    sessionId: idField,
    projectId: z.string().min(1),
    runId: z.string().nullable(),
    lessonId: lessonIdField,
    lessonVersion: z.number().int().positive(),
    bundleId: z.string().min(1),
    stageId: z.string().nullable(),
    /** 本人身份由服务分配，请求方不能自报 learnerKey。 */
    learnerKey: z.string().min(1),
    status: z.enum(CLASSROOM_SESSION_STATUS),
    awaitingReason: z.string(),
    currentSceneId: z.string(),
    roundIndex: z.number().int().positive(),
    roundCalls: z.number().int().nonnegative(),
    roundPeerTurns: z.number().int().nonnegative(),
    lessonCalls: z.number().int().nonnegative(),
    peersEnabled: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type ClassroomSessionDto = z.infer<typeof classroomSessionSchema>;

export const classroomActionPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('card_played'),
    explanationId: idField,
    sceneId: z.string().min(1),
    position: z.number().int().nonnegative(),
    origin: z.enum(EXPLANATION_ORIGIN),
  }).strict(),
  z.object({
    kind: z.literal('scene_advanced'),
    fromSceneId: z.string().min(1),
    toSceneId: z.string().min(1),
    roundIndex: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal('handback'),
    reason: z.string().max(500),
    roundIndex: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal('learner_answered'),
    roundIndex: z.number().int().positive(),
    sceneId: z.string().max(120),
  }).strict(),
  z.object({
    kind: z.literal('model_call'),
    purpose: z.enum(MODEL_CALL_PURPOSE),
    ok: z.boolean(),
    totalTokens: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal('session_closed'),
    status: z.enum(['completed', 'cancelled']),
    reason: z.string().max(500),
  }).strict(),
]);
export type ClassroomActionPayloadDto = z.infer<typeof classroomActionPayloadSchema>;

export const classroomActionSchema = z
  .object({
    sessionId: z.string().min(1),
    stepKey: z.string().min(1),
    kind: z.enum(CLASSROOM_ACTION_KINDS),
    sceneId: z.string(),
    payload: classroomActionPayloadSchema,
    at: z.string(),
  })
  .strict();
export type ClassroomActionDto = z.infer<typeof classroomActionSchema>;

/** 课堂现场快照：会话、可播放队列、已播放编号与待核数量。 */
export const classroomStateSchema = z
  .object({
    session: classroomSessionSchema,
    cards: z.array(explanationCardSchema),
    playedIds: z.array(z.string()),
    pendingReview: z.number().int().nonnegative(),
    nextSceneId: z.string().nullable(),
  })
  .strict();
export type ClassroomStateDto = z.infer<typeof classroomStateSchema>;

const statementIdsField = { statementIds: z.array(z.string().min(1)).max(40) };

export const explanationCreateSchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('create-card'),
    lessonId: lessonIdField,
    lessonVersion: z.number().int().positive(),
    sceneId: z.string().min(1).max(120),
    kind: z.enum(EXPLANATION_KIND),
    text: z.string().min(2).max(4000),
    /** 只允许登记为教师手写；模型产生的卡片由服务侧写入路径标记来源。 */
    ...statementIdsField,
  })
  .strict();
export type ExplanationCreateInput = z.infer<typeof explanationCreateSchema>;

export const explanationReviewSchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('review-card'),
    explanationId: idField,
    decision: z.enum(['approved', 'rejected']),
    note: z.string().max(500),
  })
  .strict();
export type ExplanationReviewInput = z.infer<typeof explanationReviewSchema>;

/**
 * 待核区卡片的编辑：文本与依据陈述都可改，但至少要改一项（由服务判定）。
 *
 * 这里不用 `.refine` 包装：判别联合的成员必须是裸 ZodObject，包一层会让整个命令联合无法构造。
 */
export const explanationEditSchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('edit-card'),
    explanationId: idField,
    text: z.string().min(2).max(4000).optional(),
    statementIds: z.array(z.string().min(1)).max(40).optional(),
  })
  .strict();
export type ExplanationEditInput = z.infer<typeof explanationEditSchema>;

export const classroomOpenSchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('open'),
    lessonId: lessonIdField,
    stageId: z.string().min(1).nullable(),
    /** 开课时的场景；空串表示课堂尚未定位到场景，此时播放会明确报「没有可播卡片」。 */
    sceneId: z.string().max(120),
  })
  .strict();
export type ClassroomOpenInput = z.infer<typeof classroomOpenSchema>;

export const classroomPlaySchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('play-next'),
    sessionId: idField,
  })
  .strict();
export type ClassroomPlayInput = z.infer<typeof classroomPlaySchema>;

export const classroomHandbackSchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('handback'),
    sessionId: idField,
    reason: z.string().max(500),
  })
  .strict();
export type ClassroomHandbackInput = z.infer<typeof classroomHandbackSchema>;

export const classroomAdvanceSchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('advance-scene'),
    sessionId: idField,
    sceneId: z.string().min(1).max(120),
  })
  .strict();
export type ClassroomAdvanceInput = z.infer<typeof classroomAdvanceSchema>;

export const classroomAnsweredSchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('learner-answered'),
    sessionId: idField,
  })
  .strict();
export type ClassroomAnsweredInput = z.infer<typeof classroomAnsweredSchema>;

export const classroomCloseSchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('close'),
    sessionId: idField,
    status: z.enum(['completed', 'cancelled']),
    reason: z.string().max(500),
  })
  .strict();
export type ClassroomCloseInput = z.infer<typeof classroomCloseSchema>;

export const classroomCommandSchema = z.discriminatedUnion('action', [
  classroomOpenSchema,
  classroomPlaySchema,
  classroomHandbackSchema,
  classroomAnsweredSchema,
  classroomAdvanceSchema,
  classroomCloseSchema,
]);
export type ClassroomCommand = z.infer<typeof classroomCommandSchema>;
