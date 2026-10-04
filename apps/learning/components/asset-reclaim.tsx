'use client';

import { apiResponses } from '@sew/study-contracts';

/**
 * 课堂资源回收面板。
 *
 * 候选只来自服务的报告，回收是显式动作：页面读取不删除任何资源。
 * 服务会重新确认绑定状态，因此报告过期时最坏结果是整批取消，而不是删掉在用资源。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { AssetReclaimReportDto } from '@sew/study-contracts';
import { apiFetch, describeApiError } from '../lib/client';
import { Empty, Notice } from './ui';

const formatBytes = (value: number): string =>
  value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : `${Math.round(value / 1024)} KiB`;

export const AssetReclaim = ({ projectId, generation }: { projectId: string; generation: number }): ReactNode => {
  const router = useRouter();
  const [report, setReport] = useState<AssetReclaimReportDto | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await apiFetch('/api/study/assets', apiResponses.assetReport);
      setReport(next);
      setSelected([]);
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  const reclaim = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await apiFetch('/api/study/assets', apiResponses.assetReclaim,
        {
          method: 'POST',
          body: JSON.stringify({ scope: { projectId, generation }, assetIds: selected }),
        },
      );
      setMessage(`已回收 ${result.reclaimed.length} 项资源，释放 ${formatBytes(result.freedBytes)}；剩余候选 ${result.remainingUnbound} 项。`);
      setReport((current) =>
        current === null
          ? current
          : { ...current, unbound: current.unbound.filter((asset) => !result.reclaimed.includes(asset.assetId)) },
      );
      setSelected([]);
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>课堂资源回收</h2>
      <p className="secondary">
        只列出没有被任何课件绑定的资源。被引用的资源不会出现在候选里，也不能被替换或删除；
        打开页面本身不删除数据，回收需要显式选择并确认。
      </p>
      <div className="row-inline">
        <button type="button" className="btn" onClick={load} disabled={busy}>
          读取可回收候选
        </button>
      </div>
      {report === null ? (
        <p className="hint">尚未读取报告。</p>
      ) : (
        <>
          <p className="muted mono">
            项目资源占用 {formatBytes(report.usedBytes)} / {formatBytes(report.limitBytes)} ·
            {' '}候选 {report.unbound.length} 项 · 可释放 {formatBytes(report.unboundBytes)}
          </p>
          {report.unbound.length === 0 ? (
            <Empty>没有未绑定的资源。</Empty>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {report.unbound.map((asset) => (
                <li key={asset.assetId} style={{ marginBottom: 'var(--sew-space-2)' }}>
                  <label className="secondary" style={{ display: 'flex', gap: 'var(--sew-space-2)', alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={selected.includes(asset.assetId)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked ? [...current, asset.assetId] : current.filter((id) => id !== asset.assetId),
                        )
                      }
                      disabled={busy}
                    />
                    <span className="mono">{asset.assetId}</span> · {asset.mediaType} · r{asset.revision} ·{' '}
                    {formatBytes(asset.byteLength)} · 摘要 {asset.sha256.slice(0, 12)}…
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="row-inline" style={{ marginTop: 'var(--sew-space-3)' }}>
            <button
              type="button"
              className="btn btn-danger"
              onClick={reclaim}
              disabled={busy || selected.length === 0}
              title={selected.length === 0 ? '请先勾选要回收的资源' : '删除选中的未绑定资源'}
            >
              回收选中的 {selected.length} 项
            </button>
          </div>
        </>
      )}
      {message ? <Notice tone="verified">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
};
