'use client';

/**
 * 场景计划编辑器（OMA-021、OMA-022）。
 *
 * 编辑的是「这一版课件由哪些场景、按什么顺序、每个场景里有哪些元素」：场景可增删、排序、
 * 复制、局部重生成，幻灯片元素可改正文与样式，全部编辑支持撤销/恢复。学科事实（陈述/题目
 * 绑定与知识点）仍来自冻结证据包，界面不能就地改写，只能选择本版本已选中的陈述/题目。
 *
 * 保存走 `save-scene-plan`：带 `baseRevision` 做乐观并发，服务端已推进时返回冲突而不是静默覆盖。
 * 已发布版本的计划只读：发布即冻结历史，改动必须派生新草案版本。
 */

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { apiResponses, SCENE_PLAN_WRITE_LIMIT, scenePlanSaveSchema } from '@sew/study-contracts';
import type {
  EvidenceBundleDto,
  LessonVersionDto,
  PlanElementDto,
  PlanSceneDto,
  ScenePlanDto,
} from '@sew/study-contracts';
import { Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';
import { useCommand } from '../lib/use-command';
import {
  beginLessonCommandAttempt,
  lessonCommandFailureState,
  type LessonCommandAttempt,
} from './lesson-command-retry';
import {
  addElement,
  applyPartialRegeneration,
  canRedo,
  canUndo,
  commit,
  createEditorState,
  initialLessonPlanScenes,
  DEFAULT_ELEMENT_STYLE,
  duplicateSceneAt,
  makeElement,
  moveScene,
  redo,
  removeElement,
  removeSceneAt,
  scenesForSubmit,
  undo,
  updateElement,
  updateScene,
} from './lesson-scene-plan-state';

const KIND_LABEL: Record<PlanSceneDto['kind'], string> = {
  slide: '幻灯片',
  quiz: '测验',
  interactive: '互动',
  pbl: 'PBL',
};

const ScenePlanEditor = ({
  projectId,
  generation,
  lesson,
  bundle,
  plan,
  interactions = [],
  busy,
  onSaved,
}: {
  projectId: string;
  generation: number;
  lesson: LessonVersionDto;
  bundle: EvidenceBundleDto;
  plan: ScenePlanDto | null;
  /** 本版本已审核的正式互动定义（场景编号由服务端按 `formalInteractionSceneId` 派生）。 */
  interactions?: Array<{ sceneId: string; title: string }>;
  busy: boolean;
  onSaved: (message: string) => void;
}): ReactNode => {
  const router = useRouter();
  const editable = lesson.status === 'draft';
  const initial = useMemo<PlanSceneDto[]>(() => {
    if (plan) return plan.scenes;
    return initialLessonPlanScenes(bundle, lesson, interactions);
  }, [plan, bundle, lesson, interactions]);

  /**
   * 编辑器保存必须绑定**实际加载的那一版计划 revision**。
   *
   * `loadedRevision` 随每次装载的计划固定下来（初始 props 或一次成功的保存）；提交时用它做
   * `baseRevision`，而不是用「当前 props 里最新的 revision」——否则界面刚收到别处推进的新计划、
   * 手上却还是旧快照时，会用新 revision 给旧内容背书，服务端把冲突当成一次合法更新而静默覆盖。
   * 新计划到达（`plan.revision` 变了）时这里显式进入冲突态，由用户选择「载入最新」或「覆盖」。
   */
  const [loadedRevision, setLoadedRevision] = useState<number>(plan?.revision ?? 0);
  const [editor, setEditor] = useState(() => createEditorState(initial));
  const command = useCommand([projectId, generation, lesson.lessonId, lesson.version].join(':'));
  const { error, setError } = command;
  const saving = command.busy;
  const [attempt, setAttempt] = useState<LessonCommandAttempt | null>(null);
  const [openScene, setOpenScene] = useState<string | null>(initial[0]?.sceneId ?? null);

  // 服务端计划推进后，本地快照可能落后：明确提示冲突，不静默换 revision 也不丢编辑。
  //
  // 只在服务端 revision **大于**本地已加载的 revision 时才算冲突：revision 每次保存都严格递增，
  // 因此「服务端更小」只可能是保存成功后 props 尚未刷新的短暂窗口，不能倒过来误报冲突。
  const remoteRevision = plan?.revision ?? 0;
  const stale = remoteRevision > loadedRevision;
  const overLimit = editor.scenes.length > SCENE_PLAN_WRITE_LIMIT;

  const selectedStatements = bundle.statements.filter((statement) =>
    lesson.statementIds.includes(statement.statementId),
  );
  const selectedQuestions = bundle.questions.filter((question) =>
    lesson.questionIds.includes(question.questionId),
  );

  const apply = (scenes: PlanSceneDto[]): void => setEditor((current) => commit(current, scenes));

  /** 载入服务端最新计划：放弃本地编辑（用户明确选择）。 */
  const loadLatest = (): void => {
    setEditor(createEditorState(initial));
    setLoadedRevision(remoteRevision);
    setOpenScene(initial[0]?.sceneId ?? null);
    setError(null);
  };

  const save = async (overwrite = false): Promise<void> => {
    if (attempt?.state === 'failed') return;
    // 未知结果时固定原内容、基线和 nonce；即便刷新推进了 props，也只读取这次命令的回执。
    let submitted = attempt;
    if (!submitted) {
      const requestId = crypto.randomUUID();
      const parsed = scenePlanSaveSchema.safeParse({
        scope: { projectId, generation },
        action: 'save-scene-plan',
        requestId,
        lessonId: lesson.lessonId,
        version: lesson.version,
        baseRevision: overwrite ? remoteRevision : loadedRevision,
        scenes: scenesForSubmit(editor.scenes),
      });
      if (!parsed.success) {
        setError(
          '计划内容无效：标题不能为空，正文最多 4000 字，字号需为 8–200，位置与尺寸需在允许范围内。请修改后保存。',
        );
        return;
      }
      submitted = beginLessonCommandAttempt(parsed.data, requestId);
    }
    const original = submitted;
    await command.run(
      ({ signal }) =>
        apiFetch('/api/study/lessons', apiResponses.lessonScenePlan, {
          method: 'POST',
          signal,
          body: original.body,
        }),
      {
        onStart: () => setAttempt({ ...original, state: 'pending' }),
        onSuccess: (result) => {
          setAttempt(null);
          setLoadedRevision(result.plan.revision);
          onSaved(
            `v${lesson.version} 场景计划已保存：${result.plan.scenes.length} 个场景，修订 ${result.plan.revision}。`,
          );
          router.refresh();
        },
        onError: (caught) => {
          setAttempt({ ...original, state: lessonCommandFailureState(caught) });
          setError(describeApiError(caught));
        },
      },
    );
  };

  const addScene = (kind: PlanSceneDto['kind']): void => {
    if (kind === 'slide') {
      const used = new Set(editor.scenes.map((scene) => scene.statementId));
      const next =
        selectedStatements.find((statement) => !used.has(statement.statementId)) ??
        selectedStatements[0];
      if (!next) {
        setError('本版本没有可绑定的陈述，无法新增幻灯片场景。');
        return;
      }
      apply([
        ...editor.scenes,
        {
          sceneId: `scene_slide_${next.statementId}_${editor.scenes.length}`.slice(0, 60),
          kind: 'slide',
          title: `陈述 ${editor.scenes.length + 1}`,
          statementId: next.statementId,
          questionId: null,
          knowledgeIds: [next.knowledgeId],
          elements: [makeElement(0)],
          note: '',
        },
      ]);
      return;
    }
    if (kind === 'quiz') {
      const used = new Set(editor.scenes.map((scene) => scene.questionId));
      const next =
        selectedQuestions.find((question) => !used.has(question.questionId)) ??
        selectedQuestions[0];
      if (!next) {
        setError('本版本没有可绑定的题目，无法新增测验场景。');
        return;
      }
      apply([
        ...editor.scenes,
        {
          sceneId: `scene_quiz_${next.questionId}_${editor.scenes.length}`.slice(0, 60),
          kind: 'quiz',
          title: `独立测验 ${editor.scenes.length + 1}`,
          statementId: null,
          questionId: next.questionId,
          knowledgeIds: [...next.knowledgeIds],
          elements: [],
          note: '',
        },
      ]);
      return;
    }
    apply([
      ...editor.scenes,
      {
        sceneId: `scene_${kind}_${editor.scenes.length}_${Date.now().toString(36)}`.slice(0, 60),
        kind,
        title: `${KIND_LABEL[kind]} ${editor.scenes.length + 1}`,
        statementId: null,
        questionId: null,
        knowledgeIds: [],
        elements: [],
        note: '',
      },
    ]);
  };

  /** 局部重生成：只把目标场景的正文替换为「按陈述/标题生成的确定性文本」，其余场景逐字保留。 */
  const regenerateScene = (scene: PlanSceneDto): void => {
    const statement = scene.statementId
      ? bundle.statements.find((item) => item.statementId === scene.statementId)
      : null;
    const text = statement
      ? `${statement.text}${statement.conditions ? `（适用条件：${statement.conditions}）` : ''}`
      : scene.title;
    const element: PlanElementDto = {
      ...makeElement(0),
      text,
      style: { ...DEFAULT_ELEMENT_STYLE, fontSize: 24 },
    };
    apply(applyPartialRegeneration(editor.scenes, scene.sceneId, [element]));
  };

  const updateStatementBinding = (scene: PlanSceneDto, statementId: string): void => {
    const statement = bundle.statements.find((item) => item.statementId === statementId);
    if (!statement) return;
    apply(
      editor.scenes.map((item) =>
        item.sceneId === scene.sceneId
          ? { ...item, statementId: statement.statementId, knowledgeIds: [statement.knowledgeId] }
          : item,
      ),
    );
  };

  const updateQuestionBinding = (scene: PlanSceneDto, questionId: string): void => {
    const question = bundle.questions.find((item) => item.questionId === questionId);
    if (!question) return;
    apply(
      editor.scenes.map((item) =>
        item.sceneId === scene.sceneId
          ? { ...item, questionId: question.questionId, knowledgeIds: [...question.knowledgeIds] }
          : item,
      ),
    );
  };

  const disabled = busy || saving || !editable || attempt !== null;

  return (
    <details className="card">
      <summary>
        场景计划编辑器（{editor.scenes.length} 个场景
        {plan ? ` · 修订 ${plan.revision}` : ' · 尚未保存'}）
      </summary>
      <p className="muted">
        {editable
          ? '增删、排序、复制与局部重生成都不改已有场景的编号；幻灯片元素可改正文与样式。所有编辑支持撤销/恢复。'
          : '已发布版本的计划只读：发布即冻结历史，改动请派生新草案版本。'}
      </p>
      {stale ? (
        <Notice tone="pending">
          服务端计划已推进到修订 {remoteRevision}（本地基于修订 {loadedRevision} 编辑）。
          保存会被拒绝以避免覆盖；请选择「载入最新计划」放弃本地编辑，或确认覆盖服务端当前计划。
        </Notice>
      ) : null}
      {overLimit ? (
        <Notice tone="pending">
          计划包含 {editor.scenes.length} 个场景，正式课堂最多支持 {SCENE_PLAN_WRITE_LIMIT}{' '}
          个。请删减后保存，已有历史内容不会被自动截断。
        </Notice>
      ) : null}
      {attempt?.state === 'unknown' ? (
        <Notice tone="pending">
          本次保存结果尚未确认，原内容与请求编号已保留。核对回执会重放原请求，已提交的保存不会再次推进修订。
          <button
            type="button"
            className="btn"
            disabled={busy || saving}
            data-scene-plan-retry
            onClick={() => void save()}
          >
            核对保存回执
          </button>
        </Notice>
      ) : null}
      {attempt?.state === 'failed' ? (
        <Notice tone="pending">
          回执确认本次保存失败或取消，未写入计划。可调整内容后明确开启新尝试。
          <button
            type="button"
            className="btn"
            disabled={busy || saving}
            data-scene-plan-new-attempt
            onClick={() => {
              setAttempt(null);
              setError(null);
            }}
          >
            开启新的保存尝试
          </button>
        </Notice>
      ) : null}
      <div className="row-inline">
        <button
          type="button"
          className="btn"
          disabled={disabled || !canUndo(editor)}
          onClick={() => setEditor(undo)}
        >
          撤销
        </button>
        <button
          type="button"
          className="btn"
          disabled={disabled || !canRedo(editor)}
          onClick={() => setEditor(redo)}
        >
          恢复
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled || editor.scenes.length === 0 || stale || overLimit}
          data-scene-plan-save
          onClick={() => void save()}
        >
          {saving ? '正在保存…' : '保存场景计划'}
        </button>
        {stale ? (
          <>
            <button
              type="button"
              className="btn"
              disabled={disabled}
              data-scene-plan-load-latest
              onClick={loadLatest}
            >
              载入最新计划
            </button>
            <button
              type="button"
              className="btn"
              disabled={disabled || editor.scenes.length === 0 || overLimit}
              data-scene-plan-overwrite
              onClick={() => void save(true)}
            >
              确认覆盖服务端计划
            </button>
          </>
        ) : null}
        {(['slide', 'quiz', 'interactive', 'pbl'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            className="btn"
            disabled={disabled || editor.scenes.length >= SCENE_PLAN_WRITE_LIMIT}
            onClick={() => addScene(kind)}
          >
            新增{KIND_LABEL[kind]}
          </button>
        ))}
      </div>

      {editor.scenes.length === 0 ? (
        <p className="muted">计划为空：至少保留一个场景才能保存。</p>
      ) : (
        <ol className="check-list">
          {editor.scenes.map((scene, index) => (
            <li key={scene.sceneId}>
              <div className="row-inline">
                <span className="pill">{KIND_LABEL[scene.kind]}</span>
                <input
                  value={scene.title}
                  maxLength={120}
                  disabled={disabled}
                  data-scene-title={scene.sceneId}
                  onChange={(event) =>
                    apply(updateScene(editor.scenes, scene.sceneId, { title: event.target.value }))
                  }
                />
                <button
                  type="button"
                  className="btn"
                  disabled={disabled || index === 0}
                  onClick={() => apply(moveScene(editor.scenes, scene.sceneId, -1))}
                >
                  上移
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={disabled || index === editor.scenes.length - 1}
                  onClick={() => apply(moveScene(editor.scenes, scene.sceneId, 1))}
                >
                  下移
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={disabled || editor.scenes.length >= SCENE_PLAN_WRITE_LIMIT}
                  data-scene-duplicate={scene.sceneId}
                  onClick={() => apply(duplicateSceneAt(editor.scenes, scene.sceneId))}
                >
                  复制
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={disabled || editor.scenes.length <= 1}
                  data-scene-remove={scene.sceneId}
                  onClick={() => apply(removeSceneAt(editor.scenes, scene.sceneId))}
                >
                  删除
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={disabled}
                  data-scene-toggle={scene.sceneId}
                  onClick={() => setOpenScene(openScene === scene.sceneId ? null : scene.sceneId)}
                >
                  {openScene === scene.sceneId ? '收起元素' : '编辑元素'}
                </button>
                <span className="muted mono">{scene.sceneId.slice(0, 18)}…</span>
              </div>

              {scene.kind === 'slide' ? (
                <label className="field">
                  <span>绑定陈述（本版本已选）</span>
                  <select
                    value={scene.statementId ?? ''}
                    disabled={disabled}
                    data-scene-statement={scene.sceneId}
                    onChange={(event) => updateStatementBinding(scene, event.target.value)}
                  >
                    {selectedStatements.map((statement) => (
                      <option key={statement.statementId} value={statement.statementId}>
                        {statement.text.slice(0, 40)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {scene.kind === 'quiz' ? (
                <label className="field">
                  <span>绑定题目（本版本已选）</span>
                  <select
                    value={scene.questionId ?? ''}
                    disabled={disabled}
                    data-scene-question={scene.sceneId}
                    onChange={(event) => updateQuestionBinding(scene, event.target.value)}
                  >
                    {selectedQuestions.map((question) => (
                      <option key={question.questionId} value={question.questionId}>
                        {(question.snapshot?.stem ?? question.questionId).slice(0, 40)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {openScene === scene.sceneId && scene.kind === 'slide' ? (
                <div className="card">
                  <div className="row-inline">
                    <button
                      type="button"
                      className="btn"
                      disabled={disabled}
                      onClick={() => apply(addElement(editor.scenes, scene.sceneId))}
                    >
                      新增文本元素
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={disabled}
                      data-scene-regenerate={scene.sceneId}
                      onClick={() => regenerateScene(scene)}
                    >
                      按陈述局部重生成
                    </button>
                  </div>
                  {scene.elements.map((element) => (
                    <div key={element.elementId} className="field">
                      <label>
                        <span>正文（支持 b/i/u/sub/sup/br/span）</span>
                        <textarea
                          rows={2}
                          value={element.text}
                          disabled={disabled}
                          data-element-text={element.elementId}
                          onChange={(event) =>
                            apply(
                              updateElement(editor.scenes, scene.sceneId, element.elementId, {
                                text: event.target.value,
                              }),
                            )
                          }
                        />
                      </label>
                      <div className="row-inline">
                        <label>
                          <span>字号</span>
                          <input
                            type="number"
                            min={8}
                            max={200}
                            value={element.style.fontSize}
                            disabled={disabled}
                            onChange={(event) =>
                              apply(
                                updateElement(editor.scenes, scene.sceneId, element.elementId, {
                                  style: { fontSize: Number(event.target.value) },
                                }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>颜色</span>
                          <input
                            type="color"
                            value={element.style.color}
                            disabled={disabled}
                            onChange={(event) =>
                              apply(
                                updateElement(editor.scenes, scene.sceneId, element.elementId, {
                                  style: { color: event.target.value },
                                }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>加粗</span>
                          <input
                            type="checkbox"
                            checked={element.style.bold}
                            disabled={disabled}
                            onChange={(event) =>
                              apply(
                                updateElement(editor.scenes, scene.sceneId, element.elementId, {
                                  style: { bold: event.target.checked },
                                }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>斜体</span>
                          <input
                            type="checkbox"
                            checked={element.style.italic}
                            disabled={disabled}
                            onChange={(event) =>
                              apply(
                                updateElement(editor.scenes, scene.sceneId, element.elementId, {
                                  style: { italic: event.target.checked },
                                }),
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>对齐</span>
                          <select
                            value={element.style.align}
                            disabled={disabled}
                            onChange={(event) =>
                              apply(
                                updateElement(editor.scenes, scene.sceneId, element.elementId, {
                                  style: {
                                    align: event.target.value as PlanElementDto['style']['align'],
                                  },
                                }),
                              )
                            }
                          >
                            <option value="left">左</option>
                            <option value="center">中</option>
                            <option value="right">右</option>
                          </select>
                        </label>
                        <button
                          type="button"
                          className="btn"
                          disabled={disabled}
                          data-element-remove={element.elementId}
                          onClick={() =>
                            apply(removeElement(editor.scenes, scene.sceneId, element.elementId))
                          }
                        >
                          删除元素
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </details>
  );
};

/** Scope changes remount local snapshots; the command gate also isolates late network responses. */
export const LessonScenePlanEditor = (props: Parameters<typeof ScenePlanEditor>[0]): ReactNode => (
  <ScenePlanEditor
    key={[props.projectId, props.generation, props.lesson.lessonId, props.lesson.version].join(':')}
    {...props}
  />
);
