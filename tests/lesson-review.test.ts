import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyError, newId, type PlanPayloadDto } from '@sew/study-contracts';
import { StudyStore, createNodeSqliteDriver, ensureProjectLayout, projectPaths } from '@sew/study-storage';

/**
 * 课程草案的审核、发布与撤回（LESSON-02）。
 *
 * 关注的是四道入口是否用同一份准入判定：生成（冻结证据包）、审核、发布、上课。
 * 「模型输出为草案」由生成入口保证，本文件固定的是人工审核与停用的合同。
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

describe('课程审核、发布与撤回', () => {
  let root: string;
  let store: StudyStore;
  let projectId: string;
  let materialId: string;
  let knowledgeId: string;
  let bundleId = '';
  let statementId = '';

  const draft = (title = '函数单调性（第 1 课时）', lessonId: string | null = null) =>
    store.createLessonDraft({
      projectId,
      lessonId,
      title,
      bundleId,
      statementIds: [statementId],
      questionIds: [],
    });

  const review = (lessonId: string, version: number, decision: 'approved' | 'rejected' = 'approved', note = '按原文核对') =>
    store.reviewLesson({ projectId, lessonId, version, decision, note });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-lesson-review-'));
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

    const payload: PlanPayloadDto = {
      payloadVersion: 1,
      goal: '掌握本章',
      examDate: null,
      dailyMinutes: 60,
      tasks: [{
        knowledgeId, name: '增函数定义', minutes: 30, acceptance: '',
        evidence: [{ materialId, segmentId: 'S001' }],
      }],
      gaps: [],
      basis: '测试计划',
      confirmedTaskKnowledgeIds: [knowledgeId],
    };
    store.savePlanVersion(projectId, 1, 'confirmed', payload);
    const bundle = store.buildLessonBundle(projectId, [{ knowledgeId, text: '增函数的定义', conditions: '同一区间 D 内' }], []);
    bundleId = bundle.bundleId;
    statementId = bundle.bundle.statements[0]!.statementId;
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('草案未经审核不能发布，审核通过后才能发布', () => {
    const lesson = draft();
    expectCode(
      () => store.publishLesson({ projectId, lessonId: lesson.lessonId, version: lesson.version }),
      'CLASSROOM_LESSON_NOT_REVIEWED',
      'lesson_version_not_approved',
    );
    const recorded = review(lesson.lessonId, lesson.version);
    expect(recorded).toMatchObject({ decision: 'approved', note: '按原文核对' });
    expect(recorded.admittedKnowledgeIds).toEqual([knowledgeId]);
    expect(recorded.blockedKnowledgeIds).toEqual([]);
    expect(store.publishLesson({ projectId, lessonId: lesson.lessonId, version: lesson.version }).status).toBe('published');
  });

  it('审核退回不改变草案状态，发布仍被阻断', () => {
    const lesson = draft();
    expect(review(lesson.lessonId, lesson.version, 'rejected', '表述与原文不一致').decision).toBe('rejected');
    expect(store.listLessonVersions(lesson.lessonId, projectId)[0]?.status).toBe('draft');
    expectCode(
      () => store.publishLesson({ projectId, lessonId: lesson.lessonId, version: lesson.version }),
      'CLASSROOM_LESSON_NOT_REVIEWED',
      'lesson_version_not_approved',
    );
  });

  it('审核结论只绑定该版本，新草案版本必须重新审核', () => {
    const first = draft();
    review(first.lessonId, first.version);
    store.publishLesson({ projectId, lessonId: first.lessonId, version: first.version });

    const second = draft('函数单调性（修订）', first.lessonId);
    expect(store.getLessonReview(second.lessonId, second.version, projectId)).toBeNull();
    expectCode(
      () => store.publishLesson({ projectId, lessonId: second.lessonId, version: second.version }),
      'CLASSROOM_LESSON_NOT_REVIEWED',
      'lesson_version_not_approved',
    );
    review(second.lessonId, second.version);
    expect(store.publishLesson({ projectId, lessonId: second.lessonId, version: second.version }).status).toBe('published');
    expect(store.listLessonVersions(first.lessonId, projectId).find((row) => row.version === 1)?.status).toBe('superseded');
  });

  it('已发布或已被取代的版本不能再审核改判', () => {
    const lesson = draft();
    review(lesson.lessonId, lesson.version);
    store.publishLesson({ projectId, lessonId: lesson.lessonId, version: lesson.version });
    expectCode(
      () => review(lesson.lessonId, lesson.version, 'rejected'),
      'STEP_ALREADY_COMMITTED',
      'only_draft_reviewable',
    );

    const revised = draft('函数单调性（修订）', lesson.lessonId);
    review(revised.lessonId, revised.version);
    store.publishLesson({ projectId, lessonId: revised.lessonId, version: revised.version });
    expectCode(
      () => review(lesson.lessonId, lesson.version),
      'STEP_ALREADY_COMMITTED',
      'only_draft_reviewable',
    );
  });

  it('撤回停用课堂入口并保留原因，历史版本与证据包摘要不变', () => {
    const lesson = draft();
    review(lesson.lessonId, lesson.version);
    store.publishLesson({ projectId, lessonId: lesson.lessonId, version: lesson.version });
    expect(store.assertLessonClassroomReady(lesson.lessonId, projectId).lesson.version).toBe(lesson.version);

    const withdrawn = store.withdrawLesson({ projectId, lessonId: lesson.lessonId, reason: '来源待更新，先停用' });
    expect(withdrawn.status).toBe('withdrawn');
    const link = store.getLessonClassroomLink(lesson.lessonId, projectId);
    expect(link).toMatchObject({ status: 'withdrawn', statusNote: '来源待更新，先停用' });
    expectCode(
      () => store.assertLessonClassroomReady(lesson.lessonId, projectId),
      'CLASSROOM_LESSON_NOT_REVIEWED',
      'no_published_link',
    );
    expectCode(
      () => store.publishLesson({ projectId, lessonId: lesson.lessonId, version: lesson.version }),
      'STEP_ALREADY_COMMITTED',
    );
    // 冻结的事实不因撤回而改写。
    expect(store.listEvidenceBundles(projectId)[0]?.bundleId).toBe(bundleId);
    expectCode(
      () => store.withdrawLesson({ projectId, lessonId: lesson.lessonId, reason: '再撤一次' }),
      'INVALID_ARGUMENT',
      'lesson_not_published',
    );
  });

  it('撤回后重新审核并发布的新版本会恢复课堂入口', () => {
    const lesson = draft();
    review(lesson.lessonId, lesson.version);
    store.publishLesson({ projectId, lessonId: lesson.lessonId, version: lesson.version });
    store.withdrawLesson({ projectId, lessonId: lesson.lessonId, reason: '暂时停用' });

    const revised = draft('函数单调性（重备）', lesson.lessonId);
    review(revised.lessonId, revised.version);
    store.publishLesson({ projectId, lessonId: lesson.lessonId, version: revised.version });
    const ready = store.assertLessonClassroomReady(lesson.lessonId, projectId);
    expect(ready.lesson.status).toBe('published');
    expect(ready.link.status).toBe('published');
    expect(ready.link.statusNote).toBe('');
    expect(ready.referencedKnowledgeIds).toEqual([knowledgeId]);
  });

  it('审核记录按权威列读取，损坏后拒绝而不是当作未审核', () => {
    const lesson = draft();
    review(lesson.lessonId, lesson.version);
    store.close();
    const db = createNodeSqliteDriver().open(join(root, '.study', 'study.db'));
    db.prepare('UPDATE lesson_reviews SET admitted_json = \'{"broken":1}\' WHERE lesson_id = ? AND version = ?')
      .run(lesson.lessonId, lesson.version);
    db.close();

    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    expectCode(() => store.getLessonReview(lesson.lessonId, lesson.version, projectId), 'INTERNAL');
  });

  it('来源更新后审核入口按准入阻断，批准不能放行失效来源', () => {
    const lesson = draft();
    store.importMaterial({
      projectId,
      displayName: '考纲.md',
      materialType: 'md',
      rawText: '本章要求理解增函数的定义（表述已修订）。',
    });
    try {
      review(lesson.lessonId, lesson.version);
      throw new Error('来源已变化时不应批准审核');
    } catch (error) {
      const studyError = error as StudyError;
      expect(studyError.code).toBe('KNOWLEDGE_INVALIDATED');
      expect(studyError.details?.['knowledgeIds']).toEqual([knowledgeId]);
    }
    // 退回结论仍可记录：审核入口只阻断「放行」，不阻断「更严格的判断」。
    expect(review(lesson.lessonId, lesson.version, 'rejected', '来源版本已变').blockedKnowledgeIds).toEqual([knowledgeId]);
  });
});
