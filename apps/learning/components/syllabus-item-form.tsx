'use client';

import { apiResponses } from '@sew/study-contracts';

/**
 * 登记考纲原子项。
 *
 * 条目必须绑定到已登记材料版本的段落，并列出条目内的必要要素：覆盖统计按要素判断
 * 「完整覆盖」，因此要素清单不是备注文本，而是计数依据。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';

interface SourceSegment {
  materialId: string;
  revision: number;
  materialName: string;
  segmentId: string;
  text: string;
}

const segmentKey = (segment: SourceSegment): string =>
  `${segment.materialId}|${segment.revision}|${segment.segmentId}`;

interface RequirementRow {
  key: string;
  text: string;
}

export const SyllabusItemForm = ({
  projectId,
  generation,
  segments,
}: {
  projectId: string;
  generation: number;
  segments: SourceSegment[];
}): ReactNode => {
  const router = useRouter();
  const first = segments[0];
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [selectedKey, setSelectedKey] = useState(first ? segmentKey(first) : '');
  const [requirements, setRequirements] = useState<RequirementRow[]>([{ key: '', text: '' }]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = segments.find((segment) => segmentKey(segment) === selectedKey);

  const updateRow = (index: number, patch: Partial<RequirementRow>): void => {
    setRequirements((rows) => rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  };

  const addRow = (): void => setRequirements((rows) => [...rows, { key: '', text: '' }]);
  const removeRow = (index: number): void =>
    setRequirements((rows) => (rows.length === 1 ? rows : rows.filter((_, position) => position !== index)));

  const submit = async (): Promise<void> => {
    if (!selected) {
      setError('还没有可引用的材料段落，请先导入考纲原文。');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await apiFetch('/api/study/syllabus', apiResponses.syllabusCreate, {
        method: 'POST',
        body: JSON.stringify({
          scope: { projectId, generation },
          code,
          label,
          requirements: requirements.filter((row) => row.key.trim() !== '' || row.text.trim() !== ''),
          source: { materialId: selected.materialId, revision: selected.revision, segmentId: selected.segmentId },
        }),
      });
      setMessage(`已登记考纲条目 ${code.trim()}。`);
      setCode('');
      setLabel('');
      setRequirements([{ key: '', text: '' }]);
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>登记考纲条目</h2>
      <p className="secondary">
        一个条目对应考纲里一个可单独检查的要求，编号在本项目内唯一。必要要素写全：只有全部要素都被
        已核实且准入通过的知识点覆盖，条目才计入覆盖分子；部分覆盖单独报告。
      </p>
      <div className="row-inline">
        <div className="field" style={{ flex: '0 0 140px' }}>
          <label htmlFor="syllabus-code">考纲编号</label>
          <input id="syllabus-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="例如 K1-03" />
        </div>
        <div className="field" style={{ flex: '1 1 260px' }}>
          <label htmlFor="syllabus-label">条目内容</label>
          <input id="syllabus-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="例如：理解增函数的定义并能判断单调性" />
        </div>
        <div className="field" style={{ flex: '1 1 260px' }}>
          <label htmlFor="syllabus-source">考纲原文段落</label>
          <select
            id="syllabus-source"
            value={selectedKey}
            onChange={(event) => setSelectedKey(event.target.value)}
            disabled={segments.length === 0}
          >
            {segments.length === 0 ? <option value="">请先导入考纲材料</option> : null}
            {segments.map((segment) => (
              <option key={segmentKey(segment)} value={segmentKey(segment)}>
                {segment.materialName} r{segment.revision} · {segment.segmentId} · {segment.text.slice(0, 24)}…
              </option>
            ))}
          </select>
        </div>
      </div>

      <h3>必要要素</h3>
      {requirements.map((row, index) => (
        <div className="row-inline" key={index}>
          <div className="field" style={{ flex: '0 0 160px' }}>
            <label htmlFor={`requirement-key-${index}`}>要素编号</label>
            <input
              id={`requirement-key-${index}`}
              value={row.key}
              onChange={(event) => updateRow(index, { key: event.target.value })}
              placeholder="小写字母数字，如 def-1"
            />
          </div>
          <div className="field" style={{ flex: '1 1 320px' }}>
            <label htmlFor={`requirement-text-${index}`}>要素说明</label>
            <input
              id={`requirement-text-${index}`}
              value={row.text}
              onChange={(event) => updateRow(index, { text: event.target.value })}
              placeholder="例如：任取 x1 &lt; x2 都有 f(x1) &lt; f(x2)"
            />
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => removeRow(index)}
            disabled={requirements.length === 1 || busy}
            title={requirements.length === 1 ? '条目至少需要一个必要要素' : '删除该要素'}
          >
            删除
          </button>
        </div>
      ))}
      <div className="row-inline">
        <button type="button" className="btn" onClick={addRow} disabled={busy}>
          增加必要要素
        </button>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !selected}>
          {busy ? '登记中…' : '登记条目'}
        </button>
      </div>
      {message ? <Notice tone="verified">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
};
