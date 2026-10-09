'use client';
import {
  modelConnectionInputSchema,
  modelDiscoveryResultSchema,
  MODEL_PROVIDER_IDS,
  type ModelConnectionStatus,
} from '@sew/study-contracts';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { apiFetch, getSessionToken, subscribeSessionToken } from '../lib/client';
import { getProviderDefinition } from '../lib/provider-registry';
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
        ? `已连接 · ${status.provider ?? '模型'} · ${status.model}`
        : status.lastTest
          ? `测试失败 · ${status.provider ?? '模型'} · ${status.model}`
          : `已配置，尚未测试 · ${status.provider ?? '模型'} · ${status.model}`;

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
  const [provider, setProvider] = useState(status.provider ?? 'openai-compatible');
  const [apiKey, setApiKey] = useState('');
  const [apiVersion, setApiVersion] = useState(status.apiVersion ?? '2024-10-21');
  const [region, setRegion] = useState(status.region ?? 'us-east-1');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [thinkingEnabled, setThinkingEnabled] = useState<'default' | 'on' | 'off'>(
    status.thinking?.enabled === undefined ? 'default' : status.thinking.enabled ? 'on' : 'off',
  );
  const [thinkingEffort, setThinkingEffort] = useState(status.thinking?.effort ?? '');
  const [thinkingBudget, setThinkingBudget] = useState(
    status.thinking?.budgetTokens === undefined ? '' : String(status.thinking.budgetTokens),
  );
  const [routeModels, setRouteModels] = useState<Record<string, string>>(status.routeModels ?? {});
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [discoveryMessage, setDiscoveryMessage] = useState('');
  const token = useSyncExternalStore(subscribeSessionToken, getSessionToken, () => null);
  const command = useCommand(`model-connection:${token ?? ''}`);
  const { busy, error, setError } = command;
  const [message, setMessage] = useState<{ text: string; tone: 'pending' | 'verified' } | null>(
    null,
  );
  useEffect(() => {
    setBaseUrl(status.baseUrl ?? '');
    setModel(status.model ?? '');
    setProvider(status.provider ?? 'openai-compatible');
    setApiVersion(status.apiVersion ?? '2024-10-21');
    setRegion(status.region ?? 'us-east-1');
    setRouteModels(status.routeModels ?? {});
    setThinkingEnabled(
      status.thinking?.enabled === undefined ? 'default' : status.thinking.enabled ? 'on' : 'off',
    );
    setThinkingEffort(status.thinking?.effort ?? '');
    setThinkingBudget(
      status.thinking?.budgetTokens === undefined ? '' : String(status.thinking.budgetTokens),
    );
    setApiKey('');
    setAccessKeyId('');
    setSecretAccessKey('');
    setSessionToken('');
    setDiscoveredModels([]);
    setDiscoveryMessage('');
  }, [
    status.baseUrl,
    status.model,
    status.provider,
    status.apiVersion,
    status.region,
    status.routeModels,
    status.thinking,
  ]);
  const providerDefinition = getProviderDefinition(provider);
  const setProviderValue = (nextProvider: string) => {
    const next = getProviderDefinition(nextProvider);
    setProvider(nextProvider);
    setBaseUrl(next.defaultBaseUrl ?? '');
    setModel(next.defaultModel);
    setApiKey('');
    setAccessKeyId('');
    setSecretAccessKey('');
    setSessionToken('');
    setRouteModels({});
    setDiscoveredModels([]);
    setDiscoveryMessage('');
  };
  const discoverModels = async () => {
    const controller = new AbortController();
    setDiscoveryBusy(true);
    setDiscoveryMessage('');
    try {
      const result = await apiFetch('/api/study/models/discover', modelDiscoveryResultSchema, {
        method: 'POST',
        signal: controller.signal,
      });
      setDiscoveredModels(result.models);
      setDiscoveryMessage(result.message);
    } catch {
      setDiscoveryMessage('读取模型列表失败，请检查连接配置和服务权限。');
    } finally {
      setDiscoveryBusy(false);
    }
  };
  const execute = async (action: 'configure' | 'test') => {
    await command.run(
      async ({ isCurrent }) => {
        const bridge = window.sewNative;
        if (!bridge) throw new Error('请在桌面应用中配置与测试模型连接。');
        if (action === 'configure') {
          const parsed = modelConnectionInputSchema.safeParse({
            provider,
            ...(baseUrl.trim() ? { baseUrl } : {}),
            model,
            ...(apiKey.trim() ? { apiKey } : {}),
            ...(provider === 'azure' ? { apiVersion } : {}),
            ...(provider === 'bedrock'
              ? {
                  region,
                  ...(accessKeyId.trim() ? { accessKeyId } : {}),
                  ...(secretAccessKey.trim() ? { secretAccessKey } : {}),
                  ...(sessionToken.trim() ? { sessionToken } : {}),
                }
              : {}),
            ...(Object.values(routeModels).some((value) => value.trim())
              ? {
                  routeModels: Object.fromEntries(
                    Object.entries(routeModels).filter(([, value]) => value.trim()),
                  ),
                }
              : {}),
            ...(thinkingEnabled !== 'default' || thinkingEffort || thinkingBudget.trim()
              ? {
                  thinking: {
                    ...(thinkingEnabled !== 'default' ? { enabled: thinkingEnabled === 'on' } : {}),
                    ...(thinkingEffort ? { effort: thinkingEffort } : {}),
                    ...(thinkingBudget.trim() ? { budgetTokens: Number(thinkingBudget) } : {}),
                  },
                }
              : {}),
          });
          if (!parsed.success) throw new Error('请核对服务地址、模型、协议所需密钥与区域设置。');
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
        <label htmlFor="model-provider">模型服务协议</label>
        <select
          id="model-provider"
          value={provider}
          onChange={(event) => setProviderValue(event.target.value)}
          disabled={busy}
        >
          {MODEL_PROVIDER_IDS.map((providerId) => (
            <option key={providerId} value={providerId}>
              {getProviderDefinition(providerId).label}
            </option>
          ))}
        </select>
      </div>
      {provider !== 'bedrock' ? (
        <div className="field">
          <label htmlFor="model-base-url">API 地址</label>
          <input
            id="model-base-url"
            type="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            disabled={busy}
            placeholder={
              providerDefinition.defaultBaseUrl ?? 'https://resource.openai.azure.com/openai'
            }
          />
          <small className="muted">远端使用 HTTPS；HTTP 仅允许 localhost、127.0.0.1 或 ::1。</small>
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="model-name">模型名称</label>
        <input
          id="model-name"
          list="model-catalog"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          disabled={busy}
        />
        <datalist id="model-catalog">
          {[...providerDefinition.models.map((item) => item.id), ...discoveredModels]
            .filter((item, index, all) => all.indexOf(item) === index)
            .map((item) => (
              <option key={item} value={item} />
            ))}
        </datalist>
      </div>
      <div className="field">
        <label htmlFor="model-api-key">
          {providerDefinition.requiresApiKey ? 'API 密钥' : 'API 密钥（可选）'}（写入后不回显）
        </label>
        <input
          id="model-api-key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          disabled={busy}
          placeholder={
            status?.configured
              ? '重新配置时填写密钥'
              : providerDefinition.requiresApiKey
                ? '填写密钥'
                : '本地服务可留空'
          }
        />
      </div>
      {provider === 'azure' ? (
        <div className="field">
          <label htmlFor="model-api-version">Azure API version</label>
          <input
            id="model-api-version"
            value={apiVersion}
            onChange={(event) => setApiVersion(event.target.value)}
            disabled={busy}
          />
        </div>
      ) : null}
      {provider === 'bedrock' ? (
        <>
          <div className="field">
            <label htmlFor="model-region">AWS region</label>
            <input
              id="model-region"
              value={region}
              onChange={(event) => setRegion(event.target.value)}
              disabled={busy}
              placeholder="us-east-1"
            />
          </div>
          <div className="field">
            <label htmlFor="model-access-key">AWS Access Key ID（可选）</label>
            <input
              id="model-access-key"
              autoComplete="off"
              value={accessKeyId}
              onChange={(event) => setAccessKeyId(event.target.value)}
              disabled={busy}
            />
          </div>
          <div className="field">
            <label htmlFor="model-secret-key">AWS Secret Access Key（写入后不回显）</label>
            <input
              id="model-secret-key"
              type="password"
              autoComplete="off"
              value={secretAccessKey}
              onChange={(event) => setSecretAccessKey(event.target.value)}
              disabled={busy}
            />
          </div>
          <div className="field">
            <label htmlFor="model-session-token">AWS Session Token（可选）</label>
            <input
              id="model-session-token"
              type="password"
              autoComplete="off"
              value={sessionToken}
              onChange={(event) => setSessionToken(event.target.value)}
              disabled={busy}
            />
          </div>
          <p className="muted">
            可用 Bedrock API key、成对的 AWS access/secret key，或应用进程的 AWS credential
            chain。输入凭据只会进入桌面加密凭据存储。
          </p>
        </>
      ) : null}
      <details>
        <summary>阶段模型路由与推理设置</summary>
        <p className="muted">route 仅切换当前 provider 下的 model/deployment，不切换凭据或协议。</p>
        {(
          [
            ['lesson-draft', '课程草案'],
            ['courseware', '课件生成'],
            ['teaching', '课堂讲解'],
            ['feedback', '反馈建议'],
            ['grading', '作答评分'],
            ['pbl', 'PBL导师'],
            ['pro-chat', '专业对话'],
            ['media', '媒体任务'],
          ] as const
        ).map(([route, label]) => (
          <div className="field" key={route}>
            <label htmlFor={`model-route-${route}`}>{label}模型（留空使用默认模型）</label>
            <input
              id={`model-route-${route}`}
              list="model-catalog"
              value={routeModels[route] ?? ''}
              onChange={(event) =>
                setRouteModels((current) => ({ ...current, [route]: event.target.value }))
              }
              disabled={busy}
            />
          </div>
        ))}
        <div className="field">
          <label htmlFor="model-thinking-enabled">推理模式</label>
          <select
            id="model-thinking-enabled"
            value={thinkingEnabled}
            onChange={(event) => setThinkingEnabled(event.target.value as 'default' | 'on' | 'off')}
            disabled={busy}
          >
            <option value="default">遵循模型默认</option>
            <option value="on">启用（服务商支持时）</option>
            <option value="off">关闭（服务商支持时）</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="model-thinking-effort">推理强度（支持的接口会映射）</label>
          <select
            id="model-thinking-effort"
            value={thinkingEffort}
            onChange={(event) => setThinkingEffort(event.target.value as typeof thinkingEffort)}
            disabled={busy}
          >
            <option value="">使用服务商默认</option>
            {['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="model-thinking-budget">推理预算 tokens</label>
          <input
            id="model-thinking-budget"
            type="number"
            min={0}
            max={100000}
            step={256}
            value={thinkingBudget}
            onChange={(event) => setThinkingBudget(event.target.value)}
            disabled={busy}
          />
        </div>
      </details>
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
        <button
          type="button"
          className="btn"
          data-model-discover
          disabled={busy || discoveryBusy || !status.configured}
          onClick={() => void discoverModels()}
        >
          {discoveryBusy ? '正在读取…' : '发现模型'}
        </button>
      </div>
      {discoveryMessage ? (
        <p className="muted" role="status">
          {discoveryMessage}
        </p>
      ) : null}
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
