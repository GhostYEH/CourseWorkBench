'use client';

import { apiEnvelopeSchema } from '@sew/study-contracts';
import { z } from 'zod';
import { ApiError, waitForSessionToken } from './client';

/** Binary consumers keep the session header in memory and verify bytes before creating a browser URL. */
export async function fetchVerifiedArtifact(
  path: string,
  expected: { sha256: string; byteLength: number; mime?: string; signal?: AbortSignal },
): Promise<Blob> {
  if (
    !path.startsWith('/api/study/') ||
    path.startsWith('//') ||
    !/^[a-f0-9]{64}$/.test(expected.sha256) ||
    !Number.isSafeInteger(expected.byteLength) ||
    expected.byteLength < 1 ||
    expected.byteLength > 256 * 1024 * 1024
  )
    throw new Error('产物读取参数无效。');
  const token = await waitForSessionToken(expected.signal);
  const response = await fetch(path, {
    signal: expected.signal,
    cache: 'no-store',
    headers: { 'x-sew-session': token },
  });
  if (!response.ok) {
    const envelope = apiEnvelopeSchema(z.unknown()).safeParse(
      await response.json().catch(() => null),
    );
    if (envelope.success && !envelope.data.ok) throw new ApiError(envelope.data.error);
    throw new Error(`产物读取失败（HTTP ${response.status}）。`);
  }
  const mime =
    response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ??
    'application/octet-stream';
  if (expected.mime && mime !== expected.mime.split(';')[0]?.toLowerCase())
    throw new Error('产物类型与已保存记录不符。');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) !== expected.byteLength))
    throw new Error('产物长度与已保存记录不符。');
  if (!response.body) throw new Error('产物没有可读取的字节。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      expected.signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > expected.byteLength) throw new Error('产物字节超过已保存记录。');
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  expected.signal?.throwIfAborted();
  if (size !== expected.byteLength) throw new Error('产物字节不完整。');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  expected.signal?.throwIfAborted();
  const actual = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  if (actual !== expected.sha256) throw new Error('产物 SHA-256 与已保存记录不符。');
  return new Blob([bytes], { type: mime });
}
