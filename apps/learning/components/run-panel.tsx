'use client';

/**
 * 备考 run 面板（PLAN-01 基础）。
 *
 * run 只能从已确认计划启动；启动收据按「项目 + 计划版本」去重，
 * 因此面板显示的是既有 run 与其冻结快照，而不是「正在生成的假进度」。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { RunSnapshotDto } from '@sew/study-contracts';
import { Empty, Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';

export const RunPanel = ({
  projectId,
  generation,
  snapshot,
  canStart,
}: {
  projectId: string;
  generation: number;
  snapshot: RunSnapshotDto | null;
  canStart: boolean;
}): ReactNode => {
  const router = useRouter();
  const [current, setCurrent] = useState<RunSnapshotDto | null>(snapshot);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const data = await apiFetch<{ snapshot: RunSnapshotDto | null; deduplicated: boolean }>('/api/study/run', {
        method: 'POST',
        body: JSON.stringify({ scope: { projectId, generation }, action: 'start' }),
      });
      setCurrent(data.snapshot);
      setNote(data.deduplicated ? '该计划的 run 已存在，读回既有记录，没有重复启动。' : 'run 已启动并记录冻结快照。');
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>备考 run</h2>
      <p className="secondary">
        run 记录启动时冻结的知识点摘要、材料版本、教学偏好与角色配置；后续课程与课堂都按这套事实恢复，
        不在恢复时重放已提交动作。
      </p>
      {!current ? (
        <Empty>还没有 run。{canStart ? '确认计划后可启动。' : '需要先确认包含已逐条确认任务的计划版本。'}</Empty>
      ) : (
        <table>
          <tbody>
            <tr>
              <th>run</th>
              <td className="mono">{current.runId}</td>
            </tr>
            <tr>
              <th>状态</th>
              <td className="mono">{current.state}</td>
            </tr>
            <tr>
              <th>已提交事件序号</th>
              <td className="mono">{current.lastSeq}</td>
            </tr>
            <tr>
              <th>计划版本</th>
              <td className="mono">{current.frozen.planVersion ?? '—'}</td>
            </tr>
            <tr>
              <th>知识点摘要</th>
              <td className="mono" style={{ overflowWrap: 'anywhere' }}>
                {current.frozen.knowledgeTableDigest.slice(0, 16)}…
              </td>
            </tr>
            <tr>
              <th>角色配置</th>
              <td className="mono">{current.frozen.roleConfigDigest ? `${current.frozen.roleConfigDigest.slice(0, 12)}…` : '未配置'}</td>
            </tr>
            <tr>
              <th>模型配置</th>
              <td className="muted">{current.frozen.modelProfileId ?? '未接入：本里程碑不启动真实模型调用'}</td>
            </tr>
          </tbody>
        </table>
      )}
      <div className="row-inline" style={{ marginTop: 'var(--sew-space-3)' }}>
        <button type="button" className="btn btn-primary" onClick={start} disabled={busy || !canStart}>
          从已确认计划启动 run
        </button>
      </div>
      {note ? <Notice tone="verified">{note}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
};
