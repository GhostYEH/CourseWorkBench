'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { apiResponses, coursewareApplySchema } from '@sew/study-contracts';
import type {
  CoursewareCandidateDto,
  EvidenceBundleDto,
  LessonVersionDto,
  ScenePlanDto,
} from '@sew/study-contracts';
import { Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';
import { useCommand } from '../lib/use-command';
import {
  beginLessonCommandAttempt,
  lessonCommandFailureState,
  planConfirmationKey,
  type LessonCommandAttempt,
} from './lesson-command-retry';

/**
 * 完整课件计划生成（LESSON-02 / OMA-006）。
 *
 * 模型只决定「讲哪些已选陈述/题目、按什么顺序、每个场景怎么写」：场景编号、知识点与来源
 * 都由服务端从冻结证据包沿用，候选先落待核区。人工「通过」才把候选场景写成该草案版本的
 * 场景计划（需重新审核发布）；「拒绝」只留档。生成走与其他模型入口相同的 guard，
 * 未配置模型时按钮不可用，且不会发出任何请求。
 */
const CoursewareGeneration = ({
  projectId,
  generation,
  lesson,
  bundle,
  candidates,
  plan,
  configured,
}: {
  projectId: string;
  generation: number;
  lesson: LessonVersionDto;
  bundle: EvidenceBundleDto;
  candidates: CoursewareCandidateDto[];
  /** 该版本当前场景计划；用于在审批前比较候选基线与当前计划。 */
  plan: ScenePlanDto | null;
  configured: boolean;
}): ReactNode => {
  const router = useRouter();
  const [instruction, setInstruction] = useState('');
  const [note, setNote] = useState('');
  const command = useCommand([projectId, generation, lesson.lessonId, lesson.version].join(':'));
  const { error, setError, busy } = command;
  const [info, setInfo] = useState<string | null>(null);
  const [pendingRequest, setPendingRequest] = useState<LessonCommandAttempt | null>(null);
  const [pendingDecision, setPendingDecision] = useState<LessonCommandAttempt | null>(null);
  /** 用户明确确认要覆盖的计划 revision（按候选分别记录）。 */
  const [overrides, setOverrides] = useState<Record<string, string | null>>({});

  const candidatesHere = candidates.filter(
    (candidate) =>
      candidate.lessonId === lesson.lessonId && candidate.baseVersion === lesson.version,
  );
  const pending = candidatesHere.filter((candidate) => candidate.status === 'pending');
  const hasSource =
    bundle.statements.some((statement) => lesson.statementIds.includes(statement.statementId)) ||
    bundle.questions.some((question) => lesson.questionIds.includes(question.questionId));
  const currentPlanRevision = plan?.revision ?? 0;
  const confirmation = planConfirmationKey(currentPlanRevision, plan?.digest ?? null);
  const locked = busy || pendingRequest !== null || pendingDecision !== null;

  /** 候选基线 vs 当前计划：不一致即需要显式的版本比较与覆盖确认。 */
  const planConflictOf = (candidate: CoursewareCandidateDto): boolean =>
    candidate.basePlanRevision !== currentPlanRevision ||
    (candidate.basePlanDigest ?? null) !== (plan?.digest ?? null);

  const stop = (): void => {
    command.cancel();
    setPendingRequest((current) => (current ? { ...current, state: 'unknown' } : current));
    setInfo('已请求停止本次生成；已发出的调用仍计入预算。请核对回执确认是否已取消或已生成候选。');
  };

  const propose = async (): Promise<void> => {
    if (pendingRequest?.state === 'failed') return;
    if (instruction.trim().length < 2) {
      setError('请填写编排要求（至少 2 个字）。');
      return;
    }
    const submitted =
      pendingRequest ??
      beginLessonCommandAttempt(
        {
          scope: { projectId, generation },
          action: 'propose-courseware',
          lessonId: lesson.lessonId,
          version: lesson.version,
          instruction,
        },
        crypto.randomUUID(),
      );
    await command.run(
      ({ signal }) =>
        apiFetch('/api/study/lessons/courseware', apiResponses.lessonCoursewarePropose, {
          method: 'POST',
          signal,
          body: submitted.body,
        }),
      {
        onStart: () => {
          setPendingRequest({ ...submitted, state: 'pending' });
          setInfo(null);
        },
        onSuccess: (result) => {
          setPendingRequest(
            result.candidate
              ? null
              : {
                  ...submitted,
                  state: result.generation.callState === 'started' ? 'unknown' : 'failed',
                },
          );
          if (result.candidate)
            setInfo(
              `已生成 ${result.candidate.scenes.length} 个场景的课件候选（待人工核对）。` +
                ` 服务商用量：${result.generation.providerTokens ?? '未知'}；费用未知。`,
            );
          else setError(`${result.generation.message}（${result.generation.elapsedMs} ms）`);
          router.refresh();
        },
        onError: (caught) => {
          setPendingRequest({ ...submitted, state: lessonCommandFailureState(caught) });
          setError(describeApiError(caught));
        },
        onCancel: () => setPendingRequest({ ...submitted, state: 'unknown' }),
      },
    );
  };

  const decide = async (
    candidate?: CoursewareCandidateDto,
    decision?: 'approved' | 'rejected',
  ): Promise<void> => {
    if (pendingDecision?.state === 'failed') return;
    if (!pendingDecision && (!candidate || !decision)) return;
    const conflict = candidate && decision === 'approved' && planConflictOf(candidate);
    const override = Boolean(
      conflict && candidate && overrides[candidate.candidateId] === confirmation,
    );
    let submitted = pendingDecision;
    if (!submitted) {
      const requestId = crypto.randomUUID();
      const parsed = coursewareApplySchema.safeParse({
        scope: { projectId, generation },
        action: 'apply-courseware',
        requestId,
        candidateId: candidate!.candidateId,
        decision,
        note,
        expectedPlanRevision: override ? currentPlanRevision : candidate!.basePlanRevision,
        override,
      });
      if (!parsed.success) {
        setError('审核内容无效：备注最多 500 字，请修改后提交。');
        return;
      }
      submitted = beginLessonCommandAttempt(parsed.data, requestId);
    }
    const original = submitted;
    await command.run(
      ({ signal }) =>
        apiFetch('/api/study/lessons', apiResponses.lessonCoursewareApply, {
          method: 'POST',
          signal,
          body: original.body,
        }),
      {
        onStart: () => {
          setPendingDecision({ ...original, state: 'pending' });
          setInfo(null);
        },
        onSuccess: (result) => {
          setPendingDecision(null);
          setInfo(
            result.candidate.status === 'applied'
              ? `候选已通过，已写入场景计划（${result.plan?.scenes.length ?? 0} 个场景，修订 ${result.plan?.revision ?? '?'}）。`
              : '候选已拒绝，只留档，未改写场景计划。',
          );
          setOverrides((current) => {
            const next = { ...current };
            delete next[result.candidate.candidateId];
            return next;
          });
          router.refresh();
        },
        onError: (caught) => {
          setPendingDecision({ ...original, state: lessonCommandFailureState(caught) });
          setError(describeApiError(caught));
        },
      },
    );
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
              disabled={locked}
              data-courseware-instruction
            />
          </div>
          <div className="row-inline">
            <button
              type="button"
              className="btn"
              onClick={() => void propose()}
              disabled={locked || !configured || instruction.trim().length < 2}
              data-courseware-generate
            >
              {busy ? '处理中…' : '生成完整课件候选'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={stop}
              disabled={!busy || pendingRequest === null}
              title="断开本次请求并中止正在执行的模型调用"
            >
              停止本次生成
            </button>
            {!configured ? <span className="muted">尚未配置模型连接，无法生成候选。</span> : null}
          </div>
        </>
      )}

      {pendingRequest?.state === 'unknown' ? (
        <Notice tone="pending">
          原生成请求与编号已保留；核对回执只恢复本次结果，已派发的模型调用不会重发。未知用量仍占预算。
          <button
            type="button"
            className="btn"
            disabled={busy}
            data-courseware-retry
            onClick={() => void propose()}
          >
            核对生成回执
          </button>
        </Notice>
      ) : null}
      {pendingRequest?.state === 'failed' ? (
        <Notice tone="pending">
          本次生成已确定失败或取消。可修改要求后明确开始新的模型尝试。
          <button
            type="button"
            className="btn"
            disabled={busy}
            data-courseware-new-attempt
            onClick={() => {
              setPendingRequest(null);
              setError(null);
            }}
          >
            开启新的生成尝试
          </button>
        </Notice>
      ) : null}
      {pendingDecision?.state === 'unknown' ? (
        <Notice tone="pending">
          本次审核结果尚未确认，决定与请求编号已保留；已提交的审核不会重复写入计划。
          <button
            type="button"
            className="btn"
            disabled={busy}
            data-courseware-decision-retry
            onClick={() => void decide()}
          >
            核对审核回执
          </button>
        </Notice>
      ) : null}
      {pendingDecision?.state === 'failed' ? (
        <Notice tone="pending">
          回执确认本次审核失败或取消，未写入计划。请重新比较当前计划后开启新尝试。
          <button
            type="button"
            className="btn"
            disabled={busy}
            data-courseware-decision-new-attempt
            onClick={() => {
              setPendingDecision(null);
              setOverrides({});
              setError(null);
            }}
          >
            开启新的审核尝试
          </button>
        </Notice>
      ) : null}

      {pending.length > 0 ? (
        <div style={{ marginTop: 'var(--sew-space-3)' }}>
          <h3>待核候选（{pending.length}）</h3>
          <div className="field">
            <label htmlFor={`courseware-note-${lesson.lessonId}-${lesson.version}`}>审核备注</label>
            <input
              id={`courseware-note-${lesson.lessonId}-${lesson.version}`}
              value={note}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
              placeholder="例如：场景顺序与知识点覆盖合理，通过"
              disabled={locked}
            />
          </div>
          <ul>
            {pending.map((candidate) => {
              const conflict = planConflictOf(candidate);
              const override = overrides[candidate.candidateId] === confirmation;
              return (
                <li key={candidate.candidateId} data-courseware-candidate={candidate.candidateId}>
                  <p className="hint mono">
                    生成基线：计划修订 {candidate.basePlanRevision}
                    {candidate.basePlanDigest
                      ? ` · ${candidate.basePlanDigest.slice(0, 12)}…`
                      : '（当时无计划）'}
                    {' ／ '}当前计划修订 {currentPlanRevision}
                    {plan?.digest ? ` · ${plan.digest.slice(0, 12)}…` : '（当前无计划）'}
                  </p>
                  {conflict ? (
                    <Notice tone="pending">
                      该候选基于旧计划（修订 {candidate.basePlanRevision}），当前计划已是修订{' '}
                      {currentPlanRevision}。通过它不会静默覆盖当前编辑：请先比较两侧内容，
                      确认后才可勾选下方选项覆盖。
                    </Notice>
                  ) : null}
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
                    {conflict ? (
                      <label className="secondary">
                        <input
                          type="checkbox"
                          checked={override}
                          disabled={locked}
                          data-courseware-override={candidate.candidateId}
                          onChange={(event) =>
                            setOverrides((current) => ({
                              ...current,
                              [candidate.candidateId]: event.target.checked ? confirmation : null,
                            }))
                          }
                        />{' '}
                        确认覆盖当前计划（修订 {currentPlanRevision}）
                      </label>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={locked || (conflict && !override)}
                      data-courseware-approve={candidate.candidateId}
                      onClick={() => void decide(candidate, 'approved')}
                    >
                      通过并写入计划
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={locked}
                      data-courseware-reject={candidate.candidateId}
                      onClick={() => void decide(candidate, 'rejected')}
                    >
                      拒绝
                    </button>
                  </div>
                </li>
              );
            })}
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

export const LessonCoursewareGeneration = (
  props: Parameters<typeof CoursewareGeneration>[0],
): ReactNode => (
  <CoursewareGeneration
    key={[props.projectId, props.generation, props.lesson.lessonId, props.lesson.version].join(':')}
    {...props}
  />
);
