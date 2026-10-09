import type { ModelConnectionInput } from '@sew/study-contracts';

export type ProviderId = ModelConnectionInput['provider'];
export type ProviderProtocol = 'openai' | 'azure' | 'anthropic' | 'google' | 'bedrock';
export type ModelRoute =
  | 'lesson-draft'
  | 'courseware'
  | 'teaching'
  | 'feedback'
  | 'grading'
  | 'pbl'
  | 'pro-chat'
  | 'media';

export interface ProviderModelPreset {
  readonly id: string;
  readonly label: string;
  readonly contextWindow?: number;
  readonly outputWindow?: number;
  readonly thinking?: 'effort' | 'budget' | 'google-level' | 'none';
}

export interface ProviderDefinition {
  readonly id: ProviderId;
  readonly label: string;
  readonly protocol: ProviderProtocol;
  readonly defaultBaseUrl?: string;
  readonly requiresApiKey: boolean;
  readonly modelDiscovery: 'openai' | 'anthropic' | 'google' | 'azure' | 'bedrock' | 'none';
  readonly defaultModel: string;
  readonly models: readonly ProviderModelPreset[];
}

const models = (...items: ProviderModelPreset[]): readonly ProviderModelPreset[] => items;
const preset = (
  id: string,
  label: string,
  contextWindow?: number,
  outputWindow?: number,
  thinking?: ProviderModelPreset['thinking'],
): ProviderModelPreset => ({
  id,
  label,
  ...(contextWindow ? { contextWindow } : {}),
  ...(outputWindow ? { outputWindow } : {}),
  ...(thinking ? { thinking } : {}),
});

/**
 * Product runtime registry based on OpenMAIC v1.1.1's provider/type baseline.
 * The upstream repo is a reference only; this module contains only the provider
 * protocol/config facts we need, not copied UI/catalog implementation.
 */
export const PROVIDER_REGISTRY: Readonly<Record<string, ProviderDefinition>> = {
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI-compatible',
    protocol: 'openai',
    requiresApiKey: true,
    modelDiscovery: 'openai',
    defaultModel: 'gpt-4o-mini',
    models: models(preset('gpt-4o-mini', 'GPT-4o mini'), preset('deepseek-chat', 'DeepSeek Chat')),
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    modelDiscovery: 'openai',
    defaultModel: 'gpt-5.6',
    models: models(
      preset('gpt-5.6', 'GPT-5.6', 1_050_000, 128_000, 'effort'),
      preset('gpt-5.5', 'GPT-5.5', 1_050_000, 128_000, 'effort'),
      preset('gpt-4.1', 'GPT-4.1', 1_047_576, 32_768),
    ),
  },
  azure: {
    id: 'azure',
    label: 'Azure OpenAI',
    protocol: 'azure',
    requiresApiKey: true,
    modelDiscovery: 'azure',
    defaultModel: '',
    models: [],
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude',
    protocol: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    requiresApiKey: true,
    modelDiscovery: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    models: models(
      preset('claude-opus-4-6', 'Claude Opus 4.6', 200_000, 128_000, 'budget'),
      preset('claude-sonnet-4-6', 'Claude Sonnet 4.6', 200_000, 128_000, 'budget'),
      preset('claude-haiku-4-5', 'Claude Haiku 4.5', 200_000, 64_000),
    ),
  },
  bedrock: {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    protocol: 'bedrock',
    requiresApiKey: false,
    modelDiscovery: 'bedrock',
    defaultModel: 'us.anthropic.claude-sonnet-4-6',
    models: models(
      preset('us.anthropic.claude-sonnet-4-6', 'Claude Sonnet 4.6 (Bedrock)', 1_000_000, 64_000),
      preset('us.amazon.nova-pro-v1:0', 'Amazon Nova Pro', 300_000, 10_000),
    ),
  },
  google: {
    id: 'google',
    label: 'Google Gemini',
    protocol: 'google',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requiresApiKey: true,
    modelDiscovery: 'google',
    defaultModel: 'gemini-2.5-flash',
    models: models(
      preset('gemini-2.5-flash', 'Gemini 2.5 Flash', 1_048_576, 65_536, 'google-level'),
      preset('gemini-2.5-pro', 'Gemini 2.5 Pro', 1_048_576, 65_536, 'google-level'),
    ),
  },
  atlascloud: {
    id: 'atlascloud',
    label: 'Atlas Cloud',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.atlascloud.ai/v1',
    requiresApiKey: true,
    modelDiscovery: 'openai',
    defaultModel: 'deepseek-ai/deepseek-v4-pro',
    models: models(preset('deepseek-ai/deepseek-v4-pro', 'DeepSeek V4 Pro')),
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    requiresApiKey: true,
    modelDiscovery: 'openai',
    defaultModel: 'deepseek-v4-pro',
    models: models(
      preset('deepseek-v4-pro', 'DeepSeek V4 Pro', 1_048_576, 393_216, 'effort'),
      preset('deepseek-v4-flash', 'DeepSeek V4 Flash', 1_048_576, 393_216, 'effort'),
    ),
  },
  qwen: {
    id: 'qwen',
    label: 'Qwen',
    protocol: 'openai',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    requiresApiKey: true,
    modelDiscovery: 'openai',
    defaultModel: 'qwen3.7-plus',
    models: models(
      preset('qwen3.7-plus', 'Qwen3.7 Plus'),
      preset('qwen3.5-flash', 'Qwen3.5 Flash'),
    ),
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    requiresApiKey: true,
    modelDiscovery: 'openai',
    defaultModel: 'kimi-k3',
    models: models(
      preset('kimi-k3', 'Kimi K3', 1_048_576, 131_072, 'effort'),
      preset('kimi-k2.5', 'Kimi K2.5'),
    ),
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax',
    protocol: 'anthropic',
    defaultBaseUrl: 'https://api.minimaxi.com/anthropic/v1',
    requiresApiKey: true,
    modelDiscovery: 'anthropic',
    defaultModel: 'MiniMax-M3',
    models: models(
      preset('MiniMax-M3', 'MiniMax M3', 1_000_000, 32_768, 'budget'),
      preset('MiniMax-M2.7', 'MiniMax M2.7'),
    ),
  },
  glm: {
    id: 'glm',
    label: 'GLM',
    protocol: 'openai',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    requiresApiKey: true,
    modelDiscovery: 'openai',
    defaultModel: 'glm-5.3',
    models: models(
      preset('glm-5.3', 'GLM-5.3', 1_000_000, 128_000, 'effort'),
      preset('glm-4.7', 'GLM-4.7'),
    ),
  },
  siliconflow: {
    id: 'siliconflow',
    label: 'SiliconFlow',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    requiresApiKey: true,
    modelDiscovery: 'openai',
    defaultModel: 'deepseek-ai/DeepSeek-V3.2',
    models: models(preset('deepseek-ai/DeepSeek-V3.2', 'DeepSeek V3.2')),
  },
  doubao: {
    id: 'doubao',
    label: '豆包',
    protocol: 'openai',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    requiresApiKey: true,
    modelDiscovery: 'openai',
    defaultModel: 'doubao-seed-2-1-pro-260628',
    models: models(preset('doubao-seed-2-1-pro-260628', 'Doubao Seed 2.1 Pro')),
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    modelDiscovery: 'openai',
    defaultModel: 'deepseek/deepseek-v4-pro',
    models: models(preset('deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro')),
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.x.ai/v1',
    requiresApiKey: true,
    modelDiscovery: 'openai',
    defaultModel: 'grok-4.6',
    models: models(preset('grok-4.6', 'Grok 4.6', 500_000, 500_000, 'effort')),
  },
  'tencent-hunyuan': {
    id: 'tencent-hunyuan',
    label: 'Tencent Hunyuan',
    protocol: 'openai',
    defaultBaseUrl: 'https://tokenhub.tencentmaas.com/v1',
    requiresApiKey: true,
    modelDiscovery: 'openai',
    defaultModel: 'hy3-preview',
    models: models(preset('hy3-preview', 'Tencent Hy3 Preview')),
  },
  xiaomi: {
    id: 'xiaomi',
    label: 'Xiaomi MiMo',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
    requiresApiKey: true,
    modelDiscovery: 'openai',
    defaultModel: 'mimo-v2.6-pro',
    models: models(preset('mimo-v2.6-pro', 'MiMo V2.6 Pro', 1_048_576, 131_072, 'effort')),
  },
  tokendance: {
    id: 'tokendance',
    label: 'TokenDance',
    protocol: 'openai',
    defaultBaseUrl: 'https://tokendance.space/gateway/v1',
    requiresApiKey: true,
    modelDiscovery: 'openai',
    defaultModel: 'deepseek-v4.1-flash',
    models: models(preset('deepseek-v4.1-flash', 'DeepSeek V4.1 Flash')),
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    protocol: 'openai',
    defaultBaseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
    modelDiscovery: 'openai',
    defaultModel: 'llama3.3',
    models: models(preset('llama3.3', 'Llama 3.3 70B'), preset('gemma3', 'Gemma 3 12B')),
  },
  lemonade: {
    id: 'lemonade',
    label: 'Lemonade',
    protocol: 'openai',
    defaultBaseUrl: 'http://localhost:13305/v1',
    requiresApiKey: false,
    modelDiscovery: 'openai',
    defaultModel: 'Gemma-4-26B-A4B-it-GGUF',
    models: models(preset('Gemma-4-26B-A4B-it-GGUF', 'Gemma 4 26B A4B IT GGUF')),
  },
};

export const getProviderDefinition = (provider: string): ProviderDefinition =>
  PROVIDER_REGISTRY[provider] ?? {
    id: provider as ProviderId,
    label: 'Custom OpenAI-compatible',
    protocol: 'openai',
    requiresApiKey: true,
    modelDiscovery: 'openai',
    defaultModel: '',
    models: [],
  };

export const resolveModelForRoute = (config: ModelConnectionInput, route?: ModelRoute): string =>
  (route && config.routeModels?.[route]) || config.model;

export const resolvedProviderEndpoint = (config: ModelConnectionInput): string | undefined =>
  config.baseUrl || getProviderDefinition(config.provider).defaultBaseUrl;

export const isCompatibleMediaProvider = (provider: string): boolean =>
  getProviderDefinition(provider).protocol === 'openai';

export const supportsModelDiscovery = (provider: string): boolean =>
  getProviderDefinition(provider).modelDiscovery !== 'none';
