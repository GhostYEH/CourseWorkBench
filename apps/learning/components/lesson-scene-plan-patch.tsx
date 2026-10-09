'use client';

/**
 * 受限 AI 场景计划补丁（LESSON-02 / OMA-023）。
 *
 * 模型只能提出受限操作（改标题/备注、元素正文/几何/样式、增删元素）；来源绑定、知识点、
 * 场景身份都不在合同里。候选先落待核区，界面把每条操作「能不能应用、应用后是什么」逐项摊开，
 * 用户勾选要采用的操作后再提交；通过走 save-scene-plan 的乐观并发，内容一变旧审核即失效。
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { apiResponses, scenePlanPatchApplySchema } from '@sew/study-contracts';
import type {
  LessonVersionDto,
  ScenePlanDto,
  ScenePlanPatchCandidateDto,
  ScenePlanPatchPreviewDto,
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

const OP_LABEL: Record<string, string> = {
  'replace-scene': '改场景',
  'replace-element': '改元素',
  'add-element': '加元素',
  'remove-element': '删元素',
};

/** 预览指纹：选择或计划基线任一变化都会改变它，用于丢弃迟到的旧预览。 */
const previewFingerprint = (
  candidateId: string,
  selection: number[] | undefined,
  revision: number,
  digest: string | null,
): string => JSON.stringify([candidateId, selection ?? 'all', revision, digest]);

const ScenePlanPatch = ({
  projectId,
  generation,
  lesson,
  plan,
  candidates,
  configured,
}: {
  projectId: string;
  generation: number;
  lesson: LessonVersionDto;
  plan: ScenePlanDto | null;
  candidates: ScenePlanPatchCandidateDto[];
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
  const [selection, setSelection] = useState<Record<string, number[] | undefined>>({});
  const [overrides, setOverrides] = useState<Record<string, string | null>>({});
  /** 每个候选的服务端只读预览（逐条判定）；加载失败时回落到「直接通过」而不静默假设。 */
  const [previews, setPreviews] = useState<Record<string, ScenePlanPatchPreviewDto>>({});
  const [previewBusy, setPreviewBusy] = useState<string | null>(null);
  /** 每个候选最近一次预览请求的指纹：迟到的旧响应不覆盖新选择。 */
  const previewTokens = useRef<Record<string, string>>({});

  const candidatesHere = candidates.filter(
    (candidate) =>
      candidate.lessonId === lesson.lessonId && candidate.baseVersion === lesson.version,
  );
  const pending = candidatesHere.filter((candidate) => candidate.status === 'pending');
  const currentPlanRevision = plan?.revision ?? 0;
  const confirmation = planConfirmationKey(currentPlanRevision, plan?.digest ?? null);
  const locked = busy || pendingRequest !== null || pendingDecision !== null;
  const pendingKey = pending.map((candidate) => candidate.candidateId).join(',');

  const planConflictOf = (candidate: ScenePlanPatchCandidateDto): boolean =>
    candidate.basePlanRevision !== currentPlanRevision ||
    (candidate.basePlanDigest ?? null) !== (plan?.digest ?? null);

  const stop = (): void => {
    command.cancel();
    setPendingRequest((current) => (current ? { ...current, state: 'unknown' } : current));
    setInfo('已请求停止本次生成；已发出的调用仍计入预算。请核对回执确认是否已取消或已生成候选。');
  };

  /** 加载服务端只读预览：按**当前选择**逐条判定候选操作并给出应用后的计划摘要。 */
  const loadPreview = async (
    candidate: ScenePlanPatchCandidateDto,
    chosen: number[] | undefined,
  ): Promise<void> => {
    const fingerprint = previewFingerprint(
      candidate.candidateId,
      chosen,
      currentPlanRevision,
      plan?.digest ?? null,
    );
    previewTokens.current[candidate.candidateId] = fingerprint;
    setPreviewBusy(candidate.candidateId);
    await command.run(
      ({ signal }) =>
        apiFetch('/api/study/lessons', apiResponses.lessonScenePlanPatchPreview, {
          method: 'POST',
          signal,
          body: JSON.stringify({
            scope: { projectId, generation },
            action: 'preview-scene-plan-patch',
            candidateId: candidate.candidateId,
            ...(chosen === undefined ? {} : { selectedOpIndexes: chosen }),
          }),
        }),
      {
        onSuccess: (result) => {
          // 迟到/过期预览（选择或基线已变）不覆盖新选择对应的预览。
          if (previewTokens.current[candidate.candidateId] !== fingerprint) return;
          setPreviews((current) => ({ ...current, [result.candidate.candidateId]: result.preview }));
          setError(null);
        },
        onError: (caught) => setError(describeApiError(caught)),
      },
    );
    if (previewTokens.current[candidate.candidateId] === fingerprint) setPreviewBusy(null);
  };

  /**
   * 选择或计划基线变化时，按当前选择重新计算预览（旧预览立即失效）。
   * 未加载过预览的候选不主动触发，避免打开面板就批量请求。
   */
  useEffect(() => {
    for (const candidate of pending) {
      if (!previews[candidate.candidateId]) continue;
      const chosen = selection[candidate.candidateId];
      const fingerprint = previewFingerprint(
        candidate.candidateId,
        chosen,
        currentPlanRevision,
        plan?.digest ?? null,
      );
      if (previewTokens.current[candidate.candidateId] === fingerprint) continue;
      void loadPreview(candidate, chosen);
    }
    // loadPreview 依赖当前 plan/revision；以指纹为准，避免重复触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, selection, currentPlanRevision, plan?.digest]);

  const propose = async (): Promise<void> => {
    if (pendingRequest?.state === 'failed') return;
    if (instruction.trim().length < 2) {
      setError('请填写补丁要求（至少 2 个字）。');
      return;
    }
    const submitted =
      pendingRequest ??
      beginLessonCommandAttempt(
        {
          scope: { projectId, generation },
          action: 'propose-scene-plan-patch',
          lessonId: lesson.lessonId,
          version: lesson.version,
          instruction,
        },
        crypto.randomUUID(),
      );
    await command.run(
      ({ signal }) =>
        apiFetch('/api/study/lessons/patch', apiResponses.lessonScenePlanPatchPropose, {
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
              `已生成 ${result.candidate.ops.length} 条受限补丁操作（待逐项核对）。` +
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
    candidate?: ScenePlanPatchCandidateDto,
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
      const parsed = scenePlanPatchApplySchema.safeParse({
        scope: { projectId, generation },
        action: 'apply-scene-plan-patch',
        requestId,
        candidateId: candidate!.candidateId,
        decision,
        note,
        selectedOpIndexes:
          decision === 'approved' ? selection[candidate!.candidateId] : undefined,
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
        apiFetch('/api/study/lessons', apiResponses.lessonScenePlanPatchApply, {
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
              ? `补丁已通过：应用 ${result.preview.appliedCount} 条、拒绝 ${result.preview.rejectedCount} 条；计划修订 ${result.plan?.revision ?? '?'}，需重新审核才能发布。`
              : '补丁已拒绝，只留档，未改写场景计划。',
          );
          setSelection((current) => {
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
      <summary>受限 AI 补丁（模型受限操作 → 逐项审核 → 写入场景计划）</summary>
      <p className="muted">
        基线：v{lesson.version}
        。模型只能改标题/备注、元素正文/几何/样式或增删元素；来源绑定、知识点与场景身份不在
        补丁合同里。候选先落待核区，逐项审核通过后才写进计划并需重新审核。需要先有已保存的场景计划。
      </p>
      {!plan ? (
        <p className="muted">本版本尚无场景计划，请先保存一次计划再使用 AI 补丁。</p>
      ) : (
        <>
          <div className="field">
            <label htmlFor={`patch-instruction-${lesson.lessonId}-${lesson.version}`}>
              补丁要求（按数据对待，不作为事实来源）
            </label>
            <input
              id={`patch-instruction-${lesson.lessonId}-${lesson.version}`}
              type="text"
              maxLength={600}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="例如：把标题改得更口语，并把第一段正文加粗"
              disabled={locked}
              data-patch-instruction
            />
          </div>
          <div className="row-inline">
            <button
              type="button"
              className="btn"
              onClick={() => void propose()}
              disabled={locked || !configured || instruction.trim().length < 2}
              data-patch-generate
            >
              {busy ? '处理中…' : '生成受限补丁候选'}
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
            data-patch-retry
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
            data-patch-new-attempt
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
            data-patch-decision-retry
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
            data-patch-decision-new-attempt
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
          <h3>待核补丁（{pending.length}）</h3>
          <div className="field">
            <label htmlFor={`patch-note-${lesson.lessonId}-${lesson.version}`}>审核备注</label>
            <input
              id={`patch-note-${lesson.lessonId}-${lesson.version}`}
              value={note}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
              placeholder="例如：只采用前两条，其余拒绝"
              disabled={locked}
            />
          </div>
          <ul>
            {pending.map((candidate) => {
              const conflict = planConflictOf(candidate);
              const override = overrides[candidate.candidateId] === confirmation;
              return (
                <li key={candidate.candidateId} data-patch-candidate={candidate.candidateId}>
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
                  <p className="muted">补丁操作（服务端逐条判定；被拒绝的不会写入）：</p>
                  {previews[candidate.candidateId] ? (
                    <>
                      <ul className="check-list">
                        {previews[candidate.candidateId]!.results.map((result) => {
                          const applicable = result.status === 'applicable';
                          const chosen =
                            selection[candidate.candidateId]?.includes(result.index) ?? true;
                          return (
                            <li key={result.index} data-patch-op={result.index}>
                              <label className="secondary">
                                <input
                                  type="checkbox"
                                  checked={applicable && chosen}
                                  disabled={locked || !applicable}
                                  data-patch-op-select={result.index}
                                  onChange={(event) => {
                                    const all = previews[candidate.candidateId]!.results
                                      .filter((item) => item.status === 'applicable')
                                      .map((item) => item.index);
                                    const current = new Set(
                                      selection[candidate.candidateId] ?? all,
                                    );
                                    if (event.target.checked) current.add(result.index);
                                    else current.delete(result.index);
                                    setSelection((state) => ({
                                      ...state,
                                      [candidate.candidateId]: [...current].sort((a, b) => a - b),
                                    }));
                                  }}
                                />{' '}
                                <span className="pill">{OP_LABEL[result.op] ?? result.op}</span>{' '}
                                {result.summary}
                                {!applicable ? (
                                  <span className="muted"> · 不会写入（{result.reason}）</span>
                                ) : null}
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                      <p className="muted" data-patch-preview-summary={candidate.candidateId}>
                        可应用 {previews[candidate.candidateId]!.applicableCount} 条 · 已勾选{' '}
                        {previews[candidate.candidateId]!.selectedCount} 条 · 将写入{' '}
                        {previews[candidate.candidateId]!.appliedCount} 条 · 拒绝{' '}
                        {previews[candidate.candidateId]!.rejectedCount} 条；结果计划{' '}
                        {previews[candidate.candidateId]!.scenes.length} 个场景，摘要{' '}
                        <span className="mono">
                          {previews[candidate.candidateId]!.digest.slice(0, 12)}…
                        </span>
                        。未勾选的可应用操作不会写入。
                      </p>
                    </>
                  ) : (
                    <div className="row-inline">
                      <span className="muted">
                        尚未加载逐项预览；通过前请先查看每条操作能否应用。
                      </span>
                      <button
                        type="button"
                        className="btn"
                        disabled={locked || previewBusy === candidate.candidateId}
                        data-patch-preview={candidate.candidateId}
                        onClick={() => void loadPreview(candidate, selection[candidate.candidateId])}
                      >
                        {previewBusy === candidate.candidateId ? '加载中…' : '加载逐项预览'}
                      </button>
                    </div>
                  )}
                  <div className="row-inline">
                    {conflict ? (
                      <label className="secondary">
                        <input
                          type="checkbox"
                          checked={override}
                          disabled={locked}
                          data-patch-override={candidate.candidateId}
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
                      data-patch-approve={candidate.candidateId}
                      onClick={() => void decide(candidate, 'approved')}
                    >
                      通过并写入计划
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={locked}
                      data-patch-reject={candidate.candidateId}
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
        <p className="muted">暂无待核补丁。生成后需逐项人工通过才会写入场景计划。</p>
      )}

      {info ? <Notice tone="verified">{info}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </details>
  );
};

export const LessonScenePlanPatch = (props: Parameters<typeof ScenePlanPatch>[0]): ReactNode => (
  <ScenePlanPatch
    key={[props.projectId, props.generation, props.lesson.lessonId, props.lesson.version].join(':')}
    {...props}
  />
);
