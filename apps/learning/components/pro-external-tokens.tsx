'use client';

/**
 * Pro 外部任务 token 管理（OMA-017）。
 *
 * 只在本机同源页面使用：创建/轮换返回**一次性**明文 token，读取永不回显 secret 或哈希。
 * 外部调用者用 `Authorization: Bearer sewpro_...` 访问精确路径 `/api/pro/external`。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  proExternalTokensViewSchema,
  PRO_EXTERNAL_SCOPES,
  type ProExternalScope,
} from '@sew/study-contracts';
import { Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';

type Scope = { projectId: string; generation: number };
type TokenRow = {
  tokenId: string;
  label: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};
const newRequestId = () => `pro-token-${crypto.randomUUID()}`;

export const ProExternalTokens = ({ scope }: { scope: Scope }) => {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [issued, setIssued] = useState<{ secret: string; label: string } | null>(null);
  const [label, setLabel] = useState('外部任务');
  const [scopes, setScopes] = useState<ProExternalScope[]>(['read', 'create', 'send']);
  const [ttlDays, setTtlDays] = useState(30);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const { projectId, generation } = scope;
  const refresh = useCallback(async () => {
    const data = await apiFetch('/api/study/pro/tokens', proExternalTokensViewSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: { projectId, generation }, action: 'list' }),
    });
    setTokens(data.tokens);
  }, [projectId, generation]);

  useEffect(() => {
    void refresh().catch((cause) => setError(describeApiError(cause)));
  }, [refresh]);

  const run = async (action: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const data = await apiFetch('/api/study/pro/tokens', proExternalTokensViewSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope, requestId: newRequestId(), ...action }),
      });
      if (data.issued) setIssued({ secret: data.issued.secret, label: data.issued.token.label });
      await refresh();
    } catch (cause) {
      setError(describeApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>外部任务 token（OMA-017）</h2>
      <p className="muted">
        token 绑定本人与当前项目，携带有效期与最小 scope（read/create/send）。数据库只保存哈希，
        明文仅在创建/轮换时显示一次。外部调用者用 <code>Authorization: Bearer sewpro_…</code>{' '}
        访问 <code>/api/pro/external</code>。项目 ID 不是凭据；token 才有权。
      </p>
      <div className="row-inline">
        <label>
          标签
          <input value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label>
          有效期（天）
          <input
            type="number"
            min={1}
            max={365}
            value={ttlDays}
            onChange={(event) => setTtlDays(Number(event.target.value))}
          />
        </label>
        {PRO_EXTERNAL_SCOPES.map((item) => (
          <label key={item}>
            <input
              type="checkbox"
              checked={scopes.includes(item)}
              onChange={(event) =>
                setScopes((current) =>
                  event.target.checked
                    ? [...new Set([...current, item])]
                    : current.filter((value) => value !== item),
                )
              }
            />
            {item}
          </label>
        ))}
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || scopes.length === 0 || label.trim().length === 0}
          data-pro-token-create
          onClick={() => void run({ action: 'create', label, scopes, ttlDays })}
        >
          创建 token
        </button>
      </div>
      {issued ? (
        <Notice tone="verified">
          新 token（仅此一次显示，请立即保存）：<code data-pro-token-secret>{issued.secret}</code>
          <button type="button" className="btn" onClick={() => setIssued(null)}>
            我已保存
          </button>
        </Notice>
      ) : null}
      <ul className="check-list">
        {tokens.map((token) => (
          <li key={token.tokenId} data-pro-token={token.tokenId}>
            <span className="pill">{token.label}</span> {token.scopes.join('/')} · 到期{' '}
            <span className="mono">{token.expiresAt.slice(0, 10)}</span>
            {token.revokedAt ? <span className="muted"> · 已撤销</span> : null}
            <button
              type="button"
              className="btn"
              disabled={busy || token.revokedAt !== null}
              onClick={() => void run({ action: 'rotate', tokenId: token.tokenId, ttlDays })}
            >
              轮换
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || token.revokedAt !== null}
              onClick={() => void run({ action: 'revoke', tokenId: token.tokenId })}
            >
              撤销
            </button>
          </li>
        ))}
        {tokens.length === 0 ? <li className="muted">还没有外部 token。</li> : null}
      </ul>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </section>
  );
};
