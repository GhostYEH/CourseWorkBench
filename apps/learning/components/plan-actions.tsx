'use client';

import { Notice } from './ui';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, describeApiError } from '../lib/client';

/** 计划调整在独立预览中展示受影响任务与依据；确认前不进入课程生成。 */
export const PlanActions = ({ projectId, generation }: { projectId: string; generation: number }) => {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: 'generate' | 'confirm') => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const data = await apiFetch<{ version: number; status: string }>('/api/study/plan', {
        method: 'POST',
        body: JSON.stringify({ scope: { projectId, generation }, action }),
      });
      setMessage(
        action === 'generate'
          ? `已生成计划草案 v${data.version}，等待你确认。`
          : `计划 v${data.version} 已确认，可据此生成正式课程。`,
      );
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>计划操作</h2>
      <p className="secondary">
        计划只引用已准入的知识点；缺材料的项进入「材料缺口与待核范围」，不能显示为可开始学习。
        调整保留已完成任务，并记录调整前后版本与触发依据。
      </p>
      <div className="row-inline">
        <button type="button" className="btn" onClick={() => run('generate')} disabled={busy}>
          生成计划草案
        </button>
        <button type="button" className="btn btn-primary" onClick={() => run('confirm')} disabled={busy}>
          确认计划
        </button>
      </div>
      {message ? (
        <Notice tone="verified" style={{ marginTop: 'var(--sew-space-3)' }}>
          {message}
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="pending" style={{ marginTop: 'var(--sew-space-3)' }}>
          {error}
        </Notice>
      ) : null}
    </div>
  );
};
