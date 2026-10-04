'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  modelConnectionInputSchema, modelConnectionStatusSchema, modelTestResultSchema,
  type ModelConnectionStatus,
} from '@sew/study-contracts';
import { apiFetch, getSessionToken } from '../lib/client';
import { Notice } from './ui';

const CHANGE_EVENT = 'sew-model-connection-changed';
const useModelStatus = () => {
  const [status, setStatus] = useState<ModelConnectionStatus | null>(null);
  const refresh = useCallback(async () => {
    if (!getSessionToken()) return;
    const value = modelConnectionStatusSchema.parse(await apiFetch<unknown>('/api/study/models', { cache: 'no-store' }));
    setStatus(value);
    return value;
  }, []);
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    const read = async () => {
      if (!getSessionToken()) return;
      try {
        const value = modelConnectionStatusSchema.parse(await apiFetch<unknown>('/api/study/models', { cache: 'no-store', signal: controller.signal }));
        if (!disposed) setStatus(value);
      } catch { /* A failed read does not invent a connection success. */ }
    };
    void read();
    const interval = setInterval(() => void read(), 2000);
    const onChange = () => void read();
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => { disposed = true; controller.abort(); clearInterval(interval); window.removeEventListener(CHANGE_EVENT, onChange); };
  }, []);
  return { status, refresh };
};

const statusLabel = (status: ModelConnectionStatus | null) => !status ? '读取中…'
  : !status.configured ? '未配置' : status.lastTest?.ok ? `已连接 · ${status.model}`
  : status.lastTest ? `测试失败 · ${status.model}` : `已配置，尚未测试 · ${status.model}`;

export const ModelConnectionIndicator = () => {
  const { status } = useModelStatus();
  return <span>模型连接：{statusLabel(status)}</span>;
};

export const ModelConnectionSettings = () => {
  const { status, refresh } = useModelStatus();
  const [baseUrl, setBaseUrl] = useState('https://token.qixz.eu.org/v1');
  const [model, setModel] = useState('muse-spark-1.3');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (!initialized && status) {
      if (status.baseUrl) setBaseUrl(status.baseUrl);
      if (status.model) setModel(status.model);
      setInitialized(true);
    }
  }, [initialized, status]);
  const execute = async (action: 'configure' | 'test') => {
    if (busy) return;
    const bridge = window.sewNative;
    if (!bridge) { setError('请在桌面应用中配置与测试模型连接。'); return; }
    setBusy(true); setError(null); setMessage(null);
    try {
      if (action === 'configure') {
        const parsed = modelConnectionInputSchema.safeParse({ provider: 'openai-compatible', baseUrl, model, apiKey });
        if (!parsed.success) { setError('请填写有效的 HTTPS API 地址、模型名称和密钥。'); return; }
        await bridge.configureModel(parsed.data);
        setApiKey('');
        const current = await refresh();
        setMessage(current?.persisted ? '模型配置已加密保存；点击测试连接发起真实请求。' : '当前系统加密不可用，密钥仅在本次应用会话内保存。');
      } else {
        const result = modelTestResultSchema.parse(await bridge.testModel());
        if (result.ok) setMessage(result.message); else setError(result.message);
        await refresh();
      }
      window.dispatchEvent(new Event(CHANGE_EVENT));
    } catch { setError('模型配置或测试失败，请检查本地服务后重试。'); }
    finally { setBusy(false); }
  };
  return <div className="card">
    <h2>模型连接</h2>
    <p className="secondary">密钥由桌面应用加密保管，不回显、不进入项目备份。连接测试仅发送简短诊断，不发送材料；课程生成和教师运行仍须完成后续开发与来源审核。</p>
    <p data-model-status>当前状态：{statusLabel(status)}</p>
    {status?.configured ? <p className="muted">{status.baseUrl} · {status.persisted ? '加密保存' : '仅本次会话'}{status.lastTest?.returnedModel ? ` · 服务返回：${status.lastTest.returnedModel}` : ''}</p> : null}
    <div className="field"><label htmlFor="model-base-url">API 地址（包含 /v1）</label><input id="model-base-url" type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} disabled={busy} /></div>
    <div className="field"><label htmlFor="model-name">模型名称</label><input id="model-name" value={model} onChange={event => setModel(event.target.value)} disabled={busy} /></div>
    <div className="field"><label htmlFor="model-api-key">API 密钥（写入后不回显）</label><input id="model-api-key" type="password" autoComplete="off" value={apiKey} onChange={event => setApiKey(event.target.value)} disabled={busy} placeholder={status?.configured ? '重新配置时填写密钥' : '填写密钥'} /></div>
    <div className="row-inline">
      <button type="button" className="btn btn-primary" data-model-configure disabled={busy || !initialized} onClick={() => void execute('configure')}>保存模型配置</button>
      <button type="button" className="btn" data-model-test disabled={busy || !status?.configured} onClick={() => void execute('test')}>{busy ? '处理中…' : '测试真实连接'}</button>
    </div>
    {message ? <Notice tone="verified" role="status">{message}</Notice> : null}
    {error ? <Notice tone="error" role="alert">{error}</Notice> : null}
  </div>;
};
