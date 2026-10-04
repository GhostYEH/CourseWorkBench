'use client';
import { useCommand } from '../lib/use-command';

import {
errorTagSchema,
feedbackContextSchema,
feedbackModelResultSchema,
feedbackResultSchema,
reviewTaskSchema,
type FeedbackContextDto,
type FeedbackModelInput,
type FeedbackReviewCommand,
type ReviewTaskDto
} from '@sew/study-contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef,useState } from 'react';
import { apiFetch,describeApiError } from '../lib/client';
import { createGradingRequestIds } from '../lib/grading-request-ids';

const tagLabels = { concept: '概念', method: '方法', calculation: '计算', reading: '审题', memory: '记忆', time: '时间管理', unknown: '证据不足' };
type CommandPayload<T = FeedbackReviewCommand> = T extends FeedbackReviewCommand ? Omit<T, 'scope' | 'attemptId' | 'expectedVersion' | 'requestId'> : never;
function FeedbackReviewPanelContent({ projectId, generation, initialContext, initialTasks, newAttempts }: {
  projectId: string; generation: number; initialContext: FeedbackContextDto; initialTasks: ReviewTaskDto[];
  newAttempts: { attemptId: string; submittedAt: string; answerText: string }[];
}) {
  const [context, setContext] = useState(initialContext);
  const [tasks, setTasks] = useState(initialTasks);
  const [tag, setTag] = useState<keyof typeof tagLabels>('unknown');
  const [explanation, setExplanation] = useState('现有证据不足以确定错因，需要补充诊断。');
  const [quote, setQuote] = useState('');
  const [uncertainty, setUncertainty] = useState('错因需要独立人工核对，不能仅依据最终答案推断。');
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [correction, setCorrection] = useState('');
  const [nextId, setNextId] = useState('');
  const [due, setDue] = useState('');
  const [reason, setReason] = useState('复做原题，核对原始错步与订正。');
  const command = useCommand([projectId, generation, initialContext.attemptId].join(':'));
  const { busy, error, setError, cancel } = command;
  const [modelBusy, setModelBusy] = useState(false);
  const [message, setMessage] = useState('');
  const ids = useRef(createGradingRequestIds());
  const router = useRouter();
  const send = async (payload: CommandPayload) => {
    await command.run(async ({ signal }) => {
      const body = { ...payload, scope: { projectId, generation }, attemptId: context.attemptId, expectedVersion: context.version,
        requestId: ids.current.forIntent([projectId, generation, context.attemptId, context.version, payload]) };
      await apiFetch('/api/study/feedback', feedbackResultSchema, { method: 'POST', signal, body: JSON.stringify(body) });
      const latest = await apiFetch('/api/study/feedback?' + new URLSearchParams({ projectId, generation: String(generation), attemptId: context.attemptId }), feedbackContextSchema, { signal });
      const latestTasks = await apiFetch('/api/study/feedback?' + new URLSearchParams({ projectId, generation: String(generation) }), reviewTaskSchema.array(), { signal });
      return { latest, latestTasks, requestId: body.requestId };
    }, {
      onSuccess: ({ latest, latestTasks, requestId }) => {
        ids.current.acknowledge(requestId); setContext(latest); setTasks(latestTasks); setChecked(false); setCandidateId(null); router.refresh();
      },
      onError: caught => setError(describeApiError(caught) + '。请重新读取记录后核对。'),
    });
  };
  const generate = async (purpose: FeedbackModelInput['purpose']) => {
    await command.run(async ({ signal }) => {
      const body: FeedbackModelInput = { scope: { projectId, generation }, attemptId: context.attemptId,
        expectedVersion: context.version, purpose,
        requestId: ids.current.forIntent([projectId, generation, context.attemptId, context.version, purpose]) };
      const result = await apiFetch('/api/study/feedback/generate', feedbackModelResultSchema, { method: 'POST', signal, body: JSON.stringify(body) });
      return { result, requestId: body.requestId };
    }, {
      onStart: () => { setModelBusy(true); setMessage(''); },
      onSuccess: ({ result, requestId }) => {
        ids.current.acknowledge(requestId);
        setContext(result.feedback.context); setTasks(result.feedback.tasks); setChecked(false); setMessage(result.generation.message);
        if (result.generation.ok && purpose === 'error_attribution') {
          const candidate = result.feedback.context.entries.at(-1);
          if (candidate?.action === 'propose' && candidate.conclusion) {
            setCandidateId(candidate.entryId); setExplanation(candidate.conclusion.explanation); setUncertainty(candidate.conclusion.uncertainty);
            setQuote(candidate.conclusion.evidence[0]?.quote ?? ''); setTag(candidate.conclusion.tags[0] ?? 'unknown');
          }
        }
        router.refresh();
      },
      onCancel: () => setMessage('已停止本次请求。已派发的调用会保留用量；未确认结果不会自动重发。'),
      onFinish: () => setModelBusy(false),
    });
  };
  const conclusion = () => {
    const start = context.snapshot.processText.indexOf(quote);
    return { tags: [tag], explanation, uncertainty, evidence: quote ? [{ start, end: start + quote.length, quote }] : [] };
  };
  const pending = context.entries.filter(e => e.action === 'propose' && !context.entries.some(r => r.action === 'review' && r.candidateId === e.entryId));
  const disabled = busy || !context.canWrite;
  return <section className="card" data-feedback-panel data-feedback-attempt={context.attemptId}>
    <h3>错因、订正与复习历史</h3>
    <p className="muted">原始答案与过程保持不变。错因候选需人工核对；订正不会冒充复做或复习完成。</p>
    {context.blockedReason ? <p role="alert">{context.blockedReason}</p> : null}
    <div className="actions">
      <button data-feedback-ai-error disabled={disabled} onClick={() => void generate('error_attribution')}>请求 AI 错因候选</button>
      <button data-feedback-ai-review disabled={disabled || tasks.some(task => task.attemptId === context.attemptId && task.status !== 'completed')}
        onClick={() => void generate('review_suggestion')}>请求 AI 复习建议</button>
      {modelBusy ? <button onClick={cancel}>停止本次 AI 候选</button> : null}
    </div>
    <p className="muted">AI 结果先保存为待审候选，不自动判分或确认复习。模型连接可在<Link href="/workbench/settings">科目设置</Link>中配置。</p>
    <details><summary>冻结题目、规则与来源依据</summary><p>{context.snapshot.stem}</p><p>参考：{context.snapshot.answer}</p><p>规则：{context.snapshot.rubric || '未登记简答评分标准'}</p><p>题目版本 {context.snapshot.questionRevision} · {context.snapshot.originLabel}</p>
      <pre>{JSON.stringify(context.snapshot.evidence, null, 2)}</pre></details>
    <label>错因分类<select value={tag} onChange={e => { const parsed = errorTagSchema.safeParse(e.target.value); if (parsed.success) setTag(parsed.data); }}>
      {Object.entries(tagLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    <label>错因说明<textarea value={explanation} onChange={e => setExplanation(e.target.value)} /></label>
    <label>原始过程的逐字证据（证据不足时可留空）<textarea value={quote} onChange={e => setQuote(e.target.value)} /></label>
    <label>不确定性<textarea value={uncertainty} onChange={e => setUncertainty(e.target.value)} /></label>
    <label>关联待审候选<select value={candidateId ?? ''} onChange={e => setCandidateId(e.target.value || null)}><option value="">独立人工结论</option>
      {pending.map(e => <option key={e.entryId} value={e.entryId}>{e.origin === 'model' ? 'AI 待审候选：' : '人工候选：'}{e.conclusion?.explanation}</option>)}</select></label>
    <label><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />我已核对原作答、证据位置和题目依据</label>
    <div className="actions"><button disabled={disabled} onClick={() => void send({ action: 'propose', conclusion: conclusion() })}>保存待审错因候选</button>
      <button disabled={disabled || !checked} onClick={() => void send({ action: 'review', candidateId, conclusion: conclusion(), semanticReviewed: true })}>追加人工错因审核</button></div>
    <label>完整订正<textarea value={correction} onChange={e => setCorrection(e.target.value)} /></label>
    <button disabled={disabled || !correction.trim()} onClick={() => void send({ action: 'correct', correction })}>保存订正历史</button>
    <p><Link href="/workbench/study">进入练习提交一次新的本人作答</Link>，然后回来关联复做或完成复习。</p>
    <label>新作答收据<select value={nextId} onChange={e => setNextId(e.target.value)}><option value="">请选择已保存的新作答</option>
      {newAttempts.map(a => <option key={a.attemptId} value={a.attemptId}>{a.submittedAt.slice(0, 19)} · {a.answerText.slice(0, 60)}</option>)}</select></label>
    <button disabled={disabled || !nextId} onClick={() => void send({ action: 'retry', retryAttemptId: nextId })}>关联独立复做记录</button>
    <label>复习时间<input type="datetime-local" value={due} onChange={e => setDue(e.target.value)} /></label>
    <label>复习理由<textarea value={reason} onChange={e => setReason(e.target.value)} /></label>
    <button disabled={disabled || !due || !reason.trim()} onClick={() => void send({ action: 'draft', dueAt: new Date(due).toISOString(), reason })}>保存复习建议草案</button>
    {tasks.filter(t => t.attemptId === context.attemptId).map(task => <div key={task.taskId} className="card"><p>{task.origin === 'model' ? 'AI 建议 · ' : ''}{task.reason} · {task.dueAt.slice(0, 19)} · {task.status === 'draft' ? '待确认' : task.status === 'confirmed' ? '已确认，等待新的本人作答' : '已完成'}</p>
      {task.status === 'draft' ? <button disabled={disabled || !checked} onClick={() => void send({ action: 'confirm', taskId: task.taskId, semanticReviewed: true })}>人工确认复习安排</button> : null}
      {task.status === 'confirmed' ? <button disabled={disabled || !nextId} onClick={() => void send({ action: 'complete', taskId: task.taskId, completionAttemptId: nextId })}>核验所选新作答并完成复习</button> : null}
      {task.completionAttemptId ? <p>本人作答收据：{task.completionAttemptId}</p> : null}</div>)}
    <details><summary>已保存历史（{context.entries.length}）</summary>{context.entries.map(entry => <p key={entry.entryId}>v{entry.version} · {entry.origin === 'model' ? 'AI 候选' : '人工记录'} · {entry.action} · {entry.conclusion ? `${entry.conclusion.tags.map(t => tagLabels[t]).join('、')}：${entry.conclusion.explanation}；${entry.conclusion.uncertainty}` : entry.correction || entry.retryAttemptId || '复习安排事件'} · {entry.createdAt.slice(0, 19)}</p>)}</details>
    {message ? <p role="status">{message}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <button disabled={busy} onClick={() => router.refresh()}>重新读取当前记录</button>
  </section>;
}

export function FeedbackReviewPanel(props: Parameters<typeof FeedbackReviewPanelContent>[0]) {
  return <FeedbackReviewPanelContent key={`${props.projectId}-${props.generation}-${props.initialContext.attemptId}`} {...props} />;
}
