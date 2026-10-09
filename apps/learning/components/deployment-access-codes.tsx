'use client';

/**
 * 共享部署访问码管理（OMA-083）。
 *
 * 只在本机同源页面使用：签发返回**一次性**明文访问码，读取永不回显 secret 或哈希。
 * 访问码只授予接入能力（join/guest），不代替本人凭据认证；私密项目默认不公开。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  deploymentAccessCodeViewSchema,
  DEPLOYMENT_ACCESS_SCOPES,
  type DeploymentAccessScope,
} from '@sew/study-contracts';
import { Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';

type Scope = { projectId: string; generation: number };
type CodeRow = {
  codeId: string;
  label: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  usedCount: number;
};
const newRequestId = () => `dep-code-${crypto.randomUUID()}`;

export const DeploymentAccessCodes = ({ scope }: { scope: Scope }) => {
  const [codes, setCodes] = useState<CodeRow[]>([]);
  const [issued, setIssued] = useState<{ secret: string; label: string } | null>(null);
  const [label, setLabel] = useState('外部成员接入');
  const [scopes, setScopes] = useState<DeploymentAccessScope[]>(['join']);
  const [ttlDays, setTtlDays] = useState(7);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const { projectId, generation } = scope;
  const refresh = useCallback(async () => {
    const data = await apiFetch('/api/study/deployment/access-codes', deploymentAccessCodeViewSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list' }),
    });
    setCodes(data.codes);
  }, []);

  useEffect(() => {
    void refresh().catch((cause) => setError(describeApiError(cause)));
  }, [refresh]);

  const run = async (action: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const data = await apiFetch('/api/study/deployment/access-codes', deploymentAccessCodeViewSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: newRequestId(), ...action }),
      });
      if (data.issued) setIssued({ secret: data.issued.secret, label: data.issued.code.label });
      await refresh();
    } catch (cause) {
      setError(describeApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>共享部署访问码（OMA-083）</h2>
      <p className="muted">
        访问码让外部成员以 <code>join</code>/<code>guest</code> 接入本部署，绑定当前项目并带有效期；
        数据库只保存哈希，明文仅在签发时显示一次。访问码**不**代替本人凭据认证；私密项目默认不公开，
        没有有效访问码时不开放接入。
      </p>
      <p className="muted mono">
        project {projectId} · generation {generation}
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
            max={90}
            value={ttlDays}
            onChange={(event) => setTtlDays(Number(event.target.value))}
          />
        </label>
        {DEPLOYMENT_ACCESS_SCOPES.map((item) => (
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
          data-deployment-code-issue
          onClick={() => void run({ action: 'issue', label, scopes, ttlDays })}
        >
          签发访问码
        </button>
      </div>
      {issued ? (
        <Notice tone="verified">
          新访问码（仅此一次显示，请立即保存）：
          <code data-deployment-code-secret>{issued.secret}</code>
          <button type="button" className="btn" onClick={() => setIssued(null)}>
            我已保存
          </button>
        </Notice>
      ) : null}
      <ul className="check-list">
        {codes.map((code) => (
          <li key={code.codeId} data-deployment-code={code.codeId}>
            <span className="pill">{code.label}</span> {code.scopes.join('/')} · 到期{' '}
            <span className="mono">{code.expiresAt.slice(0, 10)}</span> · 已用 {code.usedCount} 次
            {code.revokedAt ? <span className="muted"> · 已撤销</span> : null}
            <button
              type="button"
              className="btn"
              disabled={busy || code.revokedAt !== null}
              data-deployment-code-revoke={code.codeId}
              onClick={() => void run({ action: 'revoke', codeId: code.codeId })}
            >
              撤销
            </button>
          </li>
        ))}
        {codes.length === 0 ? <li className="muted">还没有访问码；私密项目默认不对外开放。</li> : null}
      </ul>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </section>
  );
};
