'use client';

import { apiResponses } from '@sew/study-contracts';

import { Notice } from './ui';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, describeApiError } from '../lib/client';

/** 计划的生成与整版确认。逐条任务确认在 PlanTasks 里完成。 */
export const PlanActions = ({
  projectId,
  generation,
  status,
  confirmedTaskCount,
}: {
  projectId: string;
  generation: number;
  /** 最近一版计划的状态：已确认版本不能再被整版确认覆盖。 */
  status: 'draft' | 'confirmed' | null;
  confirmedTaskCount: number;
}) => {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: 'generate' | 'confirm') => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const data = await apiFetch('/api/study/plan', apiResponses.planWrite, {
        method: 'POST',
        body: JSON.stringify({ scope: { projectId, generation }, action }),
      });
      setMessage(
        action === 'generate'
          ? `已生成计划草案 v${data.version}。请逐条确认任务后再确认整版计划。`
          : `计划 v${data.version} 已确认；未逐条确认的任务已转入待核范围。`,
      );
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  const canConfirm = status === 'draft' && confirmedTaskCount > 0;

  return (
    <div className="card">
      <h2>计划操作</h2>
      <p className="secondary">
        计划只引用已准入的知识点；缺材料的项进入「材料缺口与待核范围」，不能显示为可开始学习。
        重新生成会得到新的草案版本，逐条确认结果不会自动沿用到新版本。
      </p>
      <div className="row-inline">
        <button type="button" className="btn" onClick={() => run('generate')} disabled={busy}>
          生成计划草案
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => run('confirm')}
          disabled={busy || !canConfirm}
          title={
            status === 'confirmed'
              ? '当前版本已确认；需要调整请先生成新草案'
              : confirmedTaskCount === 0
                ? '还没有逐条确认的任务，不能确认整版计划'
                : '把已确认的任务固化为正式计划版本'
          }
        >
          确认整版计划
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
