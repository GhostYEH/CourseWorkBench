'use client';
import {
modelConnectionInputSchema,
modelTestResultSchema,
type ModelConnectionStatus
} from '@sew/study-contracts';
import { useState } from 'react';
import { MODEL_CONNECTION_CHANGED,useModelStatus } from '../lib/model-connection-status';
import { Notice } from './ui';

const statusLabel = (status: ModelConnectionStatus | null) => !status ? '读取中…'
  : !status.configured ? '未配置' : status.lastTest?.ok ? `已连接 · ${status.model}`
  : status.lastTest ? `测试失败 · ${status.model}` : `已配置，尚未测试 · ${status.model}`;

export const ModelConnectionIndicator = () => {
  const { status } = useModelStatus();
  return <span>模型连接：{statusLabel(status)}</span>;
};

const ModelConnectionForm = ({ status, refresh }: {
  status: ModelConnectionStatus; refresh: () => Promise<ModelConnectionStatus | undefined>;
}) => {
  const [baseUrl, setBaseUrl] = useState(status.baseUrl ?? '');
  const [model, setModel] = useState(status.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      window.dispatchEvent(new Event(MODEL_CONNECTION_CHANGED));
    } catch { setError('模型配置或测试失败，请检查本地服务后重试。'); }
    finally { setBusy(false); }
  };
  return <div className="card">
    <h2>模型连接</h2>
    <p className="secondary">密钥由桌面应用加密保管，不回显、不进入项目备份。连接测试仅发送简短诊断，不发送材料；课程生成与教师运行须通过来源、审核和预算检查。</p>
    <p data-model-status>当前状态：{statusLabel(status)}</p>
    {status?.configured ? <p className="muted">{status.baseUrl} · {status.persisted ? '加密保存' : '仅本次会话'}{status.lastTest?.returnedModel ? ` · 服务返回：${status.lastTest.returnedModel}` : ''}</p> : null}
    <div className="field"><label htmlFor="model-base-url">API 地址（包含 /v1）</label><input id="model-base-url" type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} disabled={busy} /></div>
    <div className="field"><label htmlFor="model-name">模型名称</label><input id="model-name" value={model} onChange={event => setModel(event.target.value)} disabled={busy} /></div>
    <div className="field"><label htmlFor="model-api-key">API 密钥（写入后不回显）</label><input id="model-api-key" type="password" autoComplete="off" value={apiKey} onChange={event => setApiKey(event.target.value)} disabled={busy} placeholder={status?.configured ? '重新配置时填写密钥' : '填写密钥'} /></div>
    <div className="row-inline">
      <button type="button" className="btn btn-primary" data-model-configure disabled={busy} onClick={() => void execute('configure')}>保存模型配置</button>
      <button type="button" className="btn" data-model-test disabled={busy || !status?.configured} onClick={() => void execute('test')}>{busy ? '处理中…' : '测试真实连接'}</button>
    </div>
    {message ? <Notice tone="verified" role="status">{message}</Notice> : null}
    {error ? <Notice tone="error" role="alert">{error}</Notice> : null}
  </div>;
};

export const ModelConnectionSettings = () => {
  const { status, refresh } = useModelStatus();
  return status ? <ModelConnectionForm status={status} refresh={refresh} />
    : <div className="card" role="status">正在读取模型连接配置…</div>;
};
