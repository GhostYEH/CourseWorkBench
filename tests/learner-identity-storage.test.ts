import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_LOCAL_LEARNER_KEY } from '@sew/study-contracts';
import { RUNTIME_DSL_VERSION } from '@openmaic/dsl';
import { createNodeSqliteDriver, StudyStore } from '@sew/study-storage';

const UID = 'uid_10000000-0000-4000-8000-000000000001';
const OTHER = 'uid_10000000-0000-4000-8000-000000000002';
const roots: string[] = [];
const stores: StudyStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sew-uid-binding-')); roots.push(root);
  const file = join(root, 'study.db'); const store = StudyStore.open({ file }); stores.push(store);
  store.createProject({ projectId: 'p', displayName: '科目' });
  return { store, file, root };
}
describe('local UID explains existing project learner partition', () => {
  it('binds once, retries unchanged, and rejects a different profile or malformed UID', () => {
    const f = fixture(); const binding = f.store.bindLocalLearner('p', UID);
    expect(binding).toMatchObject({ uid: UID, learnerKey: LEGACY_LOCAL_LEARNER_KEY, origin: 'created_local' });
    expect(f.store.bindLocalLearner('p', UID)).toEqual(binding);
    expect(() => f.store.bindLocalLearner('p', OTHER)).toThrowError(expect.objectContaining({ code: 'PROJECT_NOT_AUTHORIZED' }));
    expect(() => f.store.bindLocalLearner('p', 'forged')).toThrow();
    expect(() => f.store.bindLocalLearner('missing', UID)).toThrow();
    expect(f.store.getLocalLearnerBinding('p')).toEqual(binding);
  });
  it('migrates v18 and maps legacy KV/runtime without changing any historical bytes', () => {
    const f = fixture(); const at = new Date(0).toISOString();
    f.store.classroomKV.set('p', LEGACY_LOCAL_LEARNER_KEY, 'old-draft', { original: '旧本人答案' });
    const material = f.store.importMaterial({ projectId: 'p', displayName: '参考材料', materialType: 'txt', rawText: '条件与定义。' }).material;
    const proposal = f.store.createProposal({ projectId: 'p', name: '定义', concept: '定义', conditions: '', scopeStatus: 'in_syllabus', prerequisites: [], evidence: [{ materialId: material.materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }], acceptance: '', priority: 'medium', proposedBy: 'user' });
    const knowledgeId = f.store.applyReview({ proposalId: proposal.proposalId, decision: 'approved', expectedRevision: proposal.revision, semanticReviewed: true }).knowledgePoint!.knowledgeId;
    const question = f.store.createQuestion({ stem: '解释条件', answer: '定义与条件', solution: '参考解析', knowledgeIds: [knowledgeId], requestedOrigin: 'ai_new', originRecord: null,
      assessment: { schemaVersion: 1, type: 'short_answer', options: [], correctAnswers: [], rubric: '说明定义和条件', maxScore: 5, answerVersion: 1 } }).question;
    const attempt = f.store.submitAttempt({ projectId: 'p', questionId: question.questionId, idempotencyKey: 'old-submit', actorType: 'human_learner', kind: 'real', answerText: '旧本人原答', processText: '旧原始过程' }).attempt;
    f.store.runtime.createSession('p', { id: 'old-session', runtimeDslVersion: RUNTIME_DSL_VERSION, kind: 'quizAttempt', stageId: 'old-stage', learnerKey: LEGACY_LOCAL_LEARNER_KEY, status: 'completed', createdAt: at, updatedAt: at });
    f.store.runtime.saveQuizReceipt('p', { idempotencyKey: 'old-submit', sessionId: 'old-session', questionId: question.questionId, recordId: 'old-record', createdAt: at });
    f.store.reviewAttemptGrade({ projectId: 'p', attemptId: attempt.attemptId, expectedReviewVersion: 0, requestId: 'old-review', earned: 5, basis: '旧人工核对', uncertainty: '无其他疑点', semanticReviewed: true, candidateId: null });
    const driver = createNodeSqliteDriver(); const beforeDb = driver.open(f.file);
    const tables = ['classroom_kv', 'classroom_runtime_sessions', 'classroom_quiz_receipts', 'attempts', 'attempt_grade_reviews', 'attempt_grade_receipts'];
    const before = tables.map(table => beforeDb.prepare(`SELECT * FROM ${table}`).all());
    beforeDb.exec('DROP TABLE learner_identity_bindings; DELETE FROM schema_migrations WHERE version=19;'); beforeDb.close();
    f.store.close(); stores.splice(stores.indexOf(f.store), 1);
    const reopened = StudyStore.open({ file: f.file }); stores.push(reopened);
    expect(reopened.getLocalLearnerBinding('p')).toBeNull();
    expect(reopened.bindLocalLearner('p', UID).origin).toBe('legacy_local');
    const afterDb = driver.open(f.file);
    expect(tables.map(table => afterDb.prepare(`SELECT * FROM ${table}`).all())).toEqual(before); afterDb.close();
    expect(reopened.getAttemptByIdempotencyKey('old-submit')).toEqual(attempt);
    expect(reopened.getAttemptGradingContext('p', attempt.attemptId)?.effectiveGrading.earned).toBe(5);
    expect(reopened.classroomKV.get('p', LEGACY_LOCAL_LEARNER_KEY, 'old-draft')).toEqual({ original: '旧本人答案' });
    expect(reopened.runtime.getSession('p', 'old-session')?.id).toBe('old-session');
  });
  it('keeps binding in a database backup while rejecting reassignment and corrupt bindings', () => {
    const f = fixture(); const binding = f.store.bindLocalLearner('p', UID); const backupFile = join(f.root, 'backup.db');
    f.store.backupTo(backupFile); const backup = StudyStore.open({ file: backupFile }); stores.push(backup);
    expect(backup.getLocalLearnerBinding('p')).toEqual(binding);
    expect(() => backup.bindLocalLearner('p', OTHER)).toThrow();
    const db = createNodeSqliteDriver().open(backupFile); db.prepare('UPDATE learner_identity_bindings SET learner_uid=?').run('broken'); db.close();
    expect(() => backup.bindLocalLearner('p', UID)).toThrowError(expect.objectContaining({ code: 'INTERNAL' }));
  });
  it('rolls back a binding on insertion failure without changing legacy records', () => {
    const f = fixture(); f.store.classroomKV.set('p', LEGACY_LOCAL_LEARNER_KEY, 'draft', '原内容');
    const db = createNodeSqliteDriver().open(f.file); db.exec("CREATE TRIGGER fail_uid_binding BEFORE INSERT ON learner_identity_bindings BEGIN SELECT RAISE(ABORT,'failed'); END;"); db.close();
    expect(() => f.store.bindLocalLearner('p', UID)).toThrow();
    expect(f.store.getLocalLearnerBinding('p')).toBeNull();
    expect(f.store.classroomKV.get('p', LEGACY_LOCAL_LEARNER_KEY, 'draft')).toBe('原内容');
  });
});
