import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { FetchHttpHandler } from '@smithy/fetch-http-handler';
import { generateText, type LanguageModel } from 'ai';
import type { ModelChatMessage, ModelConnectionInput } from '@sew/study-contracts';
import { decodeJson } from '@sew/study-storage';
import { z } from 'zod';
import {
  getProviderDefinition,
  resolveModelForRoute,
  resolvedProviderEndpoint,
  type ModelRoute,
} from './provider-registry';

const JSON_BYTE_LIMIT = 128 * 1024;
const REQUEST_BYTE_LIMIT = 512 * 1024;
const API_VERSION_DEFAULT = '2024-10-21';
const MODEL_ID = /^[\w.\-:/]{1,200}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const credentialValues = (config: ModelConnectionInput): string[] =>
  [config.apiKey, config.accessKeyId, config.secretAccessKey, config.sessionToken].filter(
    (value): value is string => Boolean(value),
  );
const containsCredential = (text: string, config: ModelConnectionInput): boolean =>
  credentialValues(config).some((credential) => text.includes(credential));

export interface ProviderUsage {
  readonly totalTokens: number | null;
}

export interface ProviderGenerationResult {
  readonly text: string;
  readonly requestedModel: string;
  readonly returnedModel: string | null;
  readonly usage: ProviderUsage;
}

export class ProviderHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super('provider_http_error');
    this.status = status;
  }
}

export interface ProviderRuntimeOptions {
  readonly config: ModelConnectionInput;
  readonly messages: ModelChatMessage[];
  readonly maxTokens: number;
  readonly signal: AbortSignal;
  readonly fetcher?: typeof fetch;
  readonly route?: ModelRoute;
  readonly onDispatch?: () => void;
}

const providerEndpoint = (config: ModelConnectionInput): string => {
  const endpoint =
    config.provider === 'bedrock' && config.region
      ? config.baseUrl || `https://bedrock-runtime.${config.region}.amazonaws.com`
      : resolvedProviderEndpoint(config);
  if (!endpoint) throw new Error('provider_base_url_required');
  return endpoint.replace(/\/+$/, '');
};

const validateRequestUrl = (input: RequestInfo | URL): URL => {
  const raw =
    input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('provider_url_invalid');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(host)))
    throw new Error('provider_transport_requires_https_or_loopback');
  if (url.username || url.password || url.hash)
    throw new Error('provider_url_credentials_forbidden');
  return url;
};

const requestBodyBytes = async (input: RequestInfo | URL, init?: RequestInit): Promise<number> => {
  const body = init?.body;
  if (body === undefined && input instanceof Request) {
    const reader = input.clone().body?.getReader();
    if (!reader) return 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > REQUEST_BYTE_LIMIT) throw new Error('provider_request_too_large');
        decoder.decode(value, { stream: true });
      }
      decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return length;
  }
  if (body === undefined || body === null) return 0;
  if (typeof body === 'string') {
    const bytes = new TextEncoder().encode(body);
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return bytes.byteLength;
  }
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  throw new Error('provider_request_body_unsupported');
};

const readBoundedResponse = async (
  response: Response,
  limit = JSON_BYTE_LIMIT,
): Promise<Response> => {
  if (!response.body) throw new Error('provider_response_empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('provider_response_too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = Buffer.concat(chunks);
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('transfer-encoding');
  headers.set('content-length', String(bytes.byteLength));
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
};

/** Every provider SDK call uses this guarded fetch: validate destinations, reject redirects, bound bytes. */
export const createGuardedProviderFetch =
  (fetcher: typeof fetch = fetch, signal?: AbortSignal, onDispatch?: () => void): typeof fetch =>
  async (input, init = {}) => {
    const url = validateRequestUrl(input);
    const bodyBytes = await requestBodyBytes(input, init);
    if (bodyBytes > REQUEST_BYTE_LIMIT) throw new Error('provider_request_too_large');
    const requestSignal = init.signal ?? (input instanceof Request ? input.signal : signal);
    if (signal?.aborted || requestSignal?.aborted) throw new Error('provider_request_cancelled');
    const request: RequestInit = { ...init };
    if (input instanceof Request) {
      request.method ??= input.method;
      request.headers ??= input.headers;
      request.body ??= await input.clone().arrayBuffer();
    }
    onDispatch?.();
    const response = await fetcher(url.href, {
      ...request,
      ...(requestSignal ? { signal: requestSignal } : {}),
      redirect: 'error',
    });
    return readBoundedResponse(response);
  };

const getModel = (
  config: ModelConnectionInput,
  modelId: string,
  fetcher: typeof fetch,
): LanguageModel => {
  const definition = getProviderDefinition(config.provider);
  const baseURL = providerEndpoint(config);
  switch (definition.protocol) {
    case 'openai':
      return createOpenAI({ apiKey: config.apiKey ?? '', baseURL, fetch: fetcher }).chat(modelId);
    case 'azure':
      if (!config.apiKey) throw new Error('provider_api_key_missing');
      return createAzure({
        apiKey: config.apiKey,
        baseURL,
        apiVersion: config.apiVersion || API_VERSION_DEFAULT,
        useDeploymentBasedUrls: true,
        fetch: fetcher,
      }).chat(modelId);
    case 'anthropic':
      if (!config.apiKey) throw new Error('provider_api_key_missing');
      return createAnthropic({ apiKey: config.apiKey, baseURL, fetch: fetcher }).chat(modelId);
    case 'google':
      if (!config.apiKey) throw new Error('provider_api_key_missing');
      return createGoogleGenerativeAI({ apiKey: config.apiKey, baseURL, fetch: fetcher }).chat(
        modelId,
      );
    case 'bedrock': {
      const region = config.region;
      if (!region) throw new Error('provider_region_missing');
      return createAmazonBedrock({
        region,
        apiKey: config.apiKey || undefined,
        ...(config.accessKeyId && config.secretAccessKey
          ? {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
              ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
            }
          : {}),
        ...(config.baseUrl ? { baseURL: baseURL } : {}),
        fetch: fetcher,
      })(modelId);
    }
  }
};

type AIProviderOptions = NonNullable<Parameters<typeof generateText>[0]['providerOptions']>;
const providerOptionsFor = (config: ModelConnectionInput): AIProviderOptions | undefined => {
  const thinking = config.thinking;
  if (!thinking) return undefined;
  const definition = getProviderDefinition(config.provider);
  if (definition.protocol === 'anthropic') {
    if (thinking.enabled === false) return { anthropic: { thinking: { type: 'disabled' } } };
    if (thinking.enabled === true || thinking.budgetTokens !== undefined) {
      return {
        anthropic: {
          thinking: {
            type: 'enabled',
            budgetTokens: Math.max(1024, thinking.budgetTokens ?? 4096),
          },
        },
      };
    }
    return undefined;
  }
  if (definition.protocol === 'google') {
    const thinkingBudget = thinking.enabled === false ? 0 : thinking.budgetTokens;
    if (thinkingBudget === undefined) return undefined;
    return {
      google: {
        thinkingConfig: { thinkingBudget },
      },
    };
  }
  if (definition.protocol === 'bedrock') {
    return {
      bedrock: {
        additionalModelRequestFields: {
          ...(thinking.enabled !== undefined
            ? { thinking: { type: thinking.enabled ? 'enabled' : 'disabled' } }
            : {}),
          ...(thinking.budgetTokens !== undefined
            ? { thinking_budget: thinking.budgetTokens }
            : {}),
        },
      },
    };
  }
  const effort =
    thinking.effort === 'minimal' ? 'low' : thinking.effort === 'max' ? 'high' : thinking.effort;
  if (effort) return { openai: { reasoningEffort: effort } };
  return undefined;
};

const generateCompatible = async ({
  config,
  messages,
  maxTokens,
  signal,
  fetcher,
  route,
  onDispatch,
}: ProviderRuntimeOptions): Promise<ProviderGenerationResult> => {
  const model = resolveModelForRoute(config, route);
  const transport = createGuardedProviderFetch(fetcher, signal, onDispatch);
  const endpoint = providerEndpoint(config);
  const response = await transport(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: false }),
    signal,
    redirect: 'error',
  });
  if (!response.ok) throw new ProviderHttpError(response.status);
  const value = (await response.json()) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('provider_response_invalid');
  const object = value as Record<string, unknown>;
  const choices = Array.isArray(object.choices) ? object.choices : [];
  const first =
    choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : null;
  const message =
    first?.message && typeof first.message === 'object'
      ? (first.message as Record<string, unknown>)
      : null;
  const text = typeof message?.content === 'string' ? message.content : '';
  if (!text || containsCredential(text, config)) throw new Error('provider_response_invalid');
  const usage =
    object.usage && typeof object.usage === 'object'
      ? (object.usage as Record<string, unknown>)
      : null;
  const total = usage?.total_tokens;
  const totalTokens =
    Number.isSafeInteger(total) && (total as number) >= 0 ? (total as number) : null;
  const returnedModel =
    typeof object.model === 'string' &&
    MODEL_ID.test(object.model) &&
    !containsCredential(object.model, config)
      ? object.model
      : null;
  return { text, requestedModel: model, returnedModel, usage: { totalTokens } };
};

export const generateWithProvider = async ({
  config,
  messages,
  maxTokens,
  signal,
  fetcher = fetch,
  route,
  onDispatch,
}: ProviderRuntimeOptions): Promise<ProviderGenerationResult> => {
  const requestedModel = resolveModelForRoute(config, route);
  if (!MODEL_ID.test(requestedModel)) throw new Error('provider_model_invalid');
  if (config.provider === 'openai-compatible')
    return generateCompatible({ config, messages, maxTokens, signal, fetcher, route, onDispatch });
  const transport = createGuardedProviderFetch(fetcher, signal, onDispatch);
  const model = getModel(config, requestedModel, transport);
  const result = await generateText({
    model,
    messages,
    maxOutputTokens: maxTokens,
    maxRetries: 0,
    abortSignal: signal,
    ...(providerOptionsFor(config) ? { providerOptions: providerOptionsFor(config) } : {}),
  });
  const totalTokens = result.usage.totalTokens;
  const providerTokens =
    typeof totalTokens === 'number' && Number.isSafeInteger(totalTokens) && totalTokens >= 0
      ? totalTokens
      : null;
  const responseModel = result.response.modelId;
  if (!result.text || containsCredential(result.text, config))
    throw new Error('provider_response_invalid');
  return {
    text: result.text,
    requestedModel,
    returnedModel:
      responseModel && MODEL_ID.test(responseModel) && !containsCredential(responseModel, config)
        ? responseModel
        : null,
    usage: { totalTokens: providerTokens },
  };
};

const parseModelList = (value: unknown): string[] => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('provider_model_list_invalid');
  const object = value as Record<string, unknown>;
  const raw = Array.isArray(object.data)
    ? object.data
    : Array.isArray(object.models)
      ? object.models
      : Array.isArray(object.value)
        ? object.value
        : [];
  return raw
    .flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const candidate = item as Record<string, unknown>;
      const id =
        typeof candidate.id === 'string'
          ? candidate.id
          : typeof candidate.name === 'string'
            ? candidate.name.replace(/^models\//, '')
            : '';
      return MODEL_ID.test(id) ? [id] : [];
    })
    .slice(0, 500);
};

const boundedJson = async (response: Response): Promise<unknown> => {
  const safe = await readBoundedResponse(response);
  if (!safe.ok) throw new Error('provider_discovery_failed');
  const text = await safe.text();
  const decoded = decodeJson(
    text,
    z.record(z.unknown()).nullable(),
    null,
    'provider.model-discovery',
  );
  if (!decoded.ok) throw new Error('provider_response_json_invalid');
  return decoded.value;
};

export const discoverProviderModels = async ({
  config,
  signal,
  fetcher = fetch,
}: Pick<ProviderRuntimeOptions, 'config' | 'signal' | 'fetcher'>): Promise<string[]> => {
  const definition = getProviderDefinition(config.provider);
  if (definition.modelDiscovery === 'none') throw new Error('provider_model_discovery_unsupported');
  const endpoint = providerEndpoint(config);
  const transport = createGuardedProviderFetch(fetcher, signal);
  if (definition.modelDiscovery === 'azure') {
    const url = new URL(`${endpoint.replace(/\/openai\/?$/i, '')}/openai/deployments`);
    url.searchParams.set('api-version', config.apiVersion || API_VERSION_DEFAULT);
    const response = await transport(url, {
      headers: { 'api-key': config.apiKey ?? '' },
      signal,
      redirect: 'error',
    });
    return parseModelList(await boundedJson(response));
  }
  const url =
    definition.modelDiscovery === 'anthropic'
      ? new URL(`${endpoint}/models`)
      : definition.modelDiscovery === 'google'
        ? new URL(`${endpoint}/models`)
        : new URL(`${endpoint}/models`);
  const headers = new Headers();
  if (definition.modelDiscovery === 'anthropic') {
    headers.set('x-api-key', config.apiKey ?? '');
    headers.set('anthropic-version', '2023-06-01');
  } else if (definition.modelDiscovery === 'google') {
    headers.set('x-goog-api-key', config.apiKey ?? '');
  } else if (config.apiKey) {
    headers.set('authorization', `Bearer ${config.apiKey}`);
  }
  const response = await transport(url, { method: 'GET', headers, signal, redirect: 'error' });
  return parseModelList(await boundedJson(response));
};

export const discoverBedrockFoundationModels = async (
  config: ModelConnectionInput,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<string[]> => {
  if (config.provider !== 'bedrock' || !config.region) throw new Error('provider_region_missing');
  const client = new BedrockClient({
    region: config.region,
    maxAttempts: 1,
    requestHandler: new FetchHttpHandler({
      customFetch: createGuardedProviderFetch(fetcher, signal),
      credentials: 'omit',
      cache: 'no-store',
    }),
    ...(config.accessKeyId && config.secretAccessKey
      ? {
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
            ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
          },
        }
      : {}),
  });
  try {
    const result = await client.send(
      new ListFoundationModelsCommand({ byOutputModality: 'TEXT', byInferenceType: 'ON_DEMAND' }),
      { abortSignal: signal },
    );
    const models =
      result.modelSummaries?.flatMap((item) =>
        typeof item.modelId === 'string' && MODEL_ID.test(item.modelId) ? [item.modelId] : [],
      ) ?? [];
    if (Buffer.byteLength(JSON.stringify(models), 'utf8') > JSON_BYTE_LIMIT)
      throw new Error('provider_response_too_large');
    return models;
  } finally {
    client.destroy();
  }
};
