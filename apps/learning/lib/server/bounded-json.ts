import { z } from 'zod';
import { decodeJson } from '@sew/study-storage';
import { readBoundedBody, type BodyFailure } from './bounded-body';

/** `BodyFailure` plus the two decode faults; callers map every reason to their own error contract. */
export type JsonBodyFailure = BodyFailure | 'invalid_utf8' | 'invalid_json';

/**
 * 单一带限界的 HTTP JSON 入口：实际字节上限 → 严格 UTF-8 → 集中 JSON 解码。
 *
 * 只做语法解码，形状由调用方的 schema 裁定；`decodeJson` 把空正文视为「未写入」，
 * 这里按 HTTP 边界拒绝，避免空 body 降级成 `null` 后仍进入业务校验。
 * `detail` 是 json-codec 的可诊断错误，由调用方决定是否随错误返回。
 */
export const readBoundedJson = async (
  request: Request,
  maxBytes: number,
  failure: (reason: JsonBodyFailure, detail?: string) => Error,
): Promise<unknown> => {
  const bytes = await readBoundedBody(request, maxBytes, failure);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw failure('invalid_utf8');
  }
  if (text.trim().length === 0) throw failure('invalid_json');
  const decoded = decodeJson<unknown>(text, z.unknown(), null, 'http_json_body');
  if (!decoded.ok) throw failure('invalid_json', decoded.error ?? undefined);
  return decoded.value;
};
