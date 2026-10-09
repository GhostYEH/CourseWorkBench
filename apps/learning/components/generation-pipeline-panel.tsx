'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { generationPipelineResponseSchema } from '../../../packages/study-contracts/src/generation-pipeline';
import type {
  GenerationPipelineResponse,
  GenerationPipelineStage,
} from '../../../packages/study-contracts/src/generation-pipeline';
import type { EvidenceBundleDto } from '@sew/study-contracts';
import { apiFetch, describeApiError } from '../lib/client';
import { Notice } from './ui';

type BundleOption = {
  bundleId: string;
  digest: string;
  frozenAt: string;
  bundle: EvidenceBundleDto;
};

const stageLabels: Record<GenerationPipelineStage, string> = {
  'course-draft': '课程内容草案候选（OMA-004）',
  outline: '大纲与场景骨架候选（OMA-005）',
  courseware: '完整课件候选（OMA-006）',
  'teaching-profile': '授课角色与动作候选（OMA-007）',
};

export const GenerationPipelinePanel = ({
  projectId,
  generation,
  bundles,
}: {
  projectId: string;
  generation: number;
  bundles: BundleOption[];
}): ReactNode => {
  const router = useRouter();
  const [bundleId, setBundleId] = useState(bundles[0]?.bundleId ?? '');
  const [title, setTitle] = useState('');
  const [instruction, setInstruction] = useState('');
  const [statementIds, setStatementIds] = useState<string[]>([]);
  const [questionIds, setQuestionIds] = useState<string[]>([]);
  const [result, setResult] = useState<GenerationPipelineResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<string | null>(null);
  const reviewRequests = useRef<Record<string, string>>({});
  const activeController = useRef<AbortController | null>(null);
  const scope = { projectId, generation };
  const selectedBundle = bundles.find((bundle) => bundle.bundleId === bundleId) ?? null;
  const task = result?.task;

  const send = async (body: Record<string, unknown>, signal?: AbortSignal): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await apiFetch(
        '/api/study/lessons/generation-pipeline',
        generationPipelineResponseSchema,
        {
          method: 'POST',
          body: JSON.stringify(body),
          signal,
        },
      );
      setResult(next);
      try {
        localStorage.setItem(`generation-pipeline:${projectId}`, next.task.taskId);
      } catch {
        /* The task remains durable on the server. */
      }
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
      activeController.current = null;
    }
  };

  useEffect(() => {
    let taskId: string | null = null;
    try {
      taskId = localStorage.getItem(`generation-pipeline:${projectId}`);
    } catch {
      /* The task can still be opened with its request receipt. */
    }
    if (taskId) void send({ scope, action: 'get', taskId });
    // Restore once per project-open generation; reads do not start generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, generation]);

  const start = (): void => {
    if (!selectedBundle) {
      setError('先选择一份冻结材料包。');
      return;
    }
    if (title.trim().length < 2 || instruction.trim().length < 2 || statementIds.length === 0) {
      setError('请填写课程名称、编排要求，并至少选择一条已冻结陈述。');
      return;
    }
    requestRef.current ??= crypto.randomUUID();
    void send({
      scope,
      action: 'create',
      requestId: requestRef.current,
      bundleId: selectedBundle.bundleId,
      bundleDigest: selectedBundle.digest,
      title,
      statementIds,
      questionIds,
      instruction,
    });
  };

  const continueStage = (): void => {
    if (!task) return;
    const controller = new AbortController();
    activeController.current = controller;
    void send({ scope, action: 'continue', taskId: task.taskId }, controller.signal);
  };
  const refresh = (): void => {
    if (task) void send({ scope, action: 'get', taskId: task.taskId });
  };
  const stop = async (): Promise<void> => {
    if (!task) return;
    activeController.current?.abort();
    await send({ scope, action: 'stop', taskId: task.taskId });
  };
  const retry = (stage: GenerationPipelineStage): void => {
    if (task)
      void send({
        scope,
        action: 'retry',
        taskId: task.taskId,
        stage,
        requestId: crypto.randomUUID(),
      });
  };
  const review = (
    stage: 'course-draft' | 'outline' | 'teaching-profile',
    decision: 'approved' | 'rejected',
  ): void => {
    if (!task) return;
    const key = `${task.taskId}:${stage}:${decision}`;
    reviewRequests.current[key] ??= crypto.randomUUID();
    void send({
      scope,
      action: 'review',
      taskId: task.taskId,
      stage,
      decision,
      requestId: reviewRequests.current[key],
    });
  };

  const activeStage =
    task?.stages.find(
      (stage) => stage.status !== 'completed' || stage.reviewStatus === 'pending',
    ) ?? null;
  const canContinue = Boolean(
    task && ['ready', 'paused'].includes(task.status) && activeStage?.status === 'pending',
  );
  const toggle = (id: string, selected: string[], setSelected: (value: string[]) => void): void => {
    setSelected(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  };

  return (
    <details className="card" data-generation-pipeline>
      <summary>渐进式课程生成（OMA-004–008）</summary>
      <p className="muted">
        从冻结材料包开始。模型内容先作为候选；课程草案、大纲与教师配置都需明确审核采用。课件候选沿用现有课件审核区，课程不会自动发布。
      </p>
      {!task ? (
        <>
          <div className="field">
            <label htmlFor="generation-pipeline-bundle">冻结材料包</label>
            <select
              id="generation-pipeline-bundle"
              value={bundleId}
              disabled={busy || bundles.length === 0}
              onChange={(event) => {
                setBundleId(event.target.value);
                setStatementIds([]);
                setQuestionIds([]);
                requestRef.current = null;
              }}
            >
              {bundles.map((bundle) => (
                <option key={bundle.bundleId} value={bundle.bundleId}>
                  {bundle.bundle.subject} · {bundle.bundle.statements.length} 条陈述 ·{' '}
                  {bundle.bundle.questions.length} 道题
                </option>
              ))}
            </select>
          </div>
          {selectedBundle ? (
            <>
              <div className="field">
                <label htmlFor="generation-pipeline-title">课程名称</label>
                <input
                  id="generation-pipeline-title"
                  value={title}
                  maxLength={120}
                  disabled={busy}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    requestRef.current = null;
                  }}
                />
              </div>
              <fieldset className="field">
                <legend>选择冻结陈述（至少一条）</legend>
                {selectedBundle.bundle.statements.map((item) => (
                  <label key={item.statementId} className="row-inline">
                    <input
                      type="checkbox"
                      checked={statementIds.includes(item.statementId)}
                      disabled={busy}
                      onChange={() => {
                        requestRef.current = null;
                        toggle(item.statementId, statementIds, setStatementIds);
                      }}
                    />
                    <span>{item.text}</span>
                  </label>
                ))}
              </fieldset>
              <fieldset className="field">
                <legend>可选题目</legend>
                {selectedBundle.bundle.questions.map((item) => (
                  <label key={item.questionId} className="row-inline">
                    <input
                      type="checkbox"
                      checked={questionIds.includes(item.questionId)}
                      disabled={busy}
                      onChange={() => {
                        requestRef.current = null;
                        toggle(item.questionId, questionIds, setQuestionIds);
                      }}
                    />
                    <span>{item.snapshot?.stem ?? item.questionId}</span>
                  </label>
                ))}
              </fieldset>
            </>
          ) : (
            <p className="muted">当前没有可用于生成的冻结材料包。缺少材料时不会调用模型。</p>
          )}
          <div className="field">
            <label htmlFor="generation-pipeline-instruction">课程编排要求</label>
            <textarea
              id="generation-pipeline-instruction"
              value={instruction}
              maxLength={600}
              disabled={busy}
              onChange={(event) => {
                setInstruction(event.target.value);
                requestRef.current = null;
              }}
            />
          </div>
          <button
            type="button"
            className="btn"
            disabled={
              busy ||
              !selectedBundle ||
              statementIds.length === 0 ||
              title.trim().length < 2 ||
              instruction.trim().length < 2
            }
            onClick={start}
          >
            {busy ? '保存任务中…' : '创建生成任务'}
          </button>
        </>
      ) : (
        <>
          <p>
            课程：{task.title}
            {task.lessonId ? ` · 草案 ${task.lessonId} v${task.version}` : ''}；状态：
            <strong>{task.status}</strong> · 进度：
            {task.stages.filter((item) => item.status === 'completed').length}/{task.stages.length}
          </p>
          <ol>
            {task.stages.map((stage) => {
              const output =
                stage.output && typeof stage.output === 'object'
                  ? (stage.output as Record<string, unknown>)
                  : null;
              return (
                <li key={stage.stage}>
                  <strong>{stageLabels[stage.stage]}</strong>：{stage.status}（尝试 {stage.attempts}
                  ）{stage.reviewStatus === 'pending' ? ' · 等待人工审核' : ''}
                  {stage.message ? <p className="muted">{stage.message}</p> : null}
                  {output?.['candidate'] ? (
                    <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>
                      {typeof output['candidate'] === 'string'
                        ? output['candidate']
                        : JSON.stringify(output['candidate'], null, 2)}
                    </pre>
                  ) : null}
                  {stage.reviewStatus === 'pending' &&
                  (stage.stage === 'course-draft' ||
                    stage.stage === 'outline' ||
                    stage.stage === 'teaching-profile') ? (
                    <div className="row-inline">
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() =>
                          review(
                            stage.stage as 'course-draft' | 'outline' | 'teaching-profile',
                            'approved',
                          )
                        }
                      >
                        {stage.stage === 'course-draft'
                          ? '审核通过并创建课程草案'
                          : stage.stage === 'outline'
                            ? '审核通过并写入场景计划'
                            : '审核通过并采用教师配置'}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() =>
                          review(
                            stage.stage as 'course-draft' | 'outline' | 'teaching-profile',
                            'rejected',
                          )
                        }
                      >
                        拒绝候选
                      </button>
                    </div>
                  ) : null}
                  {stage.status === 'failed' ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => retry(stage.stage)}
                    >
                      只重试此阶段
                    </button>
                  ) : null}
                  {stage.stage === 'courseware' && output?.['candidateId'] ? (
                    <p className="muted">
                      课件候选已保存，请在课程工作台的现有课件审核区决定是否写入场景计划。
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
          <div className="row-inline">
            <button
              type="button"
              className="btn"
              disabled={busy || !canContinue}
              onClick={continueStage}
            >
              {busy ? '阶段执行中…' : '明确继续下一阶段'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={['completed', 'stopped'].includes(task.status)}
              onClick={() => void stop()}
            >
              停止任务
            </button>
            <button type="button" className="btn" disabled={busy} onClick={refresh}>
              读取任务状态
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setResult(null);
                requestRef.current = null;
                reviewRequests.current = {};
                try {
                  localStorage.removeItem(`generation-pipeline:${projectId}`);
                } catch {
                  /* Local task locator is optional. */
                }
              }}
            >
              创建另一项任务
            </button>
          </div>
        </>
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {task?.status === 'blocked' ? (
        <Notice tone="pending">生成被阻断：请先恢复冻结材料或修复准入，再创建新任务。</Notice>
      ) : null}
      {task?.status === 'completed' ? (
        <Notice tone="verified">
          候选处理已完成。课程仍须经过正式课程审核；采用角色偏好不会授予额外权限。
        </Notice>
      ) : null}
    </details>
  );
};
