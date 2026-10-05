import { z } from 'zod';
import { RECORD_SCOPE } from '../status';
import { SUPPORTED_MATERIAL_TYPES } from '../fingerprint';
import { GENERATED_ID_PATTERN } from '../ids';
import { SEGMENT_ID_PATTERN } from '../ids';
import { projectScopeSchema } from './project';

// —— 材料 ——

/**
 * 导入材料。
 *
 * 导入模式用 `mode` 判别联合表达，而不是靠界面文案推断：
 * - `mode: 'file'`：`sourcePath` 必须是主进程已授权的原生选择结果；服务端不接受
 *   来自课堂 iframe 的磁盘路径，也不接受渲染层自报的任意路径。
 * - `mode: 'text'`：直接给出正文，供开发/演示与粘贴导入使用，仍走同一套规范化与指纹。
 */
const materialImportBase = {
  scope: projectScopeSchema,
  displayName: z.string().min(1).max(200),
  type: z.enum(SUPPORTED_MATERIAL_TYPES),
  /** 材料在考纲/教材中的可读位置，例如「人教版必修一 3.2」。 */
  readableLocation: z.string().max(200).optional(),
};

export const materialImportFileSchema = z.object({
  ...materialImportBase,
  mode: z.literal('file'),
  sourcePath: z.string().min(1),
});
export type MaterialImportFileInput = z.infer<typeof materialImportFileSchema>;

export const materialImportTextSchema = z.object({
  ...materialImportBase,
  mode: z.literal('text'),
  rawText: z.string().min(1),
});
export type MaterialImportTextInput = z.infer<typeof materialImportTextSchema>;

export const materialImportSchema = z.discriminatedUnion('mode', [
  materialImportFileSchema,
  materialImportTextSchema,
]);
export type MaterialImportInput = z.infer<typeof materialImportSchema>;

/**
 * 原始文件归档状态。
 *
 * 只有原生选择器导入的材料才有归档字节；粘贴导入与升级前的历史版本明确标记为
 * `absent`，界面与文档都不得把它们说成可打开原文。
 */
export const materialRawArchiveSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('archived'),
    sha256: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    mediaType: z.enum(['text/plain', 'text/markdown']),
    /** 选择器的文件名字面，仅用于展示；磁盘路径不下发给渲染层。 */
    originalName: z.string().nullable(),
    archivedAt: z.string(),
  }),
  z.object({
    state: z.literal('absent'),
    reason: z.enum(['text_import', 'legacy_import']),
  }),
]);
export type MaterialRawArchiveDto = z.infer<typeof materialRawArchiveSchema>;

export const materialSchema = z.object({
  materialId: z.string(),
  displayName: z.string(),
  type: z.enum(SUPPORTED_MATERIAL_TYPES),
  revision: z.number().int().positive(),
  recordScope: z.enum(RECORD_SCOPE),
  readableLocation: z.string().nullable(),
  importedAt: z.string(),
  segmentCount: z.number().int().nonnegative(),
  normalizationVersion: z.string(),
  fingerprint: z.string(),
  /** 引用该材料的已核实知识点数量，用于删除前引用检查。 */
  referencedByKnowledge: z.number().int().nonnegative(),
  /** 原始文件字节的归档状态；未归档时不能宣称可打开原文。 */
  rawArchive: materialRawArchiveSchema,
  /** 人工核实「该版本可作为考试真题来源」的记录；题目身份据此派生，请求方不能自报。 */
  examVerification: z.object({ verifiedAt: z.string(), note: z.string() }).nullable(),
});
export type MaterialDto = z.infer<typeof materialSchema>;

export const segmentSchema = z.object({
  segmentId: z.string(),
  ordinal: z.number().int().positive(),
  text: z.string(),
  fingerprint: z.string(),
  /** 段落在归档原文中的定位；未归档原文时为 null。 */
  rawStartByte: z.number().int().nonnegative().nullable(),
  rawEndByte: z.number().int().nonnegative().nullable(),
  rawLineStart: z.number().int().positive().nullable(),
  rawLineEnd: z.number().int().positive().nullable(),
});
export type SegmentDto = z.infer<typeof segmentSchema>;

/** 读取归档原文：必须给出材料版本，段落可选用于定位。 */
export const materialRawQuerySchema = z.object({
  revision: z.coerce.number().int().positive(),
  segmentId: z.string().regex(SEGMENT_ID_PATTERN).optional(),
});
export type MaterialRawQuery = z.infer<typeof materialRawQuerySchema>;

export const materialRawViewSchema = z.object({
  materialId: z.string(),
  revision: z.number().int().positive(),
  archive: materialRawArchiveSchema,
  /** 归档的原始文本，保留 BOM 与原始换行风格；未归档为 null。 */
  rawText: z.string().nullable(),
  segment: z
    .object({
      segmentId: z.string(),
      text: z.string(),
      startByte: z.number().int().nonnegative(),
      endByte: z.number().int().nonnegative(),
      lineStart: z.number().int().positive(),
      lineEnd: z.number().int().positive(),
      /** 同一区间在解码后原文中的字符偏移，界面高亮用；权威定位仍是字节区间。 */
      startChar: z.number().int().nonnegative(),
      endChar: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type MaterialRawViewDto = z.infer<typeof materialRawViewSchema>;

/**
 * 请主进程打开某材料版本的原文副本。
 *
 * 只接受标识与版本：渲染层不能提交磁盘路径，主进程也不能凭字符串获得读盘权限。
 * 副本路径由本地服务在项目内生成，主进程复验路径归属后才交给系统打开。
 */
export const materialOriginalOpenSchema = z.object({
  scope: projectScopeSchema,
  materialId: z.string().regex(GENERATED_ID_PATTERN),
  revision: z.number().int().positive(),
  segmentId: z.string().regex(SEGMENT_ID_PATTERN).optional(),
});
export type MaterialOriginalOpenInput = z.infer<typeof materialOriginalOpenSchema>;

// —— 权威事实：材料是否为「考试真题」来源 ——
/**
 * 人工核实「该材料版本可作为考试真题来源」。这是服务端权威事实，
 * 只通过授权审核操作写入；题目身份据此派生，请求方不能自报。
 */
export const materialExamVerificationSchema = z.object({
  scope: projectScopeSchema,
  materialId: z.string().min(1),
  revision: z.number().int().positive(),
  note: z.string().max(500).default(''),
});
export type MaterialExamVerificationInput = z.infer<typeof materialExamVerificationSchema>;
