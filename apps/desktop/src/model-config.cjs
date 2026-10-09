const PROVIDERS = new Set([
  'openai-compatible',
  'openai',
  'azure',
  'anthropic',
  'bedrock',
  'google',
  'atlascloud',
  'deepseek',
  'qwen',
  'kimi',
  'minimax',
  'glm',
  'siliconflow',
  'doubao',
  'openrouter',
  'grok',
  'tencent-hunyuan',
  'xiaomi',
  'tokendance',
  'lemonade',
  'ollama',
]);
const ROUTES = new Set([
  'lesson-draft',
  'courseware',
  'teaching',
  'feedback',
  'grading',
  'pbl',
  'pro-chat',
  'media',
]);
const MODEL_ID = /^[\w.\-:/]{1,200}$/;
const CREDENTIAL = /^[\x21-\x7e]{1,4096}$/;

const invalid = () => {
  throw new Error('模型配置无效：请核对协议、服务地址、模型和凭据');
};
const isLoopback = (hostname) => {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
};
const validateEndpoint = (value) => {
  if (typeof value !== 'string' || value.length > 2000) invalid();
  let url;
  try {
    url = new URL(value);
  } catch {
    invalid();
  }
  if (url.username || url.password || url.search || url.hash) invalid();
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))
    invalid();
  return url.href.replace(/\/+$/, '');
};
const validateModelConfig = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const allowed = new Set([
    'provider',
    'baseUrl',
    'model',
    'apiKey',
    'apiVersion',
    'region',
    'accessKeyId',
    'secretAccessKey',
    'sessionToken',
    'routeModels',
    'thinking',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid();
  const provider = value.provider;
  if (
    typeof provider !== 'string' ||
    (!PROVIDERS.has(provider) && !/^custom-[a-z0-9][a-z0-9-]{0,78}$/.test(provider))
  )
    invalid();
  if (typeof value.model !== 'string' || !MODEL_ID.test(value.model.trim())) invalid();
  const baseUrl = value.baseUrl === undefined ? undefined : validateEndpoint(value.baseUrl);
  if (
    (provider === 'openai-compatible' || provider === 'azure' || provider.startsWith('custom-')) &&
    !baseUrl
  )
    invalid();
  const requiresApiKey = !['bedrock', 'ollama', 'lemonade'].includes(provider);
  const apiKey = value.apiKey === undefined ? undefined : value.apiKey.trim();
  if (requiresApiKey && (typeof apiKey !== 'string' || !CREDENTIAL.test(apiKey))) invalid();
  if (!requiresApiKey && apiKey && !CREDENTIAL.test(apiKey)) invalid();
  const apiVersion = value.apiVersion === undefined ? undefined : value.apiVersion.trim();
  if (apiVersion !== undefined && !/^[\w.-]{1,64}$/.test(apiVersion)) invalid();
  const region = value.region === undefined ? undefined : value.region.trim();
  if (provider === 'bedrock' && (typeof region !== 'string' || !/^[a-z0-9-]{1,64}$/.test(region)))
    invalid();
  if (region !== undefined && !/^[a-z0-9-]{1,64}$/.test(region)) invalid();
  const accessKeyId = value.accessKeyId === undefined ? undefined : value.accessKeyId.trim();
  const secretAccessKey =
    value.secretAccessKey === undefined ? undefined : value.secretAccessKey.trim();
  const sessionToken = value.sessionToken === undefined ? undefined : value.sessionToken.trim();
  if (
    (accessKeyId !== undefined && !CREDENTIAL.test(accessKeyId)) ||
    (secretAccessKey !== undefined && !CREDENTIAL.test(secretAccessKey)) ||
    (sessionToken !== undefined && !CREDENTIAL.test(sessionToken))
  )
    invalid();
  if (
    (provider === 'bedrock' ||
      accessKeyId !== undefined ||
      secretAccessKey !== undefined ||
      sessionToken !== undefined) &&
    Boolean(accessKeyId) !== Boolean(secretAccessKey)
  )
    invalid();
  if (provider === 'bedrock' && apiKey && (accessKeyId || secretAccessKey)) invalid();
  if (sessionToken && !accessKeyId) invalid();
  let routeModels;
  if (value.routeModels !== undefined) {
    if (
      !value.routeModels ||
      typeof value.routeModels !== 'object' ||
      Array.isArray(value.routeModels)
    )
      invalid();
    if (Object.keys(value.routeModels).some((key) => !ROUTES.has(key))) invalid();
    routeModels = {};
    for (const [route, model] of Object.entries(value.routeModels)) {
      if (typeof model !== 'string' || !MODEL_ID.test(model.trim())) invalid();
      routeModels[route] = model.trim();
    }
  }
  let thinking;
  if (value.thinking !== undefined) {
    if (!value.thinking || typeof value.thinking !== 'object' || Array.isArray(value.thinking))
      invalid();
    if (
      Object.keys(value.thinking).some(
        (key) => !['enabled', 'effort', 'budgetTokens'].includes(key),
      )
    )
      invalid();
    const { enabled, effort, budgetTokens } = value.thinking;
    if (enabled !== undefined && typeof enabled !== 'boolean') invalid();
    if (
      effort !== undefined &&
      !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
    )
      invalid();
    if (
      budgetTokens !== undefined &&
      (!Number.isInteger(budgetTokens) || budgetTokens < 0 || budgetTokens > 100000)
    )
      invalid();
    thinking = {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    };
  }
  return {
    provider,
    ...(baseUrl ? { baseUrl } : {}),
    model: value.model.trim(),
    ...(apiKey ? { apiKey } : {}),
    ...(apiVersion ? { apiVersion } : {}),
    ...(region ? { region } : {}),
    ...(accessKeyId ? { accessKeyId } : {}),
    ...(secretAccessKey ? { secretAccessKey } : {}),
    ...(sessionToken ? { sessionToken } : {}),
    ...(routeModels ? { routeModels } : {}),
    ...(thinking ? { thinking } : {}),
  };
};

module.exports = { validateModelConfig };
