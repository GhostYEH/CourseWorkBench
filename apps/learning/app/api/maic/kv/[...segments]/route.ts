import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  RuntimeHttpError,
  error,
  readBoundedRuntimeJson,
  revalidateRuntimeScope,
  runtimeRequestScope,
  runtimeRouteError,
} from '../../../../../lib/server/runtime-storage';

export const dynamic = 'force-dynamic';
const noStore = { 'cache-control': 'no-store' };
type RouteContext = { params: Promise<{ segments: string[] }> };

const response = (value: unknown): NextResponse => NextResponse.json(value, { headers: noStore });
const noContent = (): NextResponse => new NextResponse(null, { status: 204, headers: noStore });

const parseValue = async (request: Request, scope: { projectId: string; generation: number }): Promise<unknown> => {
  const raw = await readBoundedRuntimeJson(request, scope);
  const parsed = z.object({ value: z.unknown() }).strict().safeParse(raw);
  if (!parsed.success || !parsed.data || !Object.hasOwn(raw as object, 'value')) {
    throw new RuntimeHttpError(400, 'VALIDATION_FAILED', 'KV write body must contain a JSON value');
  }
  return parsed.data.value;
};

const dispatch = async (request: Request, context: RouteContext): Promise<NextResponse> => {
  const { scope } = runtimeRequestScope(request);
  const { segments } = await context.params;
  const current = revalidateRuntimeScope(scope);
  const kv = current.store.classroomKV;
  const method = request.method.toUpperCase();
  if (segments.length === 1 && segments[0] === 'keys' && method === 'GET') {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== 'prefix')) error(400, 'VALIDATION_FAILED', 'Unsupported KV keys query parameter');
    return response(kv.keys(current.projectId, 'sew:classroom:owner:v1', url.searchParams.get('prefix') ?? ''));
  }
  if (segments[0] !== 'entries' || segments.length !== 2) {
    throw new RuntimeHttpError(404, 'NOT_FOUND', 'Unknown KV operation');
  }
  const key = segments[1] ?? '';
  if (method === 'GET') {
    const value = kv.get(current.projectId, 'sew:classroom:owner:v1', key);
    if (value === null && !kv.keys(current.projectId, 'sew:classroom:owner:v1').includes(key)) {
      error(404, 'KEY_NOT_FOUND', `KV key ${JSON.stringify(key)} was not found`);
    }
    return response({ value });
  }
  if (method === 'PUT') {
    const value = await parseValue(request, scope);
    const active = revalidateRuntimeScope(scope);
    active.store.classroomKV.set(active.projectId, 'sew:classroom:owner:v1', key, value);
    return noContent();
  }
  if (method === 'DELETE') {
    const active = revalidateRuntimeScope(scope);
    active.store.classroomKV.remove(active.projectId, 'sew:classroom:owner:v1', key);
    return noContent();
  }
  throw new RuntimeHttpError(405, 'METHOD_NOT_ALLOWED', 'Unsupported KV method');
};

export const GET = async (request: Request, context: RouteContext): Promise<NextResponse> => {
  try { return await dispatch(request, context); } catch (caught) { return runtimeRouteError(caught) as NextResponse; }
};
export const PUT = async (request: Request, context: RouteContext): Promise<NextResponse> => {
  try { return await dispatch(request, context); } catch (caught) { return runtimeRouteError(caught) as NextResponse; }
};
export const DELETE = async (request: Request, context: RouteContext): Promise<NextResponse> => {
  try { return await dispatch(request, context); } catch (caught) { return runtimeRouteError(caught) as NextResponse; }
};
