/** Scope and server-assigned identity for the classroom RuntimeStore/KV routes. */
import { z } from 'zod';
import { NextResponse } from 'next/server';
import { StudyError } from '@sew/study-contracts';
import { RuntimeAppendConflictError } from '@openmaic/storage';
import { assertScope, requireSession, type Session } from './service';

const PROJECT_HEADER = 'x-sew-project-id';
const GENERATION_HEADER = 'x-sew-generation';

export interface RuntimeRequestScope {
  projectId: string;
  generation: number;
}

export class RuntimeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RuntimeHttpError';
  }
}

export const CLASSROOM_OWNER_LEARNER_KEY = 'sew:classroom:owner:v1';
export const CLASSROOM_SIMULATION_LEARNER_KEY = 'sew:classroom:simulation:v1';

export const runtimeRequestScope = (request: Request): { scope: RuntimeRequestScope; session: Session } => {
  const projectId = request.headers.get(PROJECT_HEADER);
  const rawGeneration = request.headers.get(GENERATION_HEADER);
  const generation = rawGeneration === null ? NaN : Number(rawGeneration);
  if (!projectId || !Number.isSafeInteger(generation) || generation < 1) {
    requireSession();
    throw new RuntimeHttpError(400, 'VALIDATION_FAILED', 'Missing classroom project scope headers', {
      requiredHeaders: [PROJECT_HEADER, GENERATION_HEADER],
    });
  }
  return { scope: { projectId, generation }, session: assertScope({ projectId, generation }) };
};

export const revalidateRuntimeScope = (scope: RuntimeRequestScope): Session => assertScope(scope);

const MAX_RUNTIME_BODY_BYTES = 32 * 1024 * 1024;
const assertJsonComplexity = (root: unknown): void => {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    nodes += 1;
    if (nodes > 200_000 || depth > 64) {
      throw new RuntimeHttpError(413, 'PAYLOAD_TOO_LARGE', 'Runtime JSON body is too complex');
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'string') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new RuntimeHttpError(400, 'VALIDATION_FAILED', 'Runtime JSON contains a non-finite number');
      continue;
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) throw new RuntimeHttpError(400, 'VALIDATION_FAILED', 'Runtime JSON contains a cycle');
      seen.add(value);
      for (const item of value) pending.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (typeof value === 'object') {
      if (seen.has(value)) throw new RuntimeHttpError(400, 'VALIDATION_FAILED', 'Runtime JSON contains a cycle');
      seen.add(value);
      for (const [key, item] of Object.entries(value)) {
        pending.push({ value: key, depth: depth + 1 }, { value: item, depth: depth + 1 });
      }
      continue;
    }
    throw new RuntimeHttpError(400, 'VALIDATION_FAILED', 'Runtime body is not JSON data');
  }
};

export const readBoundedRuntimeJson = async (
  request: Request,
  scope: RuntimeRequestScope,
  maxBytes = MAX_RUNTIME_BODY_BYTES,
): Promise<unknown> => {
  const rawLength = request.headers.get('content-length');
  if (rawLength !== null && /^\d+$/.test(rawLength) && Number(rawLength) > maxBytes) {
    throw new RuntimeHttpError(413, 'PAYLOAD_TOO_LARGE', 'Runtime JSON body exceeds the request limit', { limit: maxBytes });
  }
  if (!request.body) throw new RuntimeHttpError(400, 'VALIDATION_FAILED', 'Runtime JSON body is required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RuntimeHttpError(413, 'PAYLOAD_TOO_LARGE', 'Runtime JSON body exceeds the request limit', { limit: maxBytes });
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  revalidateRuntimeScope(scope);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try {
    const replay = new Request(request.url, { method: 'POST', headers: request.headers, body: bytes });
    parsed = await replay.json();
  } catch {
    throw new RuntimeHttpError(400, 'VALIDATION_FAILED', 'Runtime request body must be valid JSON');
  }
  revalidateRuntimeScope(scope);
  assertJsonComplexity(parsed);
  return parsed;
};

export const runtimeRouteError = (error: unknown): NextResponse => {
  if (error instanceof RuntimeHttpError) {
    return NextResponse.json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }, {
      status: error.status,
      headers: { 'cache-control': 'no-store', 'x-error-code': error.code },
    });
  }
  if (error instanceof StudyError) {
    const status = error.code === 'PROJECT_GENERATION_STALE' ? 409 : error.code === 'PROJECT_NOT_AUTHORIZED' ? 403 : 400;
    return NextResponse.json({ error: { code: error.code, message: error.message, details: error.details } }, {
      status,
      headers: { 'cache-control': 'no-store', 'x-error-code': error.code },
    });
  }
  if (error instanceof RuntimeAppendConflictError) {
    return NextResponse.json({ error: {
      code: 'RUNTIME_APPEND_CONFLICT',
      message: error.message,
      details: {
        sessionId: error.sessionId,
        expectedLastSeq: error.expectedLastSeq,
        actualLastSeq: error.actualLastSeq,
      },
    } }, {
      status: 409,
      headers: { 'cache-control': 'no-store', 'x-error-code': 'RUNTIME_APPEND_CONFLICT' },
    });
  }
  console.error('[classroom-runtime] request failed', error);
  return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'Classroom persistence request failed' } }, {
    status: 500,
    headers: { 'cache-control': 'no-store', 'x-error-code': 'INTERNAL_ERROR' },
  });
};

export const error = (status: number, code: string, message: string, details?: Record<string, unknown>): never => {
  throw new RuntimeHttpError(status, code, message, details);
};

export const runtimeScopeHeaders = z.object({
  projectId: z.string().min(1),
  generation: z.number().int().positive(),
});
