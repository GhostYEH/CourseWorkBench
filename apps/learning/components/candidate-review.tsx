'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ProposalDto, SyllabusItemDto } from '@sew/study-contracts';
import { CheckList, Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';

/**
 * 候选审核卡：拟加入的知识点 / 支持原文 / 考纲映射 / 审核结论。
 * 来源不足时「通过」按钮不可用，并显示具体缺口。
 */
export const CandidateReview = ({
  proposal,
  projectId,
  generation,
  syllabusItems,
}: {
  proposal: ProposalDto;
  projectId: string;
  generation: number;
  /** 已登记的考纲条目；非空时「考纲内」候选必须映射到某个必要要素才能批准。 */
  syllabusItems: SyllabusItemDto[];
}) => {
  const router = useRouter();
  const [semanticReviewed, setSemanticReviewed] = useState(false);
  const [note, setNote] = useState('');
  const [itemId, setItemId] = useState('');
  const [requirementKey, setRequirementKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedItem = syllabusItems.find((item) => item.itemId === itemId) ?? null;
  const mappingNeeded = proposal.scopeStatus === 'in_syllabus' && syllabusItems.length > 0;
  const mappingChosen = itemId !== '' && requirementKey !== '';
  const canApprove =
    proposal.mechanical.passed && semanticReviewed && (!mappingNeeded || mappingChosen);

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
          syllabus: mappingChosen ? { itemId, requirementKey } : null,
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
    <div className="card" id={`prop-${proposal.proposalId}`} style={{ scrollMarginTop: 'var(--sew-space-6)' }}>
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

      <h3>考纲映射</h3>
      {proposal.scopeStatus !== 'in_syllabus' ? (
        <p className="muted">
          该候选的范围状态是「{proposal.scopeStatus}」，不绑定考纲条目；必要前置不会增加覆盖分子。
        </p>
      ) : syllabusItems.length === 0 ? (
        <Notice tone="pending">
          尚未登记考纲条目，暂不能记录映射。到「考纲条目」页把考纲拆成可检查的原子条目后，
          「考纲内」候选必须指定它覆盖哪个条目的哪个必要要素才能批准。
        </Notice>
      ) : (
        <div className="row-inline">
          <div className="field" style={{ flex: '1 1 260px' }}>
            <label htmlFor={`syllabus-item-${proposal.proposalId}`}>考纲条目</label>
            <select
              id={`syllabus-item-${proposal.proposalId}`}
              value={itemId}
              onChange={(event) => {
                setItemId(event.target.value);
                setRequirementKey('');
              }}
            >
              <option value="">未选择（批准会被拒绝）</option>
              {syllabusItems.map((item) => (
                <option key={item.itemId} value={item.itemId}>
                  {item.code} · {item.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '1 1 220px' }}>
            <label htmlFor={`syllabus-requirement-${proposal.proposalId}`}>覆盖的必要要素</label>
            <select
              id={`syllabus-requirement-${proposal.proposalId}`}
              value={requirementKey}
              onChange={(event) => setRequirementKey(event.target.value)}
              disabled={selectedItem === null}
            >
              <option value="">{selectedItem ? '未选择' : '请先选择条目'}</option>
              {selectedItem?.requirements.map((requirement) => (
                <option key={requirement.key} value={requirement.key}>
                  {requirement.key} · {requirement.text}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

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
          title={canApprove ? '写入权威知识点表' : '缺少来源、未做语义确认或未指定考纲映射时不可通过'}
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
