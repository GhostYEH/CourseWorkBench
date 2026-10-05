'use client';

import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { apiResponses } from '@sew/study-contracts';
import type {
  EvidenceBundleDto,
  LessonVersionDto,
  StatementRevisionCandidateDto,
} from '@sew/study-contracts';
import { Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';

/**
 * 陈述正文改写候选（LESSON-02）。
 *
 * 模型改写只改表述：候选的正文先落在待核区，原陈述、原证据包与已发布版本保持不变。
 * 只有人工「通过」才会派生新的草案版本（必须重新审核发布）；「拒绝」只留档。
 * 生成走与课程草案相同的 guard，未配置模型时按钮不可用，且不会发出任何请求。
 */
export const LessonStatementRevision = ({
  projectId,
  generation,
  lesson,
  bundle,
  candidates,
  configured,
}: {
  projectId: string;
  generation: number;
  lesson: LessonVersionDto;
  bundle: EvidenceBundleDto;
  candidates: StatementRevisionCandidateDto[];
  configured: boolean;
}): ReactNode => {
  const router = useRouter();
  const [statementId, setStatementId] = useState(
    bundle.statements.find((statement) => lesson.statementIds.includes(statement.statementId))
      ?.statementId ??
      bundle.statements[0]?.statementId ??
      '',
  );
  const [instruction, setInstruction] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inflight = useRef<AbortController | null>(null);
  const pendingRequest = useRef<{ key: string; id: string } | null>(null);

  const candidatesHere = candidates.filter(
    (candidate) =>
      candidate.lessonId === lesson.lessonId && candidate.baseVersion === lesson.version,
  );
  const pending = candidatesHere.filter((candidate) => candidate.status === 'pending');
  // 只列出本版本实际选中的场景：改写不会把基线已排除的场景加回来。
  const revisableStatements = bundle.statements.filter((statement) =>
    lesson.statementIds.includes(statement.statementId),
  );
  const baseStatement =
    bundle.statements.find((statement) => statement.statementId === statementId) ?? null;

  const stop = (): void => {
    inflight.current?.abort('用户已停止本次改写生成');
    setInfo('已请求停止本次改写；已发出的调用仍计入预算，迟到的正文不会进入候选。');
  };

  const propose = async (): Promise<void> => {
    if (inflight.current) return;
    if (!statementId) {
      setError('该证据包没有可改写的陈述。');
      return;
    }
    if (instruction.trim().length < 2) {
      setError('请填写改写要求（至少 2 个字）。');
      return;
    }
    setBusy(true);
    setError(null);
    setInfo(null);
    const controller = new AbortController();
    inflight.current = controller;
    try {
      const key = `${lesson.lessonId}:${lesson.version}:${statementId}:${instruction.trim()}`;
      const requestId =
        pendingRequest.current?.key === key ? pendingRequest.current.id : crypto.randomUUID();
      pendingRequest.current = { key, id: requestId };
      const result = await apiFetch(
        '/api/study/lessons/revision',
        apiResponses.lessonRevisionPropose,
        {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({
            scope: { projectId, generation },
            action: 'propose-statement-revision',
            requestId,
            lessonId: lesson.lessonId,
            version: lesson.version,
            statementId,
            instruction,
          }),
        },
      );
      // 收到确定结果即视为本次 requestId 已消费：成功重试要复用同一候选（服务端幂等），
      // 但失败重试必须换新号，否则会撞上已占用的调用号而被拒。
      pendingRequest.current = null;
      if (result.candidate) {
        setInfo(
          `已生成改写候选（待人工核对）。服务商用量：${result.generation.providerTokens ?? '未知'}；费用未知。`,
        );
      } else {
        setError(`${result.generation.message}（${result.generation.elapsedMs} ms）`);
      }
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      inflight.current = null;
      setBusy(false);
    }
  };

  const decide = async (
    candidate: StatementRevisionCandidateDto,
    decision: 'approved' | 'rejected',
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const result = await apiFetch('/api/study/lessons', apiResponses.lessonRevisionApply, {
        method: 'POST',
        body: JSON.stringify({
          scope: { projectId, generation },
          action: 'apply-statement-revision',
          requestId: crypto.randomUUID(),
          candidateId: candidate.candidateId,
          decision,
          note,
        }),
      });
      setInfo(
        decision === 'approved'
          ? `候选已通过，已派生新草案版本 v${result.lesson?.version ?? '?'}（需重新审核后才能发布）。`
          : '候选已拒绝，只留档，未产生新版本。',
      );
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="card">
      <summary>陈述正文改写（模型候选 → 人工审核 → 新草案版本）</summary>
      <p className="muted">
        基线：v{lesson.version}。改写只改表述，知识点与来源保持不变；候选先落待核区，
        通过后派生新草案版本并需重新审核，原版本保持不变。
      </p>
      <div className="field">
        <label htmlFor={`revision-statement-${lesson.lessonId}-${lesson.version}`}>
          要改写的陈述
        </label>
        <select
          id={`revision-statement-${lesson.lessonId}-${lesson.version}`}
          value={statementId}
          onChange={(event) => setStatementId(event.target.value)}
          disabled={busy || bundle.statements.length === 0}
          data-revision-statement
        >
          {revisableStatements.map((statement) => (
            <option key={statement.statementId} value={statement.statementId}>
              {statement.text.slice(0, 40)}
              {statement.text.length > 40 ? '…' : ''}
            </option>
          ))}
        </select>
        {baseStatement ? (
          <span className="hint mono">
            {baseStatement.statementId} · 知识点 {baseStatement.knowledgeId} · 来源{' '}
            {baseStatement.evidence
              .map((item) => `${item.materialId}#${item.segmentId}`)
              .join('、')}
          </span>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor={`revision-instruction-${lesson.lessonId}-${lesson.version}`}>
          改写要求（按数据对待，不作为事实来源）
        </label>
        <input
          id={`revision-instruction-${lesson.lessonId}-${lesson.version}`}
          type="text"
          maxLength={600}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder="例如：表述更口语，保留原条件"
          disabled={busy}
          data-revision-instruction
        />
      </div>
      <div className="row-inline">
        <button
          type="button"
          className="btn"
          onClick={() => void propose()}
          disabled={busy || !configured || !statementId || instruction.trim().length < 2}
          data-revision-generate
        >
          {busy ? '处理中…' : '生成改写候选'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={stop}
          disabled={!busy}
          title="断开本次请求并中止正在执行的模型调用"
        >
          停止本次改写
        </button>
        {!configured ? <span className="muted">尚未配置模型连接，无法生成候选。</span> : null}
      </div>

      {pending.length > 0 ? (
        <div style={{ marginTop: 'var(--sew-space-3)' }}>
          <h3>待核候选（{pending.length}）</h3>
          <div className="field">
            <label htmlFor={`revision-note-${lesson.lessonId}-${lesson.version}`}>审核备注</label>
            <input
              id={`revision-note-${lesson.lessonId}-${lesson.version}`}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="例如：与教材第 2 段一致，通过"
              disabled={busy}
            />
          </div>
          <ul>
            {pending.map((candidate) => (
              <li key={candidate.candidateId} data-revision-candidate={candidate.candidateId}>
                <p className="secondary" style={{ whiteSpace: 'pre-wrap' }}>
                  {candidate.proposedText}
                </p>
                <p className="hint mono">
                  知识点 {candidate.knowledgeId} · 来源
                  {candidate.evidence
                    .map((item) => ` ${item.materialId}#${item.segmentId}`)
                    .join('、')}
                </p>
                <div className="row-inline">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    data-revision-approve={candidate.candidateId}
                    onClick={() => void decide(candidate, 'approved')}
                  >
                    通过并派生新版本
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    data-revision-reject={candidate.candidateId}
                    onClick={() => void decide(candidate, 'rejected')}
                  >
                    拒绝
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="muted">暂无待核候选。生成后需人工通过才会派生新版本。</p>
      )}

      {info ? <Notice tone="verified">{info}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </details>
  );
};
