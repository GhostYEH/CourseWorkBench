/**
 * 计划、运行快照与步骤收据的领域形状（代码整改 N8）。
 *
 * 这三类数据都以 JSON 列落库，读取时同样是不可信输入：可能是历史版本、外部工具改写，
 * 或写入中断后的半截内容。这里给出带版本号的可校验形状，存储层不再「解析后直接断言」，
 * 恢复路径也不会把损坏的权威收据当作合法事实。
 */

import { z } from 'zod';
import { RUN_EVENT_TYPES, RUN_STATE } from './status';
/** 计划载荷版本。改变载荷结构必须升版本，并在迁移里为旧载荷补标。 */
export const PLAN_PAYLOAD_VERSION = 1;

export const planEvidenceRefSchema = z.object({
  materialId: z.string().min(1),
  segmentId: z.string().min(1),
});

export const planTaskSchema = z.object({
  knowledgeId: z.string().min(1),
  name: z.string().min(1).max(200),
  minutes: z.number().int().min(5).max(600),
  acceptance: z.string().max(500),
  evidence: z.array(planEvidenceRefSchema),
});
export type PlanTaskDto = z.infer<typeof planTaskSchema>;

/** 缺口条目：来源或范围未通过时留在待核，不作为已确定任务下发。 */
export const planGapSchema = z.object({
  knowledgeId: z.string().min(1),
  name: z.string().min(1).max(200),
  code: z.string().min(1),
  missing: z.array(z.string()),
});
export type PlanGapDto = z.infer<typeof planGapSchema>;

export const planPayloadSchema = z
  .object({
    payloadVersion: z.literal(PLAN_PAYLOAD_VERSION),
    goal: z.string().max(500),
    examDate: z.string().max(20).nullable(),
    dailyMinutes: z.number().int().min(0).max(720),
    tasks: z.array(planTaskSchema),
    gaps: z.array(planGapSchema),
    basis: z.string().max(500),
    /** 人工逐条确认过的任务编号；未确认的任务不会进入正式 run。 */
    confirmedTaskKnowledgeIds: z.array(z.string()),
  })
  .strict();
export type PlanPayloadDto = z.infer<typeof planPayloadSchema>;

/**
 * 冻结版本集合：run 恢复时必须仍是同一套事实。
 *
 * 知识点清单用摘要而不是「条数」表示：任何一条知识点的新增、审核或失效都会改变摘要。
 */
export const frozenVersionsSchema = z
  .object({
    knowledgeTableDigest: z.string().min(1),
    materialRevisions: z.record(z.string(), z.number().int().positive()),
    planVersion: z.number().int().positive().nullable(),
    lessonVersion: z.number().int().positive().nullable(),
    teachingPreferenceVersion: z.number().int().nonnegative(),
    roleConfigDigest: z.string().nullable(),
    modelProfileId: z.string().nullable(),
  })
  .strict();
export type FrozenVersionsDto = z.infer<typeof frozenVersionsSchema>;

/** 步骤收据载荷版本。 */
export const STEP_RECEIPT_VERSION = 1;

/** run 启动收据：重复请求按同一 stepKey 读回既有 run，不产生第二个 run。 */
export const runStartReceiptSchema = z
  .object({
    receiptVersion: z.literal(STEP_RECEIPT_VERSION),
    runId: z.string().min(1),
    planVersion: z.number().int().positive(),
    state: z.enum(RUN_STATE),
  })
  .strict();
export type RunStartReceiptDto = z.infer<typeof runStartReceiptSchema>;

const seqField = z.number().int().positive();

/** run_events.payload_json 的分类型形状；与 RUN_EVENT_TYPES 同源。 */
export const runEventPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run_started'), state: z.enum(RUN_STATE), frozen: frozenVersionsSchema }).strict(),
  z.object({ type: z.literal('step_started'), stepId: z.string().min(1), label: z.string().max(200) }).strict(),
  z.object({ type: z.literal('draft_delta'), text: z.string().max(20_000) }).strict(),
  z.object({ type: z.literal('proposal_created'), proposalIds: z.array(z.string()) }).strict(),
  z.object({ type: z.literal('review_required'), reason: z.string().max(500), pending: z.array(z.string()) }).strict(),
  z.object({ type: z.literal('answer_required'), questionId: z.string().min(1) }).strict(),
  z.object({
    type: z.literal('step_committed'),
    stepId: z.string().min(1),
    receiptId: z.string().min(1),
    deduplicated: z.boolean(),
  }).strict(),
  z.object({ type: z.literal('run_completed'), state: z.enum(RUN_STATE) }).strict(),
  z.object({ type: z.literal('run_failed'), code: z.string().min(1), message: z.string().max(500) }).strict(),
  z.object({ type: z.literal('run_cancelled'), reason: z.string().max(500) }).strict(),
]);
export type RunEventPayloadDto = z.infer<typeof runEventPayloadSchema>;

export type RunEventTypeDto = (typeof RUN_EVENT_TYPES)[number];

/** 供恢复路径消费的运行快照：状态、冻结版本与已提交事件序号。 */
export const runSnapshotSchema = z
  .object({
    runId: z.string().min(1),
    state: z.enum(RUN_STATE),
    frozen: frozenVersionsSchema,
    /** 已提交的最大事件序号；恢复只从该序号之后继续。 */
    lastSeq: seqField.default(0),
  })
  .strict();
export type RunSnapshotDto = z.infer<typeof runSnapshotSchema>;
