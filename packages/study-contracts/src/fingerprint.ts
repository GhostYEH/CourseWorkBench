/**
 * 来源指纹规范（《规划书》5.2）。
 *
 * 指纹由程序在导入时计算，AI 只选取已登记的段落编号。
 * 规范化：统一 UTF-8、移除文件开头 BOM、换行转换为 LF，保留其他正文字符与空白。
 */

/** 规范化算法版本。改变规范化行为必须同时升版本，旧版本登记保留。 */
export const NORMALIZATION_VERSION = 'norm-1';

export const FINGERPRINT_ALGORITHM = 'sha256';

/** 段落编号形如 `S003`，在同一材料版本内稳定。 */
export const SEGMENT_ID_PREFIX = 'S';
export const formatSegmentId = (ordinal: number): string =>
  `${SEGMENT_ID_PREFIX}${String(ordinal).padStart(3, '0')}`;

export const parseSegmentId = (segmentId: string): number | null => {
  const match = /^S(\d{3,})$/.exec(segmentId);
  if (!match || match[1] === undefined) return null;
  return Number.parseInt(match[1], 10);
};

/** 首版支持的导入类型。 */
export const SUPPORTED_MATERIAL_TYPES = ['txt', 'md'] as const;
export type MaterialType = (typeof SUPPORTED_MATERIAL_TYPES)[number];

/** 单次导入上限，避免把巨型文件直接读入内存。 */
export const MAX_MATERIAL_BYTES = 4 * 1024 * 1024;
