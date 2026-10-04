'use client';

/**
 * 四层恢复面板（RESUME-01）。
 *
 * 恢复核对的结论完全由服务端给出：这一层不自行判断「应该没事」，
 * 只按 `resumable` 决定是否给出继续上课的提示。`blocked` 必须显式展示，
 * 不能折叠成一句「加载失败」。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  apiResponses,
  RECOVERY_LAYER_LABEL,
  type RecoveryCheckpointDto,
  type RecoveryStatus,
} from '@sew/study-contracts';
import { Empty, Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';

const STATUS_TONE: Record<RecoveryStatus, 'verified' | 'pending' | 'info' | 'error'> = {
  restored: 'verified',
  waiting: 'pending',
  reset: 'info',
  blocked: 'error',
};

const STATUS_LABEL: Record<RecoveryStatus, string> = {
  restored: '✓ 已恢复',
  waiting: '✎ 保持等待',
  reset: '↺ 已重置临时现场',
  blocked: '✕ 已阻断',
};

export const ClassroomRecoveryPanel = ({
  projectId,
  generation,
  sessionId,
  onCheckpoint,
}: {
  projectId: string;
  generation: number;
  sessionId: string;
  onCheckpoint?: (checkpoint: RecoveryCheckpointDto | null) => void;
}): ReactNode => {
  const callback = useRef(onCheckpoint);
  callback.current = onCheckpoint;
  const requestVersion = useRef(0);
  const [checkpoint, setCheckpoint] = useState<RecoveryCheckpointDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async (): Promise<void> => {
    const version = ++requestVersion.current;
    callback.current?.(null);
    setCheckpoint(null);
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch(
        `/api/study/recovery?projectId=${encodeURIComponent(projectId)}&generation=${generation}&sessionId=${encodeURIComponent(sessionId)}`,
        apiResponses.recovery,
      );
      if (version !== requestVersion.current) return;
      setCheckpoint(result.checkpoint);
      callback.current?.(result.checkpoint);
    } catch (caught) {
      if (version !== requestVersion.current) return;
      setError(describeApiError(caught));
      callback.current?.(null);
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  }, [projectId, generation, sessionId]);

  useEffect(() => {
    void check();
    return () => { requestVersion.current += 1; };
  }, [check]);

  return (
    <div className="card card-nested" data-classroom-recovery>
      <h3>恢复核对</h3>
      <p className="secondary">
        核对文档、白板、本人作答与互动四层。核对本身只读：不会重新生成内容，
        也不会重放白板动作、消息或提交。
      </p>
      <button type="button" className="btn" disabled={busy} onClick={() => void check()}>
        {busy ? '正在核对…' : '重新核对'}
      </button>
      {error ? <Notice tone="error" style={{ marginTop: 'var(--sew-space-2)' }}>{error}</Notice> : null}
      {!checkpoint ? (
        busy ? null : <Empty>还没有恢复核对结果。</Empty>
      ) : (
        <>
          <Notice tone={checkpoint.continuation === 'blocked' ? 'error' : checkpoint.continuation === 'continue' ? 'verified' : 'pending'} style={{ marginTop: 'var(--sew-space-2)' }}>
            {checkpoint.continuation === 'continue' ? '四层核对通过，可以继续这节课。'
              : checkpoint.continuation === 'waiting' ? '已恢复等待本人作答；不会自动续课。'
              : checkpoint.continuation === 'terminal' ? '本次课堂已完成或已取消，保留历史，不再续课。'
              : '有图层被阻断：先处理阻断原因，再继续这节课。'}
          </Notice>
          <ul className="check-list" style={{ marginTop: 'var(--sew-space-2)' }}>
            {checkpoint.layers.map((item) => (
              <li key={item.layer}>
                <span>
                  <span className="pill" data-tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</span>
                  {' '}{RECOVERY_LAYER_LABEL[item.layer]}：{item.message}
                </span>
                <span className="muted mono">
                  保留 {item.preserved} · 丢弃 {item.discarded} · 外部调用 {item.providerCalls}
                </span>
              </li>
            ))}
          </ul>
          <p className="hint mono">核对时间 {checkpoint.checkedAt}</p>
        </>
      )}
    </div>
  );
};
