'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { apiResponses, type WorkbenchStateDto } from '@sew/study-contracts';
import { apiFetch, describeApiError } from '../lib/client';
import { Notice } from './ui';

/** Save the learner's goal; this action never generates or approves course content. */
export function StudyGoalEntry({ project }: { project: WorkbenchStateDto['project'] }) {
  const router = useRouter();
  const running = useRef(false);
  const [subject, setSubject] = useState(project.subject);
  const [goal, setGoal] = useState(project.goal);
  const [minutes, setMinutes] = useState(project.dailyMinutes || 30);
  const [date, setDate] = useState(project.examDate ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (running.current) return;
    if (!subject.trim() || !goal.trim()) {
      setError('请填写备考科目和学习目标。');
      return;
    }
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/study/project', apiResponses.project, {
        method: 'PATCH',
        body: JSON.stringify({
          scope: { projectId: project.projectId, generation: project.generation },
          subject: subject.trim(),
          goal: goal.trim(),
          dailyMinutes: minutes,
          examDate: date || null,
          ...(!project.subject ? { displayName: `${subject.trim()}备考` } : {}),
        }),
      });
      router.push('/workbench/materials');
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <form className="study-composer" onSubmit={(event) => void submit(event)} aria-busy={busy}>
      <div className="field">
        <label htmlFor="study-subject">备考科目</label>
        <input
          id="study-subject"
          required
          maxLength={60}
          placeholder="例如：高考数学、考研英语"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="study-goal">你想学会什么？</label>
        <textarea
          id="study-goal"
          required
          maxLength={500}
          rows={3}
          placeholder="例如：两周内掌握函数单调性，先听讲解，再做题巩固。"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
        />
      </div>
      <div className="row-inline">
        <div className="field">
          <label htmlFor="study-minutes">每天学习（分钟）</label>
          <input
            id="study-minutes"
            type="number"
            required
            min={1}
            max={720}
            value={minutes}
            onChange={(event) => setMinutes(Number(event.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="study-date">考试日期（选填）</label>
          <input
            id="study-date"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? '保存中…' : '保存目标，导入学习材料 →'}
        </button>
      </div>
      <p className="muted">接下来导入考纲、教材或讲义，核对知识点后制定计划、生成课程。</p>
      {error ? (
        <Notice tone="error" role="alert">
          {error}
        </Notice>
      ) : null}
    </form>
  );
}
