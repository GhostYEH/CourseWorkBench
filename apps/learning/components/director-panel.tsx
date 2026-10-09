'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  directorViewSchema,
  type DirectorCommandDto,
  type DirectorStateDto,
} from '@sew/study-contracts';
import { apiFetch, describeApiError } from '../lib/client';
import { Notice } from './ui';
import { createDirectorResponseGate } from '../lib/director-response-gate';

const stateLabels: Record<DirectorStateDto['state'], string> = {
  ready: '可继续',
  running: '教师生成中',
  paused: '已暂停',
  awaiting_review: '等待审核',
  awaiting_learner: '等待本人',
  unknown: '结果未确认',
  completed: '已完成',
  stopped: '已停止',
};

/** Explicit single-step scheduling: no effect, polling or page read dispatches a model call. */
export function DirectorPanel({
  projectId,
  generation,
  sessionId,
  initial,
  onChange,
}: {
  projectId: string;
  generation: number;
  sessionId: string;
  initial: DirectorStateDto | null;
  onChange?: () => void | Promise<void>;
}): ReactNode {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reviewChecked, setReviewChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const savedRequests = useRef(new Map<string, DirectorCommandDto>());
  const responses = useRef(createDirectorResponseGate());
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const version = responses.current.beginRead();
    const query = new URLSearchParams({ projectId, generation: String(generation), sessionId });
    void apiFetch(`/api/study/director?${query}`, directorViewSchema, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted && responses.current.acceptsRead(version))
          setState(data.director);
      })
      .catch((caught) => {
        if (!controller.signal.aborted && responses.current.acceptsRead(version))
          setError(describeApiError(caught));
      });
    return () => controller.abort();
  }, [projectId, generation, sessionId]);
  const step = state?.steps.find(
    (item) =>
      item.sceneId === state.sceneIds[state.sceneIndex] &&
      !['delivered', 'skipped'].includes(item.state),
  );
  const terminal = state?.state === 'stopped' || state?.state === 'completed';
  const refresh = async (): Promise<void> => {
    const owner = lifetime.current;
    const version = responses.current.beginRead();
    try {
      const query = new URLSearchParams({ projectId, generation: String(generation), sessionId });
      const data = await apiFetch(`/api/study/director?${query}`, directorViewSchema, {
        signal: owner?.signal,
      });
      if (
        lifetime.current === owner &&
        !owner?.signal.aborted &&
        responses.current.acceptsRead(version)
      )
        setState(data.director);
    } catch (caught) {
      if (
        lifetime.current === owner &&
        !owner?.signal.aborted &&
        responses.current.acceptsRead(version)
      )
        setError(describeApiError(caught));
    }
  };
  const command = async (
    operation:
      | { action: 'start' | 'continue' | 'pause' | 'stop' }
      | { action: 'review'; decision: 'approved' | 'rejected' },
  ): Promise<void> => {
    const control = operation.action === 'pause' || operation.action === 'stop';
    if (busy && !control) return;
    setError(null);
    if (!control) setBusy(true);
    const owner = lifetime.current;
    const operationKey = JSON.stringify({
      projectId,
      generation,
      sessionId,
      operation,
      stepId: operation.action === 'review' ? step?.stepId : undefined,
    });
    const candidate: DirectorCommandDto =
      operation.action === 'review'
        ? {
            scope: { projectId, generation },
            sessionId,
            requestId: crypto.randomUUID(),
            ...operation,
            stepId: step!.stepId,
            candidateDigest: step!.candidate!.digest,
            semanticReviewed: operation.decision === 'approved' && reviewChecked,
            note: '',
          }
        : {
            scope: { projectId, generation },
            sessionId,
            requestId: crypto.randomUUID(),
            ...operation,
          };
    const input = savedRequests.current.get(operationKey) ?? candidate;
    savedRequests.current.set(operationKey, input);
    const version = responses.current.beginCommand();
    try {
      const data = await apiFetch('/api/study/director', directorViewSchema, {
        method: 'POST',
        body: JSON.stringify(input),
        signal: owner?.signal,
      });
      if (lifetime.current === owner && !owner?.signal.aborted) {
        savedRequests.current.delete(operationKey);
        if (responses.current.commitCommand(version)) {
          setState(data.director);
          setReviewChecked(false);
          await onChange?.();
        }
      }
    } catch (caught) {
      if (
        lifetime.current === owner &&
        !owner?.signal.aborted &&
        responses.current.isCurrentCommand(version)
      ) {
        setError(`${describeApiError(caught)} 再次提交会沿用原请求编号。`);
        await refresh();
      }
    } finally {
      if (!control && lifetime.current === owner && !owner?.signal.aborted) setBusy(false);
    }
  };
  return (
    <div className="card" data-director-panel>
      <h3>逐场景审核调度</h3>
      <p className="muted">
        教师讲解使用当前模型，候选需人工核对。模拟同学只复述冻结内容，属于
        simulation；每次继续执行一项。共享额度用满会暂停。
      </p>
      {state ? (
        <>
          <p>
            {stateLabels[state.state]} · 场景 {state.sceneIndex + 1}/{state.sceneIds.length}
          </p>
          <p>{state.message}</p>
        </>
      ) : (
        <p>调度会从当前正式课堂场景开始，不自动派发。</p>
      )}
      {step ? (
        <p>
          当前：
          {step.role === 'peer'
            ? `${step.roleName}（冻结内容的模拟同学）`
            : step.role === 'teacher'
              ? 'AI 教师候选'
              : '本人作答'}{' '}
          · {step.state}
        </p>
      ) : null}
      {step?.candidate ? (
        <>
          <blockquote>{step.candidate.text}</blockquote>
          {step.state === 'pending_review' ? (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={reviewChecked}
                  disabled={busy}
                  onChange={(event) => setReviewChecked(event.target.checked)}
                />
                我已对照当前场景冻结来源核对这段候选
              </label>
              <div className="row-inline">
                <button
                  className="btn"
                  type="button"
                  disabled={busy || !reviewChecked}
                  onClick={() => void command({ action: 'review', decision: 'approved' })}
                >
                  批准候选
                </button>
                <button
                  className="btn"
                  type="button"
                  disabled={busy}
                  onClick={() => void command({ action: 'review', decision: 'rejected' })}
                >
                  拒绝候选
                </button>
              </div>
            </>
          ) : null}
        </>
      ) : null}
      <div className="row-inline">
        {!state || terminal ? (
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => void command({ action: 'start' })}
          >
            {state ? '明确新建调度（新调用）' : '保存调度队列'}
          </button>
        ) : (
          <>
            <button
              className="btn btn-primary"
              type="button"
              disabled={
                busy ||
                step?.state === 'pending_review' ||
                ['started', 'unknown', 'failed'].includes(step?.state ?? '')
              }
              onClick={() => void command({ action: 'continue' })}
            >
              继续一项
            </button>
            <button className="btn" type="button" onClick={() => void command({ action: 'pause' })}>
              暂停
            </button>
            <button className="btn" type="button" onClick={() => void command({ action: 'stop' })}>
              停止调度
            </button>
          </>
        )}
        <button className="btn" type="button" onClick={() => void refresh()}>
          读回记录
        </button>
      </div>
      {state?.state === 'awaiting_learner' ? (
        <Notice tone="pending">请在课堂完成本人作答，再明确继续。等候期间不会调用模型。</Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}
