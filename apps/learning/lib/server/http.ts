/**
 * 领域 HTTP 边界：统一入参校验与错误响应。
 *
 * 响应格式固定为 `{ ok: true, data }` 或 `{ ok: false, error }`，
 * error 使用 StudyErrorPayload（含 code、中文文案与 pending 标记）。
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { StudyError, toErrorPayload, type StudyErrorCode, type StudyErrorPayload } from '@sew/study-contracts';

const HTTP_STATUS: Partial<Record<StudyErrorCode, number>> = {
  PROJECT_NOT_AUTHORIZED: 403,
  PROJECT_GENERATION_STALE: 409,
  PROJECT_FORMAT_UNSUPPORTED: 409,
  PROJECT_ALREADY_OPEN: 409,
  VERSION_CONFLICT: 409,
  STEP_ALREADY_COMMITTED: 200,
  RUN_TERMINATED: 409,
  NOT_FOUND: 404,
  INVALID_ARGUMENT: 400,
  ROLE_PERMISSION_DENIED: 403,
  SIMULATION_WRITE_FORBIDDEN: 403,
  QUESTION_ORIGIN_FORBIDDEN: 422,
  CLASSROOM_LESSON_NOT_REVIEWED: 403,
  CLASSROOM_SCENE_SOURCE_MISSING: 409,
  // 等待本人、额度用满与未配置模型都是「当前状态不允许该操作」，不是客户端可重发的入参错误。
  CLASSROOM_AWAITING_LEARNER: 409,
  BUDGET_EXCEEDED: 409,
  MODEL_NOT_CONFIGURED: 409,
  ASSET_IN_USE: 409,
  // 没有归档原文是该版本的事实状态，用 409 表达「当前状态不支持该操作」；
  // 归档字节与登记摘要不符属于本地数据故障，不能伪装成客户端可修正的入参问题。
  MATERIAL_RAW_ABSENT: 409,
  MATERIAL_RAW_UNVERIFIED: 500,
  // 同一考纲编号已登记：属于状态冲突，重试同样的请求不会成功。
  SYLLABUS_CODE_DUPLICATE: 409,
  INTERNAL: 500,
};

export const ok = <T>(data: T, init?: ResponseInit): NextResponse =>
  NextResponse.json({ ok: true, data }, init);

const absolutePathPattern = /[A-Za-z]:[\\/]|\\\\[^\\]+\\|(?:^|[\s"'(=:])\/(?!\/)[^\s]/;

const redactPathStrings = (value: unknown): { value: unknown; changed: boolean } => {
  if (typeof value === 'string') {
    // Whole strings are suppressed because whitespace is legal inside paths:
    // token-by-token replacement would expose e.g. "Doe\\project" from Jane Doe.
    const safe = absolutePathPattern.test(value) ? '[本地路径已隐藏]' : value;
    return { value: safe, changed: safe !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const result = redactPathStrings(item);
      changed ||= result.changed;
      return result.value;
    });
    return { value: items, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const result = redactPathStrings(item);
      changed ||= result.changed;
      return [key, result.value] as const;
    });
    return { value: Object.fromEntries(entries), changed };
  }
  return { value, changed: false };
};

export const fail = (error: unknown): NextResponse => {
  const payload = toErrorPayload(error);
  const safeMessage = redactPathStrings(payload.message);
  const safeDetails = payload.details === undefined ? undefined : redactPathStrings(payload.details);
  // Keep the original failure, including paths useful to an operator, in the local service log.
  // Only log when sanitization was needed or for unexpected internal errors.
  if (safeMessage.changed || safeDetails?.changed || payload.code === 'INTERNAL') {
    console.error('[learning-http] request failed', error);
  }
  const safePayload: StudyErrorPayload = {
    ...payload,
    message: safeMessage.value as string,
    ...(safeDetails ? { details: safeDetails.value as Record<string, unknown> } : {}),
  };
  const status = HTTP_STATUS[payload.code] ?? 400;
  return NextResponse.json({ ok: false, error: safePayload }, { status });
};

export const route = <Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse> | NextResponse,
) => async (...args: Args): Promise<NextResponse> => {
  try {
    return await handler(...args);
  } catch (error) {
    return fail(error);
  }
};

export const parseBody = async <S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<z.infer<S>> => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'invalid_json' });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new StudyError('INVALID_ARGUMENT', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
};

export const parseQuery = <S extends z.ZodTypeAny>(request: Request, schema: S): z.infer<S> => {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'malformed_url' });
  }
  const parsed = schema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    throw new StudyError('INVALID_ARGUMENT', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
};
