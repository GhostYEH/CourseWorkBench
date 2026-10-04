'use client';

import { apiResponses } from '@sew/study-contracts';

import { Notice } from './ui';

import { useState } from 'react';
import type { AdmissionResultDto } from '@sew/study-contracts';
import { apiFetch, describeApiError } from '../lib/client';

/**
 * 生成准入自检：与备考生成、教师发言、白板、互动、导入共用同一准入实现。
 * 被阻断时任务不会调用模型，并显示具体缺少什么材料。
 */
export const AdmissionChecker = ({
  projectId,
  generation,
  knowledge,
}: {
  projectId: string;
  generation: number;
  knowledge: Array<{ knowledgeId: string; name: string; sourceStatus: string; scopeStatus: string }>;
}) => {
  const [selected, setSelected] = useState<string[]>(knowledge.map((item) => item.knowledgeId));
  const [result, setResult] = useState<AdmissionResultDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (knowledgeId: string) =>
    setSelected((current) =>
      current.includes(knowledgeId) ? current.filter((id) => id !== knowledgeId) : [...current, knowledgeId],
    );

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await apiFetch('/api/study/admission', apiResponses.admission, {
        method: 'POST',
        body: JSON.stringify({ scope: { projectId, generation }, knowledgeIds: selected }),
      });
      setResult(data);
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>生成准入自检</h2>
      <p className="secondary">
        勾选知识点后检查准入。已核实、当前仍有效、范围合规且必要前置满足的知识点才允许进入课程生成与出题；
        其余只阻断受影响的任务，其他已核实任务仍可执行。
      </p>
      {knowledge.length === 0 ? (
        <Notice tone="pending">还没有知识点。先导入材料并提出候选，再完成人工审核。</Notice>
      ) : (
        <ul className="check-list">
          {knowledge.map((item) => (
            <li key={item.knowledgeId}>
              <label style={{ display: 'flex', gap: 'var(--sew-space-2)', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={selected.includes(item.knowledgeId)}
                  onChange={() => toggle(item.knowledgeId)}
                />
                {item.name}
              </label>
              <span className="muted mono">
                {item.sourceStatus} · {item.scopeStatus}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="row-inline" style={{ marginTop: 'var(--sew-space-3)' }}>
        <button type="button" className="btn btn-primary" onClick={check} disabled={busy || selected.length === 0}>
          运行准入检查
        </button>
      </div>
      {result ? (
        <div style={{ marginTop: 'var(--sew-space-4)' }}>
          <Notice tone={result.allowed ? 'verified' : 'pending'}>
            {result.allowed
              ? `全部 ${result.admitted.length} 项准入通过，可以生成课程草案。`
              : `${result.blocked.length} 项被阻断，本次生成不会调用模型；已准入 ${result.admitted.length} 项。`}
          </Notice>
          {result.blocked.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>知识点</th>
                  <th>错误码</th>
                  <th>说明</th>
                  <th>缺少材料</th>
                </tr>
              </thead>
              <tbody>
                {result.blocked.map((item) => (
                  <tr key={item.knowledgeId}>
                    <td className="mono">{item.knowledgeId}</td>
                    <td className="mono">{item.code}</td>
                    <td>{item.message}</td>
                    <td className="mono">{item.missing.join('、') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <Notice tone="error" style={{ marginTop: 'var(--sew-space-3)' }}>
          {error}
        </Notice>
      ) : null}
    </div>
  );
};
