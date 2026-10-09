import {
  modelChatMessageSchema,
  modelConnectionInputSchema,
  type ModelChatMessage,
  type ModelConnectionInput,
  type ModelConnectionStatus,
  type ModelTestResult,
  type MediaFailureKind,
  type MediaGenerationCommandDto,
  localMediaConfigurationInputSchema,
  type LocalMediaConfigurationInput,
  type LocalMediaConfigurationStatus,
  zeroMediaUsage,
} from '@sew/study-contracts';
import {
  discoverBedrockFoundationModels,
  discoverProviderModels,
  generateWithProvider,
  ProviderHttpError,
} from './provider-runtime';
import {
  getProviderDefinition,
  isCompatibleMediaProvider,
  resolvedProviderEndpoint,
  type ModelRoute,
} from './provider-registry';
import {
  executeMediaProvider,
  validateMediaProviderCommand,
  MediaProviderFailure,
  type CompatibleMediaConnectionInput,
  type MediaProviderOptions,
  type MediaProviderOutcome,
} from './media-provider-runtime';
import {
  createLocalMediaRuntime,
  type ComfyWorkflowBinding,
  type LocalMediaRuntimeConfig,
  type LocalMediaRuntimeDependencies,
} from './local-media-runtime';
export type { MediaProviderOutcome } from './media-provider-runtime';

const basicComfyWorkflow = (checkpoint: string): ComfyWorkflowBinding => ({
  workflow: {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: 'prompt', clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed: 0,
        steps: 20,
        cfg: 7,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': {
      class_type: 'SaveImage',
      inputs: { filename_prefix: 'subject-exam-workbench', images: ['6', 0] },
    },
  },
  promptNodeId: '2',
  negativePromptNodeId: '3',
  widthNodeId: '4',
  heightNodeId: '4',
  countNodeId: '4',
  stepsNodeId: '5',
  guidanceNodeId: '5',
  seedNodeId: '5',
});

const localRuntimeConfig = (value: LocalMediaConfigurationInput): LocalMediaRuntimeConfig => ({
  ...(value.comfyUi
    ? {
        comfyUi: {
          baseUrl: value.comfyUi.baseUrl,
          ...(value.comfyUi.bearerToken ? { bearerToken: value.comfyUi.bearerToken } : {}),
          workflows: { 'basic-txt2img': basicComfyWorkflow(value.comfyUi.checkpoint) },
        },
      }
    : {}),
  ...(value.whisper ? { whisper: { ...value.whisper } } : {}),
  ...(value.funAsr ? { funAsr: value.funAsr } : {}),
});

const originOf = (baseUrl: string | undefined): string | undefined => {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return undefined;
  }
};

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

export interface ModelGenerateOptions {
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
  readonly route?: ModelRoute;
}

export interface ModelDiscoveryResult {
  readonly ok: boolean;
  readonly message: string;
  readonly models: readonly string[];
  readonly elapsedMs: number;
}

/** Count actual bytes before JSON parsing; never reflect untrusted bodies. */
export const readModelJson = async (
  response: Response | Request,
  limit = 128 * 1024,
  signal?: AbortSignal,
): Promise<unknown> => {
  if (!response.body) throw new Error('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new Error('cancelled');
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new Error('response_too_large');
      chunks.push(next.value);
    }
    if (signal?.aborted) throw new Error('cancelled');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
  }
};

/** Connection-only call: no project material, no publication, no retries.
 * Sources are unnecessary for the fixed "OK" diagnostic. Teaching/generation
 * must add source/run admission before using the configured provider.
 */
export const createModelConnectionRuntime = ({
  fetcher = fetch,
  now = Date.now,
  deadlineMs = 40_000,
  generationDeadlineMs = 120_000,
  generationMaxCallsPerMinute = 6,
  generationMaxCallsPerHour = 30,
  localMediaDependencies = {},
}: {
  fetcher?: typeof fetch;
  now?: () => number;
  deadlineMs?: number;
  generationDeadlineMs?: number;
  generationMaxCallsPerMinute?: number;
  generationMaxCallsPerHour?: number;
  localMediaDependencies?: LocalMediaRuntimeDependencies;
} = {}) => {
  let config: ModelConnectionInput | null = null;
  let localConfig: LocalMediaConfigurationInput | null = null;
  let localRuntime: ReturnType<typeof createLocalMediaRuntime> | null = null;
  let persisted = false;
  let revision = 0;
  let lastTest: ModelTestResult | null = null;
  let active: AbortController | null = null;
  let stopped = false;
  const calls: number[] = [];
  /** 生成有独立的频次上限：连接诊断不应吃掉草案生成的次数，反之亦然。 */
  const generationCalls: number[] = [];
  const compatibleMediaInput = (): CompatibleMediaConnectionInput | null =>
    config?.apiKey && config.baseUrl && isCompatibleMediaProvider(config.provider)
      ? (config as CompatibleMediaConnectionInput)
      : null;
  const localMediaStatus = (): LocalMediaConfigurationStatus => {
    const local = localConfig;
    const comfy = local?.comfyUi;
    const whisper = local?.whisper;
    const funAsr = local?.funAsr;
    return {
      configured: Boolean(comfy || whisper || funAsr),
      storage: 'memory_only',
      comfyUi: {
        configured: Boolean(comfy),
        ...(comfy
          ? {
              endpointOrigin: originOf(comfy.baseUrl),
              workflowId: 'basic-txt2img' as const,
              checkpoint: comfy.checkpoint,
            }
          : {}),
      },
      whisper: {
        configured: Boolean(whisper),
        ...(whisper ? { endpointOrigin: originOf(whisper.baseUrl), model: whisper.model } : {}),
      },
      funAsr: {
        configured: Boolean(funAsr),
        ...(funAsr ? { endpointOrigin: originOf(funAsr.baseUrl) } : {}),
      },
    };
  };
  const mediaConfigured = (command: MediaGenerationCommandDto): boolean => {
    if (command.kind === 'image' && command.workflowLocation === 'local')
      return Boolean(localConfig?.comfyUi && localRuntime);
    if (command.kind === 'asr' && command.engine === 'local_funasr')
      return Boolean(localConfig?.funAsr && localRuntime);
    if (command.kind === 'asr' && command.engine === 'local_whisper')
      return Boolean(localConfig?.whisper && localRuntime);
    return compatibleMediaInput() !== null;
  };
  const status = (): ModelConnectionStatus => ({
    configured: config !== null,
    persisted,
    ...(config
      ? {
          provider: config.provider,
          ...(resolvedProviderEndpoint(config)
            ? { baseUrl: resolvedProviderEndpoint(config) }
            : {}),
          model: config.model,
          ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
          ...(config.region ? { region: config.region } : {}),
          ...(config.routeModels ? { routeModels: config.routeModels } : {}),
          ...(config.thinking ? { thinking: config.thinking } : {}),
        }
      : {}),
    lastTest,
  });
  const configure = (value: unknown, saved: boolean): ModelConnectionStatus => {
    if (stopped) throw new Error('模型服务正在退出');
    const parsed = modelConnectionInputSchema.safeParse(value);
    if (!parsed.success) throw new Error('模型配置无效');
    active?.abort();
    revision += 1;
    const endpoint = resolvedProviderEndpoint(parsed.data);
    config = { ...parsed.data, ...(endpoint ? { baseUrl: endpoint.replace(/\/+$/, '') } : {}) };
    persisted = saved;
    lastTest = null;
    return status();
  };
  const configureLocalMedia = (value: unknown): LocalMediaConfigurationStatus => {
    if (stopped) throw new Error('模型服务正在退出');
    const parsed = localMediaConfigurationInputSchema.safeParse(value);
    if (!parsed.success) throw new Error('本地媒体配置无效');
    active?.abort();
    revision += 1;
    localConfig = parsed.data;
    localRuntime = localMediaStatus().configured
      ? createLocalMediaRuntime(localRuntimeConfig(parsed.data), { ...localMediaDependencies, now })
      : null;
    return localMediaStatus();
  };
  const cancel = () => {
    stopped = true;
    revision += 1;
    active?.abort();
  };
  const test = async (signal?: AbortSignal): Promise<ModelTestResult> => {
    if (stopped) return { ok: false, message: '模型服务正在退出，不能开始新调用' };
    if (!config) return { ok: false, message: '尚未配置模型连接' };
    if (active) return { ok: false, message: '已有连接测试正在执行，请等待结束' };
    if (signal?.aborted) return { ok: false, message: '连接测试已取消' };
    const started = now();
    while (calls.length && calls[0]! <= started - 3_600_000) calls.shift();
    if (calls.length >= 20 || calls.filter((at) => at > started - 60_000).length >= 3) {
      return { ok: false, message: '连接测试达到次数限额，请稍后重试' };
    }
    calls.push(started);
    const input = config;
    const epoch = revision;
    const controller = new AbortController();
    active = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deadlineMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let result: ModelTestResult;
    try {
      const generated = await generateWithProvider({
        config: input,
        messages: [{ role: 'user', content: 'Reply exactly OK.' }],
        maxTokens: 1024,
        signal: controller.signal,
        fetcher,
      });
      if (!generated.text.trim()) {
        result = {
          ok: false,
          message: '模型服务未返回有效文本，可能是推理额度不足或响应格式不兼容',
        };
      } else {
        result = {
          ok: true,
          message: '真实连接测试成功，模型已返回有效文本',
          ...(generated.returnedModel ? { returnedModel: generated.returnedModel } : {}),
          ...(generated.usage.totalTokens !== null
            ? { totalTokens: generated.usage.totalTokens }
            : {}),
        };
      }
    } catch (error) {
      result = {
        ok: false,
        message: timedOut
          ? '模型连接超时，请检查服务后手动重试'
          : controller.signal.aborted
            ? '连接测试已取消'
            : error instanceof ProviderHttpError
              ? `模型服务返回 HTTP ${error.status}，请核对密钥、模型和服务额度`
              : '模型连接失败，请检查网络、地址和响应格式',
      };
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

  const discoverModels = async (signal?: AbortSignal): Promise<ModelDiscoveryResult> => {
    const started = now();
    const failed = (message: string): ModelDiscoveryResult => ({
      ok: false,
      message,
      models: [],
      elapsedMs: Math.max(0, now() - started),
    });
    if (stopped) return failed('模型服务正在退出，不能开始发现模型');
    if (!config) return failed('尚未配置模型连接');
    if (active) return failed('已有模型调用正在执行，请等待结束');
    if (signal?.aborted) return failed('模型发现已取消');
    while (calls.length && calls[0]! <= started - 3_600_000) calls.shift();
    if (calls.length >= 20 || calls.filter((at) => at > started - 60_000).length >= 3)
      return failed('模型发现达到次数限额，请稍后重试');
    calls.push(started);
    const input = config;
    const epoch = revision;
    const controller = new AbortController();
    active = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deadlineMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let models: string[] = [];
    let message = '';
    try {
      const discoveryProtocol = getProviderDefinition(input.provider).modelDiscovery;
      if (discoveryProtocol === 'bedrock') {
        models = await discoverBedrockFoundationModels(input, controller.signal, fetcher);
      } else if (discoveryProtocol === 'none') {
        throw new Error('provider_model_discovery_unsupported');
      } else {
        models = await discoverProviderModels({
          config: input,
          signal: controller.signal,
          fetcher,
        });
      }
      const credentials = [
        input.apiKey,
        input.accessKeyId,
        input.secretAccessKey,
        input.sessionToken,
      ].filter((value): value is string => Boolean(value));
      models = models.filter(
        (model) => !credentials.some((credential) => model.includes(credential)),
      );
      message = `已从 ${input.provider} 获取 ${models.length} 个模型名称`;
    } catch {
      message = timedOut
        ? '模型发现超时，请检查服务后重试'
        : controller.signal.aborted
          ? '模型发现已取消'
          : getProviderDefinition(input.provider).modelDiscovery === 'bedrock'
            ? 'Bedrock 模型列表读取失败，请检查 region、AWS 凭据和权限'
            : '模型列表读取失败，请检查地址、密钥和服务权限';
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (active === controller) active = null;
    }
    if (revision !== epoch || signal?.aborted || (controller.signal.aborted && !timedOut))
      return failed('模型发现已取消，配置已变化或应用正在退出');
    return {
      ok: Boolean(message.startsWith('已从 ')),
      message,
      models,
      elapsedMs: Math.max(0, now() - started),
    };
  };
  /**
   * 真实生成调用。它只负责凭据、期限、取消、频次与响应校验，
   * 不判断「能不能据此产出教学内容」——来源、run、审核与预算由 model-call 的 guard 决定，
   * guard 不通过时这里一次请求都不会发出。
   */
  const generate = async (
    messages: ModelChatMessage[],
    options: ModelGenerateOptions = {},
  ): Promise<ModelGenerateOutcome> => {
    const started = now();
    let dispatched = false;
    const failed = (message: string): ModelGenerateOutcome => ({
      dispatched,
      ok: false,
      message,
      text: null,
      totalTokens: 0,
      requestedModel: config
        ? (options.route && config.routeModels?.[options.route]) || config.model
        : null,
      returnedModel: null,
      providerTokens: null,
      elapsedMs: Math.max(0, now() - started),
    });
    if (stopped) return failed('模型服务正在退出，不能开始新的生成');
    if (!config) return failed('尚未配置模型连接');
    if (active) return failed('已有模型调用正在执行，请等待结束');
    if (options.signal?.aborted) return failed('生成已取消');
    const checked = modelChatMessageSchema.array().min(1).max(8).safeParse(messages);
    if (!checked.success) return failed('生成请求的消息不合法，已拒绝发出');

    while (generationCalls.length && generationCalls[0]! <= started - 3_600_000)
      generationCalls.shift();
    if (
      generationCalls.length >= generationMaxCallsPerHour ||
      generationCalls.filter((at) => at > started - 60_000).length >= generationMaxCallsPerMinute
    ) {
      return failed('生成调用达到频次限额，请稍后重试');
    }
    generationCalls.push(started);

    const input = config;
    const epoch = revision;
    const controller = new AbortController();
    active = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, generationDeadlineMs);
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    let outcome: ModelGenerateOutcome;
    try {
      dispatched = true;
      const generated = await generateWithProvider({
        config: input,
        messages: checked.data,
        maxTokens: options.maxTokens ?? 2048,
        signal: controller.signal,
        fetcher,
        ...(options.route ? { route: options.route } : {}),
        onDispatch: () => {
          dispatched = true;
        },
      });
      const content = generated.text.trim();
      if (!content) {
        outcome = failed('模型服务未返回有效文本，可能是推理额度不足或响应格式不兼容');
      } else {
        const providerTokens = generated.usage.totalTokens;
        outcome = {
          dispatched: true,
          ok: true,
          message: '模型已返回草案文本，仍需人工审核后才能用于教学',
          text: content.slice(0, 20_000),
          totalTokens: providerTokens ?? 0,
          providerTokens,
          requestedModel: generated.requestedModel,
          returnedModel: generated.returnedModel,
          elapsedMs: Math.max(0, now() - started),
        };
      }
    } catch (error) {
      outcome = failed(
        timedOut
          ? '模型生成超时，请检查服务后手动重试'
          : controller.signal.aborted
            ? '生成已取消'
            : error instanceof ProviderHttpError
              ? `模型服务返回 HTTP ${error.status}，请核对密钥、模型和服务额度`
              : '模型连接失败，请检查网络、地址和响应格式',
      );
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

  /** Media shares the same private credentials, active call and generation rate budget. */
  const generateMedia = async (
    command: MediaGenerationCommandDto,
    options: MediaProviderOptions = {},
  ): Promise<MediaProviderOutcome> => {
    const started = now();
    let dispatched = false;
    let providerJobId: string | undefined;
    const failed = (failureKind: MediaFailureKind, message: string): MediaProviderOutcome => ({
      dispatched,
      ok: false,
      failureKind,
      products: [],
      usage: dispatched ? null : zeroMediaUsage(),
      usageMeasurement: dispatched ? 'unknown' : 'actual',
      ...(providerJobId ? { providerJobId } : {}),
      elapsedMs: Math.max(0, now() - started),
      message,
    });
    if (stopped) return failed('cancelled', '模型服务正在退出，不能开始媒体调用');
    if (active) return failed('provider_error', '已有模型调用正在执行，请等待结束');
    if (options.signal?.aborted) return failed('cancelled', '媒体调用已取消');
    const localCommand =
      (command.kind === 'image' && command.workflowLocation === 'local') ||
      (command.kind === 'asr' && command.engine !== 'remote');
    const localRuntimeForCall = localRuntime;
    if (localCommand && !localRuntimeForCall)
      return failed('local_engine_unavailable', '本地媒体引擎尚未安装或配置；未派发请求');
    const remoteInput = compatibleMediaInput();
    if (!localCommand && !remoteInput)
      return failed(
        'provider_not_configured',
        '当前模型协议不能用于该媒体任务；请配置兼容媒体服务或本地引擎',
      );
    let checked: MediaGenerationCommandDto;
    try {
      checked = localCommand
        ? command
        : validateMediaProviderCommand(command, remoteInput!, options);
    } catch (error) {
      return error instanceof MediaProviderFailure
        ? failed(error.kind, error.message)
        : failed('provider_error', '媒体命令无效');
    }
    while (generationCalls.length && generationCalls[0]! <= started - 3_600_000)
      generationCalls.shift();
    if (
      generationCalls.length >= generationMaxCallsPerHour ||
      generationCalls.filter((at) => at > started - 60_000).length >= generationMaxCallsPerMinute
    ) {
      return failed('provider_error', '生成调用达到频次限额，请稍后重试');
    }
    generationCalls.push(started);
    const input = remoteInput;
    const epoch = revision;
    const controller = new AbortController();
    active = controller;
    let timedOut = false;
    const mediaDeadlineMs =
      checked.kind === 'video'
        ? Math.min(generationDeadlineMs, checked.poll.deadlineMs)
        : generationDeadlineMs;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, mediaDeadlineMs);
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    let outcome: MediaProviderOutcome;
    try {
      if (localCommand && localRuntimeForCall) {
        outcome = await localRuntimeForCall.generateMedia(checked, {
          signal: controller.signal,
          ...(options.audio ? { audio: options.audio } : {}),
        });
        dispatched = outcome.dispatched;
      } else {
        const result = await executeMediaProvider({
          command: checked,
          input: input!,
          options,
          fetcher,
          signal: controller.signal,
          readJson: readModelJson,
          onDispatch: () => {
            dispatched = true;
          },
          onJob: (id) => {
            providerJobId = id;
          },
        });
        outcome = {
          dispatched,
          ok: true,
          failureKind: null,
          ...result,
          ...(providerJobId ? { providerJobId } : {}),
          elapsedMs: Math.max(0, now() - started),
          message: '媒体服务已返回实际产物，仍需人工审核后才能用于教学',
        };
      }
    } catch (error) {
      outcome = timedOut
        ? failed('deadline_exceeded', '媒体调用超时，远端任务可能仍在执行')
        : controller.signal.aborted
          ? failed('cancelled', '媒体调用已取消，已派发的远端任务可能仍在执行')
          : error instanceof MediaProviderFailure
            ? failed(error.kind, error.message)
            : failed('provider_error', '媒体连接失败，请检查网络、接口和响应格式');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (active === controller) active = null;
    }
    // Never publish results from replaced credentials or a closing application.
    if (revision !== epoch || options.signal?.aborted || (controller.signal.aborted && !timedOut)) {
      return failed('cancelled', '媒体调用已取消，配置已变化或应用正在退出');
    }
    return outcome;
  };

  return {
    configure,
    status,
    test,
    discoverModels,
    generate,
    generateMedia,
    configureLocalMedia,
    localMediaStatus,
    mediaConfigured,
    cancel,
    revision: () => revision,
  };
};

export type MediaProviderConnection = Pick<
  ReturnType<typeof createModelConnectionRuntime>,
  'status' | 'generateMedia' | 'revision'
> &
  Partial<Pick<ReturnType<typeof createModelConnectionRuntime>, 'mediaConfigured'>>;

const shared = globalThis as typeof globalThis & {
  __sewModelConnection?: ReturnType<typeof createModelConnectionRuntime>;
};
shared.__sewModelConnection ??= createModelConnectionRuntime();
export const modelConnection = shared.__sewModelConnection;
