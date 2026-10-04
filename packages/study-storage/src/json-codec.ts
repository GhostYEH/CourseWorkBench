/**
 * 版本化 JSON codec（《规划书》N8）。
 *
 * SQLite 的 JSON 列与磁盘文件一样属于不可信输入：可能是历史版本、被外部工具改写，
 * 或在上次写入中断后残留半截文本。这里统一做「解析 + zod 形状校验」，
 * 损坏或不合法时**不静默当作合法数据**，而是返回可诊断错误并回退到显式 fallback。
 *
 * 调用方（store / repository）根据列是否是权威事实的必要输入决定：
 * 记录一行 `console.warn` 继续降级，还是抛 `StudyError('INTERNAL')` 拒绝使用。
 */

import { z } from 'zod';
import { EVIDENCE_USE, SYLLABUS_REQUIREMENT_KEY_PATTERN } from '@sew/study-contracts';

export interface DecodeResult<T> {
  value: T;
  /** false 表示该列存在但无法作为合法数据使用。 */
  ok: boolean;
  /** 含 context 的可诊断错误；ok 为 true 时为 null。 */
  error: string | null;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 解析并校验 JSON 文本；null/undefined/空串视为「未写入」，回退但不报错。 */
export const decodeJson = <T>(
  value: unknown,
  schema: z.ZodType<T>,
  fallback: T,
  context: string,
): DecodeResult<T> => {
  const fail = (reason: string): DecodeResult<T> => ({
    value: fallback,
    ok: false,
    error: `${context}: ${reason}`,
  });

  if (value === null || value === undefined) {
    return { value: fallback, ok: true, error: null };
  }
  if (typeof value !== 'string') {
    return fail(`期望 JSON 文本，实际为 ${typeof value}`);
  }
  const text = value.trim();
  if (text.length === 0) {
    return { value: fallback, ok: true, error: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return fail(`JSON 解析失败：${describe(error)}`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
      .join('; ');
    return fail(`形状校验失败：${detail}`);
  }
  return { value: result.data, ok: true, error: null };
};

/** 序列化 JSON 列。undefined 落库为显式 null，避免写入 `undefined` 字符串。 */
export const encodeJson = (value: unknown): string => JSON.stringify(value) ?? 'null';

// ——————————————————————— 各 JSON 列的 zod schema ———————————————————————

/** 引用用途；与 contracts 的 EVIDENCE_USE 同源。 */
const evidenceUseSchema = z.enum(EVIDENCE_USE);

/** proposals / knowledge_points 的 evidence_json。 */
export const evidenceStoredSchema = z.object({
  materialId: z.string(),
  revision: z.number().int().positive(),
  segmentId: z.string(),
  use: evidenceUseSchema,
  fingerprint: z.string().optional(),
  excerpt: z.string().optional(),
});
export const evidenceListSchema = z.array(evidenceStoredSchema);

/** prerequisites_json。 */
export const prerequisitesSchema = z.array(z.string());

/** mechanical_json。 */
export const mechanicalSchema = z.object({
  passed: z.boolean(),
  checks: z.array(
    z.object({
      code: z.string(),
      ok: z.boolean(),
      detail: z.string(),
    }),
  ),
});

/** questions.origin_record_json；与领域层 OriginRecord 对齐（无自报字段）。 */
export const originRecordSchema = z.object({
  materialId: z.string(),
  revision: z.number().int().positive(),
  questionNumber: z.string(),
  rewrittenFrom: z.string().nullable(),
  rewriteNote: z.string(),
});

/** knowledge_ids_json。 */
export const knowledgeIdsSchema = z.array(z.string());

/**
 * syllabus_items.requirements_json：条目内的必要要素清单。
 *
 * 覆盖统计按要素计数，编号重复会让同一条目被虚增，因此按权威列拒绝。
 */
export const syllabusRequirementItemSchema = z.object({
  key: z.string().regex(SYLLABUS_REQUIREMENT_KEY_PATTERN),
  text: z.string().min(1),
});
export const syllabusRequirementsSchema = z
  .array(syllabusRequirementItemSchema)
  .min(1)
  .refine((items) => new Set(items.map((item) => item.key)).size === items.length, {
    message: '必要要素编号不能重复',
  });

/** runs.frozen_json 等运行快照列直接复用共享合同里的版本化形状，不再另写一份字段清单。 */
export {
  frozenVersionsSchema,
  planPayloadSchema,
  runEventPayloadSchema,
  runStartReceiptSchema,
} from '@sew/study-contracts';

/** 任意载荷（收据结果、事件 payload、计划 payload）：只校验 JSON 语法与根非 undefined。 */
export const arbitrarySchema = z.unknown();
