import { z } from 'zod';
import {
  modelChatMessageSchema,
  modelConnectionInputSchema,
  type ModelChatMessage,
  type ModelConnectionInput,
  type ModelConnectionStatus,
  type ModelTestResult,
} from '@sew/study-contracts';

const responseSchema = z.object({
  model: z.string().max(200).optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string().max(100_000).nullable() }) })).min(1),
  usage: z.object({ total_tokens: z.number().int().nonnegative() }).optional(),
});

/**
 * 一次真实生成尝试的结果。失败也带 elapsedMs 与 0 token，调用方据此写台账：
 * 预算必须反映实际发生的尝试，而不是只反映成功的尝试。
 */
export interface ModelGenerateOutcome {
  dispatched: boolean;
  ok: boolean;
  message: string;
  text: string | null;
  totalTokens: number;
  requestedModel: string | null;
  elapsedMs: number;
  returnedModel?: string | null;
  providerTokens?: number | null;
}

/** Count actual bytes before JSON parsing; never reflect untrusted bodies. */
export const readModelJson = async (response: Response | Request, limit = 128 * 1024): Promise<unknown> => {
  if (!response.body) throw new Error('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new Error('response_too_large');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
};

/** Connection-only call: no project material, no publication, no retries.
 * Sources are unnecessary for the fixed "OK" diagnostic. Teaching/generation
 * must add source/run admission before using the configured provider.
 */
export const createModelConnectionRuntime = ({
  fetcher = fetch, now = Date.now, deadlineMs = 40_000,
  generationDeadlineMs = 120_000, generationMaxCallsPerMinute = 6, generationMaxCallsPerHour = 30,
}: {
  fetcher?: typeof fetch; now?: () => number; deadlineMs?: number;
  generationDeadlineMs?: number; generationMaxCallsPerMinute?: number; generationMaxCallsPerHour?: number;
} = {}) => {
  let config: ModelConnectionInput | null = null;
  let persisted = false;
  let revision = 0;
  let lastTest: ModelTestResult | null = null;
  let active: AbortController | null = null;
  let stopped = false;
  const calls: number[] = [];
  /** 生成有独立的频次上限：连接诊断不应吃掉草案生成的次数，反之亦然。 */
  const generationCalls: number[] = [];
  const status = (): ModelConnectionStatus => ({
    configured: config !== null, persisted,
    ...(config ? { provider: config.provider, baseUrl: config.baseUrl, model: config.model } : {}),
    lastTest,
  });
  const configure = (value: unknown, saved: boolean): ModelConnectionStatus => {
    if (stopped) throw new Error('模型服务正在退出');
    const parsed = modelConnectionInputSchema.safeParse(value);
    if (!parsed.success) throw new Error('模型配置无效');
    active?.abort();
    revision += 1;
    config = { ...parsed.data, baseUrl: parsed.data.baseUrl.replace(/\/+$/, '') };
    persisted = saved;
    lastTest = null;
    return status();
  };
  const cancel = () => { stopped = true; revision += 1; active?.abort(); };
  const test = async (signal?: AbortSignal): Promise<ModelTestResult> => {
    if (stopped) return { ok: false, message: '模型服务正在退出，不能开始新调用' };
    if (!config) return { ok: false, message: '尚未配置模型连接' };
    if (active) return { ok: false, message: '已有连接测试正在执行，请等待结束' };
    if (signal?.aborted) return { ok: false, message: '连接测试已取消' };
    const started = now();
    while (calls.length && calls[0]! <= started - 3_600_000) calls.shift();
    if (calls.length >= 20 || calls.filter(at => at > started - 60_000).length >= 3) {
      return { ok: false, message: '连接测试达到次数限额，请稍后重试' };
    }
    calls.push(started);
    const input = config;
    const epoch = revision;
    const controller = new AbortController();
    active = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadlineMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let result: ModelTestResult;
    try {
      const response = await fetcher(`${input.baseUrl}/chat/completions`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${input.apiKey}` },
        // This reasoning model used 511 reasoning tokens for a two-byte reply
        // in the live probe; a 256-token cap can yield null content legitimately.
        body: JSON.stringify({ model: input.model, messages: [{ role: 'user', content: 'Reply exactly OK.' }], max_tokens: 1024, stream: false }),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        result = { ok: false, message: `模型服务返回 HTTP ${response.status}，请核对密钥、模型和服务额度` };
      } else {
        const parsed = responseSchema.safeParse(await readModelJson(response));
        if (!parsed.success || !parsed.data.choices[0]?.message.content?.trim()) {
          result = { ok: false, message: '模型服务未返回有效文本，可能是推理额度不足或响应格式不兼容' };
        } else {
          const returnedModel = parsed.data.model;
          result = {
            ok: true, message: '真实连接测试成功，模型已返回有效文本',
            ...(returnedModel && /^[\w.\-:/]{1,200}$/.test(returnedModel) && !returnedModel.includes(input.apiKey) ? { returnedModel } : {}),
            ...(parsed.data.usage ? { totalTokens: parsed.data.usage.total_tokens } : {}),
          };
        }
      }
    } catch {
      result = { ok: false, message: timedOut ? '模型连接超时，请检查服务后手动重试' : controller.signal.aborted ? '连接测试已取消' : '模型连接失败，请检查网络、地址和响应格式' };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (active === controller) active = null;
    }
    if (revision !== epoch || signal?.aborted || (controller.signal.aborted && !timedOut)) {
      return { ok: false, message: '连接测试已取消，配置已变化或应用正在退出' };
    }
    result = { ...result, requestedModel: input.model, elapsedMs: Math.max(0, now() - started) };
    lastTest = result;
    return result;
  };
  /**
   * 真实生成调用。它只负责凭据、期限、取消、频次与响应校验，
   * 不判断「能不能据此产出教学内容」——来源、run、审核与预算由 model-call 的 guard 决定，
   * guard 不通过时这里一次请求都不会发出。
   */
  const generate = async (
    messages: ModelChatMessage[],
    options: { maxTokens?: number; signal?: AbortSignal } = {},
  ): Promise<ModelGenerateOutcome> => {
    const started = now();
    let dispatched = false;
    const failed = (message: string): ModelGenerateOutcome => ({
      dispatched, ok: false, message, text: null, totalTokens: 0, requestedModel: config?.model ?? null, returnedModel: null, providerTokens: null,
      elapsedMs: Math.max(0, now() - started),
    });
    if (stopped) return failed('模型服务正在退出，不能开始新的生成');
    if (!config) return failed('尚未配置模型连接');
    if (active) return failed('已有模型调用正在执行，请等待结束');
    if (options.signal?.aborted) return failed('生成已取消');
    const checked = modelChatMessageSchema.array().min(1).max(8).safeParse(messages);
    if (!checked.success) return failed('生成请求的消息不合法，已拒绝发出');

    while (generationCalls.length && generationCalls[0]! <= started - 3_600_000) generationCalls.shift();
    if (generationCalls.length >= generationMaxCallsPerHour
      || generationCalls.filter((at) => at > started - 60_000).length >= generationMaxCallsPerMinute) {
      return failed('生成调用达到频次限额，请稍后重试');
    }
    generationCalls.push(started);

    const input = config;
    const epoch = revision;
    const controller = new AbortController();
    active = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, generationDeadlineMs);
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    let outcome: ModelGenerateOutcome;
    try {
      dispatched = true;
      const response = await fetcher(`${input.baseUrl}/chat/completions`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${input.apiKey}` },
        body: JSON.stringify({
          model: input.model,
          messages: checked.data,
          max_tokens: options.maxTokens ?? 2048,
          stream: false,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        outcome = failed(`模型服务返回 HTTP ${response.status}，请核对密钥、模型和服务额度`);
      } else {
        const parsed = responseSchema.safeParse(await readModelJson(response));
        const content = parsed.success ? parsed.data.choices[0]?.message.content?.trim() : undefined;
        if (!parsed.success || !content) {
          outcome = failed('模型服务未返回有效文本，可能是推理额度不足或响应格式不兼容');
        } else {
          const returnedModel = parsed.data.model;
          outcome = {
            dispatched: true,
            ok: true,
            message: '模型已返回草案文本，仍需人工审核后才能用于教学',
            text: content.slice(0, 20_000),
            totalTokens: parsed.data.usage?.total_tokens ?? 0,
            providerTokens: parsed.data.usage?.total_tokens ?? null,
            requestedModel: input.model,
            returnedModel: returnedModel && /^[\w.\-:/]{1,200}$/.test(returnedModel) && !returnedModel.includes(input.apiKey)
              ? returnedModel
              : null,
            elapsedMs: Math.max(0, now() - started),
          };
        }
      }
    } catch {
      outcome = failed(timedOut
        ? '模型生成超时，请检查服务后手动重试'
        : controller.signal.aborted ? '生成已取消' : '模型连接失败，请检查网络、地址和响应格式');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (active === controller) active = null;
    }
    if (revision !== epoch || options.signal?.aborted || (controller.signal.aborted && !timedOut)) {
      return { ...outcome, ok: false, text: null, message: '生成已取消，配置已变化或应用正在退出' };
    }
    return outcome;
  };

  return { configure, status, test, generate, cancel };
};

const shared = globalThis as typeof globalThis & { __sewModelConnection?: ReturnType<typeof createModelConnectionRuntime> };
shared.__sewModelConnection ??= createModelConnectionRuntime();
export const modelConnection = shared.__sewModelConnection;
