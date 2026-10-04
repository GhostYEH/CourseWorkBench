/** Scope and server-assigned identity for the classroom RuntimeStore/KV routes. */
import { NextResponse } from 'next/server';
import { StudyError } from '@sew/study-contracts';
import { RuntimeAppendConflictError } from '@openmaic/storage';
import { assertScope, type Session } from './service';
import { scopedRequest } from './scoped-request';
import { readBoundedBody } from './bounded-body';
import { mapHttpError } from './http';


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

export { LEGACY_LOCAL_LEARNER_KEY as CLASSROOM_OWNER_LEARNER_KEY } from '@sew/study-contracts';
export const CLASSROOM_SIMULATION_LEARNER_KEY = 'sew:classroom:simulation:v1';

export const runtimeRequestScope = (request: Request): { scope: RuntimeRequestScope; session: Session } =>
  scopedRequest(request, requiredHeaders => new RuntimeHttpError(400, 'VALIDATION_FAILED',
    'Missing classroom project scope headers', { requiredHeaders }));

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
  const bytes = await readBoundedBody(request, maxBytes, reason => reason === 'too_large'
    ? new RuntimeHttpError(413, 'PAYLOAD_TOO_LARGE', 'Runtime JSON body exceeds the request limit', { limit: maxBytes })
    : new RuntimeHttpError(400, 'VALIDATION_FAILED', reason === 'missing'
      ? 'Runtime JSON body is required' : 'Runtime request body could not be read'));
  revalidateRuntimeScope(scope);
  let parsed: unknown;
  try {
    // 复制成独立 ArrayBuffer 再交给 Request：Uint8Array 视图在本项目的 TS lib 下
    // 不满足 BodyInit 的类型约束，直接传视图会在构建期报类型错误。
    const bodyBytes = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(bodyBytes).set(bytes);
    const replay = new Request(request.url, { method: 'POST', headers: request.headers, body: bodyBytes });
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
    const mapped = mapHttpError(error);
    return NextResponse.json({ error: mapped.error }, {
      status: mapped.status,
      headers: { 'cache-control': 'no-store', 'x-error-code': mapped.error.code },
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
