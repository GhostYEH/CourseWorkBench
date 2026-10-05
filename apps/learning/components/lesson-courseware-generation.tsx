'use client';

import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { apiResponses } from '@sew/study-contracts';
import type {
  CoursewareCandidateDto,
  EvidenceBundleDto,
  LessonVersionDto,
} from '@sew/study-contracts';
import { Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';

/**
 * 完整课件计划生成（LESSON-02 / OMA-006）。
 *
 * 模型只决定「讲哪些已选陈述/题目、按什么顺序、每个场景怎么写」：场景编号、知识点与来源
 * 都由服务端从冻结证据包沿用，候选先落待核区。人工「通过」才把候选场景写成该草案版本的
 * 场景计划（需重新审核发布）；「拒绝」只留档。生成走与其他模型入口相同的 guard，
 * 未配置模型时按钮不可用，且不会发出任何请求。
 */
export const LessonCoursewareGeneration = ({
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
  candidates: CoursewareCandidateDto[];
  configured: boolean;
}): ReactNode => {
  const router = useRouter();
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
  const hasSource =
    bundle.statements.some((statement) => lesson.statementIds.includes(statement.statementId)) ||
    bundle.questions.some((question) => lesson.questionIds.includes(question.questionId));

  const stop = (): void => {
    inflight.current?.abort('用户已停止本次课件生成');
    setInfo('已请求停止本次生成；已发出的调用仍计入预算，迟到的场景不会进入候选。');
  };

  const propose = async (): Promise<void> => {
    if (inflight.current) return;
    if (instruction.trim().length < 2) {
      setError('请填写编排要求（至少 2 个字）。');
      return;
    }
    setBusy(true);
    setError(null);
    setInfo(null);
    const controller = new AbortController();
    inflight.current = controller;
    try {
      const key = `${lesson.lessonId}:${lesson.version}:${instruction.trim()}`;
      const requestId =
        pendingRequest.current?.key === key ? pendingRequest.current.id : crypto.randomUUID();
      pendingRequest.current = { key, id: requestId };
      const result = await apiFetch(
        '/api/study/lessons/courseware',
        apiResponses.lessonCoursewarePropose,
        {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({
            scope: { projectId, generation },
            action: 'propose-courseware',
            requestId,
            lessonId: lesson.lessonId,
            version: lesson.version,
            instruction,
          }),
        },
      );
      // 收到确定结果即视为本次 requestId 已消费：成功重试复用同一候选，失败重试换新号。
      pendingRequest.current = null;
      if (result.candidate) {
        setInfo(
          `已生成 ${result.candidate.scenes.length} 个场景的课件候选（待人工核对）。` +
            ` 服务商用量：${result.generation.providerTokens ?? '未知'}；费用未知。`,
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
    candidate: CoursewareCandidateDto,
    decision: 'approved' | 'rejected',
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const result = await apiFetch('/api/study/lessons', apiResponses.lessonCoursewareApply, {
        method: 'POST',
        body: JSON.stringify({
          scope: { projectId, generation },
          action: 'apply-courseware',
          requestId: crypto.randomUUID(),
          candidateId: candidate.candidateId,
          decision,
          note,
        }),
      });
      setInfo(
        decision === 'approved'
          ? `候选已通过，已写入场景计划（${result.plan?.scenes.length ?? 0} 个场景，修订 ${result.plan?.revision ?? '?'}）。`
          : '候选已拒绝，只留档，未改写场景计划。',
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
      <summary>完整课件生成（模型候选 → 人工审核 → 写入场景计划）</summary>
      <p className="muted">
        基线：v{lesson.version}
        。模型只能编排本版本已选中的陈述与题目；场景编号、知识点与来源由服务端沿用，
        候选先落待核区，通过后写入场景计划并需重新审核，原计划保持不变。
      </p>
      {!hasSource ? (
        <p className="muted">本版本没有已选中的陈述或题目，无法生成完整课件。</p>
      ) : (
        <>
          <div className="field">
            <label htmlFor={`courseware-instruction-${lesson.lessonId}-${lesson.version}`}>
              编排要求（按数据对待，不作为事实来源）
            </label>
            <input
              id={`courseware-instruction-${lesson.lessonId}-${lesson.version}`}
              type="text"
              maxLength={600}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="例如：先给定义幻灯片，再给一道独立测验"
              disabled={busy}
              data-courseware-instruction
            />
          </div>
          <div className="row-inline">
            <button
              type="button"
              className="btn"
              onClick={() => void propose()}
              disabled={busy || !configured || instruction.trim().length < 2}
              data-courseware-generate
            >
              {busy ? '处理中…' : '生成完整课件候选'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={stop}
              disabled={!busy}
              title="断开本次请求并中止正在执行的模型调用"
            >
              停止本次生成
            </button>
            {!configured ? <span className="muted">尚未配置模型连接，无法生成候选。</span> : null}
          </div>
        </>
      )}

      {pending.length > 0 ? (
        <div style={{ marginTop: 'var(--sew-space-3)' }}>
          <h3>待核候选（{pending.length}）</h3>
          <div className="field">
            <label htmlFor={`courseware-note-${lesson.lessonId}-${lesson.version}`}>审核备注</label>
            <input
              id={`courseware-note-${lesson.lessonId}-${lesson.version}`}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="例如：场景顺序与知识点覆盖合理，通过"
              disabled={busy}
            />
          </div>
          <ul>
            {pending.map((candidate) => (
              <li key={candidate.candidateId} data-courseware-candidate={candidate.candidateId}>
                <ol className="check-list">
                  {candidate.scenes.map((scene) => (
                    <li key={scene.sceneId}>
                      <span className="pill">{scene.kind}</span> {scene.title}
                      {scene.statementId ? (
                        <span className="muted mono"> · {scene.statementId}</span>
                      ) : null}
                      {scene.questionId ? (
                        <span className="muted mono"> · {scene.questionId}</span>
                      ) : null}
                    </li>
                  ))}
                </ol>
                <div className="row-inline">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    data-courseware-approve={candidate.candidateId}
                    onClick={() => void decide(candidate, 'approved')}
                  >
                    通过并写入计划
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    data-courseware-reject={candidate.candidateId}
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
        <p className="muted">暂无待核候选。生成后需人工通过才会写入场景计划。</p>
      )}

      {info ? <Notice tone="verified">{info}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </details>
  );
};
