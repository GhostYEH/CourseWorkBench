'use client';
import { personalAttemptSubmitResultSchema,type QuestionAssessmentMetadataDto } from '@sew/study-contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef,useState,type FormEvent } from 'react';
import { apiFetch } from '../lib/client';
import { createGradingRequestIds } from '../lib/grading-request-ids';
import { writeMultipleAnswer } from '../lib/quiz-answer';
import { useCommand } from '../lib/use-command';

export function PersonalPractice({ projectId, generation, questionId, assessment }: {
  projectId: string; generation: number; questionId: string; assessment: QuestionAssessmentMetadataDto | null;
}) {
  const [answer, setAnswer] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [process, setProcess] = useState('');
  const command = useCommand([projectId, generation, questionId].join(':'));
  const { busy, error } = command;
  const [receipt, setReceipt] = useState('');
  const ids = useRef(createGradingRequestIds());
  const router = useRouter();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await command.run(async ({ signal }) => {
      const answerText = assessment?.type === 'multiple' ? writeMultipleAnswer(selected)
        : assessment?.type === 'single' ? selected[0] ?? '' : answer;
      const idempotencyKey = ids.current.forIntent([projectId, generation, questionId, answerText, process]);
      const result = await apiFetch('/api/study/attempts', personalAttemptSubmitResultSchema, { method: 'POST', signal,
        body: JSON.stringify({ scope: { projectId, generation }, questionId, idempotencyKey,
          actorType: 'human_learner', kind: 'real', answerText, processText: process }) });
      return { result, idempotencyKey };
    }, { onSuccess: ({ result, idempotencyKey }) => {
      ids.current.acknowledge(idempotencyKey); setReceipt(result.attempt.attemptId); router.refresh();
    } });
  };
  return <form onSubmit={event => void submit(event)}>
    {assessment?.type === 'single' || assessment?.type === 'multiple' ? assessment.options.map(option => <label key={option.value}>
      <input type={assessment.type === 'single' ? 'radio' : 'checkbox'} name={`answer-${questionId}`} checked={selected.includes(option.value)}
        onChange={e => setSelected(assessment.type === 'single' ? [option.value] : e.target.checked ? [...selected, option.value] : selected.filter(v => v !== option.value))} />{option.value} · {option.label}</label>)
      : <label>本人答案<textarea value={answer} onChange={e => setAnswer(e.target.value)} required /></label>}
    <label>解题过程<textarea value={process} onChange={e => setProcess(e.target.value)} /></label>
    <button disabled={busy || ((assessment?.type === 'single' || assessment?.type === 'multiple') && !selected.length)}>保存新的本人作答</button>
    {receipt ? <p>已保存收据：{receipt}。<Link href="/workbench/mistakes">查看反馈、订正与复习安排</Link></p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </form>;
}
