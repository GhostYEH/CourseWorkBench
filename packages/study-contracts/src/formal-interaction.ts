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
 * - 线性：结果 = a*x + intercept，|a|、|x|、|intercept| 各自可达 100，故 |结果| ≤ 100*100+100 = 10100；
 * - 二次：结果 = a*x² + intercept，|a| ≤ 100、|x| ≤ 100，故 |结果| ≤ 100*100²+100 = 1 000 100。
 * 取两者上界，二次公式的预测才可能被判定为一致。
 */
const PREDICTION_BOUND = 100 * 100 * 100 + 100;
const predictionField = z.number().finite().min(-PREDICTION_BOUND).max(PREDICTION_BOUND).nullable();

/**
 * 参数实验的公式种类（VIS-01 的「其余参数组件」）。
 *
 * 两种公式共用同一套「本人调参 → 服务端按冻结定义核验结果 → 记录预测是否一致」的合同，
 * 服务端按 `formula` 选择核验式；客户端不能自报公式或结果。
 */
export const PARAMETER_FORMULAS = ['linear', 'quadratic'] as const;
export type ParameterFormula = (typeof PARAMETER_FORMULAS)[number];

export const formalInteractionDefinitionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...base,
      kind: z.literal('parameter'),
      /** 实验公式。`linear` = a·x+b，`quadratic` = a·x²+b；结果一律由服务端按它核验。 */
      formula: z.enum(PARAMETER_FORMULAS),
      min: z.number().finite().min(-100).max(100),
      max: z.number().finite().min(-100).max(100),
      step: z.number().positive().max(100),
      intercept: z.number().finite().min(-100).max(100),
      /**
       * 本版本是否要求本人先给出预测。
       *
       * 这是**冻结在定义里**的版本合同：改它必须重新审核定义（定义摘要随之变化），
       * 因此「要不要预测」不会被悄悄放宽。默认 `false` 让 v1 之前的定义仍可读。
       */
      predictionRequired: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('concept_relation'),
      nodes: z
        .array(z.object({ id, label: z.string().min(1).max(200) }).strict())
        .min(2)
        .max(24),
      edges: z
        .array(z.object({ id, from: id, to: id, label: z.string().min(1).max(200) }).strict())
        .min(1)
        .max(48),
    })
    .strict(),
  /**
   * 排序关系（VIS-02）：把一组概念排成「由弱到强 / 由先到后」的正确顺序。
   *
   * 与 `concept_relation` 的区别：这里没有逐条 `to` 目标，正确顺序是**整条序列**——
   * 公开投影必须给出候选集合（`items`）但不给出正确顺序（`correctOrder`），否则等于把答案发出去。
   * 顺序按 `id` 引用 `items`，必须恰好覆盖所有条目、不重复（由服务端在冻结时校验）。
   */
  z
    .object({
      ...base,
      kind: z.literal('ordering'),
      items: z
        .array(z.object({ id, label: z.string().min(1).max(200) }).strict())
        .min(2)
        .max(24),
      /** 正确的排列（`items.id` 的一个排列）。服务端核验本人提交的顺序是否与它一致。 */
      correctOrder: z.array(id).min(2).max(24),
    })
    .strict(),
  /**
   * 步骤技能训练（OMA-085）：按顺序执行一组操作步骤，工具/成功条件/错误后果随定义冻结。
   *
   * 与 `ordering` 的区别：这里每个步骤有独立的**工具**与**成功判据**，且服务端在提交时逐步骤
   * 核验「本人这一步用的工具/顺序是否正确」；公开投影去掉每一步的 `correctToolId` 与步骤的
   * 正确先后（`correctOrder`），只给步骤集合与可选工具。训练记录仍是本人操作，不更新掌握。
   */
  z
    .object({
      ...base,
      kind: z.literal('procedural_skill'),
      procedureType: z.enum(['repair', 'assembly', 'inspection', 'operation', 'custom']),
      task: z.string().min(2).max(500),
      tools: z
        .array(z.object({ id, label: z.string().min(1).max(200) }).strict())
        .min(2)
        .max(24),
      steps: z
        .array(
          z
            .object({
              id,
              label: z.string().min(1).max(200),
              /** 该步骤的正确工具（`tools.id`）；服务端据此核验本人选择。 */
              correctToolId: id,
              /** 成功判据（阈值/读数/状态），展示给本人，不构成答案泄漏。 */
              successCriteria: z.string().min(2).max(400),
              /** 跳过或违规操作的后果，展示给本人。 */
              errorConsequences: z.string().min(2).max(400),
            })
            .strict(),
        )
        .min(2)
        .max(24),
      /** 正确步骤顺序（`steps.id` 的一个排列）。服务端核验本人提交的执行顺序。 */
      correctOrder: z.array(id).min(2).max(24),
    })
    .strict(),
]);
export type FormalInteractionDefinitionDto = z.infer<typeof formalInteractionDefinitionSchema>;
export const formalInteractionPublicDefinitionSchema = z.union([
  formalInteractionDefinitionSchema.options[0],
  z
    .object({
      ...base,
      kind: z.literal('concept_relation'),
      nodes: z.array(z.object({ id, label: z.string() }).strict()),
      edges: z.array(z.object({ id, from: id, label: z.string() }).strict()),
    })
    .strict(),
  /** 排序的公开投影：给出候选条目，**去掉正确顺序** `correctOrder`。 */
  z
    .object({
      ...base,
      kind: z.literal('ordering'),
      items: z.array(z.object({ id, label: z.string() }).strict()),
    })
    .strict(),
  /** 步骤技能的公开投影：给出步骤/工具/判据，**去掉每步正确工具与正确步骤顺序**。 */
  z
    .object({
      ...base,
      kind: z.literal('procedural_skill'),
      procedureType: z.enum(['repair', 'assembly', 'inspection', 'operation', 'custom']),
      task: z.string(),
      tools: z.array(z.object({ id, label: z.string() }).strict()),
      steps: z.array(
        z
          .object({
            id,
            label: z.string(),
            successCriteria: z.string(),
            errorConsequences: z.string(),
          })
          .strict(),
      ),
    })
    .strict(),
]);
export const formalInteractionFrozenSchema = z
  .object({
    version: z.literal(1),
    projectId: id,
    lessonId: id,
    lessonVersion: z.number().int().positive(),
    bundleDigest: id,
    reviewedBy: id,
    reviewNote: z.string().min(2).max(2000),
    definitions: z.array(formalInteractionDefinitionSchema).min(1).max(2),
  })
  .strict();
export type FormalInteractionFrozenDto = z.infer<typeof formalInteractionFrozenSchema>;
export const formalInteractionValuesSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('parameter'),
      a: z.number().finite(),
      x: z.number().finite().min(-100).max(100),
      /** 本人预测的实验结果；未填为 null。草稿可留空，提交是否必须由定义决定。 */
      prediction: predictionField.default(null),
      explanation: z.string().max(2000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('concept_relation'),
      edgeId: id,
      to: id,
      explanation: z.string().max(2000),
    })
    .strict(),
  /** 本人给出的排序：`items` 的一个排列。服务端核验是否与 `correctOrder` 一致。 */
  z
    .object({
      kind: z.literal('ordering'),
      order: z.array(id).min(2).max(24),
      explanation: z.string().max(2000),
    })
    .strict(),
  /**
   * 本人给出的步骤执行：按执行顺序给出步骤 id，并为每步选择所用工具。
   * 服务端核验「步骤顺序正确」且「每步工具正确」，逐步骤给出对错。
   */
  z
    .object({
      kind: z.literal('procedural_skill'),
      executed: z
        .array(z.object({ stepId: id, toolId: id }).strict())
        .min(2)
        .max(24),
      explanation: z.string().max(2000),
    })
    .strict(),
]);
export const formalInteractionBindingSchema = z
  .object({
    version: z.literal(1),
    stageId: id,
    sceneId: id,
    documentDigest: id,
    definitionDigest: id,
  })
  .strict();
export const formalInteractionRecordSchema = z
  .object({
    version: z.literal(1),
    uid: id,
    recordScope: z.literal('formal'),
    actorType: z.literal('human_learner'),
    binding: formalInteractionBindingSchema,
    values: formalInteractionValuesSchema,
    result: z.union([z.number().finite(), z.string()]).nullable(),
    /**
     * 预测与实测是否一致。只由服务端在提交时计算；草稿恒为 null。
     * 它是「这次预测对不对」的事实记录，不是掌握结论。
     */
    predictionMatched: z.boolean().nullable().default(null),
    mode: z.enum(['draft', 'submit']),
    nonce: id,
  })
  .strict();
export const formalInteractionReceiptSchema = z
  .object({ id, createdAt: z.string(), payload: formalInteractionRecordSchema })
  .strict();
export const formalInteractionStateSchema = z
  .object({
    definition: formalInteractionPublicDefinitionSchema,
    binding: formalInteractionBindingSchema,
    draft: formalInteractionReceiptSchema.nullable(),
    lastSubmission: formalInteractionReceiptSchema.nullable(),
    count: z.number().int().nonnegative(),
    deduplicated: z.boolean(),
  })
  .strict();
export const formalInteractionCommandSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('review'),
      scope: projectScopeSchema,
      lessonId: id,
      lessonVersion: z.number().int().positive(),
      semanticReviewed: z.literal(true),
      reviewNote: z.string().min(2).max(2000),
      definitions: z.array(formalInteractionDefinitionSchema).min(1).max(2),
    })
    .strict(),
  z
    .object({
      operation: z.literal('draft'),
      scope: projectScopeSchema,
      binding: formalInteractionBindingSchema,
      values: formalInteractionValuesSchema,
      nonce: id,
    })
    .strict(),
  z
    .object({
      operation: z.literal('submit'),
      scope: projectScopeSchema,
      binding: formalInteractionBindingSchema,
      values: formalInteractionValuesSchema,
      nonce: id,
    })
    .strict(),
]);
export type FormalInteractionCommand = z.infer<typeof formalInteractionCommandSchema>;
export type FormalInteractionStateDto = z.infer<typeof formalInteractionStateSchema>;
export type FormalInteractionBindingDto = z.infer<typeof formalInteractionBindingSchema>;
export type FormalInteractionValuesDto = z.infer<typeof formalInteractionValuesSchema>;
export type FormalInteractionRecordDto = z.infer<typeof formalInteractionRecordSchema>;
