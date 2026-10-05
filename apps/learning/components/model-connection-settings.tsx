'use client';
import { modelConnectionInputSchema, type ModelConnectionStatus } from '@sew/study-contracts';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getSessionToken, subscribeSessionToken } from '../lib/client';
import { MODEL_CONNECTION_CHANGED, useModelStatus } from '../lib/model-connection-status';
import { runModelConnectionCommand } from '../lib/model-connection-command';
import { useCommand } from '../lib/use-command';
import { Notice } from './ui';

const statusLabel = (status: ModelConnectionStatus | null) =>
  !status
    ? '读取中…'
    : !status.configured
      ? '未配置'
      : status.lastTest?.ok
        ? `已连接 · ${status.model}`
        : status.lastTest
          ? `测试失败 · ${status.model}`
          : `已配置，尚未测试 · ${status.model}`;

export const ModelConnectionIndicator = () => {
  const { status, error, refreshing, refresh } = useModelStatus();
  return (
    <span>
      模型连接：{error ? '读取失败' : statusLabel(status)}
      {error ? (
        <button
          type="button"
          className="btn"
          disabled={refreshing}
          title={error}
          onClick={() => void refresh().catch(() => undefined)}
        >
          重试
        </button>
      ) : null}
    </span>
  );
};

const ModelConnectionForm = ({
  status,
  refresh,
}: {
  status: ModelConnectionStatus;
  refresh: () => Promise<ModelConnectionStatus | undefined>;
}) => {
  const [baseUrl, setBaseUrl] = useState(status.baseUrl ?? '');
  const [model, setModel] = useState(status.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const token = useSyncExternalStore(subscribeSessionToken, getSessionToken, () => null);
  const command = useCommand(`model-connection:${token ?? ''}`);
  const { busy, error, setError } = command;
  const [message, setMessage] = useState<{ text: string; tone: 'pending' | 'verified' } | null>(
    null,
  );
  useEffect(() => {
    setBaseUrl(status.baseUrl ?? '');
    setModel(status.model ?? '');
    setApiKey('');
  }, [status.baseUrl, status.model]);
  const execute = async (action: 'configure' | 'test') => {
    await command.run(
      async ({ isCurrent }) => {
        const bridge = window.sewNative;
        if (!bridge) throw new Error('请在桌面应用中配置与测试模型连接。');
        if (action === 'configure') {
          const parsed = modelConnectionInputSchema.safeParse({
            provider: 'openai-compatible',
            baseUrl,
            model,
            apiKey,
          });
          if (!parsed.success) throw new Error('请填写有效的 HTTPS API 地址、模型名称和密钥。');
          return runModelConnectionCommand(
            { action: 'configure', bridge, input: parsed.data },
            { refresh, isCurrent },
          );
        }
        return runModelConnectionCommand({ action: 'test', bridge }, { refresh, isCurrent });
      },
      {
        onStart: () => setMessage(null),
        onError: () => setError('模型配置或测试失败，请检查填写内容、本地服务和连接状态后重试。'),
        onSuccess: (receipt) => {
          if (!receipt) return;
          const statusRefreshed =
            receipt.action === 'configure' ? receipt.status !== null : receipt.statusRefreshed;
          if (receipt.action === 'configure') {
            setApiKey('');
            if (!receipt.status) {
              setMessage({
                text: '配置已提交，但状态读取失败，暂时无法确认是否已加密保存。密钥输入已清空；请重新读取模型连接状态确认结果。',
                tone: 'pending',
              });
            } else if (receipt.status.persisted) {
              setMessage({
                text: '模型配置已加密保存；点击测试连接发起真实请求。',
                tone: 'verified',
              });
            } else {
              setMessage({
                text: '当前系统加密不可用，密钥仅在本次应用会话内保存。',
                tone: 'verified',
              });
            }
          } else {
            const readFailure = statusRefreshed
              ? ''
              : ' 状态读取失败；请仅重新读取模型连接状态，无需重复连接测试。';
            if (receipt.diagnostic.ok) {
              setMessage({
                text: `${receipt.diagnostic.message}${readFailure}`,
                tone: statusRefreshed ? 'verified' : 'pending',
              });
            } else {
              setError(`${receipt.diagnostic.message}${readFailure}`);
            }
          }
          if (statusRefreshed) window.dispatchEvent(new Event(MODEL_CONNECTION_CHANGED));
        },
      },
    );
  };
  return (
    <div className="card">
      <h2>模型连接</h2>
      <p className="secondary">
        密钥由桌面应用加密保管，不回显、不进入项目备份。连接测试仅发送简短诊断，不发送材料；课程生成与教师运行须通过来源、审核和预算检查。
      </p>
      <p data-model-status>当前状态：{statusLabel(status)}</p>
      {status?.configured ? (
        <p className="muted">
          {status.baseUrl} · {status.persisted ? '加密保存' : '仅本次会话'}
          {status.lastTest?.returnedModel ? ` · 服务返回：${status.lastTest.returnedModel}` : ''}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="model-base-url">API 地址（包含 /v1）</label>
        <input
          id="model-base-url"
          type="url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          disabled={busy}
        />
      </div>
      <div className="field">
        <label htmlFor="model-name">模型名称</label>
        <input
          id="model-name"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          disabled={busy}
        />
      </div>
      <div className="field">
        <label htmlFor="model-api-key">API 密钥（写入后不回显）</label>
        <input
          id="model-api-key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          disabled={busy}
          placeholder={status?.configured ? '重新配置时填写密钥' : '填写密钥'}
        />
      </div>
      <div className="row-inline">
        <button
          type="button"
          className="btn btn-primary"
          data-model-configure
          disabled={busy}
          onClick={() => void execute('configure')}
        >
          保存模型配置
        </button>
        <button
          type="button"
          className="btn"
          data-model-test
          disabled={busy || !status?.configured}
          onClick={() => void execute('test')}
        >
          {busy ? '处理中…' : '测试真实连接'}
        </button>
      </div>
      {message ? (
        <Notice tone={message.tone} role="status">
          {message.text}
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="error" role="alert">
          {error}
        </Notice>
      ) : null}
    </div>
  );
};

export const ModelConnectionSettings = () => {
  const { status, error, refreshing, refresh } = useModelStatus();
  return (
    <>
      {error ? (
        <Notice tone="error" role="alert">
          模型连接状态读取失败：{error}{' '}
          <button
            type="button"
            className="btn"
            disabled={refreshing}
            onClick={() => void refresh().catch(() => undefined)}
          >
            重新读取
          </button>
        </Notice>
      ) : null}
      {status ? (
        <ModelConnectionForm status={status} refresh={refresh} />
      ) : !error ? (
        <div className="card" role="status">
          正在读取模型连接配置…
        </div>
      ) : null}
    </>
  );
};
