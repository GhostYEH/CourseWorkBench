/**
 * 场景计划与元素编辑（LESSON-02 / OMA-006、OMA-021、OMA-022）。
 *
 * 场景计划是「这一版课件由哪些场景、按什么顺序、每个场景里有哪些元素」的可编辑草稿层：
 * - 场景用稳定 `sceneId`（不靠序号映射），增删/排序/复制/局部重生成都不改已有场景的身份；
 * - 幻灯片场景带可编辑元素（正文富文本 + 字号/颜色/加粗/对齐 + 位置尺寸），撤销恢复由
 *   编辑历史承担，落库的是最终计划本身；
 * - 计划只允许挂在草案版本上编辑，已发布版本的计划一经发布即冻结，历史不被原地改写。
 *
 * 计划与证据包一起装配成正式课件文档；同一份（证据包 + 计划）在任何时刻都得到同一份文档。
 */

import { z } from 'zod';
import { GENERATED_ID_PATTERN } from './ids';
import { projectScopeSchema } from './api';

/** 场景计划结构版本。 */
export const SCENE_PLAN_VERSION = 1;

/** 计划里允许出现的场景种类：与 `@openmaic/dsl` 的四类 Scene 一致。 */
export const PLAN_SCENE_KINDS = ['slide', 'quiz', 'interactive', 'pbl'] as const;
export type PlanSceneKind = (typeof PLAN_SCENE_KINDS)[number];

/** 可编辑元素种类。首版支持文本与图片，其余元素类型保持只读展示。 */
export const PLAN_ELEMENT_KINDS = ['text', 'image'] as const;
export type PlanElementKind = (typeof PLAN_ELEMENT_KINDS)[number];

/**
 * 富文本白名单。正文允许的行内标记在这里收口：模型或用户提交的正文若带
 * `script`/`iframe` 等标签一律拒绝，避免课件正文变成可执行内容。
 */
export const RICH_TEXT_TAGS = ['b', 'i', 'u', 'sub', 'sup', 'br', 'span'] as const;

export const planElementStyleSchema = z
  .object({
    fontSize: z.number().int().min(8).max(200),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    bold: z.boolean(),
    italic: z.boolean(),
    align: z.enum(['left', 'center', 'right']),
  })
  .strict();
export type PlanElementStyleDto = z.infer<typeof planElementStyleSchema>;

export const planElementSchema = z
  .object({
    elementId: z.string().regex(GENERATED_ID_PATTERN),
    kind: z.enum(PLAN_ELEMENT_KINDS),
    /** 文本元素的富文本正文；图片元素为空串。 */
    text: z.string().max(4000),
    /** 图片元素的符号引用；文本元素为 null。不写本地磁盘路径。 */
    assetRef: z.string().max(200).nullable(),
    left: z.number().int().min(0).max(4000),
    top: z.number().int().min(0).max(4000),
    width: z.number().int().min(20).max(4000),
    height: z.number().int().min(20).max(4000),
    style: planElementStyleSchema,
  })
  .strict();
export type PlanElementDto = z.infer<typeof planElementSchema>;

export const planSceneSchema = z
  .object({
    /** 稳定场景编号：排序、复制、局部重生成都不改已有场景的身份。 */
    sceneId: z.string().regex(GENERATED_ID_PATTERN),
    kind: z.enum(PLAN_SCENE_KINDS),
    title: z.string().min(1).max(120),
    /** 幻灯片场景绑定一条冻结陈述；其余场景为 null。 */
    statementId: z.string().min(1).nullable(),
    /** 测验场景绑定一道冻结题目；其余场景为 null。 */
    questionId: z.string().min(1).nullable(),
    knowledgeIds: z.array(z.string().min(1)).max(40),
    /** 可编辑元素；非幻灯片场景为空数组。 */
    elements: z.array(planElementSchema).max(24),
    /** 该场景的编辑备注（例如局部重生成的说明）；不进入教学事实。 */
    note: z.string().max(500),
  })
  .strict();
export type PlanSceneDto = z.infer<typeof planSceneSchema>;

/**
 * 场景计划。
 *
 * `origin` 区分确定性装配与模型生成的计划；两者都必须经人工审核发布后才进入教学。
 * `revision` 是乐观并发版本：客户端基于读到的 revision 提交，服务端 revision 已推进即拒绝。
 */
export const scenePlanSchema = z
  .object({
    planVersion: z.literal(SCENE_PLAN_VERSION),
    projectId: z.string().min(1),
    lessonId: z.string().min(1),
    lessonVersion: z.number().int().positive(),
    bundleId: z.string().min(1),
    scenes: z.array(planSceneSchema).min(1).max(48),
    revision: z.number().int().nonnegative(),
    origin: z.enum(['deterministic', 'model_generated']),
    updatedAt: z.string(),
  })
  .strict();
export type ScenePlanDto = z.infer<typeof scenePlanSchema>;

/** 保存场景计划：整份计划覆盖写，带 `baseRevision` 做乐观并发。 */
export const scenePlanSaveSchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('save-scene-plan'),
    requestId: z.string().trim().min(1).max(200),
    lessonId: z.string().min(1),
    version: z.number().int().positive(),
    /** 客户端读到并据以编辑的 revision；服务端已推进时返回 VERSION_CONFLICT。 */
    baseRevision: z.number().int().nonnegative(),
    scenes: z.array(planSceneSchema).min(1).max(48),
  })
  .strict();
export type ScenePlanSaveInput = z.infer<typeof scenePlanSaveSchema>;

/** 请求模型生成完整课件计划（OMA-006）。产物只作为待核候选，不直接写入计划。 */
export const coursewareProposeSchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('propose-courseware'),
    requestId: z.string().trim().min(1).max(200),
    lessonId: z.string().min(1),
    version: z.number().int().positive(),
    instruction: z.string().trim().min(2).max(600),
  })
  .strict();
export type CoursewareProposeInput = z.infer<typeof coursewareProposeSchema>;

/**
 * 模型输出的完整课件计划：只允许给出场景种类、标题、绑定的陈述/题目与元素正文。
 * 场景编号、知识点、来源都由服务端从冻结证据包沿用，模型不能自报身份或来源。
 */
export const coursewareSceneOutputSchema = z
  .object({
    kind: z.enum(PLAN_SCENE_KINDS),
    title: z.string().trim().min(1).max(120),
    /** 幻灯片绑定本版本已选中的陈述；测验绑定本版本已选中的题目；其余为 null。 */
    statementId: z.string().min(1).nullable(),
    questionId: z.string().min(1).nullable(),
    note: z.string().max(500).optional(),
    elements: z
      .array(
        z
          .object({
            text: z.string().min(1).max(4000),
            style: planElementStyleSchema.partial().optional(),
          })
          .strict(),
      )
      .max(12)
      .optional(),
  })
  .strict();
export type CoursewareSceneOutput = z.infer<typeof coursewareSceneOutputSchema>;

export const coursewareOutputSchema = z
  .object({ scenes: z.array(coursewareSceneOutputSchema).min(1).max(48) })
  .strict();
export type CoursewareOutput = z.infer<typeof coursewareOutputSchema>;

/** 完整课件生成候选的状态：先落 `pending`，人工通过才写入计划。 */
export const COURSEWARE_CANDIDATE_STATUS = ['pending', 'applied', 'rejected'] as const;
export type CoursewareCandidateStatus = (typeof COURSEWARE_CANDIDATE_STATUS)[number];

/** 一条完整课件生成候选。正文是模型草案，未通过前不进入任何课程计划或教学。 */
export const coursewareCandidateSchema = z
  .object({
    candidateId: z.string().min(1),
    projectId: z.string().min(1),
    lessonId: z.string().min(1),
    baseVersion: z.number().int().positive(),
    origin: z.literal('model_generated'),
    status: z.enum(COURSEWARE_CANDIDATE_STATUS),
    scenes: z.array(planSceneSchema).min(1).max(48),
    instruction: z.string(),
    note: z.string(),
    /** 审核人身份由服务端写入；请求体没有该字段。 */
    reviewedBy: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type CoursewareCandidateDto = z.infer<typeof coursewareCandidateSchema>;

/** 人工处置完整课件候选：通过则把候选场景写入该草案版本的场景计划。 */
export const coursewareApplySchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('apply-courseware'),
    requestId: z.string().trim().min(1).max(200),
    candidateId: z.string().min(1),
    decision: z.enum(['approved', 'rejected']),
    note: z.string().max(500),
  })
  .strict();
export type CoursewareApplyInput = z.infer<typeof coursewareApplySchema>;
