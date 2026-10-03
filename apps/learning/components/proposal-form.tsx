'use client';

import { Notice } from './ui';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SegmentDto } from '@sew/study-contracts';
import { apiFetch, describeApiError } from '../lib/client';

/**
 * 提出知识点候选。AI 与用户共用该入口，但都只能写候选。
 * 不提供「无来源提交」的便捷路径：引用段落是必填项。
 */
export const ProposalForm = ({
  projectId,
  generation,
  segments,
}: {
  projectId: string;
  generation: number;
  segments: Array<SegmentDto & { materialId: string; revision: number }>;
}) => {
  const router = useRouter();
  const [name, setName] = useState('');
  const [concept, setConcept] = useState('');
  const [conditions, setConditions] = useState('');
  const [segmentId, setSegmentId] = useState(segments[0]?.segmentId ?? '');
  const [use, setUse] = useState<'scope_basis' | 'concept_basis' | 'method_basis'>('concept_basis');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = segments.find((segment) => segment.segmentId === segmentId);

  const submit = async (withEvidence: boolean) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const data = await apiFetch<{ proposal: { name: string; mechanical: { passed: boolean } } }>(
        '/api/study/knowledge/propose',
        {
          method: 'POST',
          body: JSON.stringify({
            scope: { projectId, generation },
            name: name || '未命名候选',
            concept: concept || '（未填写陈述）',
            conditions,
            scopeStatus: 'in_syllabus',
            prerequisites: [],
            evidence:
              withEvidence && selected
                ? [{ materialId: selected.materialId, revision: selected.revision, segmentId: selected.segmentId, use }]
                : [],
            acceptance: '',
            priority: 'medium',
            proposedBy: 'user',
          }),
        },
      );
      setMessage(
        data.proposal.mechanical.passed
          ? '候选已保存，机械检查通过，等待你对照原文做语义审核。'
          : '候选已保存，但机械检查未通过：该候选停在待核实，不能用于课程和出题。',
      );
      setName('');
      setConcept('');
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>提出知识点候选</h2>
      <p className="secondary">
        候选必须绑定材料段落。程序在导入时计算指纹，你只需选择已登记的段落编号；
        引用不存在或版本过期时，候选只能停在待核实。
      </p>
      <div className="row-inline">
        <div className="field" style={{ flex: '1 1 220px' }}>
          <label htmlFor="proposal-name">知识点名称</label>
          <input id="proposal-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：增函数的定义" />
        </div>
        <div className="field" style={{ flex: '1 1 220px' }}>
          <label htmlFor="proposal-segment">引用段落</label>
          <select
            id="proposal-segment"
            value={segmentId}
            onChange={(event) => setSegmentId(event.target.value)}
            disabled={segments.length === 0}
          >
            {segments.length === 0 ? <option value="">请先导入材料</option> : null}
            {segments.map((segment) => (
              <option key={segment.segmentId} value={segment.segmentId}>
                {segment.segmentId} · {segment.text.slice(0, 24)}…
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: '0 0 140px' }}>
          <label htmlFor="proposal-use">引用用途</label>
          <select id="proposal-use" value={use} onChange={(event) => setUse(event.target.value as typeof use)}>
            <option value="concept_basis">概念依据</option>
            <option value="method_basis">方法依据</option>
            <option value="scope_basis">范围依据</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="proposal-concept">陈述</label>
        <textarea
          id="proposal-concept"
          value={concept}
          onChange={(event) => setConcept(event.target.value)}
          placeholder="用一句话写出这一条要教什么"
        />
      </div>
      <div className="field">
        <label htmlFor="proposal-conditions">适用条件（可留空）</label>
        <input id="proposal-conditions" value={conditions} onChange={(event) => setConditions(event.target.value)} />
      </div>
      {selected ? (
        <div className="excerpt" data-highlight="true">
          {selected.text}
        </div>
      ) : null}
      <div className="row-inline">
        <button type="button" className="btn btn-primary" disabled={busy || !selected} onClick={() => submit(true)}>
          提交候选（带引用）
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy}
          onClick={() => submit(false)}
          title="用于演示无来源注入被拦截"
        >
          提交无来源候选（演示拦截）
        </button>
      </div>
      {message ? (
        <Notice tone="pending" style={{ marginTop: 'var(--sew-space-3)' }}>
          {message}
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="error" style={{ marginTop: 'var(--sew-space-3)' }}>
          {error}
        </Notice>
      ) : null}
    </div>
  );
};
