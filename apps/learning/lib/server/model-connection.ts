import { z } from 'zod';
import {
  modelConnectionInputSchema, type ModelConnectionInput,
  type ModelConnectionStatus, type ModelTestResult,
} from '@sew/study-contracts';

const responseSchema = z.object({
  model: z.string().max(200).optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string().max(100_000).nullable() }) })).min(1),
  usage: z.object({ total_tokens: z.number().int().nonnegative() }).optional(),
});

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
}: { fetcher?: typeof fetch; now?: () => number; deadlineMs?: number } = {}) => {
  let config: ModelConnectionInput | null = null;
  let persisted = false;
  let revision = 0;
  let lastTest: ModelTestResult | null = null;
  let active: AbortController | null = null;
  let stopped = false;
  const calls: number[] = [];
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
        body: JSON.stringify({ model: input.model, messages: [{ role: 'user', content: 'Reply exactly OK.' }], max_tokens: 256, stream: false }),
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
  return { configure, status, test, cancel };
};

const shared = globalThis as typeof globalThis & { __sewModelConnection?: ReturnType<typeof createModelConnectionRuntime> };
shared.__sewModelConnection ??= createModelConnectionRuntime();
export const modelConnection = shared.__sewModelConnection;
