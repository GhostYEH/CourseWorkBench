'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ProposalDto } from '@sew/study-contracts';
import { CheckList, Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';

/**
 * 候选审核卡：拟加入的知识点 / 支持原文 / 审核结论。
 * 来源不足时「通过」按钮不可用，并显示具体缺口。
 */
export const CandidateReview = ({
  proposal,
  projectId,
  generation,
}: {
  proposal: ProposalDto;
  projectId: string;
  generation: number;
}) => {
  const router = useRouter();
  const [semanticReviewed, setSemanticReviewed] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canApprove = proposal.mechanical.passed && semanticReviewed;

  const decide = async (decision: 'approved' | 'rejected' | 'needs_material') => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/study/knowledge/review', {
        method: 'POST',
        body: JSON.stringify({
          scope: { projectId, generation },
          proposalId: proposal.proposalId,
          decision,
          expectedRevision: proposal.revision,
          semanticReviewed,
          note,
        }),
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
      <h2>
        {proposal.name}{' '}
        <span className="pill" data-tone={proposal.mechanical.passed ? 'pending' : 'error'}>
          {proposal.status === 'needs_material'
            ? '证据不足，待补材料'
            : proposal.mechanical.passed
              ? '引用可定位，等待语义审核'
              : '缺少支持原文'}
        </span>
      </h2>

      <h3>拟加入的知识点</h3>
      <p className="reading">{proposal.concept}</p>
      {proposal.conditions ? <p className="secondary">适用条件：{proposal.conditions}</p> : null}
      <p className="muted">
        范围状态：{proposal.scopeStatus} · 提出方：{proposal.proposedBy === 'ai' ? 'AI 候选' : '用户'}
        {proposal.prerequisites.length > 0 ? ` · 前置：${proposal.prerequisites.join('、')}` : ''}
      </p>

      <h3>支持原文</h3>
      {proposal.evidence.length === 0 ? (
        <Notice tone="error">
          没有提供任何材料引用。该候选只能停在待核实，不能进入课程与出题。
        </Notice>
      ) : (
        proposal.evidence.map((item, index) => (
          <div key={`${item.materialId}-${item.segmentId}-${index}`}>
            <p className="muted mono">
              {item.materialId} r{item.revision} · {item.segmentId} · 用途 {item.use} · 指纹{' '}
              {(item.fingerprint ?? '').slice(0, 12)}…
            </p>
            <div className="excerpt" data-highlight="true">
              {item.excerpt || '（该引用未能定位到原文）'}
            </div>
          </div>
        ))
      )}

      <h3>机械检查</h3>
      <CheckList checks={proposal.mechanical.checks} />
      <p className="muted">
        机械检查只证明「引用可定位」，不代表引用支持这个知识点；语义支持需要你对照原文判断。
      </p>

      <h3>审核结论</h3>
      <label className="secondary" style={{ display: 'flex', gap: 'var(--sew-space-2)', alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={semanticReviewed}
          onChange={(event) => setSemanticReviewed(event.target.checked)}
          disabled={!proposal.mechanical.passed}
        />
        我已对照原文，确认引用支持该陈述、适用条件与范围
      </label>
      <div className="field" style={{ marginTop: 'var(--sew-space-3)' }}>
        <label htmlFor={`note-${proposal.proposalId}`}>审核备注</label>
        <textarea
          id={`note-${proposal.proposalId}`}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="例如：引用只支持定义，不包含适用条件的完整表述"
        />
      </div>
      <div className="row-inline">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canApprove || busy}
          title={canApprove ? '写入权威知识点表' : '缺少来源或未做语义确认时不可通过'}
          onClick={() => decide('approved')}
        >
          通过并写入权威知识点
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => decide('needs_material')}>
          保留待核实，补材料
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => decide('rejected')}>
          拒绝
        </button>
      </div>
      {error ? (
        <Notice tone="error" style={{ marginTop: 'var(--sew-space-3)' }}>
          {error}
        </Notice>
      ) : null}
    </div>
  );
};
