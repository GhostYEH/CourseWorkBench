'use client';

/**
 * 计划任务与逐条人工确认（PLAN-01）。
 *
 * 生成的草案里每条任务都要人确认；退回或未确认的任务在整版确认时转入待核范围，
 * 不会作为正式任务进入 run。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { PlanPayloadDto } from '@sew/study-contracts';
import { Empty, Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';

export const PlanTasks = ({
  projectId,
  generation,
  version,
  status,
  payload,
}: {
  projectId: string;
  generation: number;
  version: number;
  status: 'draft' | 'confirmed';
  payload: PlanPayloadDto;
}): ReactNode => {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const decide = async (knowledgeId: string, decision: 'accept' | 'reject'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/study/plan', {
        method: 'POST',
        body: JSON.stringify({ scope: { projectId, generation }, action: 'confirm-task', knowledgeId, decision }),
      });
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>任务列表 · v{version}（{status === 'confirmed' ? '已确认' : '草案'}）</h2>
      <p className="secondary">{payload.basis}</p>
      {payload.tasks.length === 0 ? (
        <Empty>没有可下发的任务。请先完成材料导入与知识点审核，或生成计划草案。</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>知识点</th>
              <th>预计用时</th>
              <th>验收方式</th>
              <th>来源</th>
              <th>确认</th>
            </tr>
          </thead>
          <tbody>
            {payload.tasks.map((task) => {
              const accepted = payload.confirmedTaskKnowledgeIds.includes(task.knowledgeId);
              return (
                <tr key={task.knowledgeId}>
                  <td>{task.name}</td>
                  <td className="mono">{task.minutes} 分钟</td>
                  <td>{task.acceptance}</td>
                  <td className="mono muted">
                    {task.evidence.map((item) => `${item.materialId}/${item.segmentId}`).join('、')}
                  </td>
                  <td>
                    {status === 'confirmed' ? (
                      <span className="pill" data-tone={accepted ? 'verified' : 'pending'}>
                        {accepted ? '已确认' : '未确认'}
                      </span>
                    ) : (
                      <span className="row-inline">
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => decide(task.knowledgeId, 'accept')}
                          disabled={busy || accepted}
                        >
                          {accepted ? '已接受' : '接受'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => decide(task.knowledgeId, 'reject')}
                          disabled={busy || !accepted}
                        >
                          退回
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
};
