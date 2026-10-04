import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyError, newId, type PlanPayloadDto } from '@sew/study-contracts';
import { StudyStore, createNodeSqliteDriver, ensureProjectLayout, projectPaths } from '@sew/study-storage';

/**
 * 课程证据包与课程版本（LESSON-01）。
 *
 * 关注三件事：每条学科陈述与题目都要能指向已冻结的来源；修改课程只产生新草案版本；
 * 来源更新不改写已发布课程，但会让依赖它的新发布被准入阻断。
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

describe('证据包与课程版本', () => {
  let root: string;
  let store: StudyStore;
  let projectId: string;
  let materialId: string;
  let knowledgeId: string;

  const confirmPlanWith = (accepted: string[]): void => {
    const latest = store.getLatestPlan(projectId);
    const version = (latest?.version ?? 0) + 1;
    const payload: PlanPayloadDto = {
      payloadVersion: 1,
      goal: '掌握本章',
      examDate: null,
      dailyMinutes: 60,
      tasks: accepted.map((id) => ({
        knowledgeId: id,
        name: id,
        minutes: 30,
        acceptance: '',
        evidence: [{ materialId, segmentId: 'S001' }],
      })),
      gaps: [],
      basis: '测试计划',
      confirmedTaskKnowledgeIds: accepted,
    };
    store.savePlanVersion(projectId, version, 'confirmed', payload);
  };

  const freeze = (text = '增函数的定义：区间内任取 x1 < x2 都有 f(x1) < f(x2)') =>
    store.buildLessonBundle(projectId, [{ knowledgeId, text, conditions: '同一区间 D 内' }], []);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-lesson-'));
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
    materialId = imported.material.materialId;
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
    knowledgeId = store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
    }).knowledgePoint!.knowledgeId;
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('没有已确认计划时不能冻结证据包', () => {
    expectCode(() => freeze(), 'PLAN_NOT_CONFIRMED');
  });

  it('冻结证据包会绑定已批准来源与段落摘要，重复冻结按摘要复用', () => {
    confirmPlanWith([knowledgeId]);
    const first = freeze();
    expect(first.bundle.statements).toHaveLength(1);
    expect(first.bundle.statements[0]?.evidence[0]).toMatchObject({ materialId, revision: 1, segmentId: 'S001' });
    expect(first.bundle.segmentDigests[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.bundle.planVersion).toBe(1);
    expect(first.bundle.roleConfigDigest).toBeNull();
    expect(first.bundle.reviewProvenance).toBe('user_semantic');

    const again = freeze();
    expect(again.bundleId).toBe(first.bundleId);
    expect(store.listEvidenceBundles(projectId)).toHaveLength(1);

    const changed = freeze('改写过的一种表述');
    expect(changed.bundleId).not.toBe(first.bundleId);
    expect(store.listEvidenceBundles(projectId)).toHaveLength(2);
  });

  it('陈述指向未准入知识点、草案引用包外陈述都被拒绝', () => {
    confirmPlanWith([knowledgeId]);
    expectCode(
      () => store.buildLessonBundle(projectId, [{ knowledgeId: 'kp-absent', text: '无来源陈述', conditions: '' }], []),
      'NOT_FOUND',
    );

    const bundle = freeze();
    expectCode(
      () =>
        store.createLessonDraft({
          projectId,
          lessonId: null,
          title: '课时一',
          bundleId: bundle.bundleId,
          statementIds: ['stmt-not-in-bundle'],
          questionIds: [],
        }),
      'INVALID_ARGUMENT',
      'statement_outside_bundle',
    );
    expect(store.listLessons(projectId)).toHaveLength(0);
  });

  it('题目只能引用包内知识点，引用包外知识点时冻结失败', () => {
    confirmPlanWith([knowledgeId]);
    const other = store.createProposal({
      projectId,
      name: '另一个知识点',
      concept: '另一个概念陈述',
      conditions: '',
      scopeStatus: 'prerequisite',
      prerequisites: [],
      evidence: [{ materialId, revision: 1, segmentId: 'S002', use: 'concept_basis' }],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'user',
    });
    const otherKnowledge = store.applyReview({
      proposalId: other.proposalId,
      decision: 'approved',
      expectedRevision: other.revision,
      semanticReviewed: true,
    }).knowledgePoint!.knowledgeId;
    const question = store.createQuestion({
      stem: '综合题',
      answer: '略',
      solution: '略',
      knowledgeIds: [knowledgeId, otherKnowledge],
      requestedOrigin: 'ai_new',
      originRecord: null,
    }).question;

    expectCode(
      () => store.buildLessonBundle(projectId, [{ knowledgeId, text: '定义陈述', conditions: '' }], [question.questionId]),
      'KNOWLEDGE_SCOPE_INVALID',
    );
  });

  it('修改课程只新增草案版本，发布后旧已发布版本转为已取代', () => {
    confirmPlanWith([knowledgeId]);
    const bundle = freeze();
    const created = store.createLessonDraft({
      projectId,
      lessonId: null,
      title: '函数单调性（第 1 课时）',
      bundleId: bundle.bundleId,
      statementIds: bundle.bundle.statements.map((statement) => statement.statementId),
      questionIds: [],
    });
    expect(created.version).toBe(1);
    expect(created.status).toBe('draft');

    const revised = store.createLessonDraft({
      projectId,
      lessonId: created.lessonId,
      title: '函数单调性（第 1 课时·修订）',
      bundleId: bundle.bundleId,
      statementIds: created.statementIds,
      questionIds: [],
    });
    expect(revised.version).toBe(2);

    const published = store.publishLesson({ projectId, lessonId: created.lessonId, version: 1 });
    expect(published.status).toBe('published');
    const link = store.getLessonClassroomLink(created.lessonId, projectId);
    expect(link).toMatchObject({ lessonVersion: 1, evidenceBundleId: bundle.bundleId, stageId: null, status: 'published' });

    const second = store.publishLesson({ projectId, lessonId: created.lessonId, version: 2 });
    expect(second.status).toBe('published');
    const versions = store.listLessonVersions(created.lessonId, projectId);
    expect(versions.map((row) => [row.version, row.status])).toEqual([[2, 'published'], [1, 'superseded']]);
    expectCode(
      () => store.publishLesson({ projectId, lessonId: created.lessonId, version: 2 }),
      'STEP_ALREADY_COMMITTED',
    );
  });

  it('来源更新不改写已发布课程，但依赖旧来源的新发布会被准入阻断', () => {
    confirmPlanWith([knowledgeId]);
    const bundle = freeze();
    const lesson = store.createLessonDraft({
      projectId,
      lessonId: null,
      title: '函数单调性',
      bundleId: bundle.bundleId,
      statementIds: bundle.bundle.statements.map((statement) => statement.statementId),
      questionIds: [],
    });
    store.publishLesson({ projectId, lessonId: lesson.lessonId, version: lesson.version });

    // 同名材料重新导入产生新版本：已发布课程与证据包仍指向 r1 及其摘要。
    store.importMaterial({
      projectId,
      displayName: '考纲.md',
      materialType: 'md',
      rawText: '本章要求理解增函数的定义（修订）。',
    });
    const published = store.listLessonVersions(lesson.lessonId, projectId).find((row) => row.version === 1);
    expect(published?.status).toBe('published');
    const stillFrozen = store.getLessonClassroomLink(lesson.lessonId, projectId);
    expect(stillFrozen?.evidenceBundleId).toBe(bundle.bundleId);
    expect(store.listEvidenceBundles(projectId)[0]?.bundle.segmentDigests[0]?.revision).toBe(1);

    // 新草案引用同一知识点时，准入复验会因来源版本变化而阻断发布。
    const fresh = store.createLessonDraft({
      projectId,
      lessonId: lesson.lessonId,
      title: '函数单调性（修订）',
      bundleId: bundle.bundleId,
      statementIds: bundle.bundle.statements.map((statement) => statement.statementId),
      questionIds: [],
    });
    expectCode(
      () => store.publishLesson({ projectId, lessonId: fresh.lessonId, version: fresh.version }),
      'KNOWLEDGE_INVALIDATED',
    );
  });

  it('损坏的证据包按权威列拒绝，不按空包继续', () => {
    confirmPlanWith([knowledgeId]);
    const bundle = freeze();
    store.close();
    const db = createNodeSqliteDriver().open(join(root, '.study', 'study.db'));
    db.prepare("UPDATE evidence_bundles SET bundle_json = '{\"bundleVersion\":1}' WHERE bundle_id = ?").run(bundle.bundleId);
    db.close();

    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    expectCode(() => store.listEvidenceBundles(projectId), 'INTERNAL');
  });
});
