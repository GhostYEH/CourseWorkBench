'use client';

import { apiResponses } from '@sew/study-contracts';

import { Notice } from './ui';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, describeApiError } from '../lib/client';

/** 科目设置：目标、时间与学习模式属于项目配置，保存设置不代表候选或课程已审核通过。 */
export const ProjectSettingsForm = ({
  initial,
  projectId,
  generation,
}: {
  initial: {
    displayName: string;
    subject: string;
    goal: string;
    examDate: string | null;
    dailyMinutes: number;
    learningMode: 'beginner' | 'review';
  };
  projectId: string;
  generation: number;
}) => {
  const router = useRouter();
  const [draft, setDraft] = useState(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await apiFetch('/api/study/project', apiResponses.project, {
        method: 'PATCH',
        body: JSON.stringify({
          scope: { projectId, generation },
          displayName: draft.displayName,
          subject: draft.subject,
          goal: draft.goal,
          examDate: draft.examDate,
          dailyMinutes: draft.dailyMinutes,
          learningMode: draft.learningMode,
        }),
      });
      setMessage('项目设置已保存（草稿）。这不代表候选或课程已经审核通过。');
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>目标与时间</h2>
      <div className="row-inline">
        <div className="field" style={{ flex: '1 1 220px' }}>
          <label htmlFor="display-name">项目名称</label>
          <input
            id="display-name"
            value={draft.displayName}
            onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
          />
        </div>
        <div className="field" style={{ flex: '0 0 160px' }}>
          <label htmlFor="subject">科目</label>
          <input
            id="subject"
            value={draft.subject}
            onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
            placeholder="例如：数学"
          />
        </div>
        <div className="field" style={{ flex: '0 0 180px' }}>
          <label htmlFor="exam-date">考试日期</label>
          <input
            id="exam-date"
            type="date"
            value={draft.examDate ?? ''}
            onChange={(event) => setDraft({ ...draft, examDate: event.target.value || null })}
          />
        </div>
        <div className="field" style={{ flex: '0 0 180px' }}>
          <label htmlFor="daily-minutes">每天可用时间（分钟）</label>
          <input
            id="daily-minutes"
            type="number"
            min={0}
            max={720}
            value={draft.dailyMinutes}
            onChange={(event) => setDraft({ ...draft, dailyMinutes: Number(event.target.value) })}
          />
        </div>
        <div className="field" style={{ flex: '0 0 160px' }}>
          <label htmlFor="mode">学习模式</label>
          <select
            id="mode"
            value={draft.learningMode}
            onChange={(event) =>
              setDraft({ ...draft, learningMode: event.target.value === 'review' ? 'review' : 'beginner' })
            }
          >
            <option value="beginner">零基础</option>
            <option value="review">复习</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="goal">学习目标</label>
        <textarea id="goal" value={draft.goal} onChange={(event) => setDraft({ ...draft, goal: event.target.value })} />
        <span className="hint">缺少考试日期时会按相对天数给出初版计划，并明确标注假设。</span>
      </div>
      <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
        保存设置
      </button>
      {message ? (
        <Notice tone="verified" style={{ marginTop: 'var(--sew-space-3)' }}>
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
