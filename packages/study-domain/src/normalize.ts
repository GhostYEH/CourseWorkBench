/**
 * 材料规范化与指纹（《规划书》5.2）。
 *
 * 规范化规则：统一 UTF-8、移除文件开头 BOM、换行转换为 LF，保留其他正文字符与空白。
 * 规范化后的文本作为只读版本保存；重新导入产生新版本，旧版本保留。
 * 文件导入还保存原始字节，因此段落额外带原始文本中的字节区间与行号用于定位原文。
 */

import { createHash } from 'node:crypto';
import { NORMALIZATION_VERSION, StudyError, formatSegmentId } from '@sew/study-contracts';

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

/** 段落在原始文本中的定位：字节区间为 UTF-8 偏移，行号为 1 起始。 */
export interface RawSegmentSpan {
  segmentId: string;
  ordinal: number;
  startByte: number;
  endByte: number;
  lineStart: number;
  lineEnd: number;
  text: string;
}

/**
 * 把每个段落定位回原始文本的字节区间。
 *
 * 分段边界必须与 `splitSegments(normalizeText(raw))` 逐字一致：以真正空的行（行内
 * 没有任何字符）为界，段内单换行保留，段首尾空白不计入文本但仍落在字节区间内。
 * 字节偏移按 UTF-8 计算，中文与 emoji 材料的定位才能直接用于原始文件副本。
 */
export const locateRawSegments = (raw: string): RawSegmentSpan[] => {
  const spans: RawSegmentSpan[] = [];
  let ordinal = 0;
  let line = 0;
  let charPos = 0;
  let bytePos = 0;
  let blockStartChar = -1;
  let blockStartByte = 0;
  let blockStartLine = 0;
  let blockEndChar = 0;
  let blockEndByte = 0;
  let blockEndLine = 0;

  const flushBlock = (): void => {
    if (blockStartChar < 0) return;
    const text = normalizeText(raw.slice(blockStartChar, blockEndChar)).trim();
    blockStartChar = -1;
    if (text.length === 0) return;
    ordinal += 1;
    spans.push({
      segmentId: formatSegmentId(ordinal),
      ordinal,
      startByte: blockStartByte,
      endByte: blockEndByte,
      lineStart: blockStartLine,
      lineEnd: blockEndLine,
      text,
    });
  };

  while (charPos < raw.length) {
    line += 1;
    let end = charPos;
    while (end < raw.length && raw[end] !== '\n' && raw[end] !== '\r') end += 1;
    const termChars = end >= raw.length ? 0 : raw[end] === '\r' && raw[end + 1] === '\n' ? 2 : 1;
    const content = raw.slice(charPos, end);
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (content.length === 0) {
      flushBlock();
    } else {
      if (blockStartChar < 0) {
        blockStartChar = charPos;
        blockStartByte = bytePos;
        blockStartLine = line;
      }
      blockEndChar = end;
      blockEndByte = bytePos + contentBytes;
      blockEndLine = line;
    }
    charPos = end + termChars;
    // 行终止符在 UTF-8 里各占一字节，字节数与字符数相同。
    bytePos += contentBytes + termChars;
  }
  flushBlock();
  return spans;
};

export interface LocatedSegment extends RawSegment {
  startByte: number;
  endByte: number;
  lineStart: number;
  lineEnd: number;
}

export interface MaterialWithRawSpans extends Omit<NormalizedMaterial, 'segments'> {
  segments: LocatedSegment[];
}

/**
 * 规范化并定位段落。切分结果与定位结果任何一处不吻合都直接拒绝，
 * 不留下可能指向错误原文位置的段落记录。
 */
export const normalizeMaterialWithRawSpans = (raw: string): MaterialWithRawSpans => {
  const base = normalizeMaterial(raw);
  const spans = locateRawSegments(raw);
  if (spans.length !== base.segments.length) {
    throw new StudyError('INTERNAL', { reason: 'raw_span_mismatch' }, '段落无法定位到原始文本，已拒绝归档');
  }
  const segments: LocatedSegment[] = [];
  for (let index = 0; index < base.segments.length; index += 1) {
    const segment = base.segments[index] as RawSegment;
    const span = spans[index] as RawSegmentSpan;
    if (span.segmentId !== segment.segmentId || span.ordinal !== segment.ordinal || span.text !== segment.text) {
      throw new StudyError(
        'INTERNAL',
        { reason: 'raw_span_mismatch', segmentId: segment.segmentId },
        '段落无法定位到原始文本，已拒绝归档',
      );
    }
    segments.push({
      ...segment,
      startByte: span.startByte,
      endByte: span.endByte,
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
    });
  }
  return { ...base, segments };
};
