import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateScene } from '@openmaic/dsl';
import type { PblProjectDefinitionDto } from '@sew/study-contracts';
import { pblHash, pblProjectSceneId, pblRecordSessionId } from '@sew/study-domain';
import { buildLessonExport, readZip } from '@sew/study-storage';
import {
  attachFormalLessonDocument,
  loadRenderableDocument,
} from '../apps/learning/lib/server/classroom-service';
import { checkRecovery } from '../apps/learning/lib/server/classroom-recovery';
import {
  executeLessonCommand,
  initialPlanScenes,
} from '../apps/learning/lib/server/lesson-service';
import { commandPblProject, readPblContext } from '../apps/learning/lib/server/pbl-service';
import {
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';

const roots: string[] = [];
afterEach(() => {
  closeProject();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const makeDefinition = (session: Session, statementId: string): PblProjectDefinitionDto => ({
  id: 'pbl_function_project',
  title: '校园数据解释项目',
  statementIds: [statementId],
  background: 'PUBLIC_CONTEXT_VISIBLE',
  authenticContext: {
    audience: '校园社团',
    problem: '根据公开数据解释趋势',
    constraints: ['仅使用已审核来源'],
  },
  goals: [
    { id: 'goal_model', statement: '建立可解释模型', successDescription: '报告说明变量与适用条件' },
  ],
  projectChecks: [],
  roles: [
    {
      id: 'learner_seat',
      name: '本人',
      kind: 'learner',
      responsibilities: ['完成报告'],
      memberUid: session.learnerUid,
    },
    {
      id: 'mentor_seat',
      name: '导师',
      kind: 'mentor',
      responsibilities: ['逐条反馈'],
      memberUid: null,
    },
  ],
  tasks: [
    {
      id: 'task_report',
      title: '提交分析报告',
      phase: '分析',
      statementIds: [statementId],
      outcome: '说明数据趋势和模型限制',
      artifactKinds: ['report'],
      roleIds: ['learner_seat'],
      milestoneIds: ['milestone_report'],
      checks: [
        {
          id: 'check_length',
          kind: 'deliverable_min_length',
          label: '报告长度',
          expectation: '至少40字',
          minChars: 40,
          artifactKind: 'report',
        },
      ],
    },
  ],
  milestones: [
    {
      id: 'milestone_report',
      title: '分析报告',
      statementIds: [statementId],
      order: 1,
      taskIds: ['task_report'],
      rubricIds: ['rubric_private'],
      checks: [
        {
          id: 'milestone_length',
          kind: 'deliverable_min_length',
          label: '报告长度',
          expectation: '报告至少40字',
          minChars: 40,
          artifactKind: 'report',
        },
      ],
    },
  ],
  rubrics: [
    {
      id: 'rubric_private',
      criterion: 'PRIVATE_RUBRIC_DETAIL',
      levels: [
        { level: 'exemplary', descriptor: '完整解释' },
        { level: 'adequate', descriptor: '基本说明' },
        { level: 'developing', descriptor: '需要补充' },
      ],
    },
  ],
  cadenceDays: 7,
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sew-pbl-scene-'));
  roots.push(root);
  const session = openProjectFromDisk(root);
  const projectId = session.projectId;
  const material = session.store.importMaterial({
    projectId,
    displayName: '函数来源.md',
    materialType: 'md',
    rawText: '正斜率对应递增趋势；使用公开数据解释时要说明适用条件。',
  }).material;
  const proposal = session.store.createProposal({
    projectId,
    name: '斜率与趋势',
    concept: '正斜率对应递增趋势',
    conditions: '适用于给定区间',
    scopeStatus: 'in_syllabus',
    prerequisites: [],
    evidence: [
      { materialId: material.materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' },
    ],
    acceptance: '',
    priority: 'medium',
    proposedBy: 'user',
  });
  const knowledgeId = session.store.applyReview({
    proposalId: proposal.proposalId,
    decision: 'approved',
    expectedRevision: proposal.revision,
    semanticReviewed: true,
  }).knowledgePoint!.knowledgeId;
  session.store.savePlanVersion(projectId, 1, 'confirmed', {
    payloadVersion: 1,
    goal: '解释数据趋势',
    examDate: null,
    dailyMinutes: 30,
    tasks: [
      {
        knowledgeId,
        name: '趋势解释',
        minutes: 30,
        acceptance: '',
        evidence: [{ materialId: material.materialId, segmentId: 'S001' }],
      },
    ],
    gaps: [],
    basis: '人工确认',
    confirmedTaskKnowledgeIds: [knowledgeId],
  });
  const bundle = session.store.buildLessonBundle(
    projectId,
    [{ knowledgeId, text: '正斜率对应递增趋势', conditions: '适用于给定区间' }],
    [],
  );
  const statementId = bundle.bundle.statements[0]!.statementId;
  const lesson = session.store.createLessonDraft({
    projectId,
    lessonId: null,
    title: '数据趋势项目课',
    bundleId: bundle.bundleId,
    statementIds: [statementId],
    questionIds: [],
  });
  const scope = { projectId, generation: session.generation };
  const definition = makeDefinition(session, statementId);
  commandPblProject(session, {
    operation: 'review',
    scope,
    lessonId: lesson.lessonId,
    lessonVersion: lesson.version,
    semanticReviewed: true,
    reviewNote: '人工核对目标、任务和来源支持',
    definition,
    binding: {
      version: 1,
      stageId: `stage_formal_${lesson.lessonId}_v${lesson.version}`,
      definitionId: definition.id,
      definitionDigest: pblHash(definition),
      documentDigest: 'draft',
    },
  });
  return { root, session, projectId, material, bundle, lesson, scope, definition, statementId };
}

const saveInitialPlan = (f: ReturnType<typeof fixture>) => {
  const scenes = initialPlanScenes(f.session, f.lesson);
  const pbl = scenes.find((scene) => scene.kind === 'pbl');
  expect(pbl).toMatchObject({
    sceneId: pblProjectSceneId(f.definition.id),
    title: f.definition.title,
  });
  executeLessonCommand({
    action: 'save-scene-plan',
    scope: f.scope,
    requestId: 'save-pbl-plan',
    lessonId: f.lesson.lessonId,
    version: f.lesson.version,
    baseRevision: 0,
    scenes,
  });
  return { scenes, pbl: pbl! };
};

const publishAndAttach = (f: ReturnType<typeof fixture>) => {
  f.session.store.reviewLesson({
    projectId: f.projectId,
    lessonId: f.lesson.lessonId,
    version: f.lesson.version,
    decision: 'approved',
    note: '核对课程事实及PBL计划',
  });
  f.session.store.publishLesson({
    projectId: f.projectId,
    lessonId: f.lesson.lessonId,
    version: f.lesson.version,
  });
  return attachFormalLessonDocument(f.session, f.lesson.lessonId, f.lesson.version);
};

describe('PBL definition → plan → classroom document integration', () => {
  it('binds the sole reviewed definition to the stable plan scene and emits only public DSL content', () => {
    const f = fixture();
    const { pbl } = saveInitialPlan(f);
    expect(pbl.sceneId).toBe(pblProjectSceneId(f.definition.id));

    const info = publishAndAttach(f);
    const renderable = loadRenderableDocument(f.session, info.stageId)!;
    const scene = (
      renderable.document as {
        scenes: Array<{ id: string; type: string; content: Record<string, unknown> }>;
      }
    ).scenes.find((item) => item.id === pbl.sceneId)!;
    expect(scene.type).toBe('pbl');
    expect(scene.content).toMatchObject({
      type: 'pbl',
      definitionId: f.definition.id,
      statementIds: [f.statementId],
    });
    expect(validateScene(scene).valid).toBe(true);
    const serialized = JSON.stringify(scene.content);
    expect(serialized).toContain('PUBLIC_CONTEXT_VISIBLE');
    expect(serialized).not.toContain('PRIVATE_RUBRIC_DETAIL');
    expect(serialized).not.toContain('rubricIds');
    expect(serialized).not.toContain(f.session.learnerUid);
    expect((scene.content['projectV2'] as { submissions?: unknown[] }).submissions).toEqual([]);
    expect(info.scenes.find((item) => item.sceneId === pbl.sceneId)?.knowledgeIds).toHaveLength(1);
  });

  it('rejects a forged or changed PBL scene identity before a plan can be saved', () => {
    const f = fixture();
    const { scenes, pbl } = saveInitialPlan(f);
    const forged = scenes.map((scene) =>
      scene.sceneId === pbl.sceneId ? { ...scene, sceneId: 'scene_forged_pbl' } : scene,
    );
    expect(() =>
      executeLessonCommand({
        action: 'save-scene-plan',
        scope: f.scope,
        requestId: 'forged-pbl-plan',
        lessonId: f.lesson.lessonId,
        version: f.lesson.version,
        baseRevision: 1,
        scenes: forged,
      }),
    ).toThrowError(expect.objectContaining({ code: 'CLASSROOM_SCENE_SOURCE_MISSING' }));
    expect(
      f.session.store.getScenePlan(f.projectId, f.lesson.lessonId, f.lesson.version)?.scenes,
    ).toEqual(scenes);
  });

  it('blocks after an evidence source is invalidated and recovery validates the PBL binding without creating learner records', () => {
    const f = fixture();
    saveInitialPlan(f);
    const info = publishAndAttach(f);
    const document = loadRenderableDocument(f.session, info.stageId)!;
    const pblScene = info.scenes.find((scene) => scene.sceneType === 'pbl')!;
    const learner = f.session.store.getLocalLearnerBinding(f.projectId)!;
    const opened = f.session.store.openClassroomSession({
      projectId: f.projectId,
      lessonId: f.lesson.lessonId,
      stageId: info.stageId,
      learnerKey: learner.learnerKey,
      sceneId: pblScene.sceneId,
    });
    const state = readPblContext(f.session, info.stageId, f.definition.id).state;
    const recordsId = pblRecordSessionId(f.projectId, f.session.learnerUid, state.binding);
    const before = f.session.store.runtime.listRecords(f.projectId, recordsId);
    expect(before).toHaveLength(0);
    expect(
      checkRecovery(f.session, opened.sessionId).layers.find(
        (layer) => layer.layer === 'interaction',
      ),
    ).toMatchObject({ status: 'restored', reason: 'pbl_definition_verified', preserved: 0 });
    expect(f.session.store.runtime.listRecords(f.projectId, recordsId)).toEqual(before);

    f.session.store.importMaterial({
      projectId: f.projectId,
      displayName: f.material.displayName,
      materialType: 'md',
      rawText: '来源已替换：原有陈述不再有效。',
    });
    expect(() => loadRenderableDocument(f.session, document.stageId)).toThrowError(
      expect.objectContaining({ code: 'KNOWLEDGE_INVALIDATED' }),
    );
  });

  it('exports public project goals, tasks, and milestones; legacy skeletons are labeled without invented content', () => {
    const f = fixture();
    saveInitialPlan(f);
    const info = publishAndAttach(f);
    const stored = f.session.store.getClassroomDocument(f.projectId, info.stageId)!;
    const bundleRow = f.session.store.getEvidenceBundle(f.projectId, f.lesson.bundleId)!;
    const pkg = buildLessonExport({
      store: f.session.store,
      projectId: f.projectId,
      lessonId: f.lesson.lessonId,
      version: f.lesson.version,
      title: f.lesson.title,
      bundleDigest: bundleRow.digest,
      plan: f.session.store.getScenePlan(f.projectId, f.lesson.lessonId, f.lesson.version),
      stageId: info.stageId,
      dslVersion: stored.dslVersion,
      documentDigest: stored.digest,
      document: stored.document,
    });
    const html = Buffer.from(
      readZip(pkg.bytes).find((entry) => entry.path === 'index.html')!.bytes,
    ).toString('utf8');
    expect(html).toContain('校园数据解释项目');
    expect(html).toContain('报告说明变量与适用条件');
    expect(html).toContain('提交分析报告');
    expect(html).not.toContain('PRIVATE_RUBRIC_DETAIL');
    expect(html).not.toContain('rubricIds');
    expect(html).not.toContain(f.session.learnerUid);
  });
});
