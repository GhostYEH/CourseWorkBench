import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyError, newId, type PlanPayloadDto, type PlanSceneDto } from '@sew/study-contracts';
import {
  assertPlanGrounded,
  duplicateScene,
  removeScene,
  reorderScenes,
  replaceSceneElements,
} from '@sew/study-domain';
import { StudyStore, ensureProjectLayout, projectPaths } from '@sew/study-storage';
import { buildPlannedLessonDocument } from '../apps/learning/lib/classroom/planned-lesson-document';
import {
  addElement,
  canRedo,
  canUndo,
  commit,
  createEditorState,
  duplicateSceneAt,
  moveScene,
  redo,
  removeSceneAt,
  undo,
  updateElement,
} from '../apps/learning/components/lesson-scene-plan-state';

/**
 * 场景计划与元素编辑（LESSON-02 / OMA-006、OMA-021、OMA-022）。
 *
 * 固定四件事：① 计划只挂在草案版本上，发布后不再改写；② 场景用稳定编号，增删/排序/复制/
 * 局部重生成都不改已有场景身份；③ 计划必须与冻结证据包相容（绑定与知识点由服务端沿用）；
 * ④ 完整课件候选先落待核区，人工通过才写入计划。
 */

const expectCode = (action: () => unknown, code: string, reason?: string): void => {
  try {
    action();
  } catch (error) {
    expect((error as StudyError).code).toBe(code);
    if (reason !== undefined) expect((error as StudyError).details?.['reason']).toBe(reason);
    return;
  }
  throw new Error(`预期抛出 ${code}，但调用成功了`);
};

const element = (id: string, text: string) => ({
  elementId: id,
  kind: 'text' as const,
  text,
  assetRef: null,
  left: 90,
  top: 130,
  width: 820,
  height: 100,
  style: { fontSize: 24, color: '#232323', bold: false, italic: false, align: 'left' as const },
});

describe('场景计划与完整课件候选（存储层）', () => {
  let root: string;
  let store: StudyStore;
  let projectId: string;
  let bundleId = '';
  let statementId = '';
  let secondStatementId = '';
  let lessonId = '';
  let lessonVersion = 1;
  let questionId: string | null = null;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-scene-plan-'));
    ensureProjectLayout(root);
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    projectId = newId<'project'>('proj');
    store.createProject({ projectId, displayName: '数学', subject: '数学', dailyMinutes: 60 });
    const imported = store.importMaterial({
      projectId,
      displayName: '考纲.md',
      materialType: 'md',
      rawText: '本章要求理解增函数的定义。\n\n第二条范围说明。',
    });
    const materialId = imported.material.materialId;
    const proposal = store.createProposal({
      projectId,
      name: '增函数定义',
      concept: '区间内任取 x1 < x2 都有 f(x1) < f(x2)',
      conditions: '同一区间 D 内',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [{ materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'user',
    });
    const knowledgeId = store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
    }).knowledgePoint!.knowledgeId;
    const payload: PlanPayloadDto = {
      payloadVersion: 1,
      goal: '掌握本章',
      examDate: null,
      dailyMinutes: 60,
      tasks: [
        {
          knowledgeId,
          name: '增函数定义',
          minutes: 30,
          acceptance: '',
          evidence: [{ materialId, segmentId: 'S001' }],
        },
      ],
      gaps: [],
      basis: '测试计划',
      confirmedTaskKnowledgeIds: [knowledgeId],
    };
    store.savePlanVersion(projectId, 1, 'confirmed', payload);
    store.startPlanRun(projectId);
    const bundle = store.buildLessonBundle(
      projectId,
      [
        { knowledgeId, text: '增函数的定义', conditions: '同一区间 D 内' },
        { knowledgeId, text: '减函数的定义', conditions: '同一区间 D 内' },
      ],
      [],
    );
    bundleId = bundle.bundleId;
    statementId = bundle.bundle.statements[0]!.statementId;
    secondStatementId = bundle.bundle.statements[1]!.statementId;
    const lesson = store.createLessonDraft({
      projectId,
      lessonId: null,
      title: '函数单调性',
      bundleId,
      statementIds: [statementId, secondStatementId],
      questionIds: [],
    });
    lessonId = lesson.lessonId;
    lessonVersion = lesson.version;
    questionId = null;
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  const scenes = (): PlanSceneDto[] => [
    {
      sceneId: 'scene_slide_a',
      kind: 'slide',
      title: '陈述 1',
      statementId,
      questionId: null,
      knowledgeIds: [
        store.getEvidenceBundle(projectId, bundleId)!.bundle.statements[0]!.knowledgeId,
      ],
      elements: [element('el_text_a', '增函数的定义')],
      note: '',
    },
    {
      sceneId: 'scene_slide_b',
      kind: 'slide',
      title: '陈述 2',
      statementId: secondStatementId,
      questionId: null,
      knowledgeIds: [
        store.getEvidenceBundle(projectId, bundleId)!.bundle.statements[1]!.knowledgeId,
      ],
      elements: [],
      note: '',
    },
  ];

  const save = (over: Partial<Parameters<typeof store.saveScenePlan>[0]> = {}) =>
    store.saveScenePlan({
      projectId,
      lessonId,
      lessonVersion,
      bundleId,
      scenes: scenes(),
      origin: 'deterministic',
      baseRevision: 0,
      ...over,
    });

  it('保存计划推进 revision，并可从项目读回', () => {
    const plan = save();
    expect(plan.revision).toBe(1);
    expect(plan.scenes.map((scene) => scene.sceneId)).toEqual(['scene_slide_a', 'scene_slide_b']);
    expect(store.getScenePlan(projectId, lessonId, lessonVersion)!.revision).toBe(1);
    expect(store.listProjectScenePlans(projectId)).toHaveLength(1);
  });

  it('乐观并发：revision 已推进时拒绝覆盖', () => {
    save();
    expectCode(() => save({ baseRevision: 0 }), 'VERSION_CONFLICT', 'plan_revision_stale');
    const next = save({ baseRevision: 1, scenes: [scenes()[0]!] });
    expect(next.revision).toBe(2);
  });

  it('已发布版本的计划不可改写：发布即冻结历史', () => {
    store.reviewLesson({
      projectId,
      lessonId,
      version: lessonVersion,
      decision: 'approved',
      note: '',
    });
    store.publishLesson({ projectId, lessonId, version: lessonVersion });
    expectCode(() => save(), 'STEP_ALREADY_COMMITTED', 'plan_base_not_draft');
  });

  it('场景编号稳定：增删/排序/复制都不改已有场景身份', () => {
    const base = scenes();
    const removed = removeScene(base, 'scene_slide_a');
    expect(removed.map((scene) => scene.sceneId)).toEqual(['scene_slide_b']);
    const reordered = reorderScenes(base, ['scene_slide_b', 'scene_slide_a']);
    expect(reordered.map((scene) => scene.sceneId)).toEqual(['scene_slide_b', 'scene_slide_a']);
    const duplicated = duplicateScene(base, 'scene_slide_a', () => 'scene_slide_copy');
    expect(duplicated.scenes.map((scene) => scene.sceneId)).toEqual([
      'scene_slide_a',
      'scene_slide_copy',
      'scene_slide_b',
    ]);
    expect(duplicated.copy.elements[0]!.elementId).not.toBe('el_text_a');
    expect(duplicated.copy.elements[0]!.text).toBe('增函数的定义');
  });

  it('局部重生成只替换目标场景的元素，其余场景逐字保留', () => {
    const base = scenes();
    const next = replaceSceneElements(base, 'scene_slide_a', [
      element('el_text_new', '改写后的正文'),
    ]);
    expect(next[0]!.elements[0]!.text).toBe('改写后的正文');
    expect(next[1]).toEqual(base[1]);
  });

  it('计划必须与冻结证据包相容：包外陈述与知识点不符都被拒绝', () => {
    const bundle = store.getEvidenceBundle(projectId, bundleId)!.bundle;
    expectCode(
      () =>
        assertPlanGrounded([{ ...scenes()[0]!, statementId: 'stmt_not_in_bundle' }], { bundle }),
      'SOURCE_MISSING',
      'statement_not_in_bundle',
    );
    expectCode(
      () =>
        assertPlanGrounded([{ ...scenes()[0]!, knowledgeIds: ['knowledge_wrong'] }], { bundle }),
      'KNOWLEDGE_SCOPE_INVALID',
      'plan_knowledge_mismatch',
    );
  });

  it('富文本白名单：脚本标签与事件属性被拒绝', () => {
    const bundle = store.getEvidenceBundle(projectId, bundleId)!.bundle;
    expectCode(
      () =>
        assertPlanGrounded(
          [{ ...scenes()[0]!, elements: [element('el_x', '<script>alert(1)</script>')] }],
          { bundle },
        ),
      'INVALID_ARGUMENT',
      'rich_text_tag_not_allowed',
    );
    expectCode(
      () =>
        assertPlanGrounded(
          [{ ...scenes()[0]!, elements: [element('el_y', '<b onclick="x()">hi</b>')] }],
          { bundle },
        ),
      'INVALID_ARGUMENT',
      'rich_text_unsafe',
    );
  });

  it('同一份（证据包 + 计划）装配出同一份文档与同一指纹', () => {
    const plan = save();
    const bundle = store.getEvidenceBundle(projectId, bundleId)!;
    const build = () =>
      buildPlannedLessonDocument({
        bundle: bundle.bundle,
        bundleDigest: bundle.digest,
        plan,
        lessonId,
        lessonVersion,
        title: '函数单调性',
        frozenAt: bundle.frozenAt,
      });
    const first = build();
    const second = build();
    expect(first.scenes.map((scene) => scene.sceneId)).toEqual(['scene_slide_a', 'scene_slide_b']);
    expect(JSON.stringify(first.document)).toBe(JSON.stringify(second.document));
    expect(first.document.scenes).toHaveLength(2);
  });

  it('完整课件候选只落待核区，通过才写入计划', () => {
    const candidate = store.createCoursewareCandidate({
      candidateId: newId<'cw'>('cw'),
      projectId,
      lessonId,
      baseVersion: lessonVersion,
      scenes: scenes(),
      instruction: '先定义后测验',
    });
    expect(candidate.status).toBe('pending');
    expect(candidate.origin).toBe('model_generated');
    // 候选存在但计划还没写入。
    expect(store.getScenePlan(projectId, lessonId, lessonVersion)).toBeNull();
    const applied = store.applyCoursewareCandidate({
      projectId,
      candidateId: candidate.candidateId,
      decision: 'approved',
      note: '场景顺序合理',
      reviewedBy: 'tester',
      scenes: scenes(),
    });
    expect(applied.candidate.status).toBe('applied');
    expect(applied.candidate.reviewedBy).toBe('tester');
    expect(applied.plan!.revision).toBe(1);
    expect(store.getScenePlan(projectId, lessonId, lessonVersion)!.scenes).toHaveLength(2);
  });

  it('拒绝候选只留档，不写入计划；同一候选不能处置两次', () => {
    const candidate = store.createCoursewareCandidate({
      candidateId: newId<'cw'>('cw'),
      projectId,
      lessonId,
      baseVersion: lessonVersion,
      scenes: scenes(),
      instruction: 'x',
    });
    const rejected = store.applyCoursewareCandidate({
      projectId,
      candidateId: candidate.candidateId,
      decision: 'rejected',
      note: '偏离',
      reviewedBy: 't',
      scenes: null,
    });
    expect(rejected.candidate.status).toBe('rejected');
    expect(rejected.plan).toBeNull();
    expect(store.getScenePlan(projectId, lessonId, lessonVersion)).toBeNull();
    expectCode(
      () =>
        store.applyCoursewareCandidate({
          projectId,
          candidateId: candidate.candidateId,
          decision: 'approved',
          note: '',
          reviewedBy: 't',
          scenes: scenes(),
        }),
      'STEP_ALREADY_COMMITTED',
      'courseware_already_decided',
    );
  });

  it('基线已发布时不允许把候选写入计划', () => {
    const candidate = store.createCoursewareCandidate({
      candidateId: newId<'cw'>('cw'),
      projectId,
      lessonId,
      baseVersion: lessonVersion,
      scenes: scenes(),
      instruction: 'x',
    });
    store.reviewLesson({
      projectId,
      lessonId,
      version: lessonVersion,
      decision: 'approved',
      note: '',
    });
    store.publishLesson({ projectId, lessonId, version: lessonVersion });
    expectCode(
      () =>
        store.applyCoursewareCandidate({
          projectId,
          candidateId: candidate.candidateId,
          decision: 'approved',
          note: '',
          reviewedBy: 't',
          scenes: scenes(),
        }),
      'STEP_ALREADY_COMMITTED',
      'courseware_base_not_draft',
    );
  });

  it('生成与处置收据按 requestId 与意图幂等', () => {
    store.saveCoursewareReceipt(projectId, 'req-1', 'propose', 'intent-a', { candidate: null });
    expect(store.coursewareReceipt(projectId, 'req-1', 'propose', 'intent-a')).toMatchObject({
      action: 'propose',
      intent: 'intent-a',
    });
    expectCode(
      () => store.coursewareReceipt(projectId, 'req-1', 'propose', 'intent-b'),
      'VERSION_CONFLICT',
      'courseware_nonce_reused',
    );
  });

  it('questionId 未参与时不产生测验绑定；场景数量上限被强制', () => {
    expect(questionId).toBeNull();
    const tooMany = Array.from({ length: 49 }, (_, index) => ({
      ...scenes()[0]!,
      sceneId: `scene_slide_${index}`,
    }));
    const bundle = store.getEvidenceBundle(projectId, bundleId)!.bundle;
    expectCode(
      () => assertPlanGrounded(tooMany, { bundle }),
      'INVALID_ARGUMENT',
      'plan_scene_limit',
    );
  });
});

describe('场景计划编辑器状态机（撤销/恢复与稳定编号）', () => {
  const base: PlanSceneDto[] = [
    {
      sceneId: 'scene_slide_a',
      kind: 'slide',
      title: 'A',
      statementId: 'stmt_a',
      questionId: null,
      knowledgeIds: ['k_a'],
      elements: [element('el_a', '正文 A')],
      note: '',
    },
    {
      sceneId: 'scene_slide_b',
      kind: 'slide',
      title: 'B',
      statementId: 'stmt_b',
      questionId: null,
      knowledgeIds: ['k_b'],
      elements: [],
      note: '',
    },
  ];

  it('撤销/恢复有确定语义：恢复整份快照，且新编辑清空恢复栈', () => {
    let state = createEditorState(base);
    expect(canUndo(state)).toBe(false);
    state = commit(state, moveScene(state.scenes, 'scene_slide_b', -1));
    expect(state.scenes.map((scene) => scene.sceneId)).toEqual(['scene_slide_b', 'scene_slide_a']);
    expect(canUndo(state)).toBe(true);
    expect(canRedo(state)).toBe(false);

    state = undo(state);
    expect(state.scenes.map((scene) => scene.sceneId)).toEqual(['scene_slide_a', 'scene_slide_b']);
    expect(canRedo(state)).toBe(true);

    state = redo(state);
    expect(state.scenes.map((scene) => scene.sceneId)).toEqual(['scene_slide_b', 'scene_slide_a']);

    // 新编辑使恢复栈失效：重做不再回到旧分支。
    state = undo(state);
    state = commit(state, removeSceneAt(state.scenes, 'scene_slide_a'));
    expect(canRedo(state)).toBe(false);
  });

  it('复制场景与新增元素都产生新编号，正文逐字保留', () => {
    let state = createEditorState(base);
    state = commit(state, duplicateSceneAt(state.scenes, 'scene_slide_a'));
    expect(state.scenes).toHaveLength(3);
    const copy = state.scenes[1]!;
    expect(copy.sceneId).not.toBe('scene_slide_a');
    expect(copy.elements[0]!.elementId).not.toBe('el_a');
    expect(copy.elements[0]!.text).toBe('正文 A');

    state = commit(state, addElement(state.scenes, 'scene_slide_b'));
    expect(state.scenes.find((scene) => scene.sceneId === 'scene_slide_b')!.elements).toHaveLength(
      1,
    );
  });

  it('元素样式编辑可撤销：恢复的是整份快照而不是逐字段反向', () => {
    let state = createEditorState(base);
    state = commit(
      state,
      updateElement(state.scenes, 'scene_slide_a', 'el_a', { style: { fontSize: 48, bold: true } }),
    );
    expect(state.scenes[0]!.elements[0]!.style).toMatchObject({ fontSize: 48, bold: true });
    state = undo(state);
    expect(state.scenes[0]!.elements[0]!.style).toMatchObject({ fontSize: 24, bold: false });
  });
});
