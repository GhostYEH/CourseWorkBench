/**
 * 严格受限的 AI 场景计划补丁（LESSON-02 / OMA-023）。
 *
 * 这是「AI 编辑课件」的唯一受控入口：模型只能提出**补丁操作**，且操作的目标被收口在
 * 一个极小的字段白名单里——只允许改场景标题/备注、元素正文/几何/样式，以及在同一场景内
 * 增删元素。来源绑定（statementId/questionId）、知识点、场景身份（sceneId/kind）与任何
 * 计划元数据（projectId/lessonId/revision/digest/…）都不在合同里，模型**没有字段可以表达**，
 * 因此不存在「先写进来再拒绝」的窗口。
 *
 * 补丁本身不是权威：它先落待核候选，人工逐项查看「哪一条能不能应用、应用后长什么样」，
 * 明确通过后才按 `save-scene-plan` 的乐观并发与事务回执写入计划；内容一变旧审核即失效，
 * 新版本必须重新审核后才能发布。补丁复用现有生成 guard（来源/run/预算/取消），不新开无预算的模型路径。
 */

import { z } from 'zod';
import { GENERATED_ID_PATTERN } from './ids';
import { projectScopeSchema } from './api';
import { PLAN_ELEMENT_KINDS, planElementStyleSchema, planSceneSchema } from './scene-plan';

/** 单次补丁的操作条数上限：异常大的补丁直接拒绝，避免把审核界面淹没。 */
export const SCENE_PATCH_OP_LIMIT = 40;

/** 允许 AI 修改的**场景级**字段。场景身份与来源绑定不在此列。 */
export const SCENE_PATCH_SCENE_FIELDS = ['title', 'note'] as const;
export type ScenePatchSceneField = (typeof SCENE_PATCH_SCENE_FIELDS)[number];

/**
 * 允许 AI 修改的**元素级**字段。
 *
 * 注意 `assetRef` 虽在列表里，但它的取值仍要经服务端按「本课程相同证据包内已审核图片」
 * 复验（`assertFormalLessonImage`）；把 `assetRef` 设成任意字符串不会通过保存。
 */
export const SCENE_PATCH_ELEMENT_FIELDS = [
  'text',
  'assetRef',
  'left',
  'top',
  'width',
  'height',
  'rotation',
  'layerOrder',
  'style.fontSize',
  'style.color',
  'style.bold',
  'style.italic',
  'style.align',
] as const;
export type ScenePatchElementField = (typeof SCENE_PATCH_ELEMENT_FIELDS)[number];

const sceneRef = z.string().regex(GENERATED_ID_PATTERN);
const elementRef = z.string().regex(GENERATED_ID_PATTERN);

/** 模型新增元素时只给种类、正文与几何；元素编号由服务端按 requestId 派生，模型不能自报身份。 */
export const scenePatchNewElementSchema = z
  .object({
    kind: z.enum(PLAN_ELEMENT_KINDS),
    text: z.string().max(4000),
    assetRef: z.string().max(200).nullable(),
    left: z.number().int().min(0).max(4000),
    top: z.number().int().min(0).max(4000),
    width: z.number().int().min(20).max(4000),
    height: z.number().int().min(20).max(4000),
    style: planElementStyleSchema.partial().optional(),
  })
  .strict();
export type ScenePatchNewElement = z.infer<typeof scenePatchNewElementSchema>;

/**
 * 一条受限补丁操作。
 *
 * 采用结构化目标而不是任意 JSON Pointer：`field` 是枚举，未知字段/未知操作直接被 schema 拒绝；
 * `value` 的类型与范围由领域层按 `field` 逐条判定，越界一律记为「不可应用」而不是静默裁剪。
 */
export const scenePlanPatchOpSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('replace-scene'),
      sceneId: sceneRef,
      field: z.enum(SCENE_PATCH_SCENE_FIELDS),
      value: z.string().max(2000),
    })
    .strict(),
  z
    .object({
      op: z.literal('replace-element'),
      sceneId: sceneRef,
      elementId: elementRef,
      field: z.enum(SCENE_PATCH_ELEMENT_FIELDS),
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      op: z.literal('add-element'),
      sceneId: sceneRef,
      element: scenePatchNewElementSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal('remove-element'),
      sceneId: sceneRef,
      elementId: elementRef,
    })
    .strict(),
]);
export type ScenePlanPatchOp = z.infer<typeof scenePlanPatchOpSchema>;

/** 模型输出的补丁：只允许一串受限操作，不得夹带身份、来源或解释字段。 */
export const scenePlanPatchOutputSchema = z
  .object({ ops: z.array(scenePlanPatchOpSchema).min(1).max(SCENE_PATCH_OP_LIMIT) })
  .strict();
export type ScenePlanPatchOutput = z.infer<typeof scenePlanPatchOutputSchema>;

/** 逐项应用结果：每条操作是「可应用」还是「被拒绝」，被拒绝时给出机器可判定的原因。 */
export const scenePlanPatchOpResultSchema = z
  .object({
    index: z.number().int().nonnegative(),
    op: z.enum(['replace-scene', 'replace-element', 'add-element', 'remove-element']),
    status: z.enum(['applicable', 'rejected']),
    reason: z.string(),
    /** 人类可读的变更摘要，供逐项审核界面展示。 */
    summary: z.string(),
  })
  .strict();
export type ScenePlanPatchOpResultDto = z.infer<typeof scenePlanPatchOpResultSchema>;

/**
 * 补丁预览：把「应用这份补丁会得到什么计划」在写入前如实摊开。
 *
 * `results` 逐条给出可应用/被拒绝；`scenes` 是只应用**被选中的可应用**操作后的计划内容（尚未写入）；
 * `digest` 是这份结果计划的稳定摘要，用于与后续保存/审核对齐。
 *
 * 数量语义彼此独立，界面据此准确呈现：
 * - `applicableCount`：候选里**可应用**的操作总数（与是否勾选无关）；
 * - `selectedCount`：本次**勾选**的操作数（未提供选择时等于可应用数）；
 * - `appliedCount`：实际会写入计划的操作数（勾选 ∩ 可应用）；
 * - `rejectedCount`：被服务端判定为**不可应用**的操作数。
 * 未勾选的可应用操作既不写入也不计为 rejected，只在 `appliedCount` 与 `applicableCount` 的差里体现。
 */
export const scenePlanPatchPreviewSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    baseDigest: z.string().min(1).nullable(),
    results: z.array(scenePlanPatchOpResultSchema).max(SCENE_PATCH_OP_LIMIT),
    applicableCount: z.number().int().nonnegative(),
    selectedCount: z.number().int().nonnegative(),
    appliedCount: z.number().int().nonnegative(),
    rejectedCount: z.number().int().nonnegative(),
    scenes: z.array(planSceneSchema).min(1).max(48),
    digest: z.string().min(1),
  })
  .strict();
export type ScenePlanPatchPreviewDto = z.infer<typeof scenePlanPatchPreviewSchema>;

export const SCENE_PLAN_PATCH_CANDIDATE_STATUS = ['pending', 'applied', 'rejected'] as const;
export type ScenePlanPatchCandidateStatus = (typeof SCENE_PLAN_PATCH_CANDIDATE_STATUS)[number];

/**
 * 一条补丁候选。`basePlanRevision`/`basePlanDigest` 记录生成时的计划基线，
 * 人工处置时若计划已被别处推进，除非显式确认覆盖，否则拒绝把旧补丁写进新计划。
 */
export const scenePlanPatchCandidateSchema = z
  .object({
    candidateId: z.string().min(1),
    projectId: z.string().min(1),
    lessonId: z.string().min(1),
    baseVersion: z.number().int().positive(),
    basePlanRevision: z.number().int().nonnegative(),
    basePlanDigest: z.string().min(1).nullable(),
    origin: z.literal('model_generated'),
    status: z.enum(SCENE_PLAN_PATCH_CANDIDATE_STATUS),
    instruction: z.string(),
    ops: z.array(scenePlanPatchOpSchema).min(1).max(SCENE_PATCH_OP_LIMIT),
    note: z.string(),
    reviewedBy: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type ScenePlanPatchCandidateDto = z.infer<typeof scenePlanPatchCandidateSchema>;

/** 请求模型生成一份受限补丁。产物只落待核候选，不直接写入计划。 */
export const scenePlanPatchProposeSchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('propose-scene-plan-patch'),
    requestId: z.string().trim().min(1).max(200),
    lessonId: z.string().min(1),
    version: z.number().int().positive(),
    instruction: z.string().trim().min(2).max(600),
  })
  .strict();
export type ScenePlanPatchProposeInput = z.infer<typeof scenePlanPatchProposeSchema>;

/**
 * 逐项审核的**只读**预览：把候选操作逐条判定「可应用/被拒绝」，并算出应用**被选中的可应用**操作后的
 * 计划内容与摘要。它不写入任何计划、天然幂等，写回仍走 `apply-scene-plan-patch` 的乐观并发。
 *
 * `selectedOpIndexes` 给出当前勾选的操作（省略即全部可应用操作）。界面在勾选或计划基线变化时重新计算，
 * 使预览与最终写入逐字一致；迟到的旧预览由界面按基线/选择指纹丢弃，不覆盖新选择。
 */
export const scenePlanPatchPreviewInputSchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('preview-scene-plan-patch'),
    candidateId: z.string().min(1),
    selectedOpIndexes: z.array(z.number().int().nonnegative()).max(SCENE_PATCH_OP_LIMIT).optional(),
  })
  .strict();
export type ScenePlanPatchPreviewInput = z.infer<typeof scenePlanPatchPreviewInputSchema>;

/**
 * 人工处置补丁候选：通过则把选中的可应用操作写进计划。
 *
 * `selectedOpIndexes` 是逐项审核后的选择（省略表示采用全部可应用操作）。被拒绝的操作不写入。
 * 通过时仍需 `expectedPlanRevision` 与计划基线一致（`override` 才允许覆盖已推进的计划）。
 */
export const scenePlanPatchApplySchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('apply-scene-plan-patch'),
    requestId: z.string().trim().min(1).max(200),
    candidateId: z.string().min(1),
    decision: z.enum(['approved', 'rejected']),
    note: z.string().max(500),
    /** 逐项审核后的操作选择；省略即采用全部可应用操作。 */
    selectedOpIndexes: z.array(z.number().int().nonnegative()).max(SCENE_PATCH_OP_LIMIT).optional(),
    expectedPlanRevision: z.number().int().nonnegative().optional(),
    override: z.boolean().default(false),
  })
  .strict();
export type ScenePlanPatchApplyInput = z.infer<typeof scenePlanPatchApplySchema>;
