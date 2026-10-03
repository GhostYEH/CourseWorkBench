import { createHash } from 'node:crypto';
import { z } from 'zod';
import { decodeJson } from '@sew/study-storage';
import { assertScope, requireSession, type Session } from './service';

export const MAX_ASSET_BYTES = 32 * 1024 * 1024;
export const MAX_ASSET_METADATA_BYTES = 64 * 1024;
export const MAX_ASSET_REQUEST_BYTES = 33 * 1024 * 1024;
export const MAX_PROJECT_ASSET_BYTES = 128 * 1024 * 1024;
const PROJECT_HEADER = 'x-sew-project-id';
const GENERATION_HEADER = 'x-sew-generation';
const metadataSchema = z.record(z.string(), z.unknown());

export class AssetHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'AssetHttpError';
  }
}

export const scopedAssetSession = (request: Request): { scope: { projectId: string; generation: number }; session: Session } => {
  if (request.url.includes('?')) throw new AssetHttpError(400, 'VALIDATION_FAILED', '课堂资源地址不能包含查询参数');
  const projectId = request.headers.get(PROJECT_HEADER);
  const rawGeneration = request.headers.get(GENERATION_HEADER);
  const generation = rawGeneration === null ? NaN : Number(rawGeneration);
  if (!projectId || !Number.isSafeInteger(generation) || generation < 1) {
    // Still authenticate first to keep the service's unauthenticated behavior consistent.
    requireSession();
    throw new AssetHttpError(400, 'VALIDATION_FAILED', '缺少有效的课堂项目范围', { requiredHeaders: [PROJECT_HEADER, GENERATION_HEADER] });
  }
  return { scope: { projectId, generation }, session: assertScope({ projectId, generation }) };
};

export const revalidateAssetScope = (scope: { projectId: string; generation: number }): Session => assertScope(scope);

export const rejectEncodedBody = (request: Request): void => {
  if (request.headers.has('content-encoding')) throw new AssetHttpError(400, 'VALIDATION_FAILED', '不支持压缩的课堂资源请求体');
};

export const boundedBody = async (request: Request): Promise<Uint8Array> => {
  const length = request.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_ASSET_REQUEST_BYTES) {
    throw new AssetHttpError(413, 'PAYLOAD_TOO_LARGE', '课堂资源请求体超过上限', { limit: MAX_ASSET_REQUEST_BYTES });
  }
  if (!request.body) throw new AssetHttpError(400, 'VALIDATION_FAILED', '课堂资源请求体为空');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_ASSET_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AssetHttpError(413, 'PAYLOAD_TOO_LARGE', '课堂资源请求体超过上限', { limit: MAX_ASSET_REQUEST_BYTES });
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof AssetHttpError) throw error;
    throw new AssetHttpError(400, 'VALIDATION_FAILED', '无法读取课堂资源请求体');
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
};

export const parseAssetMultipart = async (request: Request, rawBody: Uint8Array, metadataRequired = true): Promise<{ mediaType: string; metadata: Record<string, unknown>; hasMetadata: boolean; bytes: Uint8Array }> => {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'multipart/form-data') {
    throw new AssetHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '课堂资源必须使用 multipart/form-data');
  }
  let form: FormData;
  try {
    const bodyBuffer = rawBody.buffer.slice(rawBody.byteOffset, rawBody.byteOffset + rawBody.byteLength) as ArrayBuffer;
    const replay = new Request(request.url, { method: request.method, headers: request.headers, body: bodyBuffer });
    form = await replay.formData();
  } catch {
    throw new AssetHttpError(400, 'VALIDATION_FAILED', '课堂资源 multipart 格式无效');
  }
  const entries = [...form.entries()];
  if (entries.length > 8) throw new AssetHttpError(413, 'PAYLOAD_TOO_LARGE', '课堂资源 multipart part 数超过上限', { limit: 8 });
  if (entries.length < 1) throw new AssetHttpError(400, 'VALIDATION_FAILED', '课堂资源 multipart part 数无效');
  const names = entries.map(([name]) => name);
  if (names.some((name) => name !== 'meta' && name !== 'bytes') || new Set(names).size !== names.length) {
    throw new AssetHttpError(400, 'VALIDATION_FAILED', '课堂资源 multipart parts 无效');
  }
  const metadataPart = entries.find(([name]) => name === 'meta')?.[1];
  const bytesPart = entries.find(([name]) => name === 'bytes')?.[1];
  if (!(bytesPart instanceof File) ||
      (metadataRequired && !(metadataPart instanceof File)) ||
      (metadataPart !== undefined && !(metadataPart instanceof File)) ||
      (metadataRequired ? entries.length !== 2 : entries.length < 1 || entries.length > 2)) {
    throw new AssetHttpError(400, 'VALIDATION_FAILED', '课堂资源必须包含 meta 与 bytes 文件 part');
  }
  if (metadataPart instanceof File && names[0] !== 'meta') throw new AssetHttpError(400, 'VALIDATION_FAILED', '课堂资源 meta part 必须先于 bytes part');
  if (metadataPart instanceof File && metadataPart.size > MAX_ASSET_METADATA_BYTES) throw new AssetHttpError(413, 'PAYLOAD_TOO_LARGE', '课堂资源元数据超过上限', { limit: MAX_ASSET_METADATA_BYTES });
  if (bytesPart.size > MAX_ASSET_BYTES) throw new AssetHttpError(413, 'PAYLOAD_TOO_LARGE', '课堂资源文件超过上限', { limit: MAX_ASSET_BYTES });
  let metadata: Record<string, unknown> = {};
  if (metadataPart instanceof File) {
    if (metadataPart.type.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') throw new AssetHttpError(400, 'VALIDATION_FAILED', '课堂资源元数据必须为 application/json');
    let metadataText: string;
    try { metadataText = new TextDecoder('utf-8', { fatal: true }).decode(await metadataPart.arrayBuffer()); }
    catch { throw new AssetHttpError(400, 'VALIDATION_FAILED', '课堂资源元数据不是有效 UTF-8'); }
    const parsed = decodeJson<Record<string, unknown>>(metadataText, metadataSchema, {}, 'asset-meta');
    if (!parsed.ok) throw new AssetHttpError(400, 'VALIDATION_FAILED', '课堂资源元数据不是有效 JSON');
    if ('principal' in parsed.value || 'contentHash' in parsed.value) throw new AssetHttpError(400, 'VALIDATION_FAILED', '课堂资源元数据包含禁止字段');
    let metadataNodes = 0;
    const validateMetadataValue = (value: unknown, depth = 0): void => {
      metadataNodes += 1;
      if (depth > 64 || metadataNodes > 20_000) throw new AssetHttpError(400, 'VALIDATION_FAILED', '课堂资源元数据嵌套过深或成员过多');
      if (typeof value === 'string' && value.includes('\0')) throw new AssetHttpError(400, 'VALIDATION_FAILED', '课堂资源元数据包含禁止字符');
      if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) throw new AssetHttpError(400, 'VALIDATION_FAILED', '课堂资源元数据包含无效数字');
      if (Array.isArray(value)) value.forEach((member) => validateMetadataValue(member, depth + 1));
      else if (value && typeof value === 'object') Object.entries(value).forEach(([key, member]) => { validateMetadataValue(key, depth + 1); validateMetadataValue(member, depth + 1); });
    };
    validateMetadataValue(parsed.value);
    metadata = parsed.value;
  }
  const contentTypeOverride = Object.hasOwn(metadata, 'contentType') ? metadata['contentType'] : undefined;
  if (contentTypeOverride !== undefined && (typeof contentTypeOverride !== 'string' || !/^[\x20-\x7e]*$/.test(contentTypeOverride))) {
    throw new AssetHttpError(400, 'VALIDATION_FAILED', '课堂资源元数据 contentType 无效');
  }
  const mediaType = typeof contentTypeOverride === 'string' ? contentTypeOverride : (bytesPart.type || 'application/octet-stream');
  const bytes = new Uint8Array(await bytesPart.arrayBuffer());
  if (bytes.byteLength > MAX_ASSET_BYTES) throw new AssetHttpError(413, 'PAYLOAD_TOO_LARGE', '课堂资源文件超过上限', { limit: MAX_ASSET_BYTES });
  return { mediaType, metadata, hasMetadata: metadataPart instanceof File, bytes };
};

export const assetDigest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
