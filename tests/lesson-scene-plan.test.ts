import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateScene, validateStage } from '@openmaic/dsl';
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
  scenePlanDigest,
} from '@sew/study-domain';
import {
  StudyStore,
  createNodeSqliteDriver,
  ensureProjectLayout,
  projectPaths,
} from '@sew/study-storage';
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
    expect(plan.digest).toHaveLength(64);
    expect(plan.scenes.map((scene) => scene.sceneId)).toEqual(['scene_slide_a', 'scene_slide_b']);
    expect(store.getScenePlan(projectId, lessonId, lessonVersion)!.revision).toBe(1);
    expect(store.listProjectScenePlans(projectId)).toHaveLength(1);
  });

  it('计划摘要是内容的函数：内容不变则摘要不变，内容一变摘要即变', () => {
    const first = save();
    // 重存同一内容：revision 推进，但内容摘要保持不变（审核据此不被误伤）。
    const second = save({ baseRevision: 1 });
    expect(second.revision).toBe(2);
    expect(second.digest).toBe(first.digest);

    const changed = save({
      baseRevision: 2,
      scenes: [{ ...scenes()[0]!, title: '改了标题' }],
    });
    expect(changed.digest).not.toBe(first.digest);
  });

  it('审核绑定计划内容：计划被改写后旧审核失效，发布必须复核当前内容', () => {
    const plan = save();
    store.reviewLesson({
      projectId,
      lessonId,
      version: lessonVersion,
      decision: 'approved',
      note: '按计划审核',
    });
    const review = store.getLessonReview(lessonId, lessonVersion, projectId)!;
    expect(review.planRevision).toBe(plan.revision);
    expect(review.planDigest).toBe(plan.digest);
    // 审核后内容未变：发布放行。
    expect(store.publishLesson({ projectId, lessonId, version: lessonVersion }).status).toBe(
      'published',
    );
  });

  it('审核后编辑计划：发布被阻断，重新审核后才放行', () => {
    save();
    store.reviewLesson({
      projectId,
      lessonId,
      version: lessonVersion,
      decision: 'approved',
      note: '按计划审核',
    });
    // 审核之后改了内容（手工保存）。
    const edited = save({ baseRevision: 1, scenes: [{ ...scenes()[0]!, title: '审核后改写' }] });
    expect(edited.digest).not.toBe(
      store.getLessonReview(lessonId, lessonVersion, projectId)!.planDigest,
    );
    expectCode(
      () => store.publishLesson({ projectId, lessonId, version: lessonVersion }),
      'VERSION_CONFLICT',
      'review_plan_changed',
    );
    // 重新审核当前内容后发布才放行。
    store.reviewLesson({
      projectId,
      lessonId,
      version: lessonVersion,
      decision: 'approved',
      note: '按新计划复核',
    });
    expect(store.publishLesson({ projectId, lessonId, version: lessonVersion }).status).toBe(
      'published',
    );
  });

  it('无计划的旧课程保持兼容：审核基线为空，发布不因缺计划被阻断', () => {
    store.reviewLesson({
      projectId,
      lessonId,
      version: lessonVersion,
      decision: 'approved',
      note: '旧课程无计划',
    });
    const review = store.getLessonReview(lessonId, lessonVersion, projectId)!;
    expect(review.planRevision).toBeNull();
    expect(review.planDigest).toBeNull();
    expect(store.getScenePlan(projectId, lessonId, lessonVersion)).toBeNull();
    expect(store.publishLesson({ projectId, lessonId, version: lessonVersion }).status).toBe(
      'published',
    );
  });

  it('上课入口与审核/发布共用同一份计划判定：审核基线漂移即阻断课堂', () => {
    save();
    store.reviewLesson({
      projectId,
      lessonId,
      version: lessonVersion,
      decision: 'approved',
      note: '按计划审核',
    });
    store.publishLesson({ projectId, lessonId, version: lessonVersion });
    // 当前计划与审核基线相符：课堂入口放行。
    expect(store.assertLessonClassroomReady(lessonId, projectId).lesson.status).toBe('published');

    // 直接改写落库的计划内容（模拟「审核之后计划内容已变」的权威库状态）。
    const plan = store.getScenePlan(projectId, lessonId, lessonVersion)!;
    store.close();
    const db = createNodeSqliteDriver().open(join(root, '.study', 'study.db'));
    const changedPlan = {
      ...plan,
      scenes: plan.scenes.map((scene) => ({ ...scene, title: '实际变化后的内容' })),
    };
    db.prepare(
      'UPDATE lesson_scene_plans SET plan_json = ? WHERE lesson_id = ? AND lesson_version = ?',
    ).run(
      JSON.stringify({ ...changedPlan, digest: scenePlanDigest(changedPlan) }),
      lessonId,
      lessonVersion,
    );
    db.close();
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    expectCode(
      () => store.assertLessonClassroomReady(lessonId, projectId),
      'VERSION_CONFLICT',
      'review_plan_changed',
    );
  });

  it('外部篡改已发布计划正文却保留旧摘要时，课堂入口与目录均拒绝', () => {
    const plan = save();
    store.reviewLesson({
      projectId,
      lessonId,
      version: lessonVersion,
      decision: 'approved',
      note: '审核实际正文',
    });
    store.publishLesson({ projectId, lessonId, version: lessonVersion });
    store.close();
    const db = createNodeSqliteDriver().open(projectPaths(root).databaseFile);
    db.prepare(
      'UPDATE lesson_scene_plans SET plan_json=? WHERE project_id=? AND lesson_id=? AND lesson_version=?',
    ).run(
      JSON.stringify({
        ...plan,
        scenes: plan.scenes.map((scene) => ({ ...scene, title: '未经审核的篡改正文' })),
      }),
      projectId,
      lessonId,
      lessonVersion,
    );
    db.close();
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    expectCode(
      () => store.assertLessonClassroomReady(lessonId, projectId),
      'INTERNAL',
      'invalid_scene_plan',
    );
    expectCode(() => store.listProjectScenePlans(projectId), 'INTERNAL', 'invalid_scene_plan');
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

  it('已保存富文本装配保留格式并通过真实 DSL 校验，编码标签仍为文本', () => {
    const edited = scenes();
    edited[0]!.elements = [element('el_rich', '<b>中文 &amp; 条件</b>：x &lt; y\n<i>比较</i>')];
    const plan = store.saveScenePlan({
      projectId,
      lessonId,
      lessonVersion,
      bundleId,
      baseRevision: 0,
      scenes: edited,
      origin: 'deterministic',
    });
    const bundle = store.getEvidenceBundle(projectId, bundleId)!;
    const document = buildPlannedLessonDocument({
      bundle: bundle.bundle,
      bundleDigest: bundle.digest,
      plan,
      lessonId,
      lessonVersion,
      title: '富文本课件',
      frozenAt: bundle.frozenAt,
    }).document;
    expect(validateStage(document.stage).valid).toBe(true);
    expect(document.scenes.every((scene) => validateScene(scene).valid)).toBe(true);
    expect(JSON.stringify(document.scenes[0])).toContain(
      '<b>中文 &amp; 条件</b>：x &lt; y<br><i>比较</i>',
    );
  });

  it('互动/PBL 场景必须绑定本版本已审核的正式互动定义，缺失即漏装配并如实报告', () => {
    const plan = store.saveScenePlan({
      projectId,
      lessonId,
      lessonVersion,
      bundleId,
      baseRevision: 0,
      origin: 'deterministic',
      scenes: [
        scenes()[0]!,
        {
          sceneId: 'scene_formal_interaction_parameter',
          kind: 'interactive',
          title: '参数实验',
          statementId: null,
          questionId: null,
          knowledgeIds: [],
          elements: [],
          note: '',
        },
        {
          sceneId: 'scene_formal_interaction_pbl',
          kind: 'pbl',
          title: '项目式学习',
          statementId: null,
          questionId: null,
          knowledgeIds: [],
          elements: [],
          note: '',
        },
      ],
    });
    const bundle = store.getEvidenceBundle(projectId, bundleId)!;
    const build = (
      interactions: Parameters<typeof buildPlannedLessonDocument>[0]['interactions'],
    ) =>
      buildPlannedLessonDocument({
        bundle: bundle.bundle,
        bundleDigest: bundle.digest,
        plan,
        lessonId,
        lessonVersion,
        title: '互动课件',
        frozenAt: bundle.frozenAt,
        ...(interactions ? { interactions } : {}),
      });

    // 没有已审核定义：互动场景列为未生成（漏装配），而不是塞占位内容冒充；
    // PBL 同样必须绑定冻结定义，手写骨架不会冒充可执行项目。
    const without = build(undefined);
    expect(without.scenes.map((scene) => scene.sceneId)).toEqual(['scene_slide_a']);
    expect(without.skipped.map((item) => item.id)).toEqual([
      'scene_formal_interaction_parameter',
      'scene_formal_interaction_pbl',
    ]);
    expect(without.skipped.every((item) => item.reason.includes('缺少本版本已审核'))).toBe(true);

    // 有定义才生成对应的 interactive 场景，知识点由定义绑定的陈述沿用。
    const withDefinitions = build([
      {
        id: 'parameter',
        kind: 'parameter',
        title: '参数实验',
        statementIds: [statementId],
        formula: 'linear',
        min: -3,
        max: 3,
        step: 0.1,
        intercept: 2,
        predictionRequired: false,
      },
    ]);
    expect(withDefinitions.skipped.map((item) => item.id)).toEqual([
      'scene_formal_interaction_pbl',
    ]);
    expect(withDefinitions.document.scenes.map((scene) => scene.type)).toEqual([
      'slide',
      'interactive',
    ]);
    const interactive = withDefinitions.scenes.find(
      (scene) => scene.sceneId === 'scene_formal_interaction_parameter',
    )!;
    expect(interactive.knowledgeIds).toEqual([bundle.bundle.statements[0]!.knowledgeId]);
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
    // 生成时没有计划：基线记 0 与 null。
    expect(candidate.basePlanRevision).toBe(0);
    expect(candidate.basePlanDigest).toBeNull();
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

  it('候选记录生成时的计划基线；审批旧候选不静默覆盖新编辑', () => {
    // 先生成候选（基线：无计划）。
    const candidate = store.createCoursewareCandidate({
      candidateId: newId<'cw'>('cw'),
      projectId,
      lessonId,
      baseVersion: lessonVersion,
      scenes: scenes(),
      instruction: '基于无计划生成',
    });
    expect(candidate.basePlanRevision).toBe(0);
    // 别处先手工保存了一份计划：候选的基线已经过期。
    const manual = save();
    expect(manual.revision).toBe(1);

    // 审批旧候选且未确认覆盖：拒绝写入，返回版本冲突而不是静默覆盖手工编辑。
    expectCode(
      () =>
        store.applyCoursewareCandidate({
          projectId,
          candidateId: candidate.candidateId,
          decision: 'approved',
          note: '未确认覆盖',
          reviewedBy: 't',
          scenes: scenes(),
        }),
      'VERSION_CONFLICT',
      'plan_revision_stale',
    );
    // 冲突被拒后没有任何写入：计划仍是手工那一份，候选仍是待核。
    expect(store.getScenePlan(projectId, lessonId, lessonVersion)!.revision).toBe(1);
    expect(store.getCoursewareCandidate(projectId, candidate.candidateId)!.status).toBe('pending');

    // 显式确认覆盖后，才按候选写入（revision 推进到 2）。
    const applied = store.applyCoursewareCandidate({
      projectId,
      candidateId: candidate.candidateId,
      decision: 'approved',
      note: '确认覆盖',
      reviewedBy: 't',
      scenes: scenes(),
      override: true,
      expectedPlanRevision: manual.revision,
    });
    expect(applied.candidate.status).toBe('applied');
    expect(applied.plan!.revision).toBe(2);
  });

  it('候选覆盖确认必须绑定当前计划，更新基线或沿用旧确认不能绕过冲突', () => {
    const base = save();
    const candidate = store.createCoursewareCandidate({
      candidateId: newId<'cw'>('cw'),
      projectId,
      lessonId,
      baseVersion: lessonVersion,
      scenes: scenes(),
      instruction: 'x',
      basePlanRevision: base.revision,
      basePlanDigest: base.digest,
    });
    expect(candidate.basePlanRevision).toBe(1);
    expect(candidate.basePlanDigest).toBe(base.digest);
    // 计划被再次推进（revision 2）。
    save({ baseRevision: 1, scenes: [{ ...scenes()[0]!, title: '后续编辑' }] });
    // 审批时给出过期的 expectedPlanRevision：拒绝。
    expectCode(
      () =>
        store.applyCoursewareCandidate({
          projectId,
          candidateId: candidate.candidateId,
          decision: 'approved',
          note: '',
          reviewedBy: 't',
          scenes: scenes(),
          expectedPlanRevision: 1,
        }),
      'VERSION_CONFLICT',
      'plan_revision_stale',
    );
    // 仅更新 expectedPlanRevision 不能冒充显式覆盖确认。
    expectCode(
      () =>
        store.applyCoursewareCandidate({
          projectId,
          candidateId: candidate.candidateId,
          decision: 'approved',
          note: '',
          reviewedBy: 't',
          scenes: scenes(),
          expectedPlanRevision: 2,
        }),
      'VERSION_CONFLICT',
      'plan_revision_stale',
    );
    // 用户对 revision 1 的旧确认也不能授权覆盖 revision 2。
    expectCode(
      () =>
        store.applyCoursewareCandidate({
          projectId,
          candidateId: candidate.candidateId,
          decision: 'approved',
          note: '',
          reviewedBy: 't',
          scenes: scenes(),
          expectedPlanRevision: 1,
          override: true,
        }),
      'VERSION_CONFLICT',
      'plan_revision_stale',
    );
    expect(store.getCoursewareCandidate(projectId, candidate.candidateId)!.status).toBe('pending');
    expect(store.getScenePlan(projectId, lessonId, lessonVersion)!.revision).toBe(2);
    // 明确确认当前 revision 才放行。
    const applied = store.applyCoursewareCandidate({
      projectId,
      candidateId: candidate.candidateId,
      decision: 'approved',
      note: '',
      reviewedBy: 't',
      scenes: scenes(),
      expectedPlanRevision: 2,
      override: true,
    });
    expect(applied.plan!.revision).toBe(3);
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

  it('计划命令回执四态可查询：completed 带结果，failed/cancelled/unknown 不带业务结果', () => {
    store.saveScenePlanReceipt({
      projectId,
      requestId: 'r-completed',
      action: 'save-scene-plan',
      intent: 'i',
      state: 'completed',
      result: { plan: { revision: 1 } },
      message: '',
    });
    const completed = store.scenePlanReceipt(projectId, 'r-completed', 'save-scene-plan', 'i')!;
    expect(completed.state).toBe('completed');
    expect(completed.result).toMatchObject({ plan: { revision: 1 } });

    for (const state of ['failed', 'cancelled', 'unknown'] as const) {
      store.saveScenePlanReceipt({
        projectId,
        requestId: `r-${state}`,
        action: 'save-scene-plan',
        intent: 'i',
        state,
        result: { plan: { revision: 9 } },
        message: `${state} 原因`,
        errorCode: 'VERSION_CONFLICT',
        errorReason: `${state}_reason`,
      });
      const receipt = store.scenePlanReceipt(projectId, `r-${state}`, 'save-scene-plan', 'i')!;
      expect(receipt.state).toBe(state);
      // 非 completed 一律不落业务结果：这些状态代表「没有业务写入」。
      expect(receipt.result).toBeNull();
      expect(receipt.errorCode).toBe('VERSION_CONFLICT');
      expect(receipt.message).toBe(`${state} 原因`);
    }

    // 同 requestId 换用途/意图属于 nonce 复用，按冲突拒绝而不是静默返回旧回执。
    expectCode(
      () => store.scenePlanReceipt(projectId, 'r-completed', 'apply-courseware', 'i'),
      'VERSION_CONFLICT',
      'scene_plan_nonce_reused',
    );
  });

  it('回执与业务同事务：进程重开后仍能按 requestId 读回同一结论', () => {
    store.transaction(() =>
      store.saveScenePlanReceipt({
        projectId,
        requestId: 'r-reopen',
        action: 'save-scene-plan',
        intent: 'i',
        state: 'completed',
        result: { plan: { revision: 1 } },
        message: '',
      }),
    );
    store.close();
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    const receipt = store.scenePlanReceipt(projectId, 'r-reopen', 'save-scene-plan', 'i')!;
    expect(receipt.state).toBe('completed');
    expect(receipt.result).toMatchObject({ plan: { revision: 1 } });
  });

  it('questionId 未参与时不产生测验绑定；场景数量上限被强制', () => {
    expect(questionId).toBeNull();
    const tooMany = Array.from({ length: 25 }, (_, index) => ({
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

describe('计划内容摘要（审核/发布绑定的唯一判据）', () => {
  const plan = (over: Partial<PlanSceneDto> = {}) => ({
    lessonId: 'lesson_a',
    lessonVersion: 1,
    bundleId: 'bundle_a',
    scenes: [
      {
        sceneId: 'scene_slide_a',
        kind: 'slide' as const,
        title: 'A',
        statementId: 'stmt_a',
        questionId: null,
        knowledgeIds: ['k_a'],
        elements: [
          {
            elementId: 'el_a',
            kind: 'text' as const,
            text: '正文 A',
            assetRef: null,
            left: 90,
            top: 130,
            width: 820,
            height: 100,
            style: {
              fontSize: 24,
              color: '#232323',
              bold: false,
              italic: false,
              align: 'left' as const,
            },
          },
        ],
        note: '',
        ...over,
      },
    ],
  });

  it('同内容同摘要：大小写颜色与知识点顺序不影响判定', () => {
    const left = scenePlanDigest(plan());
    const right = scenePlanDigest({
      ...plan(),
      scenes: [{ ...plan().scenes[0]!, knowledgeIds: ['k_a'] }],
    });
    expect(left).toBe(right);
  });

  it('内容任一实质变化都会改变摘要：标题、正文、知识点、顺序', () => {
    const base = scenePlanDigest(plan());
    expect(scenePlanDigest(plan({ title: 'B' }))).not.toBe(base);
    expect(scenePlanDigest(plan({ statementId: 'stmt_b' }))).not.toBe(base);
    expect(scenePlanDigest(plan({ knowledgeIds: ['k_b'] }))).not.toBe(base);
    const withElementEdit = plan();
    withElementEdit.scenes[0]!.elements[0]!.text = '改过的正文';
    expect(scenePlanDigest(withElementEdit)).not.toBe(base);
  });
});
