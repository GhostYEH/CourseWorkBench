import { z } from 'zod';
import { projectScopeSchema } from './api';

const id = z.string().min(1).max(200);
const base = { id, title: z.string().min(1).max(120), statementIds: z.array(id).min(1).max(24) };

/**
 * 参数实验的独立预测字段（VIS-01）。
 *
 * 预测是**本人先给出的猜测**，必须在看到服务核验结果之前记录，且与解释分开保存。
 * 它是否与实测一致由服务端判定并写入记录，但**不更新掌握状态**——一次预测对不对
 * 不足以证明学科掌握。
 */
/**
 * 预测的取值范围必须覆盖结果的包络，否则「预测一致」对大量参数组合不可达：
 * 结果 = a*x + intercept，而 |a|、|x|、|intercept| 各自可达 100，故 |结果| ≤ 100*100+100 = 10100。
 */
const PREDICTION_BOUND = 100 * 100 + 100;
const predictionField = z.number().finite().min(-PREDICTION_BOUND).max(PREDICTION_BOUND).nullable();

export const formalInteractionDefinitionSchema = z.discriminatedUnion('kind', [
  z.object({
    ...base, kind: z.literal('parameter'), formula: z.literal('linear'),
    min: z.number().finite().min(-100).max(100), max: z.number().finite().min(-100).max(100),
    step: z.number().positive().max(100), intercept: z.number().finite().min(-100).max(100),
    /**
     * 本版本是否要求本人先给出预测。
     *
     * 这是**冻结在定义里**的版本合同：改它必须重新审核定义（定义摘要随之变化），
     * 因此「要不要预测」不会被悄悄放宽。默认 `false` 让 v1 之前的定义仍可读。
     */
    predictionRequired: z.boolean().default(false),
  }).strict(),
  z.object({ ...base, kind: z.literal('concept_relation'), nodes: z.array(z.object({ id, label: z.string().min(1).max(200) }).strict()).min(2).max(24), edges: z.array(z.object({ id, from: id, to: id, label: z.string().min(1).max(200) }).strict()).min(1).max(48) }).strict(),
]);
export type FormalInteractionDefinitionDto = z.infer<typeof formalInteractionDefinitionSchema>;
export const formalInteractionPublicDefinitionSchema = z.union([
  formalInteractionDefinitionSchema.options[0],
  z.object({ ...base, kind: z.literal('concept_relation'), nodes: z.array(z.object({ id, label: z.string() }).strict()), edges: z.array(z.object({ id, from: id, label: z.string() }).strict()) }).strict(),
]);
export const formalInteractionFrozenSchema = z.object({ version: z.literal(1), projectId: id, lessonId: id, lessonVersion: z.number().int().positive(), bundleDigest: id, reviewedBy: id, reviewNote: z.string().min(2).max(2000), definitions: z.array(formalInteractionDefinitionSchema).min(1).max(2) }).strict();
export type FormalInteractionFrozenDto = z.infer<typeof formalInteractionFrozenSchema>;
export const formalInteractionValuesSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('parameter'),
    a: z.number().finite(), x: z.number().finite().min(-100).max(100),
    /** 本人预测的实验结果；未填为 null。草稿可留空，提交是否必须由定义决定。 */
    prediction: predictionField.default(null),
    explanation: z.string().max(2000),
  }).strict(),
  z.object({ kind: z.literal('concept_relation'), edgeId: id, to: id, explanation: z.string().max(2000) }).strict(),
]);
export const formalInteractionBindingSchema = z.object({ version: z.literal(1), stageId: id, sceneId: id, documentDigest: id, definitionDigest: id }).strict();
export const formalInteractionRecordSchema = z.object({
  version: z.literal(1), uid: id, recordScope: z.literal('formal'), actorType: z.literal('human_learner'),
  binding: formalInteractionBindingSchema, values: formalInteractionValuesSchema,
  result: z.union([z.number().finite(), z.string()]).nullable(),
  /**
   * 预测与实测是否一致。只由服务端在提交时计算；草稿恒为 null。
   * 它是「这次预测对不对」的事实记录，不是掌握结论。
   */
  predictionMatched: z.boolean().nullable().default(null),
  mode: z.enum(['draft', 'submit']), nonce: id,
}).strict();
export const formalInteractionReceiptSchema = z.object({ id, createdAt: z.string(), payload: formalInteractionRecordSchema }).strict();
export const formalInteractionStateSchema = z.object({ definition: formalInteractionPublicDefinitionSchema, binding: formalInteractionBindingSchema, draft: formalInteractionReceiptSchema.nullable(), lastSubmission: formalInteractionReceiptSchema.nullable(), count: z.number().int().nonnegative(), deduplicated: z.boolean() }).strict();
export const formalInteractionCommandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('review'), scope: projectScopeSchema, lessonId: id, lessonVersion: z.number().int().positive(), semanticReviewed: z.literal(true), reviewNote: z.string().min(2).max(2000), definitions: z.array(formalInteractionDefinitionSchema).min(1).max(2) }).strict(),
  z.object({ operation: z.literal('draft'), scope: projectScopeSchema, binding: formalInteractionBindingSchema, values: formalInteractionValuesSchema, nonce: id }).strict(),
  z.object({ operation: z.literal('submit'), scope: projectScopeSchema, binding: formalInteractionBindingSchema, values: formalInteractionValuesSchema, nonce: id }).strict(),
]);
export type FormalInteractionCommand = z.infer<typeof formalInteractionCommandSchema>;
export type FormalInteractionStateDto = z.infer<typeof formalInteractionStateSchema>;
export type FormalInteractionBindingDto = z.infer<typeof formalInteractionBindingSchema>;
export type FormalInteractionValuesDto = z.infer<typeof formalInteractionValuesSchema>;
export type FormalInteractionRecordDto = z.infer<typeof formalInteractionRecordSchema>;
