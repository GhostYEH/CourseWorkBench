'use client';

/**
 * 真题来源人工核对。
 *
 * 「该材料版本可作为考试真题来源」是服务端权威事实：只有这里的显式确认能写入，
 * 请求方或模型自称真题不改变题目身份。核实后引用该版本的题目才可能被判定为考试真题。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { MaterialDto } from '@sew/study-contracts';
import { apiFetch, describeApiError } from '../lib/client';
import { Notice } from './ui';

export const ExamSourceVerification = ({
  projectId,
  generation,
  material,
}: {
  projectId: string;
  generation: number;
  material: MaterialDto;
}): ReactNode => {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const verified = material.examVerification;

  const submit = async (): Promise<void> => {
    if (!confirmed) {
      setError('需要先勾选「已逐条核对原文与出处」才能登记。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/study/materials/${material.materialId}/exam-verification`, {
        method: 'POST',
        body: JSON.stringify({
          scope: { projectId, generation },
          materialId: material.materialId,
          revision: material.revision,
          note,
        }),
      });
      setDone(true);
      setConfirmed(false);
      setNote('');
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>真题来源核对 · {material.displayName} r{material.revision}</h3>
      {verified ? (
        <Notice tone="verified">
          该版本已核实为考试真题来源（{verified.verifiedAt.slice(0, 19).replace('T', ' ')}）。
          {verified.note ? ` 核对说明：${verified.note}` : ''}
          引用该版本并经原文匹配的题目才可能被判定为考试真题。
        </Notice>
      ) : (
        <p className="secondary">
          该版本尚未核实。未核实的材料可以支持知识点与讲解，但引用它的题目不能标为「考试真题」；
          自称真题不会改变身份。
        </p>
      )}
      <div className="field">
        <label htmlFor={`exam-note-${material.materialId}-${material.revision}`}>核对说明（出处、年份、题号）</label>
        <input
          id={`exam-note-${material.materialId}-${material.revision}`}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="例如：2023 年本市学业水平卷第 12 题，与题干逐字比对"
        />
      </div>
      <label className="secondary" style={{ display: 'flex', gap: 'var(--sew-space-2)', alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          disabled={busy}
        />
        我已逐条核对该版本原文与可信出处，确认它可作为考试真题来源
      </label>
      <div className="row-inline" style={{ marginTop: 'var(--sew-space-3)' }}>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !confirmed}>
          {busy ? '登记中…' : verified ? '更新核对说明' : '登记为考试真题来源'}
        </button>
      </div>
      {done ? <Notice tone="verified">核对结论已登记，题目身份将按该版本重新派生。</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className="hint">
        记录只作用于当前版本；材料重新导入会产生新版本，需要重新核对，旧版本的核实记录仍然保留可查。
      </p>
    </div>
  );
};
