/** Validate write-only IPC/disk credentials before they reach storage or HTTP. */
const validateModelConfig = (value) => {
  const invalid = () => { throw new Error('模型配置无效：请填写 HTTPS 服务地址、模型名称和密钥'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  if (Object.keys(value).some(key => !['provider', 'baseUrl', 'model', 'apiKey'].includes(key))) invalid();
  if (value.provider !== 'openai-compatible' || typeof value.baseUrl !== 'string' || value.baseUrl.length > 2000) invalid();
  let url;
  try { url = new URL(value.baseUrl); } catch { invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) invalid();
  if (typeof value.model !== 'string' || !/^[\w.\-:/]{1,200}$/.test(value.model.trim())) invalid();
  if (typeof value.apiKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(value.apiKey.trim())) invalid();
  return { provider: 'openai-compatible', baseUrl: url.href.replace(/\/+$/, ''), model: value.model.trim(), apiKey: value.apiKey.trim() };
};
module.exports = { validateModelConfig };
