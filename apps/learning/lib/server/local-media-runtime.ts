import {
  mediaGenerationCommandSchema,
  zeroMediaUsage,
  type AsrGenerationCommandDto,
  type ImageGenerationCommandDto,
  type MediaGenerationCommandDto,
} from '@sew/study-contracts';
import { decodeJson } from '@sew/study-storage';
import { z } from 'zod';
import {
  MediaProviderFailure,
  mediaMime,
  type MediaProviderOptions,
  type MediaProviderOutcome,
} from './media-provider-runtime';

const MAX_PRODUCT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_DEADLINE_MS = 5 * 60_000;
const MAX_DEADLINE_MS = 30 * 60_000;
const MAX_JSON_BYTES = 512 * 1024;
const comfyPromptResponseSchema = z.object({
  prompt_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
});
const comfyImageResponseSchema = z.object({
  filename: z.string().min(1).max(240),
  subfolder: z.string().max(240),
  type: z.string().min(1).max(20),
});
const comfyHistoryResponseSchema = z.record(
  z.string(),
  z
    .object({
      outputs: z.record(
        z.string(),
        z.object({ images: z.array(comfyImageResponseSchema).optional() }).passthrough(),
      ),
    })
    .passthrough(),
);
const whisperResponseSchema = z.object({
  text: z.string().max(100_000),
  duration: z.number().finite().nonnegative().optional(),
});
const funAsrMessageSchema = z.object({
  text: z.string().max(100_000).optional(),
  is_final: z.boolean().optional(),
  is_end: z.boolean().optional(),
  error: z.string().max(400).optional(),
});

export interface ComfyWorkflowBinding {
  /** Trusted, server-owned ComfyUI API prompt graph. User commands never supply graph JSON. */
  workflow: Record<string, unknown>;
  promptNodeId: string;
  negativePromptNodeId?: string;
  widthNodeId: string;
  heightNodeId: string;
  countNodeId?: string;
  stepsNodeId: string;
  guidanceNodeId: string;
  seedNodeId?: string;
}

export interface LocalEngineEndpoint {
  /** HTTP is accepted only for loopback. Remote endpoints require HTTPS and an explicit bearer token. */
  baseUrl: string;
  bearerToken?: string;
}

export interface LocalMediaRuntimeConfig {
  comfyUi?: LocalEngineEndpoint & {
    workflows: Readonly<Record<string, ComfyWorkflowBinding>>;
    pollIntervalMs?: number;
  };
  whisper?: LocalEngineEndpoint & { model: string };
  funAsr?: LocalEngineEndpoint;
  deadlineMs?: number;
}

export interface LocalMediaRuntimeDependencies {
  fetcher?: typeof fetch;
  webSocketFactory?: (url: string, protocols?: string | string[]) => WebSocket;
  now?: () => number;
}

export interface LocalMediaRuntime {
  generateMedia(
    command: MediaGenerationCommandDto,
    options?: MediaProviderOptions,
  ): Promise<MediaProviderOutcome>;
}

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const loopbackHost = (hostname: string): boolean => {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
};

/** Validate configured destinations once and again at use time; never follow redirects. */
export const validateLocalEngineEndpoint = (endpoint: LocalEngineEndpoint): URL => {
  let url: URL;
  try {
    url = new URL(endpoint.baseUrl);
  } catch {
    throw new MediaProviderFailure('provider_not_configured', '本地引擎地址无效');
  }
  const local = loopbackHost(url.hostname);
  const token = endpoint.bearerToken?.trim();
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!local && (url.protocol !== 'https:' || !token || !/^[\x21-\x7e]{1,4096}$/.test(token))) ||
    (local && token && !/^[\x21-\x7e]{1,4096}$/.test(token))
  ) {
    throw new MediaProviderFailure(
      'permission_denied',
      '本地引擎仅允许 loopback HTTP；其他地址须使用 HTTPS 和显式 bearer 凭据',
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
};

const endpointUrl = (base: URL, suffix: string): string =>
  `${base.toString().replace(/\/$/, '')}${suffix}`;

const limitedJson = async <S extends z.ZodTypeAny>(
  response: Response,
  signal: AbortSignal,
  schema: S,
): Promise<z.infer<S>> => {
  if (!response.body) throw new MediaProviderFailure('provider_error', '本地引擎返回空响应');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new MediaProviderFailure('cancelled', '本地媒体调用已取消');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES)
        throw new MediaProviderFailure('provider_error', '本地引擎响应超过大小上限');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    const decoded = decodeJson(
      text,
      schema,
      undefined as z.infer<S>,
      'local media provider response',
    );
    if (!decoded.ok) throw new Error('invalid_provider_response');
    return decoded.value;
  } catch {
    throw new MediaProviderFailure('provider_error', '本地引擎返回无效 JSON 或响应结构');
  }
};

const boundedBytes = async (response: Response, signal: AbortSignal): Promise<Uint8Array> => {
  if (!response.body) throw new MediaProviderFailure('provider_error', '本地引擎未返回图像');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new MediaProviderFailure('cancelled', '本地媒体调用已取消');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PRODUCT_BYTES)
        throw new MediaProviderFailure('provider_error', '本地图像超过 16 MiB 上限');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!size) throw new MediaProviderFailure('provider_error', '本地引擎返回空图像');
  return Buffer.concat(chunks);
};

const checkedResponse = async (response: Response): Promise<Response> => {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new MediaProviderFailure('provider_error', `本地媒体引擎返回 HTTP ${response.status}`);
  }
  return response;
};

const cloneWorkflow = (
  binding: ComfyWorkflowBinding,
  command: ImageGenerationCommandDto,
): JsonRecord => {
  const graph = structuredClone(binding.workflow);
  const builtinNodes = new Set([
    'CheckpointLoaderSimple',
    'CLIPTextEncode',
    'EmptyLatentImage',
    'KSampler',
    'VAEDecode',
    'SaveImage',
    'LoraLoader',
    'VAELoader',
    'CLIPLoader',
    'UNETLoader',
  ]);
  const modelInputs = new Set(['ckpt_name', 'clip_name', 'vae_name', 'unet_name', 'lora_name']);
  for (const node of Object.values(graph)) {
    if (
      !isRecord(node) ||
      typeof node.class_type !== 'string' ||
      !builtinNodes.has(node.class_type) ||
      !isRecord(node.inputs)
    )
      throw new MediaProviderFailure(
        'provider_error',
        '本地工作流含不允许的自定义节点或文件操作节点',
      );
    for (const [name, value] of Object.entries(node.inputs)) {
      if (
        modelInputs.has(name) &&
        (typeof value !== 'string' ||
          !/^[A-Za-z0-9_. -]{1,160}$/.test(value) ||
          value === '.' ||
          value === '..')
      )
        throw new MediaProviderFailure(
          'provider_error',
          '本地工作流模型名必须是安全的模型目录内文件名',
        );
      if (
        name === 'filename_prefix' &&
        (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(value))
      )
        throw new MediaProviderFailure('provider_error', '本地工作流输出名前缀无效');
    }
  }
  const setInput = (nodeId: string, input: string, value: unknown): void => {
    const node = graph[nodeId];
    if (!isRecord(node) || !isRecord(node.inputs) || !(input in node.inputs))
      throw new MediaProviderFailure('provider_error', '本地工作流节点绑定无效');
    node.inputs[input] = value;
  };
  const required = (nodeId: string, value: unknown): void => {
    if (!/^\d{1,10}$/.test(nodeId))
      throw new MediaProviderFailure('provider_error', '本地工作流节点编号无效');
    setInput(nodeId, 'text', value);
  };
  required(binding.promptNodeId, command.prompt);
  if (command.negativePrompt !== undefined) {
    if (!binding.negativePromptNodeId)
      throw new MediaProviderFailure('provider_error', '此本地工作流不支持负向提示词');
    required(binding.negativePromptNodeId, command.negativePrompt);
  }
  const numeric = (nodeId: string, key: string, value: number): void => {
    if (!/^\d{1,10}$/.test(nodeId))
      throw new MediaProviderFailure('provider_error', '本地工作流节点编号无效');
    const node = graph[nodeId];
    if (!isRecord(node) || !isRecord(node.inputs) || !(key in node.inputs))
      throw new MediaProviderFailure('provider_error', '本地工作流节点绑定无效');
    node.inputs[key] = value;
  };
  numeric(binding.widthNodeId, 'width', command.width);
  numeric(binding.heightNodeId, 'height', command.height);
  if (command.count > 1 && !binding.countNodeId)
    throw new MediaProviderFailure('provider_error', '此本地工作流不支持一次生成多张图像');
  if (binding.countNodeId) numeric(binding.countNodeId, 'batch_size', command.count);
  numeric(binding.stepsNodeId, 'steps', command.steps);
  numeric(binding.guidanceNodeId, 'cfg', command.guidance);
  if (command.seed !== undefined && command.seed !== null) {
    if (!binding.seedNodeId)
      throw new MediaProviderFailure('provider_error', '此本地工作流不支持指定 seed');
    numeric(binding.seedNodeId, 'seed', command.seed);
  }
  return graph;
};

const runComfyImage = async (
  command: ImageGenerationCommandDto,
  config: NonNullable<LocalMediaRuntimeConfig['comfyUi']>,
  fetcher: typeof fetch,
  signal: AbortSignal,
  onDispatch: () => void,
): Promise<MediaProviderOutcome['products']> => {
  const binding = config.workflows[command.workflowId];
  if (!binding)
    throw new MediaProviderFailure(
      'provider_not_configured',
      '未配置此 ComfyUI 工作流；未调用本地引擎',
    );
  const graph = cloneWorkflow(binding, command);
  const base = validateLocalEngineEndpoint(config);
  const headers = {
    'content-type': 'application/json',
    ...(config.bearerToken ? { authorization: `Bearer ${config.bearerToken}` } : {}),
  };
  const request = async (path: string, init: RequestInit): Promise<Response> => {
    if (signal.aborted) throw new MediaProviderFailure('cancelled', '本地媒体调用已取消');
    onDispatch();
    try {
      return await checkedResponse(
        await fetcher(endpointUrl(base, path), {
          ...init,
          headers: { ...headers, ...init.headers },
          redirect: 'error',
          signal,
        }),
      );
    } catch (error) {
      if (error instanceof MediaProviderFailure) throw error;
      throw new MediaProviderFailure(
        signal.aborted ? 'cancelled' : 'no_connection',
        '无法连接已配置的 ComfyUI 服务',
      );
    }
  };
  const submitted = await limitedJson(
    await request('/prompt', { method: 'POST', body: JSON.stringify({ prompt: graph }) }),
    signal,
    comfyPromptResponseSchema,
  );
  const promptId = submitted.prompt_id;
  const interval = Math.max(100, Math.min(config.pollIntervalMs ?? 1000, 5000));
  let outputs: JsonRecord | null = null;
  const deadline = Date.now() + MAX_DEADLINE_MS;
  while (!outputs) {
    if (signal.aborted)
      throw new MediaProviderFailure('cancelled', 'ComfyUI 任务已取消，本机计算可能仍在运行');
    if (Date.now() >= deadline)
      throw new MediaProviderFailure('deadline_exceeded', 'ComfyUI 等待超过本地引擎期限');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, interval);
      const abort = () => {
        clearTimeout(timer);
        reject(new MediaProviderFailure('cancelled', 'ComfyUI 等待已取消'));
      };
      signal.addEventListener('abort', abort, { once: true });
      setTimeout(() => signal.removeEventListener('abort', abort), interval + 1);
    });
    const history = await limitedJson(
      await request(`/history/${encodeURIComponent(promptId)}`, { method: 'GET' }),
      signal,
      comfyHistoryResponseSchema,
    );
    const job = history[promptId];
    if (job?.outputs) outputs = job.outputs as JsonRecord;
  }
  const images: Array<{ filename: string; subfolder: string; type: string }> = [];
  for (const node of Object.values(outputs)) {
    if (!isRecord(node) || !Array.isArray(node.images)) continue;
    for (const candidate of node.images) {
      if (
        !isRecord(candidate) ||
        typeof candidate.filename !== 'string' ||
        !/^[A-Za-z0-9_.-]{1,240}$/.test(candidate.filename) ||
        candidate.filename === '.' ||
        candidate.filename === '..' ||
        typeof candidate.subfolder !== 'string' ||
        (candidate.subfolder !== '' && !/^[A-Za-z0-9_.\/-]{1,240}$/.test(candidate.subfolder)) ||
        candidate.subfolder.split('/').some((part) => part === '..') ||
        candidate.type !== 'output'
      )
        continue;
      images.push({ filename: candidate.filename, subfolder: candidate.subfolder, type: 'output' });
    }
  }
  if (images.length < command.count)
    throw new MediaProviderFailure('provider_error', 'ComfyUI 返回图像数量不足');
  const products: MediaProviderOutcome['products'] = [];
  for (const image of images.slice(0, command.count)) {
    const params = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder,
      type: 'output',
    });
    const response = await request(`/view?${params.toString()}`, { method: 'GET', headers: {} });
    const bytes = await boundedBytes(response, signal);
    const mime = mediaMime(bytes);
    if (!mime?.startsWith('image/'))
      throw new MediaProviderFailure('provider_error', 'ComfyUI 输出不是完整且有效的图像格式');
    products.push({ bytes, mime, durationSeconds: null });
  }
  if (products.reduce((sum, item) => sum + item.bytes.byteLength, 0) > MAX_TOTAL_BYTES)
    throw new MediaProviderFailure('provider_error', 'ComfyUI 总输出超过 32 MiB 上限');
  return products;
};

interface PcmWave {
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  pcm: Uint8Array;
}

const parsePcmWave = (bytes: Uint8Array): PcmWave | null => {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    b.length < 44 ||
    b.toString('ascii', 0, 4) !== 'RIFF' ||
    b.toString('ascii', 8, 12) !== 'WAVE' ||
    b.readUInt32LE(4) + 8 !== b.length
  )
    return null;
  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let byteRate = 0;
  let bitsPerSample = 0;
  let data: Buffer | null = null;
  while (offset + 8 <= b.length) {
    const size = b.readUInt32LE(offset + 4);
    if (offset + 8 + size > b.length) return null;
    if (b.toString('ascii', offset, offset + 4) === 'fmt ' && size >= 16) {
      format = b.readUInt16LE(offset + 8);
      channels = b.readUInt16LE(offset + 10);
      sampleRate = b.readUInt32LE(offset + 12);
      byteRate = b.readUInt32LE(offset + 16);
      bitsPerSample = b.readUInt16LE(offset + 22);
      if (
        format !== 1 ||
        channels < 1 ||
        channels > 2 ||
        ![8, 16, 24, 32].includes(bitsPerSample) ||
        byteRate !== (sampleRate * channels * bitsPerSample) / 8
      )
        return null;
    }
    if (b.toString('ascii', offset, offset + 4) === 'data')
      data = b.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  if (!data || !data.length || byteRate <= 0 || format !== 1 || sampleRate <= 0) return null;
  return {
    durationSeconds: data.length / byteRate,
    sampleRate,
    channels,
    bitsPerSample,
    pcm: data,
  };
};

const transcribeFunAsr = async (
  endpoint: LocalEngineEndpoint,
  audio: PcmWave,
  signal: AbortSignal,
  socketFactory: NonNullable<LocalMediaRuntimeDependencies['webSocketFactory']>,
  onDispatch: () => void,
): Promise<string> => {
  const base = validateLocalEngineEndpoint(endpoint);
  if (!loopbackHost(base.hostname) || endpoint.bearerToken)
    throw new MediaProviderFailure(
      'permission_denied',
      'FunASR runtime WebSocket 仅允许无凭据 loopback 服务',
    );
  if (audio.sampleRate !== 16_000 || audio.channels !== 1 || audio.bitsPerSample !== 16)
    throw new MediaProviderFailure(
      'provider_error',
      'FunASR runtime 需要 16 kHz、单声道、PCM16 WAV',
    );
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  onDispatch();
  return await new Promise<string>((resolve, reject) => {
    let completed = false;
    let finalText = '';
    let socket!: WebSocket;
    const finish = (error?: MediaProviderFailure): void => {
      if (completed) return;
      completed = true;
      signal.removeEventListener('abort', abort);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
      try {
        socket.close();
      } catch {
        // A failed WebSocket may already be closed.
      }
      if (error) reject(error);
      else if (finalText.trim()) resolve(finalText.trim());
      else reject(new MediaProviderFailure('provider_error', 'FunASR runtime 未返回最终转写文本'));
    };
    const abort = (): void =>
      finish(new MediaProviderFailure('cancelled', 'FunASR runtime 调用已取消'));
    const onOpen = (): void => {
      try {
        socket.send(
          JSON.stringify({
            mode: 'offline',
            chunk_size: [5, 10, 5],
            chunk_interval: 10,
            encoder_chunk_look_back: 4,
            decoder_chunk_look_back: 0,
            audio_fs: audio.sampleRate,
            wav_name: 'local-candidate',
            wav_format: 'pcm',
            is_speaking: true,
            hotwords: '',
            itn: true,
          }),
        );
        const stride = 19_200; // 600 ms at 16 kHz mono PCM16.
        for (let offset = 0; offset < audio.pcm.byteLength; offset += stride) {
          if (signal.aborted) return abort();
          socket.send(audio.pcm.subarray(offset, Math.min(offset + stride, audio.pcm.byteLength)));
        }
        socket.send(JSON.stringify({ is_speaking: false, is_end: true }));
      } catch {
        finish(new MediaProviderFailure('provider_error', 'FunASR runtime 音频发送失败'));
      }
    };
    const onMessage = (event: MessageEvent): void => {
      const raw = typeof event.data === 'string' ? event.data : null;
      if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_JSON_BYTES)
        return finish(new MediaProviderFailure('provider_error', 'FunASR runtime 返回无效响应'));
      const decoded = decodeJson(raw, funAsrMessageSchema, null, 'FunASR runtime response');
      if (!decoded.ok || !decoded.value)
        return finish(
          new MediaProviderFailure('provider_error', 'FunASR runtime 返回无效 JSON 或响应结构'),
        );
      const message = decoded.value;
      if (message.error)
        return finish(new MediaProviderFailure('provider_error', 'FunASR runtime 转写失败'));
      if (message.is_final === true && typeof message.text === 'string') finalText = message.text;
      if (message.is_end === true) finish();
    };
    const onError = (): void =>
      finish(new MediaProviderFailure('no_connection', 'FunASR runtime WebSocket 连接失败'));
    const onClose = (): void => {
      if (!completed)
        finish(new MediaProviderFailure('provider_error', 'FunASR runtime 在最终响应前关闭连接'));
    };
    if (signal.aborted)
      return reject(new MediaProviderFailure('cancelled', 'FunASR runtime 调用已取消'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      socket = socketFactory(base.toString(), ['binary']);
      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
    } catch {
      signal.removeEventListener('abort', abort);
      reject(new MediaProviderFailure('no_connection', '无法创建 FunASR runtime WebSocket'));
    }
  });
};

const runAsr = async (
  command: AsrGenerationCommandDto,
  audio: NonNullable<MediaProviderOptions['audio']>,
  endpoint: LocalEngineEndpoint & { model?: string },
  engine: 'whisper' | 'funasr',
  fetcher: typeof fetch,
  signal: AbortSignal,
  socketFactory: NonNullable<LocalMediaRuntimeDependencies['webSocketFactory']>,
  onDispatch: () => void,
): Promise<Pick<MediaProviderOutcome, 'products' | 'usage' | 'usageMeasurement'>> => {
  const wave = audio.mime === 'audio/wav' ? parsePcmWave(audio.bytes) : null;
  const duration = wave?.durationSeconds ?? null;
  if (!duration || Math.abs(duration - command.audioSeconds) > 0.15)
    throw new MediaProviderFailure('provider_error', '本地 ASR 音频格式或真实时长与授权记录不符');
  if (mediaMime(audio.bytes) !== audio.mime)
    throw new MediaProviderFailure('provider_error', '本地 ASR 音频字节与声明格式不一致');
  if (engine === 'funasr') {
    if (!wave)
      throw new MediaProviderFailure('provider_error', 'FunASR runtime 只支持已验证 PCM WAV');
    const text = await transcribeFunAsr(endpoint, wave, signal, socketFactory, onDispatch);
    return {
      products: [
        { bytes: new TextEncoder().encode(text), mime: 'text/plain', durationSeconds: duration },
      ],
      usage: { ...zeroMediaUsage(), asrSeconds: duration },
      usageMeasurement: 'actual',
    };
  }
  const base = validateLocalEngineEndpoint(endpoint);
  if (!endpoint.model)
    throw new MediaProviderFailure(
      'local_engine_unavailable',
      '本地 Whisper 需要明确配置服务模型标识',
    );
  const form = new FormData();
  form.append('model', endpoint.model);
  form.append(
    'file',
    new Blob([Uint8Array.from(audio.bytes)], { type: audio.mime }),
    audio.mime === 'audio/wav' ? 'recording.wav' : 'recording.mp3',
  );
  form.append('response_format', 'json');
  if (command.locale) form.append('language', command.locale.split(/[-_]/)[0]!);
  const suffix = '/audio/transcriptions';
  onDispatch();
  let response: Response;
  try {
    response = await fetcher(endpointUrl(base, suffix), {
      method: 'POST',
      body: form,
      redirect: 'error',
      signal,
      headers: endpoint.bearerToken ? { authorization: `Bearer ${endpoint.bearerToken}` } : {},
    });
  } catch {
    throw new MediaProviderFailure(
      signal.aborted ? 'cancelled' : 'no_connection',
      `无法连接已配置的本地 ${engine} 服务`,
    );
  }
  await checkedResponse(response);
  const result = await limitedJson(response, signal, whisperResponseSchema);
  const text = result.text.trim();
  if (
    !text ||
    text.length > 100_000 ||
    (endpoint.bearerToken && text.includes(endpoint.bearerToken))
  )
    throw new MediaProviderFailure('provider_error', '本地 ASR 未返回有效转写文本');
  return {
    products: [
      { bytes: new TextEncoder().encode(text), mime: 'text/plain', durationSeconds: duration },
    ],
    usage: { ...zeroMediaUsage(), asrSeconds: duration },
    usageMeasurement: 'actual',
  };
};

export const createLocalMediaRuntime = (
  config: LocalMediaRuntimeConfig = {},
  dependencies: LocalMediaRuntimeDependencies = {},
): LocalMediaRuntime => {
  const fetcher = dependencies.fetcher ?? fetch;
  const socketFactory =
    dependencies.webSocketFactory ?? ((url, protocols) => new WebSocket(url, protocols));
  const now = dependencies.now ?? Date.now;
  const deadlineMs = Math.max(
    1000,
    Math.min(config.deadlineMs ?? DEFAULT_DEADLINE_MS, MAX_DEADLINE_MS),
  );

  const generateMedia = async (
    raw: MediaGenerationCommandDto,
    options: MediaProviderOptions = {},
  ): Promise<MediaProviderOutcome> => {
    const started = now();
    let dispatched = false;
    const failed = (
      kind: MediaProviderOutcome['failureKind'],
      message: string,
    ): MediaProviderOutcome => ({
      dispatched,
      ok: false,
      failureKind: kind,
      products: [],
      usage: dispatched ? null : zeroMediaUsage(),
      usageMeasurement: dispatched ? 'unknown' : 'actual',
      elapsedMs: Math.max(0, now() - started),
      message,
    });
    if (options.signal?.aborted) return failed('cancelled', '本地媒体调用已取消');
    const parsed = mediaGenerationCommandSchema.safeParse(raw);
    if (!parsed.success) return failed('provider_error', '本地媒体命令无效');
    const command = parsed.data;
    const supported =
      (command.kind === 'image' && command.workflowLocation === 'local') ||
      (command.kind === 'asr' && command.engine.startsWith('local_'));
    if (!supported) return failed('provider_error', '本地引擎不处理此媒体类型');
    if (command.kind === 'image' && command.referenceAssetId)
      return failed('provider_error', '本地运行时只接受基础参数，不读取项目文件或外部引用');
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    let outcome: MediaProviderOutcome;
    const onDispatch = () => {
      dispatched = true;
    };
    try {
      let products: MediaProviderOutcome['products'];
      let usage: MediaProviderOutcome['usage'];
      let usageMeasurement: MediaProviderOutcome['usageMeasurement'];
      if (command.kind === 'image') {
        if (!config.comfyUi)
          throw new MediaProviderFailure(
            'local_engine_unavailable',
            'ComfyUI 尚未安装或尚未配置；未启动下载',
          );
        products = await runComfyImage(
          command,
          config.comfyUi,
          fetcher,
          controller.signal,
          onDispatch,
        );
        usage = { ...zeroMediaUsage(), images: products.length };
        usageMeasurement = 'actual';
      } else {
        if (!command.microphoneGranted)
          throw new MediaProviderFailure('permission_denied', '未获得录音授权');
        const audio = options.audio;
        if (!audio || !audio.bytes.byteLength || audio.bytes.byteLength > MAX_PRODUCT_BYTES)
          throw new MediaProviderFailure('provider_error', '缺少有效且大小合规的已授权录音');
        const engine = command.engine === 'local_funasr' ? 'funasr' : 'whisper';
        const endpoint = engine === 'funasr' ? config.funAsr : config.whisper;
        if (!endpoint)
          throw new MediaProviderFailure(
            'local_engine_unavailable',
            `本地 ${engine} 尚未安装或尚未配置；未启动下载`,
          );
        const asr = await runAsr(
          command,
          audio,
          endpoint,
          engine,
          fetcher,
          controller.signal,
          socketFactory,
          onDispatch,
        );
        products = asr.products;
        usage = asr.usage;
        usageMeasurement = asr.usageMeasurement;
      }
      if (controller.signal.aborted)
        throw new MediaProviderFailure(
          options.signal?.aborted ? 'cancelled' : 'deadline_exceeded',
          '本地媒体调用已取消或超时',
        );
      outcome = {
        dispatched,
        ok: true,
        failureKind: null,
        products,
        usage,
        usageMeasurement,
        elapsedMs: Math.max(0, now() - started),
        message: '本地媒体引擎已返回候选产物，仍需人工审核后才能用于教学',
      };
    } catch (error) {
      const failure = controller.signal.aborted
        ? new MediaProviderFailure(
            options.signal?.aborted ? 'cancelled' : 'deadline_exceeded',
            options.signal?.aborted ? '本地媒体调用已取消' : '本地媒体调用超过期限',
          )
        : error instanceof MediaProviderFailure
          ? error
          : new MediaProviderFailure('provider_error', '本地媒体引擎调用失败');
      outcome = failed(failure.kind, failure.message);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
    return outcome;
  };
  return { generateMedia };
};
