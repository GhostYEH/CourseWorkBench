/**
 * 材料规范化与指纹（《规划书》5.2）。
 *
 * 规范化规则：统一 UTF-8、移除文件开头 BOM、换行转换为 LF，保留其他正文字符与空白。
 * 规范化后的文本作为只读版本保存；重新导入产生新版本，旧版本保留。
 */

import { createHash } from 'node:crypto';
import { NORMALIZATION_VERSION, formatSegmentId } from '@sew/study-contracts';

/** 移除开头 BOM 并把换行统一为 LF。不做 NFC/大小写等会改变原文的变换。 */
export const normalizeText = (raw: string): string => {
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return withoutBom.replace(/\r\n?/g, '\n');
};

/** 计算文本指纹（sha256 十六进制）。指纹验证原文身份与版本，不证明语义支持。 */
export const fingerprintOf = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

export interface RawSegment {
  segmentId: string;
  ordinal: number;
  text: string;
  fingerprint: string;
}

/**
 * 按空行切分段落，段落编号形如 S001。
 *
 * 规则：连续空行视为一个分段边界；段内单换行保留；去掉段首尾空白；
 * 空段不产生编号，保证同一文本切分结果稳定。
 */
export const splitSegments = (normalized: string): RawSegment[] => {
  const blocks = normalized.split(/\n{2,}/);
  const segments: RawSegment[] = [];
  let ordinal = 0;
  for (const block of blocks) {
    const text = block.trim();
    if (text.length === 0) continue;
    ordinal += 1;
    segments.push({
      segmentId: formatSegmentId(ordinal),
      ordinal,
      text,
      fingerprint: fingerprintOf(text),
    });
  }
  return segments;
};

export interface NormalizedMaterial {
  normalizationVersion: string;
  normalizedText: string;
  fingerprint: string;
  segments: RawSegment[];
}

/** 一次完成规范化、全文指纹与段落切分。 */
export const normalizeMaterial = (raw: string): NormalizedMaterial => {
  const normalizedText = normalizeText(raw);
  return {
    normalizationVersion: NORMALIZATION_VERSION,
    normalizedText,
    fingerprint: fingerprintOf(normalizedText),
    segments: splitSegments(normalizedText),
  };
};
