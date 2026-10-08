'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  pblMentorCommandSchema,
  pblProjectStateSchema,
  pblSimulationStateSchema,
  pblSimulationStepSchemaChecked,
  type PblProjectStateDto,
  type PblSimulationStateDto,
  type PblSimulationStepInput,
} from '@sew/study-contracts';
import type { PBLContent } from '@openmaic/dsl';
import { ApiError, apiFetch, describeApiError, projectScopeHeaders } from '../../lib/client';

type PblSceneContent = PBLContent & { definitionId?: string; statementIds?: string[] };
type Scope = { projectId: string; generation: number };
type Draft = {
  artifactKind: 'report' | 'prototype' | 'dataset' | 'slides' | 'log' | 'other';
  artifactTitle: string;
  artifactText: string;
};
const emptyDraft = (): Draft => ({ artifactKind: 'report', artifactTitle: '', artifactText: '' });

type SavedDraft = NonNullable<PblProjectStateDto['ownDraft']>;
/** Prefer the service's latest global draft; legacy/per-task entries are fallback only. */
export const selectPblInitialDraft = (input: {
  tasks: ReadonlyArray<Pick<PblProjectStateDto['definition']['tasks'][number], 'id'>>;
  ownDraft: SavedDraft | null;
  ownDrafts?: ReadonlyArray<SavedDraft>;
}): SavedDraft | null => {
  const taskIds = new Set(input.tasks.map((task) => task.id));
  if (input.ownDraft && taskIds.has(input.ownDraft.taskId)) return input.ownDraft;
  return input.ownDrafts?.find((draft) => taskIds.has(draft.taskId)) ?? null;
};

/** Formal, member-private PBL runtime. Public DSL content is descriptive only; all authority comes from API readback. */
export function FormalPblSceneView({
  stageId,
  sceneId,
  scope,
  content,
}: {
  stageId: string;
  sceneId: string;
  scope: Scope;
  content: PblSceneContent;
}) {
  const { projectId, generation } = scope;
  const definitionId = content.definitionId ?? '';
  const [state, setState] = useState<PblProjectStateDto | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [taskId, setTaskId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [report, setReport] = useState('');
  const [mentorRoleId, setMentorRoleId] = useState('');
  const [milestoneId, setMilestoneId] = useState('');
  const [acceptedCandidateIds, setAcceptedCandidateIds] = useState<Record<string, string[]>>({});
  const [artifactId, setArtifactId] = useState('');
  const [question, setQuestion] = useState('');
  const [demo, setDemo] = useState<PblSimulationStateDto | null>(null);
  const [demoSteps, setDemoSteps] = useState<PblSimulationStepInput[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const requests = useRef(new Set<AbortController>());
  const busyRef = useRef(false);
  const readVersion = useRef(0);
  const retry = useRef<{ key: string; body: unknown; endpoint: string } | null>(null);
  const headers = useMemo(
    () => projectScopeHeaders({ projectId, generation }),
    [projectId, generation],
  );
  const url = `/api/study/pbl?stageId=${encodeURIComponent(stageId)}&definitionId=${encodeURIComponent(definitionId)}`;

  const load = useCallback(
    async (ticket: number, signal: AbortSignal) => {
      const version = ++readVersion.current;
      const loaded = await apiFetch(url, pblProjectStateSchema, {
        headers,
        cache: 'no-store',
        signal,
      });
      if (ticket !== epoch.current || signal.aborted || version !== readVersion.current) return;
      setState(loaded);
      const saved = selectPblInitialDraft({
        tasks: loaded.definition.tasks,
        ownDraft: loaded.ownDraft,
        ownDrafts: loaded.ownDrafts,
      });
      setTaskId(saved?.taskId ?? loaded.definition.tasks[0]?.id ?? '');
      setRoleId(
        loaded.definition.roles.find(
          (item) => item.kind === 'learner' && item.memberUid === loaded.viewerUid,
        )?.id ?? '',
      );
      setMentorRoleId(
        loaded.definition.roles.find((item) => item.kind === 'mentor' || item.kind === 'peer_ai')
          ?.id ?? '',
      );
      setMilestoneId(loaded.definition.milestones[0]?.id ?? '');
      if (saved) {
        setDraft({
          artifactKind: saved.artifactKind,
          artifactTitle: saved.artifactTitle,
          artifactText: saved.artifactText,
        });
        setTaskId(saved.taskId);
      }
      setError(null);
    },
    [url, headers],
  );

  useEffect(() => {
    const ticket = ++epoch.current;
    readVersion.current++;
    const controller = new AbortController();
    const activeRequests = requests.current;
    activeRequests.add(controller);
    setState(null);
    setDemo(null);
    setError(null);
    busyRef.current = false;
    setBusy(false);
    void load(ticket, controller.signal)
      .catch((caught: unknown) => {
        if (!controller.signal.aborted && ticket === epoch.current)
          setError(describeApiError(caught));
      })
      .finally(() => activeRequests.delete(controller));
    return () => {
      epoch.current = ticket + 1;
      activeRequests.forEach((item) => item.abort());
    };
  }, [load]);

  const runCommand = async (
    key: string,
    body: unknown,
    endpoint = '/api/study/pbl',
  ): Promise<void> => {
    if (busyRef.current) return;
    if (retry.current && (retry.current.key !== key || retry.current.endpoint !== endpoint)) {
      setError(
        '上一条命令尚未得到成功回执。请先用“重试上一条命令”核对原请求，或重新读取状态；不会自动用新编号替换未确认请求。',
      );
      return;
    }
    if (!retry.current || retry.current.key !== key || retry.current.endpoint !== endpoint)
      retry.current = { key, body, endpoint };
    const stableBody = retry.current.body;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const ticket = epoch.current;
    const requestVersion = ++readVersion.current;
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      const operation =
        typeof stableBody === 'object' && stableBody !== null && 'operation' in stableBody
          ? (stableBody as { operation?: unknown }).operation
          : null;
      const simulationResult = endpoint.endsWith('/simulation') || operation === 'simulate';
      const result = await apiFetch(
        endpoint,
        simulationResult ? pblSimulationStateSchema : pblProjectStateSchema,
        {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify(stableBody),
        },
      );
      if (
        ticket !== epoch.current ||
        controller.signal.aborted ||
        requestVersion !== readVersion.current
      )
        return;
      if (simulationResult) {
        setDemo(result as PblSimulationStateDto);
      } else {
        setState(result as PblProjectStateDto);
      }
      retry.current = null;
    } catch (caught) {
      if (ticket === epoch.current && !controller.signal.aborted) {
        setError(describeApiError(caught));
        if (
          caught instanceof ApiError &&
          !caught.pending &&
          !['API_RESPONSE_INVALID', 'API_HTTP_ERROR'].includes(caught.code)
        )
          retry.current = null;
        // Keep the exact request identity for ambiguous responses; user can explicitly retry it.
      }
    } finally {
      requests.current.delete(controller);
      if (ticket === epoch.current && !controller.signal.aborted) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const submitOperation = async (
    operation: 'draft' | 'submit' | 'task',
    extra: Record<string, unknown> = {},
  ) => {
    if (!state || !state.viewerUid || busyRef.current) return;
    const taskView = state.tasks.find((item) => item.taskId === taskId);
    if (taskView?.claimedByUid && taskView.claimedByUid !== state.viewerUid) {
      setError('此任务已由其他成员承接，当前不能用本人身份更新。');
      return;
    }
    const intent = taskView?.claimedByUid === state.viewerUid ? 'update' : 'open';
    const body =
      operation === 'draft'
        ? {
            operation,
            scope,
            binding: state.binding,
            actorUid: state.viewerUid,
            draft: {
              taskId,
              milestoneId: null,
              ...draft,
              assetRefs: [],
              goalIds: [],
              artifactText: draft.artifactText,
            },
            nonce: crypto.randomUUID(),
          }
        : operation === 'submit'
          ? {
              operation,
              scope,
              binding: state.binding,
              actorUid: state.viewerUid,
              deliverable: { taskId, milestoneId: null, ...draft, assetRefs: [], goalIds: [] },
              nonce: crypto.randomUUID(),
            }
          : {
              operation,
              intent,
              scope,
              binding: state.binding,
              actorUid: state.viewerUid,
              taskId,
              roleId: intent === 'open' ? activeRoleId : null,
              reportedStatus: extra.reportedStatus ?? 'in_progress',
              report,
              nonce: crypto.randomUUID(),
            };
    const key = JSON.stringify({ ...body, nonce: undefined });
    await runCommand(key, body);
  };

  const allArtifacts = useMemo(
    () =>
      state?.ownSubmissions.flatMap((receipt) =>
        receipt.payload.kind === 'deliverable' && receipt.artifactId
          ? [
              {
                id: receipt.artifactId,
                title: receipt.payload.artifactTitle,
                taskId: receipt.payload.taskId,
              },
            ]
          : [],
      ) ?? [],
    [state],
  );
  const taskArtifacts = allArtifacts.filter((item) => item.taskId === taskId);
  const availableRoles =
    state?.definition.roles.filter(
      (item) =>
        item.kind === 'learner' &&
        item.memberUid === state.viewerUid &&
        (state.definition.tasks.find((task) => task.id === taskId)?.roleIds.includes(item.id) ??
          false),
    ) ?? [];
  const activeRoleId = availableRoles.some((item) => item.id === roleId)
    ? roleId
    : (availableRoles[0]?.id ?? '');
  const localDraftKey = state
    ? `sew-pbl-draft:${scope.projectId}:${scope.generation}:${sceneId}:${state.viewerUid ?? 'guest'}:${taskId}`
    : '';
  useEffect(() => {
    if (!localDraftKey || !state) return;
    try {
      const kind = sessionStorage.getItem(`${localDraftKey}:kind`);
      const title = sessionStorage.getItem(`${localDraftKey}:title`);
      const text = sessionStorage.getItem(`${localDraftKey}:text`);
      if (
        kind &&
        ['report', 'prototype', 'dataset', 'slides', 'log', 'other'].includes(kind) &&
        (title !== null || text !== null)
      )
        setDraft({
          artifactKind: kind as Draft['artifactKind'],
          artifactTitle: title ?? '',
          artifactText: text ?? '',
        });
    } catch {
      /* Browser storage is only a best-effort private draft cache. */
    }
  }, [localDraftKey, state]);
  const updateDraft = (patch: Partial<Draft>) =>
    setDraft((current) => {
      const next = { ...current, ...patch };
      if (localDraftKey) {
        try {
          sessionStorage.setItem(`${localDraftKey}:kind`, next.artifactKind);
          sessionStorage.setItem(`${localDraftKey}:title`, next.artifactTitle);
          sessionStorage.setItem(`${localDraftKey}:text`, next.artifactText);
        } catch {
          /* Draft persistence may be unavailable in private browsing. */
        }
      }
      return next;
    });
  const readAgain = () => {
    const controller = new AbortController();
    requests.current.add(controller);
    const ticket = epoch.current;
    void load(ticket, controller.signal)
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(describeApiError(caught));
      })
      .finally(() => requests.current.delete(controller));
  };
  const retryPrevious = () => {
    const current = retry.current;
    if (current) void runCommand(current.key, current.body, current.endpoint);
  };

  const generateMentor = async (kind: 'feedback' | 'assessment' | 'contribution') => {
    if (!state?.viewerUid) return;
    const body = pblMentorCommandSchema.parse({
      scope,
      binding: state.binding,
      actorUid: state.viewerUid,
      requestId: crypto.randomUUID(),
      kind,
      roleId: mentorRoleId,
      taskId,
      milestoneId: kind === 'assessment' ? milestoneId || null : null,
      artifactIds: taskArtifacts.length
        ? [taskArtifacts.find((item) => item.id === artifactId)?.id ?? taskArtifacts[0]!.id]
        : [],
      question: question.trim(),
    });
    await runCommand(
      JSON.stringify({ ...body, requestId: undefined }),
      body,
      '/api/study/pbl/mentor',
    );
  };

  const cancel = () => {
    requests.current.forEach((item) => item.abort());
    busyRef.current = false;
    setBusy(false);
    setError('已停止等待；服务端是否完成请重新读取权威状态。');
  };
  const startDemo = async () => {
    if (!state?.viewerUid || !state.viewerIsMember) return;
    await runCommand('demo-open', {
      operation: 'simulate',
      scope,
      binding: state.binding,
      viewerUid: state.viewerUid,
      maxSteps: 50,
    });
  };
  const appendDemoStep = (operation: PblSimulationStepInput['operation']) => {
    if (
      !demo ||
      !taskId ||
      !state?.viewerUid ||
      !state.viewerIsMember ||
      demoSteps.length >= demo.stepBudget.maxSteps
    )
      return;
    const step = pblSimulationStepSchemaChecked.parse({
      scope,
      binding: demo.binding,
      operation,
      nonce: crypto.randomUUID(),
      actorUid: state.viewerUid,
      taskId,
      roleId: operation === 'open' ? roleId : null,
      milestoneId: null,
      reportedStatus: operation === 'submit' ? null : 'in_progress',
      deliverable:
        operation === 'submit'
          ? {
              taskId,
              milestoneId: null,
              ...draft,
              artifactTitle: draft.artifactTitle || '演练产物',
              artifactText: draft.artifactText || '演练草稿',
              assetRefs: [],
              goalIds: [],
            }
          : null,
      contribution: null,
      contributionNonce: null,
      feedback: null,
      assessment: null,
      assessmentNonce: null,
      acceptedCandidateIds: null,
      artifactIds: null,
      note: operation === 'update' ? report : '',
    });
    setDemoSteps((items) => [...items, step]);
  };
  const runDemo = () =>
    demo &&
    runCommand(
      `demo-run:${JSON.stringify(demoSteps)}`,
      { scope, binding: demo.binding, steps: demoSteps, maxSteps: demo.stepBudget.maxSteps },
      '/api/study/pbl/simulation',
    );

  if (!definitionId) return <p role="alert">PBL场景缺少冻结定义编号，已停止加载。</p>;
  const definition = state?.definition;
  const ownDeliverables =
    state?.ownSubmissions.filter((receipt) => receipt.payload.kind === 'deliverable') ?? [];
  return (
    <section className="card" data-scene="pbl" data-scene-id={sceneId}>
      <h2>{definition?.title ?? content.projectV2?.title ?? '正在读取 PBL 项目…'}</h2>
      {definition ? (
        <>
          <p>{definition.background}</p>
          <p>目标：{definition.goals.map((goal) => goal.statement).join('；')}</p>
          {!state?.viewerIsMember ? (
            <p role="status">当前身份不是项目成员：仅可查看公开定义，不能读取或提交私人产物。</p>
          ) : null}
          {state?.viewerIsMember && state.viewerUid ? (
            <>
              <fieldset disabled={busy}>
                <legend>本人任务与交付</legend>
                <label>
                  任务
                  <select
                    data-pbl-task
                    value={taskId}
                    onChange={(event) => {
                      const nextTaskId = event.target.value;
                      const savedDraft =
                        state.ownDrafts?.find((item) => item.taskId === nextTaskId) ??
                        (state.ownDraft?.taskId === nextTaskId ? state.ownDraft : null);
                      setTaskId(nextTaskId);
                      setDraft(
                        savedDraft
                          ? {
                              artifactKind: savedDraft.artifactKind,
                              artifactTitle: savedDraft.artifactTitle,
                              artifactText: savedDraft.artifactText,
                            }
                          : emptyDraft(),
                      );
                    }}
                  >
                    {definition.tasks.map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.title} · {task.outcome}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  本人席位
                  <select
                    data-pbl-role
                    value={activeRoleId}
                    onChange={(event) => setRoleId(event.target.value)}
                  >
                    {availableRoles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  产物类型
                  <select
                    value={draft.artifactKind}
                    onChange={(event) =>
                      updateDraft({ artifactKind: event.target.value as Draft['artifactKind'] })
                    }
                  >
                    {['report', 'prototype', 'dataset', 'slides', 'log', 'other'].map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  产物标题
                  <input
                    data-pbl-artifact-title
                    value={draft.artifactTitle}
                    onChange={(event) => updateDraft({ artifactTitle: event.target.value })}
                  />
                </label>
                <label>
                  产物正文
                  <textarea
                    data-pbl-artifact-text
                    value={draft.artifactText}
                    onChange={(event) => updateDraft({ artifactText: event.target.value })}
                  />
                </label>
                <label>
                  任务说明
                  <input
                    data-pbl-report
                    value={report}
                    onChange={(event) => setReport(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  data-pbl-task-command
                  disabled={
                    busy ||
                    !activeRoleId ||
                    !taskId ||
                    !report.trim() ||
                    Boolean(
                      state.tasks.find((item) => item.taskId === taskId)?.claimedByUid &&
                      state.tasks.find((item) => item.taskId === taskId)?.claimedByUid !==
                        state.viewerUid,
                    )
                  }
                  onClick={() => void submitOperation('task', { reportedStatus: 'in_progress' })}
                >
                  开启/更新任务
                </button>
                <button
                  type="button"
                  data-pbl-save-draft
                  disabled={busy || !draft.artifactTitle.trim()}
                  onClick={() => void submitOperation('draft')}
                >
                  保存本人草稿
                </button>
                <button
                  type="button"
                  data-pbl-submit
                  disabled={busy || !draft.artifactTitle.trim() || !draft.artifactText.trim()}
                  onClick={() => void submitOperation('submit')}
                >
                  提交本人产物
                </button>
                <button type="button" data-pbl-reload disabled={busy} onClick={readAgain}>
                  重新读取本人状态
                </button>
              </fieldset>
              {busy ? (
                <button type="button" onClick={cancel}>
                  停止等待
                </button>
              ) : null}
              {retry.current ? (
                <button type="button" data-pbl-retry disabled={busy} onClick={retryPrevious}>
                  重试上一条命令
                </button>
              ) : null}
              <h3>本人历史产物</h3>
              <ul>
                {ownDeliverables.map((item) =>
                  item.payload.kind === 'deliverable' ? (
                    <li key={item.id}>
                      <strong>{item.payload.artifactTitle}</strong>
                      <p>{item.payload.artifactText}</p>
                    </li>
                  ) : null,
                )}
              </ul>
              <h3>确定性检查</h3>
              {state.tasks.map((task) => (
                <article key={task.taskId}>
                  <strong>{definition.tasks.find((item) => item.id === task.taskId)?.title}</strong>{' '}
                  · {task.status}
                  <ul>
                    {task.deterministic.map((check) => (
                      <li key={check.checkId}>
                        {definition.tasks
                          .find((item) => item.id === task.taskId)
                          ?.checks.find((item) => item.id === check.checkId)?.label ??
                          check.checkId}
                        ：{check.passed ? '通过' : '未通过'}（{check.detail}）
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
              <h3>里程碑确定性结论</h3>
              {state.milestones.map((milestone) => (
                <article key={milestone.milestoneId}>
                  <strong>
                    {definition.milestones.find((item) => item.id === milestone.milestoneId)?.title}
                  </strong>{' '}
                  · {milestone.reached ? '已达成' : '尚未达成'}
                  <ul>
                    {milestone.deterministic.map((check) => (
                      <li key={check.checkId}>
                        {definition.milestones
                          .find((item) => item.id === milestone.milestoneId)
                          ?.checks.find((item) => item.id === check.checkId)?.label ??
                          check.checkId}
                        ：{check.passed ? '通过' : '未通过'}（{check.detail}）
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
              <h3>AI 指导候选（仅供本人核对）</h3>
              {taskArtifacts.length > 0 ? (
                <fieldset disabled={busy}>
                  <label>
                    协作席位
                    <select
                      value={mentorRoleId}
                      onChange={(event) => setMentorRoleId(event.target.value)}
                    >
                      {definition.roles
                        .filter((role) => role.kind === 'mentor' || role.kind === 'peer_ai')
                        .map((role) => (
                          <option key={role.id} value={role.id}>
                            {role.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    本人提交的产物
                    <select
                      value={
                        artifactId && taskArtifacts.some((item) => item.id === artifactId)
                          ? artifactId
                          : (taskArtifacts[0]?.id ?? '')
                      }
                      onChange={(event) => setArtifactId(event.target.value)}
                    >
                      {taskArtifacts.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    希望导师/同行关注的问题
                    <textarea
                      maxLength={1000}
                      value={question}
                      onChange={(event) => setQuestion(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy || !question.trim() || !mentorRoleId}
                    onClick={() => void generateMentor('feedback')}
                  >
                    生成反馈候选
                  </button>
                  <button
                    type="button"
                    disabled={busy || !question.trim() || !mentorRoleId}
                    onClick={() => void generateMentor('assessment')}
                  >
                    生成里程碑评价候选
                  </button>
                  <button
                    type="button"
                    disabled={busy || !question.trim() || !mentorRoleId}
                    onClick={() => void generateMentor('contribution')}
                  >
                    生成参考贡献
                  </button>
                </fieldset>
              ) : (
                <p>提交本人产物后才能请求基于真实产物的 AI 指导。</p>
              )}
              <p>
                AI
                结果是私有候选；不会改写确定性任务/里程碑达成结论。评价采纳与贡献认领需要另行执行本人操作。
              </p>
              {state.feedback.map((item) => (
                <article key={item.id}>
                  <strong>反馈候选</strong>
                  {item.payload.kind === 'feedback'
                    ? item.payload.points.map((point, index) => (
                        <p key={`${item.id}-${index}`}>
                          {point.observation} → {point.suggestion}
                        </p>
                      ))
                    : null}
                </article>
              ))}
              {state.assessments.map((item) => (
                <article key={item.id}>
                  <strong>里程碑评价候选</strong>
                  <p>候选仅供人工采纳；不表示达成。</p>
                  {item.payload.kind === 'assessment'
                    ? item.payload.candidates.map((candidate) => (
                        <p key={candidate.candidateId}>
                          {candidate.judgement}：{candidate.rationale}
                        </p>
                      ))
                    : null}
                </article>
              ))}
              {state.contributions.map((item) => (
                <article key={item.id}>
                  <strong>参考贡献（未计入本人交付）</strong>
                  {item.payload.kind === 'contribution' ? (
                    <>
                      <p>{item.payload.content}</p>
                      <button
                        type="button"
                        disabled={
                          busy ||
                          (state.acknowledgedContributionNonces ?? []).includes(item.payload.nonce)
                        }
                        onClick={() => {
                          const body = {
                            operation: 'acknowledge',
                            scope,
                            binding: state.binding,
                            actorUid: state.viewerUid,
                            contributionNonce: item.payload.nonce,
                            note: '本人已核对并选择认领此参考贡献。',
                            nonce: crypto.randomUUID(),
                          };
                          void runCommand(JSON.stringify({ ...body, nonce: undefined }), body);
                        }}
                      >
                        {(state.acknowledgedContributionNonces ?? []).includes(item.payload.nonce)
                          ? '已认领'
                          : '认领参考贡献'}
                      </button>
                    </>
                  ) : null}
                </article>
              ))}
              {state.assessments.map((item) =>
                item.payload.kind === 'assessment' ? (
                  <fieldset key={`accept-${item.id}`} disabled={busy}>
                    <legend>人工采纳评价候选：{item.payload.milestoneId}</legend>
                    {item.payload.candidates.map((candidate) => (
                      <label key={candidate.candidateId}>
                        <input
                          type="checkbox"
                          checked={(acceptedCandidateIds[item.payload.nonce] ?? []).includes(
                            candidate.candidateId,
                          )}
                          onChange={(event) =>
                            setAcceptedCandidateIds((current) => {
                              const selected = current[item.payload.nonce] ?? [];
                              return {
                                ...current,
                                [item.payload.nonce]: event.target.checked
                                  ? [...new Set([...selected, candidate.candidateId])]
                                  : selected.filter((id) => id !== candidate.candidateId),
                              };
                            })
                          }
                        />
                        {candidate.judgement}：{candidate.rationale}
                      </label>
                    ))}
                    <button
                      type="button"
                      disabled={busy || !acceptedCandidateIds[item.payload.nonce]?.length}
                      onClick={() => {
                        const selected = acceptedCandidateIds[item.payload.nonce] ?? [];
                        const body = {
                          operation: 'acceptEvaluation',
                          scope,
                          binding: state.binding,
                          actorUid: state.viewerUid,
                          assessmentNonce: item.payload.nonce,
                          acceptedCandidateIds: selected,
                          nonce: crypto.randomUUID(),
                        };
                        void runCommand(JSON.stringify({ ...body, nonce: undefined }), body);
                      }}
                    >
                      明确采纳选中的候选
                    </button>
                    <p>采纳不会改变确定性里程碑达成结果。</p>
                  </fieldset>
                ) : null,
              )}
            </>
          ) : null}
        </>
      ) : (
        <p role="status">正在读取该项目状态…</p>
      )}
      <details data-pbl-demo>
        <summary>演练区（明确为 demo，不写正式记录）</summary>
        <p>演练只使用本人动作与 demo 分区。AI 生成不进入演练；完整多角色演练仍待后续实现。</p>
        <button
          type="button"
          data-pbl-demo-open
          disabled={busy || retry.current !== null || !state?.viewerIsMember || !state.viewerUid}
          onClick={() => {
            if (retry.current) return;
            setDemoSteps([]);
            void startDemo();
          }}
        >
          开始演练
        </button>
        {demo ? (
          <>
            <p>
              当前演练步骤：{demoSteps.length}/{demo.stepBudget.maxSteps}
            </p>
            <button
              type="button"
              data-pbl-demo-add-open
              disabled={busy || demoSteps.length >= demo.stepBudget.maxSteps}
              onClick={() => appendDemoStep('open')}
            >
              加入开任务动作
            </button>
            <button
              type="button"
              disabled={busy || demoSteps.length >= demo.stepBudget.maxSteps}
              onClick={() => appendDemoStep('update')}
            >
              加入任务更新动作
            </button>
            <button
              type="button"
              data-pbl-demo-add-submit
              disabled={busy || demoSteps.length >= demo.stepBudget.maxSteps}
              onClick={() => appendDemoStep('submit')}
            >
              加入提交动作
            </button>
            <button
              type="button"
              data-pbl-demo-run
              disabled={busy || demoSteps.length === 0}
              onClick={runDemo}
            >
              运行演练
            </button>
          </>
        ) : null}
        {demo?.tasks.map((task) => (
          <p key={task.taskId}>
            演练任务：{task.taskId} · {task.status}
          </p>
        ))}
      </details>
      {error ? (
        <p role="alert">
          {error}
          {error.includes('MODEL_NOT_CONFIGURED') ? '：请先配置真实模型 provider。' : ''}
        </p>
      ) : null}
    </section>
  );
}
