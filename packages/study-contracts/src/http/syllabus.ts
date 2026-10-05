import { z } from 'zod';
import { EVIDENCE_USE } from '../status';
import { RECORD_SCOPE } from '../status';
import { SEGMENT_ID_PATTERN } from '../ids';
import { SYLLABUS_REQUIREMENT_KEY_PATTERN } from '../ids';
import { projectScopeSchema } from './project';

/** 条目内的一个必要要素；只有全部要素都被覆盖，条目才计入分子。 */
export const syllabusRequirementSchema = z.object({
  key: z.string().regex(SYLLABUS_REQUIREMENT_KEY_PATTERN),
  text: z.string().min(2).max(500),
});
export type SyllabusRequirementInput = z.infer<typeof syllabusRequirementSchema>;

/** 知识点绑定到某条目的某个必要要素；同一要素被多个知识点命中只计一次。 */
export const syllabusMappingSchema = z.object({
  itemId: z.string().min(1),
  requirementKey: z.string().regex(SYLLABUS_REQUIREMENT_KEY_PATTERN),
});
export type SyllabusMappingInput = z.infer<typeof syllabusMappingSchema>;

// —— 考纲原子项与覆盖（《规划书》8.1）——

export const syllabusItemCreateSchema = z
  .object({
    scope: projectScopeSchema,
    /** 考纲原文中的条目编号：同一范围内重复登记会被拒绝，避免虚增分母。 */
    code: z.string().min(1).max(60),
    label: z.string().min(2).max(200),
    requirements: z.array(syllabusRequirementSchema).min(1).max(40),
    /** 条目出自哪个已登记材料版本段落；来源不可定位时拒绝登记。 */
    source: z.object({
      materialId: z.string().min(1),
      revision: z.number().int().positive(),
      segmentId: z.string().regex(SEGMENT_ID_PATTERN),
    }),
  })
  .refine(
    (value) =>
      new Set(value.requirements.map((item) => item.key)).size === value.requirements.length,
    { message: '必要要素编号不能重复' },
  );
export type SyllabusItemCreateInput = z.infer<typeof syllabusItemCreateSchema>;

export const syllabusItemSchema = z.object({
  itemId: z.string(),
  code: z.string(),
  label: z.string(),
  recordScope: z.enum(RECORD_SCOPE),
  requirements: z.array(syllabusRequirementSchema),
  source: z.object({
    materialId: z.string(),
    revision: z.number().int().positive(),
    segmentId: z.string(),
    use: z.enum(EVIDENCE_USE),
    fingerprint: z.string(),
    excerpt: z.string(),
    /** 材料已更新到更新版本：条目仍指向旧版本，需人工重新核对。 */
    sourceStale: z.boolean(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SyllabusItemDto = z.infer<typeof syllabusItemSchema>;

export const syllabusCoverageItemSchema = z.object({
  itemId: z.string(),
  code: z.string(),
  label: z.string(),
  totalRequirements: z.number().int().positive(),
  coveredRequirements: z.number().int().nonnegative(),
  state: z.enum(['covered', 'partial', 'uncovered']),
});
export type SyllabusCoverageItemDto = z.infer<typeof syllabusCoverageItemSchema>;

export const syllabusCoverageSchema = z.object({
  totalItems: z.number().int().nonnegative(),
  coveredItems: z.number().int().nonnegative(),
  partialItems: z.number().int().nonnegative(),
  uncoveredItems: z.number().int().nonnegative(),
  /** 完整覆盖条目数 / 考纲条目总数；未登记条目时为 null，不显示为 0%。 */
  coverageRate: z.number().min(0).max(1).nullable(),
  /** 已核实但未绑定任何考纲条目的「考纲内」知识点数：作为缺口单列。 */
  unmappedKnowledge: z.number().int().nonnegative(),
  items: z.array(syllabusCoverageItemSchema),
});
export type SyllabusCoverageDto = z.infer<typeof syllabusCoverageSchema>;
