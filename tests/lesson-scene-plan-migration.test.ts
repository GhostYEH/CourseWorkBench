import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  StudyError,
  scenePlanSchema,
  coursewareCandidateSchema,
  evidenceBundleSchema,
} from '@sew/study-contracts';
import { assertPlanPublishable, scenePlanDigest, evidenceBundleDigest } from '@sew/study-domain';
import { StudyStore, createNodeSqliteDriver, type SqlDatabase } from '@sew/study-storage';
import { MIGRATIONS, SCHEMA_VERSION } from '../packages/study-storage/src/schema';
import { migrateScenePlanJson } from '../packages/study-storage/src/migrations/scene-plan';

const projectId = 'proj_legacy';
const lessonId = 'lesson_legacy';
const at = '2026-10-01T00:00:00.000Z';
const reviewedAt = '2026-10-01T00:00:01.000Z';
const publishedAt = '2026-10-01T00:00:02.000Z';
const scenes = [
  {
    sceneId: 'scene_legacy',
    kind: 'slide' as const,
    title: '历史课件正文',
    statementId: 'statement_legacy',
    questionId: null,
    knowledgeIds: ['knowledge_legacy'],
    elements: [],
    note: '',
  },
];
const legacyPlan = (version = 1) => ({
  planVersion: 1,
  projectId,
  lessonId,
  lessonVersion: version,
  bundleId: 'bundle_legacy',
  scenes,
  revision: 3,
  origin: 'deterministic',
  updatedAt: at,
});
const legacyCandidate = (candidateId: string, status = 'pending') => ({
  candidateId,
  projectId,
  lessonId,
  baseVersion: 1,
  origin: 'model_generated',
  status,
  scenes,
  instruction: '旧生成请求',
  note: '',
  reviewedBy: status === 'pending' ? null : 'learner_legacy',
  createdAt: at,
  updatedAt: at,
});
const generation = {
  ok: true,
  message: '已保存候选',
  totalTokens: 10,
  elapsedMs: 25,
  usage: { callsUsed: 1, tokensUsed: 10, maxCalls: 10, maxTokens: 1000 },
  remainingCalls: 9,
  remainingTokens: 990,
  pendingExplanationId: null,
};

describe('旧场景计划数据库升级', () => {
  const roots: string[] = [];
  const handles: { close(): void }[] = [];
  const openDb = (file: string) => {
    const db = createNodeSqliteDriver().open(file);
    handles.push(db);
    return db;
  };
  const openStore = (file: string) => {
    const store = StudyStore.open({ file });
    handles.push(store);
    return store;
  };
  const fixture = (version = 27) => {
    const root = mkdtempSync(join(tmpdir(), 'sew-scene-upgrade-'));
    roots.push(root);
    const file = join(root, 'legacy.sqlite');
    const db = openDb(file);
    db.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    for (const migration of MIGRATIONS.filter((item) => item.version <= version)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(
        migration.version,
        migration.name,
        at,
      );
    }
    db.prepare(
      'INSERT INTO projects (project_id,display_name,created_at,updated_at) VALUES (?,?,?,?)',
    ).run(projectId, '旧项目', at, at);
    db.prepare('INSERT INTO evidence_bundles VALUES (?,?,?,?,?)').run(
      'bundle_legacy',
      projectId,
      'legacy-bundle-digest',
      '{}',
      at,
    );
    for (const lessonVersion of [1, 2, 3]) {
      db.prepare(
        `INSERT INTO lesson_versions
        (lesson_id,version,project_id,title,status,bundle_id,bundle_digest,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        lessonId,
        lessonVersion,
        projectId,
        '旧课程',
        lessonVersion === 2 ? 'published' : 'draft',
        'bundle_legacy',
        'legacy-bundle-digest',
        at,
        lessonVersion === 2 ? publishedAt : at,
      );
      db.prepare(
        "INSERT INTO lesson_reviews (project_id,lesson_id,version,decision,reviewed_at) VALUES (?,?,?,'approved',?)",
      ).run(projectId, lessonId, lessonVersion, reviewedAt);
      if (lessonVersion !== 3)
        db.prepare('INSERT INTO lesson_scene_plans VALUES (?,?,?,?,?,?,?,?,?)').run(
          projectId,
          lessonId,
          lessonVersion,
          'bundle_legacy',
          JSON.stringify(legacyPlan(lessonVersion)),
          3,
          'deterministic',
          at,
          at,
        );
    }
    for (const [id, status] of [
      ['candidate_pending', 'pending'],
      ['candidate_applied', 'applied'],
      ['candidate_rejected', 'rejected'],
    ]) {
      db.prepare(
        `INSERT INTO lesson_courseware_candidates
        (candidate_id,project_id,lesson_id,base_version,status,candidate_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        projectId,
        lessonId,
        1,
        status,
        JSON.stringify(legacyCandidate(id!, status)),
        at,
        at,
      );
    }
    db.prepare('INSERT INTO lesson_courseware_receipts VALUES (?,?,?,?,?)').run(
      projectId,
      'propose_old',
      'propose',
      'old-propose-intent',
      JSON.stringify({
        candidate: legacyCandidate('candidate_pending'),
        generation,
        deduplicated: false,
      }),
    );
    db.prepare('INSERT INTO lesson_courseware_receipts VALUES (?,?,?,?,?)').run(
      projectId,
      'apply_old',
      'apply',
      JSON.stringify({ candidateId: 'candidate_applied', decision: 'approved', note: '' }),
      JSON.stringify({
        candidate: legacyCandidate('candidate_applied', 'applied'),
        plan: legacyPlan(),
        deduplicated: false,
      }),
    );
    db.prepare('INSERT INTO lesson_courseware_receipts VALUES (?,?,?,?,?)').run(
      projectId,
      'reject_old',
      'apply',
      JSON.stringify({ candidateId: 'candidate_rejected', decision: 'rejected', note: '' }),
      JSON.stringify({
        candidate: legacyCandidate('candidate_rejected', 'rejected'),
        plan: null,
        deduplicated: false,
      }),
    );
    const history = JSON.stringify({
      stage: { id: 'stage_legacy' },
      scenes: [{ answer: '历史答案不能被迁移改写' }],
    });
    db.prepare(
      'INSERT INTO classroom_documents (stage_id,project_id,lesson_id,document_json,digest,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    ).run('stage_legacy', projectId, lessonId, history, 'original-document-digest', at, at);
    db.prepare(
      'INSERT INTO questions (question_id,stem,answer,origin,origin_label,created_at) VALUES (?,?,?,?,?,?)',
    ).run('question_legacy', '历史题干', '历史答案', 'ai_new', '历史来源', at);
    db.prepare(
      `INSERT INTO attempts
      (attempt_id,question_id,kind,actor_type,answer_text,attribution_status,idempotency_key,submitted_at)
      VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      'attempt_legacy',
      'question_legacy',
      'real',
      'learner',
      '历史作答',
      'pending',
      'old-answer-nonce',
      at,
    );
    return { db, file, history };
  };
  const errorDetails = (action: () => unknown) => {
    try {
      action();
    } catch (error) {
      expect(error).toBeInstanceOf(StudyError);
      return (error as StudyError).details;
    }
    throw new Error('应拒绝损坏的数据');
  };
  const snapshot = (db: SqlDatabase) =>
    ['lesson_versions', 'lesson_reviews', 'classroom_documents', 'questions', 'attempts'].map(
      (table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );

  // 专项业务入口 fixture：选中的 AI 新题没有知识点绑定，但题目、答案、证据包与计划均合法。
  const classroomFixture = (version: number) => {
    const result = fixture(version);
    const bundle = evidenceBundleSchema.parse({
      bundleVersion: 1,
      projectId,
      subject: '数学',
      recordScope: 'formal',
      planVersion: 1,
      knowledgeVersions: [{ knowledgeId: 'knowledge_legacy', revision: 1 }],
      materialRevisions: { material_legacy: 1 },
      segmentDigests: [
        {
          materialId: 'material_legacy',
          revision: 1,
          segmentId: 'S001',
          fingerprint: 'legacy-source',
        },
      ],
      statements: [
        {
          statementId: 'statement_legacy',
          knowledgeId: 'knowledge_legacy',
          text: '历史课件正文',
          conditions: '',
          evidence: [
            { materialId: 'material_legacy', revision: 1, segmentId: 'S001', use: 'concept_basis' },
          ],
        },
      ],
      questions: [
        {
          questionId: 'question_legacy',
          revision: 1,
          origin: 'ai_new',
          knowledgeIds: [],
          snapshot: { stem: '历史题干', answer: '历史答案', solution: '', assessment: null },
        },
      ],
      reviewProvenance: 'user_semantic',
      teachingPreferenceVersion: 0,
      roleConfigDigest: null,
    });
    const digest = evidenceBundleDigest(bundle);
    result.db
      .prepare('UPDATE evidence_bundles SET bundle_json=?,digest=?')
      .run(JSON.stringify(bundle), digest);
    result.db
      .prepare('UPDATE lesson_versions SET bundle_digest=?,question_ids_json=?')
      .run(digest, JSON.stringify(['question_legacy']));
    const plan = {
      ...legacyPlan(2),
      scenes: [
        {
          ...scenes[0]!,
          kind: 'quiz' as const,
          statementId: null,
          questionId: 'question_legacy',
          knowledgeIds: [],
        },
      ],
    };
    result.db
      .prepare('UPDATE lesson_scene_plans SET plan_json=? WHERE lesson_version=2')
      .run(JSON.stringify(plan));
    result.db
      .prepare(
        `INSERT INTO classroom_links
      (lesson_id,project_id,lesson_version,evidence_bundle_id,status,created_at,updated_at)
      VALUES (?,?,2,?,'published',?,?)`,
      )
      .run(lessonId, projectId, 'bundle_legacy', publishedAt, publishedAt);
    return { ...result, plan };
  };

  afterEach(() => {
    for (const handle of handles.splice(0)) {
      try {
        handle.close();
      } catch {
        /* 部分 fixture 已显式关闭 */
      }
    }
    for (const root of roots.splice(0)) {
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'sew-scene-upgrade-'))
        throw new Error('Unexpected fixture cleanup path');
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([27, 28])('真实 v%i 旧 JSON 升级后严格读取计划、三态候选和历史回执', (version) => {
    const { db, file } = fixture(version);
    const history = snapshot(db);
    db.close();
    const store = openStore(file);
    const plan = store.getScenePlan(projectId, lessonId, 1)!;
    expect(scenePlanSchema.parse(plan).digest).toBe(scenePlanDigest(legacyPlan()));
    expect(plan.scenes).toEqual(scenes);
    expect(plan.revision).toBe(3);
    const candidates = store.listProjectCoursewareCandidates(projectId);
    expect(candidates.map((item) => item.status)).toEqual(['applied', 'pending', 'rejected']);
    for (const candidate of candidates)
      expect(coursewareCandidateSchema.parse(candidate)).toMatchObject({
        basePlanRevision: 0,
        basePlanDigest: null,
      });
    const proposed = store.coursewareReceipt(
      projectId,
      'propose_old',
      'propose',
      'old-propose-intent',
    )!;
    expect(proposed.result).toMatchObject({
      candidate: { basePlanRevision: 0, basePlanDigest: null },
      generation,
    });
    const intent = JSON.stringify({
      candidateId: 'candidate_applied',
      decision: 'approved',
      note: '',
      expectedPlanRevision: null,
      override: false,
    });
    const receipt = store.scenePlanReceipt(projectId, 'apply_old', 'apply-courseware', intent)!;
    expect(receipt).toMatchObject({
      state: 'completed',
      result: { plan: { digest: plan.digest }, candidate: { status: 'applied' } },
    });
    const rejectedIntent = JSON.stringify({
      candidateId: 'candidate_rejected',
      decision: 'rejected',
      note: '',
      expectedPlanRevision: null,
      override: false,
    });
    expect(
      store.scenePlanReceipt(projectId, 'reject_old', 'apply-courseware', rejectedIntent),
    ).toMatchObject({
      state: 'completed',
      result: { plan: null, candidate: { status: 'rejected' } },
    });
    expect(
      errorDetails(() =>
        store.scenePlanReceipt(projectId, 'apply_old', 'apply-courseware', intent + ' '),
      ),
    ).toMatchObject({ reason: 'scene_plan_nonce_reused' });
    expect(
      errorDetails(() =>
        store.applyCoursewareCandidate({
          projectId,
          candidateId: 'candidate_pending',
          decision: 'approved',
          note: '',
          reviewedBy: 'learner_legacy',
          scenes,
        }),
      ),
    ).toMatchObject({ reason: 'plan_revision_stale' });
    const review = store.getLessonReview(lessonId, 1, projectId)!;
    expect(review).toMatchObject({ decision: 'approved', planRevision: null, planDigest: null });
    expect(
      errorDetails(() =>
        assertPlanPublishable(review, { revision: plan.revision, digest: plan.digest }),
      ),
    ).toMatchObject({ reason: 'review_plan_missing' });
    expect(() =>
      assertPlanPublishable(store.getLessonReview(lessonId, 3, projectId), null),
    ).not.toThrow();
    expect(store.getLessonVersion(lessonId, 2, projectId)!.status).toBe('published');
    expect(store.getLessonReview(lessonId, 2, projectId)).toMatchObject({
      planRevision: 3,
      planDigest: scenePlanDigest(legacyPlan(2)),
      reviewedAt,
    });
    expect(() =>
      assertPlanPublishable(
        store.getLessonReview(lessonId, 2, projectId),
        store.getScenePlan(projectId, lessonId, 2),
      ),
    ).not.toThrow();
    store.close();
    const upgraded = openDb(file);
    expect(
      (
        upgraded.prepare('SELECT max(version) AS version FROM schema_migrations').get() as {
          version: number;
        }
      ).version,
    ).toBe(SCHEMA_VERSION);
    expect(snapshot(upgraded)).toEqual(
      history.map((rows, index) =>
        index === 1
          ? (rows as Record<string, unknown>[]).map((row) => ({
              ...row,
              plan_revision: row['version'] === 2 ? 3 : null,
              plan_digest: row['version'] === 2 ? scenePlanDigest(legacyPlan(2)) : null,
            }))
          : rows,
      ),
    );
    const first = upgraded
      .prepare('SELECT plan_json FROM lesson_scene_plans ORDER BY lesson_version')
      .all();
    upgraded.transaction(() => migrateScenePlanJson(upgraded));
    expect(
      upgraded.prepare('SELECT plan_json FROM lesson_scene_plans ORDER BY lesson_version').all(),
    ).toEqual(first);
    upgraded.close();
    expect(openStore(file).listProjectScenePlans(projectId)).toHaveLength(2);
  });

  it.each([27, 28])('v%i 可证明先保存、再审核、再发布的历史计划恢复课堂业务入口', (version) => {
    const { db, file, plan } = classroomFixture(version);
    const history = snapshot(db);
    db.close();
    const store = openStore(file);
    expect(store.assertLessonClassroomReady(lessonId, projectId).lesson.version).toBe(2);
    expect(store.getLessonReview(lessonId, 2, projectId)).toMatchObject({
      planRevision: plan.revision,
      planDigest: scenePlanDigest(plan),
      reviewedAt,
    });
    store.close();
    const upgraded = openDb(file);
    const after = snapshot(upgraded);
    expect(after.filter((_, index) => index !== 1)).toEqual(
      history.filter((_, index) => index !== 1),
    );
    expect(after[1]).toEqual(
      (history[1] as Record<string, unknown>[]).map((row) => ({
        ...row,
        plan_revision: row['version'] === 2 ? plan.revision : null,
        plan_digest: row['version'] === 2 ? scenePlanDigest(plan) : null,
      })),
    );
  });

  it.each(
    [27, 28].flatMap((version) =>
      [
        'same_millisecond',
        'changed_after_review',
        'changed_after_publish',
        'missing_review_time',
        'invalid_publish_time',
        'invalid_plan_time',
        'mismatched_plan_time',
        'review_after_publish',
        'draft',
        'rejected',
      ].map((kind) => ({ version, kind })),
    ),
  )('v$version $kind 不伪造审核基线', ({ version, kind }) => {
    const { db, file, plan } = classroomFixture(version);
    if (kind === 'same_millisecond')
      db.prepare('UPDATE lesson_reviews SET reviewed_at=? WHERE version=2').run(at);
    if (kind === 'missing_review_time')
      db.prepare("UPDATE lesson_reviews SET reviewed_at='' WHERE version=2").run();
    if (kind === 'invalid_publish_time')
      db.prepare(
        "UPDATE lesson_versions SET updated_at='2026-02-30T00:00:00.000Z' WHERE version=2",
      ).run();
    if (kind === 'invalid_plan_time')
      db.prepare(
        'UPDATE lesson_scene_plans SET plan_json=?,updated_at=? WHERE lesson_version=2',
      ).run(JSON.stringify({ ...plan, updatedAt: '' }), '');
    if (kind === 'mismatched_plan_time')
      db.prepare('UPDATE lesson_scene_plans SET updated_at=? WHERE lesson_version=2').run(
        reviewedAt,
      );
    if (kind === 'review_after_publish')
      db.prepare('UPDATE lesson_reviews SET reviewed_at=? WHERE version=2').run(
        '2026-10-01T00:00:03.000Z',
      );
    if (kind === 'changed_after_review' || kind === 'changed_after_publish') {
      const changedAt =
        kind === 'changed_after_review' ? '2026-10-01T00:00:01.500Z' : '2026-10-01T00:00:03.000Z';
      db.prepare(
        'UPDATE lesson_scene_plans SET plan_json=?,updated_at=? WHERE lesson_version=2',
      ).run(
        JSON.stringify({
          ...plan,
          updatedAt: changedAt,
          scenes: [{ ...plan.scenes[0]!, title: '审核后的新正文' }],
        }),
        changedAt,
      );
    }
    if (kind === 'draft')
      db.prepare("UPDATE lesson_versions SET status='draft' WHERE version=2").run();
    if (kind === 'rejected')
      db.prepare("UPDATE lesson_reviews SET decision='rejected' WHERE version=2").run();
    db.close();
    const store = openStore(file);
    expect(store.getLessonReview(lessonId, 2, projectId)).toMatchObject({
      planRevision: null,
      planDigest: null,
    });
    expect(errorDetails(() => store.assertLessonClassroomReady(lessonId, projectId))).toMatchObject(
      { reason: kind === 'rejected' ? 'lesson_version_not_approved' : 'review_plan_missing' },
    );
  });

  it('v28 已有真实摘要、候选基线和审核绑定逐项保留，不降级成未知历史', () => {
    const { db, file } = fixture(28);
    const plan = { ...legacyPlan(), digest: scenePlanDigest(legacyPlan()) };
    const candidate = {
      ...legacyCandidate('candidate_pending'),
      basePlanRevision: plan.revision,
      basePlanDigest: plan.digest,
    };
    db.prepare('UPDATE lesson_scene_plans SET plan_json=? WHERE lesson_version=1').run(
      JSON.stringify(plan),
    );
    db.prepare(
      'UPDATE lesson_courseware_candidates SET candidate_json=?,base_plan_revision=?,base_plan_digest=? WHERE candidate_id=?',
    ).run(JSON.stringify(candidate), plan.revision, plan.digest, candidate.candidateId);
    db.prepare('UPDATE lesson_reviews SET plan_revision=?,plan_digest=? WHERE version=1').run(
      plan.revision,
      plan.digest,
    );
    db.close();
    const store = openStore(file);
    expect(store.getScenePlan(projectId, lessonId, 1)).toEqual(plan);
    expect(store.getCoursewareCandidate(projectId, candidate.candidateId)).toEqual(candidate);
    const review = store.getLessonReview(lessonId, 1, projectId)!;
    expect(review).toMatchObject({ planRevision: plan.revision, planDigest: plan.digest });
    expect(() =>
      assertPlanPublishable(review, { revision: plan.revision, digest: plan.digest }),
    ).not.toThrow();
  });

  it('升级已落库 v28 回执自己的旧快照，不以最新计划替代历史结果', () => {
    const { db, file } = fixture(28);
    const older = {
      ...legacyPlan(),
      revision: 1,
      scenes: [{ ...scenes[0]!, title: '回执里的旧正文' }],
    };
    const intent = JSON.stringify({ lessonId, version: 1, baseRevision: 0, scenes: older.scenes });
    db.prepare(
      `INSERT INTO lesson_scene_plan_receipts
      (project_id,request_id,action,intent_json,state,result_json,created_at)
      VALUES (?,?,'save-scene-plan',?,'completed',?,?)`,
    ).run(projectId, 'save_old', intent, JSON.stringify({ plan: older }), at);
    db.close();
    const store = openStore(file);
    expect(
      store.scenePlanReceipt(projectId, 'save_old', 'save-scene-plan', intent)!.result,
    ).toMatchObject({
      plan: { revision: 1, digest: scenePlanDigest(older), scenes: [{ title: '回执里的旧正文' }] },
    });
    expect(store.getScenePlan(projectId, lessonId, 1)!.scenes[0]!.title).toBe('历史课件正文');
  });

  it.each([25, 48])('v28 合法 %i 场景旧保存回执不受新写入上限限制', (count) => {
    const { db, file } = fixture(28);
    const plan = {
      ...legacyPlan(),
      revision: 1,
      scenes: Array.from({ length: count }, (_, index) => ({
        ...scenes[0]!,
        sceneId: `scene_old_${index}`,
      })),
    };
    const intent = JSON.stringify({ lessonId, version: 1, baseRevision: 0, scenes: plan.scenes });
    db.prepare(
      `INSERT INTO lesson_scene_plan_receipts
      (project_id,request_id,action,intent_json,state,result_json,created_at)
      VALUES (?,?,'save-scene-plan',?,'completed',?,?)`,
    ).run(projectId, 'save_many', intent, JSON.stringify({ plan }), at);
    db.close();
    const store = openStore(file);
    expect(
      store.scenePlanReceipt(projectId, 'save_many', 'save-scene-plan', intent)!.result,
    ).toMatchObject({ plan: { revision: 1, scenes: plan.scenes, digest: scenePlanDigest(plan) } });
  });

  it.each([
    'save_project',
    'save_lesson',
    'save_version',
    'apply_project',
    'apply_candidate',
    'apply_decision',
    'apply_missing_plan',
    'apply_plan_lesson',
    'apply_plan_version',
    'invalid_intent',
  ])('v28 损坏 completed %s 回执拒绝迁移并回滚审核补绑定', (kind) => {
    const { db, file } = fixture(28);
    const save = kind.startsWith('save');
    const plan = legacyPlan();
    const candidate = legacyCandidate('candidate_applied', 'applied');
    const intent = save
      ? { lessonId, version: 1, baseRevision: 0, scenes }
      : {
          candidateId: candidate.candidateId,
          decision: 'approved',
          note: '',
          expectedPlanRevision: null,
          override: false,
        };
    const result: {
      plan: ReturnType<typeof legacyPlan> | null;
      candidate?: ReturnType<typeof legacyCandidate>;
    } = save ? { plan } : { plan, candidate };
    if (kind === 'save_project') plan.projectId = 'other_project';
    if (kind === 'save_lesson' || kind === 'apply_plan_lesson') plan.lessonId = 'other_lesson';
    if (kind === 'save_version' || kind === 'apply_plan_version') plan.lessonVersion = 9;
    if (kind === 'apply_project') {
      candidate.projectId = 'other_project';
      plan.projectId = 'other_project';
    }
    if (kind === 'apply_candidate') candidate.candidateId = 'other_candidate';
    if (kind === 'apply_decision') candidate.status = 'rejected';
    if (kind === 'apply_missing_plan') result.plan = null;
    db.prepare(
      `INSERT INTO lesson_scene_plan_receipts
      (project_id,request_id,action,intent_json,state,result_json,created_at)
      VALUES (?,?,?,?,'completed',?,?)`,
    ).run(
      projectId,
      'corrupt_completed',
      save ? 'save-scene-plan' : 'apply-courseware',
      kind === 'invalid_intent' ? '{bad' : JSON.stringify(intent),
      JSON.stringify(result),
      at,
    );
    const before = snapshot(db);
    const receiptBefore = db.prepare('SELECT * FROM lesson_scene_plan_receipts').all();
    db.close();
    expect(errorDetails(() => StudyStore.open({ file }))).toMatchObject({
      reason: 'invalid_scene_plan_migration',
    });
    const failed = openDb(file);
    expect(snapshot(failed)).toEqual(before);
    expect(failed.prepare('SELECT * FROM lesson_scene_plan_receipts').all()).toEqual(receiptBefore);
    expect(
      failed.prepare('SELECT version FROM schema_migrations WHERE version=29').get(),
    ).toBeUndefined();
  });

  it.each([
    'plan_json',
    'candidate_json',
    'receipt_json',
    'wrong_digest',
    'partial_baseline',
    'identity',
  ])('损坏 %s 拒绝迁移并回滚所有 v29 JSON 修改和版本回执', (kind) => {
    const { db, file } = fixture(28);
    if (kind === 'plan_json')
      db.prepare('UPDATE lesson_scene_plans SET plan_json=? WHERE lesson_version=2').run(
        JSON.stringify({ ...legacyPlan(2), unexpected: true }),
      );
    if (kind === 'wrong_digest')
      db.prepare('UPDATE lesson_scene_plans SET plan_json=? WHERE lesson_version=2').run(
        JSON.stringify({ ...legacyPlan(2), digest: 'fabricated' }),
      );
    if (kind === 'identity')
      db.prepare('UPDATE lesson_scene_plans SET plan_json=? WHERE lesson_version=2').run(
        JSON.stringify({ ...legacyPlan(2), projectId: 'other-project' }),
      );
    if (kind === 'candidate_json' || kind === 'partial_baseline')
      db.prepare(
        'UPDATE lesson_courseware_candidates SET candidate_json=? WHERE candidate_id=?',
      ).run(
        kind === 'candidate_json'
          ? '{bad'
          : JSON.stringify({
              ...legacyCandidate('candidate_rejected', 'rejected'),
              basePlanRevision: 1,
            }),
        'candidate_rejected',
      );
    if (kind === 'receipt_json')
      db.prepare('UPDATE lesson_courseware_receipts SET result_json=? WHERE request_id=?').run(
        JSON.stringify({
          candidate: legacyCandidate('candidate_pending'),
          generation,
          deduplicated: false,
          unknown: true,
        }),
        'propose_old',
      );
    const before = db
      .prepare('SELECT plan_json FROM lesson_scene_plans ORDER BY lesson_version')
      .all();
    const candidates = db
      .prepare('SELECT candidate_json FROM lesson_courseware_candidates ORDER BY candidate_id')
      .all();
    db.close();
    expect(errorDetails(() => StudyStore.open({ file }))).toMatchObject({
      reason: 'invalid_scene_plan_migration',
    });
    const failed = openDb(file);
    expect(
      failed.prepare('SELECT plan_json FROM lesson_scene_plans ORDER BY lesson_version').all(),
    ).toEqual(before);
    expect(
      failed
        .prepare('SELECT candidate_json FROM lesson_courseware_candidates ORDER BY candidate_id')
        .all(),
    ).toEqual(candidates);
    expect(
      failed.prepare('SELECT version FROM schema_migrations WHERE version=29').get(),
    ).toBeUndefined();
    expect(failed.prepare('SELECT * FROM lesson_scene_plan_receipts').all()).toEqual([]);
  });
});
