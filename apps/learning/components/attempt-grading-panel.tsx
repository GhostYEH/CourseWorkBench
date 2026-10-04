'use client';
import { useCommand } from '../lib/use-command';

import { apiResponses,type AttemptGradeCandidateDto,type AttemptGradingContextDto } from '@sew/study-contracts';
import { useRouter } from 'next/navigation';
import { useRef,useState,type FormEvent } from 'react';
import { candidateApprovalBlocked,effectiveGradeLabel } from '../lib/attempt-grading';
import { ApiError,apiFetch,describeApiError } from '../lib/client';
import { createGradingRequestIds } from '../lib/grading-request-ids';

export function AttemptGradingPanel({ projectId, generation, initialContext }: {
  projectId: string; generation: number; initialContext: AttemptGradingContextDto;
}) {
  const router = useRouter();
  const [context, setContext] = useState(initialContext);
  const [earned, setEarned] = useState('');
  const [basis, setBasis] = useState('');
  const [uncertainty, setUncertainty] = useState('');
  const [semanticReviewed, setSemanticReviewed] = useState(false);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const command = useCommand([projectId, generation, initialContext.attemptId].join(':'));
  const { busy, error, setError } = command;
  const [note, setNote] = useState<string | null>(null);
  const [rejectNotes, setRejectNotes] = useState<Record<string, string>>({});
  const [generationRecovery, setGenerationRecovery] = useState<{requestId: string; state: 'started' | 'failed'} | null>(null);
  const requestIds = useRef(createGradingRequestIds());
  const applyContext = (next: AttemptGradingContextDto) => {
    setContext(next); setCandidateId(null); setSemanticReviewed(false);
  };
  const execute = (operation: (signal: AbortSignal) => Promise<AttemptGradingContextDto>, success: string) =>
    command.run(({ signal }) => operation(signal), {
      onStart: () => setNote(null),
      onSuccess: next => { applyContext(next); setNote(success); router.refresh(); },
      onError: caught => {
        setError(describeApiError(caught) + "。若记录已更新，请重新读取后核对。");
        if (caught instanceof ApiError && typeof caught.details?.['requestId'] === 'string'
          && (caught.details['generationRequestState'] === 'failed' || caught.details['generationRequestState'] === 'started')) {
          setGenerationRecovery({ requestId: caught.details['requestId'], state: caught.details['generationRequestState'] });
        }
      },
    });
  const commandBase = (action: string, values: readonly unknown[] = []) => ({ scope: { projectId, generation }, attemptId: context.attemptId,
    expectedReviewVersion: context.currentReviewVersion,
    requestId: requestIds.current.forIntent([projectId, generation, context.attemptId, context.currentReviewVersion, action, ...values]) });
  const readCurrent = (signal: AbortSignal) => apiFetch(`/api/study/grading?${new URLSearchParams({
    attemptId: context.attemptId, projectId, generation: String(generation),
  })}`, apiResponses.attemptGradingContext, { signal });
  const acknowledge = async (requestId: string, result: {context: AttemptGradingContextDto; deduplicated: boolean}, signal: AbortSignal) => {
    const current = result.deduplicated ? await readCurrent(signal) : result.context;
    if (signal.aborted) return current;
    requestIds.current.acknowledge(requestId);
    setGenerationRecovery(old => old?.requestId === requestId ? null : old);
    return current;
  };
  const reload = () => execute(readCurrent, '已重新读取，请按最新审核版本核对。');
  const review = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const score = Number(earned);
    if (!earned.trim() || !Number.isFinite(score) || score < 0 || score > context.maxScore || !basis.trim() || !uncertainty.trim() || !semanticReviewed) {
      setError('请填写有效得分、评分依据和不确定性，并确认已核对作答语义。'); return;
    }
    const selected = context.candidates.find((item) => item.candidateId === candidateId);
    if (candidateId && (!selected || candidateApprovalBlocked(selected, context.currentReviewVersion))) {
      setError('此候选不能批准，请重新读取或取消候选关联后独立人工评分。'); return;
    }
    const base = commandBase('review', [score, basis.trim(), uncertainty.trim(), candidateId]);
    void execute(async (signal) => acknowledge(base.requestId, await apiFetch('/api/study/grading', apiResponses.attemptGradeReview, {
      method: 'POST', signal, body: JSON.stringify({ ...base, action: 'review', earned: score,
        basis: basis.trim(), uncertainty: uncertainty.trim(), semanticReviewed: true, candidateId }),
    }), signal), '人工审核已保存，原作答保持不变。');
  };
  const generate = () => {
    const base = commandBase('generate');
    return execute(async (signal) => acknowledge(base.requestId, await apiFetch('/api/study/grading', apiResponses.attemptGradeCandidate, {
      method: 'POST', signal, body: JSON.stringify({ ...base, action: 'generate' }),
    }), signal), '模型候选已保存，仍需人工审核；候选不更新掌握。');
  };
  const reject = (candidate: AttemptGradeCandidateDto) => {
    const rejectNote = rejectNotes[candidate.candidateId]?.trim();
    if (!rejectNote) { setError('拒绝候选前请填写拒绝理由。'); return; }
    const base = commandBase('reject', [candidate.candidateId, rejectNote]);
    void execute(async (signal) => acknowledge(base.requestId, await apiFetch('/api/study/grading', apiResponses.attemptGradeReject, {
      method: 'POST', signal, body: JSON.stringify({ ...base, action: 'reject', candidateId: candidate.candidateId, note: rejectNote }),
    }), signal), '候选已拒绝，未更新得分或掌握。');
  };
  const selectCandidate = (candidate: AttemptGradeCandidateDto) => {
    setCandidateId(candidate.candidateId); setEarned(String(candidate.proposedEarned));
    setBasis(candidate.basis); setUncertainty(candidate.uncertainty); setSemanticReviewed(false); setError(null); setNote(null);
  };

  return <details id={`attempt-${context.attemptId}`} data-attempt-grading={context.attemptId}>
    <summary>核对简答评分 · {effectiveGradeLabel(context.effectiveGrading)} · 审核 v{context.currentReviewVersion}</summary>
    <div className="card">
      <h3>已提交作答与冻结评分标准</h3>
      <p>{context.stem}</p>
      <dl><dt>原始作答</dt><dd className="raw-source">{context.answerText}</dd><dt>解题过程</dt><dd className="raw-source">{context.processText || '（未填写）'}</dd>
        <dt>参考答案</dt><dd className="raw-source">{context.referenceAnswer}</dd><dt>解析</dt><dd className="raw-source">{context.solution || '（未填写）'}</dd>
        <dt>评分标准</dt><dd className="raw-source">{context.rubric}</dd></dl>
      <p className="muted">题目 v{context.questionRevision} · 答案 v{context.answerVersion} · 满分 {context.maxScore} 分。提交时：{effectiveGradeLabel(context.submissionGrading)}；当前有效：{effectiveGradeLabel(context.effectiveGrading)}。</p>
      {!context.canReview ? <p role="status">{context.reviewBlockedReason ?? '当前来源或作答条件不允许新增审核，历史仍可读取。'}</p> : null}
      <button type="button" className="btn" disabled={busy} onClick={() => void reload()}>重新读取评分</button>
      <h3>人工语义核对</h3>
      <p className="muted">人工审核追加新版本。掌握是否更新由准入和评分结果决定；部分得分不视为满分掌握。</p>
      {candidateId ? <p>正在审核模型候选，可修改分数与依据。<button type="button" className="btn" disabled={busy} onClick={() => { setCandidateId(null); setSemanticReviewed(false); }}>取消候选关联，独立人工评分</button></p> : null}
      <form onSubmit={review}>
        <fieldset disabled={busy || !context.canReview}>
          <div className="field"><label htmlFor={`grade-score-${context.attemptId}`}>人工确定得分</label><input data-grade-score id={`grade-score-${context.attemptId}`} type="number" min="0" max={context.maxScore} step="any" required value={earned} onChange={(event) => setEarned(event.target.value)} /></div>
          <div className="field"><label htmlFor={`grade-basis-${context.attemptId}`}>评分依据</label><textarea data-grade-basis id={`grade-basis-${context.attemptId}`} required maxLength={8000} value={basis} onChange={(event) => setBasis(event.target.value)} /></div>
          <div className="field"><label htmlFor={`grade-uncertainty-${context.attemptId}`}>不确定性或无疑点说明</label><textarea data-grade-uncertainty id={`grade-uncertainty-${context.attemptId}`} required maxLength={8000} value={uncertainty} onChange={(event) => setUncertainty(event.target.value)} /></div>
          <label><input data-grade-semantic type="checkbox" checked={semanticReviewed} onChange={(event) => setSemanticReviewed(event.target.checked)} />我已核对原答、过程和评分标准，完成语义判断</label>
          <div><button data-grade-submit type="submit" className="btn btn-primary" disabled={!semanticReviewed}>{busy ? '正在保存…' : candidateId ? '批准候选并保存人工审核' : '保存人工审核版本'}</button></div>
        </fieldset>
      </form>
      <h3>模型评分候选</h3>
      <p className="muted">仅点击下方按钮才请求模型，需要已启动运行且有可用模型连接。候选属于待审核建议，不直接更新掌握。</p>
      <button type="button" className="btn" disabled={busy || !context.canReview} onClick={() => void generate()}>请求模型评分候选</button>
      {generationRecovery ? <div role="status"><p>{generationRecovery.state === 'failed' ? '这次评分请求已失败。重复请求会返回原结果。' : '此前请求的结果尚未确认，请先重新读取评分和查看任务日志。'}如需再次调用模型，请明确发起新请求；新调用会消耗额度。</p>
        <button type="button" className="btn" disabled={busy || !context.canReview} onClick={() => {
          requestIds.current.acknowledge(generationRecovery.requestId); setGenerationRecovery(null); void generate();
        }}>发起新的模型评分请求</button></div> : null}
      {!context.candidates.length ? <p>尚无模型候选。</p> : context.candidates.map((candidate) => {
        const blocked = candidateApprovalBlocked(candidate, context.currentReviewVersion);
        return <section key={candidate.candidateId} data-grade-candidate={candidate.candidateId}>
          <h4>{candidate.status === 'pending' ? '待人工审核' : candidate.status === 'approved' ? '已人工批准' : '已拒绝'} · 模型 {candidate.requestedModel ?? '未记录'}</h4>
          <p>建议得分：{candidate.proposedEarned === null ? '未能确定' : `${candidate.proposedEarned}/${context.maxScore}`} · 依据审核 v{candidate.expectedReviewVersion}</p>
          <p>依据：{candidate.basis}</p><p>不确定性：{candidate.uncertainty}</p>
          {candidate.reviewNote ? <p>审核说明：{candidate.reviewNote}</p> : null}
          {candidate.status === 'pending' ? <><p className="muted">{blocked}</p><button type="button" className="btn" disabled={busy || !context.canReview || !!blocked} onClick={() => selectCandidate(candidate)}>载入候选进行人工审核</button>
            <div className="field"><label htmlFor={`grade-reject-${candidate.candidateId}`}>拒绝理由</label><input id={`grade-reject-${candidate.candidateId}`} disabled={busy || !context.canReview} value={rejectNotes[candidate.candidateId] ?? ''} onChange={(event) => setRejectNotes({ ...rejectNotes, [candidate.candidateId]: event.target.value })} /></div>
            <button type="button" className="btn" disabled={busy || !context.canReview} onClick={() => reject(candidate)}>拒绝候选</button></> : null}
        </section>;
      })}
      <h3>追加审核历史</h3>
      {!context.reviews.length ? <p>尚无人工审核。</p> : context.reviews.map((item) => <section key={item.reviewId}>
        <h4>审核 v{item.reviewVersion} · {effectiveGradeLabel(item.grading)}</h4>
        <p>{item.source === 'model_reviewed' ? '模型候选经人工审核' : '独立人工审核'} · 掌握更新：{item.masteryApplied ? '已应用' : '未应用'}</p>
        {item.appliedKnowledgeIds ? <p className="muted">更新 {item.appliedKnowledgeIds.length} 个知识点；保留较新作答的 {item.skippedKnowledgeIds?.length ?? 0} 个知识点。</p> : null}
        <p>依据：{item.basis}</p><p>不确定性：{item.uncertainty}</p><p className="muted">{item.createdAt}</p>
      </section>)}
      {error ? <p role="alert" className="error-text">{error}</p> : null}
      {note ? <p role="status">{note}</p> : null}
    </div>
  </details>;
}
