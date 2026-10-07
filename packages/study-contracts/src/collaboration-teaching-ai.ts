/**
 * 生成式教师 / AI 同学公共输出合同（OMA-029 剩余项，协议 4 之上的**新增**通道）。
 *
 * 与 `collaboration-teaching.ts` 的分工：那条通道只播报**冻结已审核陈述**；本通道
 * 允许房主发起模型实时生成的讲解与 AI 同学的公共讨论，但来源纪律**不放宽**：
 * - 模型正文只能以候选形状落入 `candidates` 待核区，且必须挂在**当前场景**知识点
 *   关联的冻结已审核 `anchorStatementId` 上；未审核候选永远进不了 `publicOutputs`；
 * - 候选只有经房主人工审核（`semanticReviewed` 显式确认）置为 `approved` 后才能
 *   公共播报；播报命令只引用 `candidateId`，正文由服务端从已核候选读出——与
 *   `speak` 同一纪律，调用方不能凭空塞任意正文；
 * - 等待本人（协议 4 的 waiting）期间，生成/记录/审核/播报一律暂停：服务在真正
 *   调用模型**之前**先读调度结论（`collabTeachingAiGateSchema`），不得空转；
 * - `senderType` 只取 `teacher_ai` / `peer_ai`，公共通道**不存在** `human_learner`
 *   取值；每条公共输出固定 `aiLabeled: true`，公开投影再把标注写死为 `'AI'`。
 *
 * 公开投影 `collabTeachingAiPublicOutputSchema` 是白名单字段：候选的审核批注、
 * 模型标识、私人观察、答案与评分依据都留在服务端，不随投影进入公共通道。
 * 本文件是协议 4 之外的新类型，`collaboration-teaching.ts` 的形状与语义不变。
 */
import { z } from 'zod';
import { learnerUidSchema } from './learner-profile';
import { collabEventSchema, collabText } from './classroom-collaboration';

const id = z.string().min(1).max(200);

export const COLLAB_TEACHING_AI_CANDIDATE_LIMIT = 50;
export const COLLAB_TEACHING_AI_OUTPUT_LIMIT = 200;
export const COLLAB_TEACHING_AI_BODY_MAX_LENGTH = 4000;
export const COLLAB_TEACHING_AI_INSTRUCTION_MAX_LENGTH = 500;
export const COLLAB_TEACHING_AI_NOTE_MAX_LENGTH = 500;

/** 发言归属：生成式教师或 AI 同学。真人不在此通道（真人走既有 CHAT-01 消息路径）。 */
export const COLLAB_TEACHING_AI_SENDER_TYPES = ['teacher_ai', 'peer_ai'] as const;
export type CollabTeachingAiSenderType = (typeof COLLAB_TEACHING_AI_SENDER_TYPES)[number];

/** 展示归属标签：公共通道里的每一条都带 AI 标注，界面不得自行改名成「教师」。 */
export const COLLAB_TEACHING_AI_SENDER_LABEL: Record<CollabTeachingAiSenderType, string> = {
  teacher_ai: '生成式教师（AI）',
  peer_ai: 'AI 同学',
};

/** 候选状态流：只有 pending → approved/rejected，approved 才可公共播报。 */
export const COLLAB_TEACHING_AI_CANDIDATE_STATUS = ['pending', 'approved', 'rejected'] as const;
export type CollabTeachingAiCandidateStatus = (typeof COLLAB_TEACHING_AI_CANDIDATE_STATUS)[number];

/** 调度结论的原因码，与领域判定使用的 `details.reason` 同源。 */
export const COLLAB_TEACHING_AI_GATE_REASONS = [
  'not_room_member',
  'collab_room_not_active',
  'collab_ai_owner_required',
  'collab_ai_waiting_learner',
  'collab_ai_candidate_limit',
  'collab_ai_output_limit',
] as const;
export type CollabTeachingAiGateReason = (typeof COLLAB_TEACHING_AI_GATE_REASONS)[number];

const aiBodyText = collabText(COLLAB_TEACHING_AI_BODY_MAX_LENGTH);

/** 教师候选不携带同学身份字段；peer 候选必须同时给出档案号与展示名。 */
const assertSpeakerFields = (
  value: {
    senderType: CollabTeachingAiSenderType;
    roleProfileId?: string;
    peerName?: string;
  },
  ctx: z.RefinementCtx,
): void => {
  const hasProfile = value.roleProfileId !== undefined;
  const hasName = value.peerName !== undefined;
  if (value.senderType === 'peer_ai') {
    if (!hasProfile)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roleProfileId'],
        message: 'roleProfileId required for peer_ai',
      });
    if (!hasName)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['peerName'],
        message: 'peerName required for peer_ai',
      });
  } else {
    if (hasProfile)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roleProfileId'],
        message: 'roleProfileId not allowed for teacher_ai',
      });
    if (hasName)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['peerName'],
        message: 'peerName not allowed for teacher_ai',
      });
  }
};

/**
 * 待核区候选：服务端模型调用的产物记录。
 *
 * `origin` 写死 `model_generated`：客户端提交的路径永远造不出「已审核」候选，
 * 审核结果（status/reviewNote/reviewedByUid）只有房主的 review 命令能改写。
 */
export const collabTeachingAiCandidateSchema = z
  .object({
    candidateId: id,
    seq: z.number().int().positive(),
    sceneId: id,
    /** 生成锚点：当前场景知识点关联的冻结已审核陈述编号。 */
    anchorStatementId: id,
    senderType: z.enum(COLLAB_TEACHING_AI_SENDER_TYPES),
    roleProfileId: id.optional(),
    peerName: collabText(80).optional(),
    body: aiBodyText,
    /** 仅审计/房主视图用；不进入公开投影与公共讨论流。 */
    model: z.string().trim().min(1).max(200),
    origin: z.literal('model_generated'),
    status: z.enum(COLLAB_TEACHING_AI_CANDIDATE_STATUS),
    reviewNote: z.string().max(COLLAB_TEACHING_AI_NOTE_MAX_LENGTH),
    reviewedByUid: learnerUidSchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine(assertSpeakerFields);
export type CollabTeachingAiCandidateDto = z.infer<typeof collabTeachingAiCandidateSchema>;

/**
 * 公共输出条目：只由 `broadcast-ai-candidate` 从 **approved** 候选追加。
 *
 * `aiLabeled` 是合同级常量位——公共通道不存在「AI 自称真人」的写入路径。
 * `conditions` 由服务端在播报时从冻结快照的锚点陈述复制，供界面展示适用条件。
 */
export const collabTeachingAiPublicOutputSchema = z
  .object({
    eventId: id,
    seq: z.number().int().positive(),
    sceneId: id,
    senderType: z.enum(COLLAB_TEACHING_AI_SENDER_TYPES),
    aiLabeled: z.literal(true),
    roleProfileId: id.optional(),
    peerName: collabText(80).optional(),
    candidateId: id,
    anchorStatementId: id,
    body: aiBodyText,
    conditions: z.string().max(2000),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine(assertSpeakerFields);
export type CollabTeachingAiPublicOutputDto = z.infer<typeof collabTeachingAiPublicOutputSchema>;

/**
 * 生成式公共输出命令。
 *
 * `generate-*` 是**客户端可发起**的请求：服务端先过调度结论再真正调用模型，产物走
 * `record-ai-candidate` 落库；`record-ai-candidate` 只允许**服务端模型调用完成路径**
 * 提交；`review-ai-candidate` / `broadcast-ai-candidate` 为人工动作（仅房主）。
 * 所有操作共用乐观并发字段（expectedRevision / expectedSeq）与幂等字段（eventId / requestId）。
 */
export const collabTeachingAiOperationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('generate-teacher-explanation'),
      anchorStatementId: id,
      instruction: collabText(COLLAB_TEACHING_AI_INSTRUCTION_MAX_LENGTH).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('generate-peer-utterance'),
      roleProfileId: id,
      peerName: collabText(80),
      anchorStatementId: id,
      instruction: collabText(COLLAB_TEACHING_AI_INSTRUCTION_MAX_LENGTH).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('record-ai-candidate'),
      candidateId: id,
      anchorStatementId: id,
      senderType: z.enum(COLLAB_TEACHING_AI_SENDER_TYPES),
      roleProfileId: id.optional(),
      peerName: collabText(80).optional(),
      body: aiBodyText,
      model: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal('review-ai-candidate'),
      candidateId: id,
      decision: z.enum(['approved', 'rejected']),
      note: z.string().max(COLLAB_TEACHING_AI_NOTE_MAX_LENGTH),
      /** 人工语义审核的显式确认位：界面必须让用户勾一下，不给默认值。 */
      semanticReviewed: z.literal(true),
    })
    .strict(),
  z.object({ kind: z.literal('broadcast-ai-candidate'), candidateId: id }).strict(),
]);
export type CollabTeachingAiOperation = z.infer<typeof collabTeachingAiOperationSchema>;

export const collabTeachingAiCommandSchema = z
  .object({
    roomId: id,
    actorUid: learnerUidSchema,
    sceneId: id,
    expectedRevision: z.number().int().positive(),
    expectedSeq: z.number().int().positive(),
    eventId: id,
    requestId: id,
    operation: collabTeachingAiOperationSchema,
  })
  .strict();
export type CollabTeachingAiCommandInput = z.infer<typeof collabTeachingAiCommandSchema>;

export const collabTeachingAiStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    roomId: id,
    sceneId: id,
    /** 待核区：模型候选只进这里，有界。 */
    candidates: z.array(collabTeachingAiCandidateSchema).max(COLLAB_TEACHING_AI_CANDIDATE_LIMIT),
    /** 公共输出：仅审核通过的候选可播报进入，有界；与协议 4 的 outputs 各自独立。 */
    publicOutputs: z.array(collabTeachingAiPublicOutputSchema).max(COLLAB_TEACHING_AI_OUTPUT_LIMIT),
  })
  .strict();
export type CollabTeachingAiStateDto = z.infer<typeof collabTeachingAiStateSchema>;

export const collabTeachingAiGateSchema = z
  .object({
    canGenerate: z.boolean(),
    reason: z.enum(COLLAB_TEACHING_AI_GATE_REASONS).nullable(),
  })
  .strict();
export type CollabTeachingAiGateDto = z.infer<typeof collabTeachingAiGateSchema>;

export const collabTeachingAiViewSchema = z
  .object({
    state: collabTeachingAiStateSchema,
    roomRevision: z.number().int().positive(),
    tailSeq: z.number().int().nonnegative(),
    /**
     * 服务端调度结论。界面必须消费这里而不是自己再算「开关 && 等待 && 上限」，
     * 与 `classroomState.peerSchedule` 同惯例，避免按钮亮着但服务端拒绝的漂移。
     */
    gate: collabTeachingAiGateSchema,
  })
  .strict();
export type CollabTeachingAiViewDto = z.infer<typeof collabTeachingAiViewSchema>;

export const collabTeachingAiResultSchema = z
  .object({
    state: collabTeachingAiStateSchema,
    roomRevision: z.number().int().positive(),
    event: collabEventSchema,
    deduplicated: z.boolean(),
  })
  .strict();
export type CollabTeachingAiResultDto = z.infer<typeof collabTeachingAiResultSchema>;

/** 新场景的初始待核态：空的候选区与公共输出，等待房主发起生成。 */
export const createCollabTeachingAiInitialState = (facts: {
  roomId: string;
  sceneId: string;
}): CollabTeachingAiStateDto => ({
  schemaVersion: 1,
  roomId: facts.roomId,
  sceneId: facts.sceneId,
  candidates: [],
  publicOutputs: [],
});
