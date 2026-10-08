/**
 * 本地服务到独立协作服务的 HTTP 客户端（ADR-0005）。
 *
 * 只做「带凭据/令牌发请求 + 按统一信封解析」：业务判定在协作服务与领域层，
 * 这里不自行决定「能不能邀请」。地址来自配置 `SEW_COLLAB_SERVICE_URL`；
 * 未配置时返回 null，界面据此继续显示「不能联网邀请」。
 *
 * 凭据 `secret` 只在本模块与协作服务之间使用，绝不回传渲染层或写入日志。
 */

import { z } from 'zod';
import {
  StudyError,
  STUDY_ERROR_CODES,
  apiEnvelopeSchema,
  apiErrorPayloadSchema,
  COLLAB_PROTOCOL_VERSION,
  type StudyErrorCode,
} from '@sew/study-contracts';

/** 解析协作服务地址；未配置或非法返回 null（视为未开通在线能力）。 */
export const resolveCollabServiceUrl = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const configured = env['SEW_COLLAB_SERVICE_URL']?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
};

export interface CollabClientRequest {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number>;
  token?: string;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const REMOTE_CODE_SET: ReadonlySet<string> = new Set<string>(STUDY_ERROR_CODES);

/** 把协作服务的错误载荷还原成本地可判定的 StudyError（保留 code 与 details）。 */
const remoteError = (payload: z.infer<typeof apiErrorPayloadSchema>): StudyError => {
  const code = REMOTE_CODE_SET.has(payload.code) ? (payload.code as StudyErrorCode) : 'INTERNAL';
  return new StudyError(code, payload.details, payload.message);
};

/**
 * 发送一次请求并按 schema 校验响应。
 *
 * 网络不可达与响应不合合同都收敛为可判定的本地错误，界面据此显示「在线不可用」
 * 而不是把失败说成成功。
 */
export const collabFetch = async <S extends z.ZodTypeAny>(
  baseUrl: string,
  request: CollabClientRequest,
  schema: S,
): Promise<z.infer<S>> => {
  if (request.signal?.aborted)
    throw new StudyError('RUN_TERMINATED', { reason: 'request_aborted' });
  const url = new URL(`${baseUrl}${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, String(value));
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method,
      headers: {
        'content-type': 'application/json',
        'x-sew-collab-protocol': String(COLLAB_PROTOCOL_VERSION),
        ...(request.token ? { authorization: `Bearer ${request.token}` } : {}),
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: request.signal
        ? AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs ?? 8000)])
        : AbortSignal.timeout(request.timeoutMs ?? 8000),
    });
  } catch {
    if (request.signal?.aborted)
      throw new StudyError('RUN_TERMINATED', { reason: 'request_aborted' });
    throw new StudyError(
      'INTERNAL',
      { reason: 'collab_unreachable' },
      '在线协作服务暂时不可达，请稍后重试或检查网络。',
    );
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    if (request.signal?.aborted)
      throw new StudyError('RUN_TERMINATED', { reason: 'request_aborted' });
    throw new StudyError(
      'INTERNAL',
      { reason: 'collab_response_invalid' },
      '协作服务响应不是有效 JSON。',
    );
  }
  const envelope = apiEnvelopeSchema(z.unknown()).safeParse(raw);
  if (!envelope.success) {
    throw new StudyError(
      'INTERNAL',
      { reason: 'collab_response_invalid' },
      '协作服务响应与合同不一致。',
    );
  }
  if (!envelope.data.ok) throw remoteError(envelope.data.error);
  const result = schema.safeParse(envelope.data.data);
  if (!result.success) {
    throw new StudyError(
      'INTERNAL',
      { reason: 'collab_response_invalid' },
      '协作服务响应与合同不一致。',
    );
  }
  return result.data;
};

/** 读取错误原因码，供「按原因决定是否重试」这类分支使用。 */
export const collabErrorReason = (error: unknown): string | null => {
  if (error instanceof StudyError && error.details) {
    const reason = error.details['reason'];
    return typeof reason === 'string' ? reason : null;
  }
  return null;
};

/** 把错误转成不泄露凭据/路径的可读文案。 */
export const describeCollabError = (error: unknown): string =>
  error instanceof StudyError ? `${error.code}：${error.message}` : String(error);
