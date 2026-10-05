import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyStore, createNodeSqliteDriver } from '@sew/study-storage';
import { MIGRATIONS } from '../packages/study-storage/src/schema';
import { generateAttemptGradeCandidate } from '../apps/learning/lib/server/attempt-grading-model';
import { assertModelCallAdmitted } from '@sew/study-domain';

const roots: string[] = [];
const stores: StudyStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sew-grade-')); roots.push(root);
  const file = join(root, 'study.sqlite'); const store = StudyStore.open({ file }); stores.push(store);
  store.createProject({ projectId: 'p', displayName: '数学', subject: '数学', dailyMinutes: 30 });
  const material = store.importMaterial({ projectId: 'p', displayName: '考纲', materialType: 'txt', rawText: '理解定义与适用条件。' }).material;
  const proposal = store.createProposal({ projectId: 'p', name: '定义', concept: '理解定义', conditions: '', scopeStatus: 'in_syllabus', prerequisites: [], evidence: [{ materialId: material.materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }], acceptance: '', priority: 'medium', proposedBy: 'user' });
  const knowledgeId = store.applyReview({ proposalId: proposal.proposalId, decision: 'approved', expectedRevision: proposal.revision, semanticReviewed: true }).knowledgePoint!.knowledgeId;
  const question = store.createQuestion({ stem: '说明条件', answer: '参考内容', solution: '参考分析', knowledgeIds: [knowledgeId], requestedOrigin: 'ai_new', originRecord: null,
    assessment: { schemaVersion: 1, type: 'short_answer', options: [], correctAnswers: [], rubric: '解释定义和适用条件', maxScore: 5, answerVersion: 1 } }).question;
  let n = 0;
  const submit = (actorType: 'human_learner' | 'peer_ai' = 'human_learner') => store.submitAttempt({ projectId: 'p', questionId: question.questionId, idempotencyKey: `nonce-${++n}`, actorType, kind: 'real', answerText: '原始答案', processText: '原始过程' }).attempt;
  const attempt = submit();
  const review = { projectId: 'p', attemptId: attempt.attemptId, expectedReviewVersion: 0, requestId: 'review-1', earned: 5, basis: '定义和条件完整', uncertainty: '人工已核对参考材料', semanticReviewed: true as const, candidateId: null };
  const candidate = { projectId: 'p', attemptId: attempt.attemptId, expectedReviewVersion: 0, requestId: 'candidate-1', proposedEarned: 4, basis: '缺少一个条件', uncertainty: '表达方式可能同义', requestedModel: 'test-model', runId: 'run-test' };
  return { store, file, material, knowledgeId, question, attempt, submit, review, candidate };
}
describe('append-only short answer reviews', () => {
  it('keeps original answers and submission grading immutable; scores versions and retries', () => {
    const f = fixture(); const original = f.store.listAttempts()[0];
    const reviewed = f.store.reviewAttemptGrade(f.review);
    expect(reviewed.review).toMatchObject({ reviewVersion: 1, reviewer: 'local_user', masteryApplied: true, grading: { earned: 5, correct: true } });
    expect(f.store.listAttempts()[0]).toEqual(original);
    expect(f.store.getKnowledge(f.knowledgeId)?.masteryStatus).toBe('passed');
    expect(f.store.reviewAttemptGrade(f.review)).toMatchObject({ deduplicated: true, review: reviewed.review });
    expect(() => f.store.reviewAttemptGrade({ ...f.review, earned: 4 })).toThrow();
    expect(() => f.store.reviewAttemptGrade({ ...f.review, requestId: 'stale' })).toThrow();
    const second = f.store.reviewAttemptGrade({ ...f.review, requestId: 'review-2', expectedReviewVersion: 1, earned: 3 });
    expect(second.context.reviews).toHaveLength(2);
    expect(second.review).toMatchObject({ reviewVersion: 2, grading: { correct: false, earned: 3 } });
    expect(f.store.getKnowledge(f.knowledgeId)?.masteryStatus).toBe('to_reinforce');
  });
  it('persists model proposals without mastery and only applies explicitly reviewed candidates', () => {
    const f = fixture(); const proposed = f.store.saveAttemptGradeCandidate(f.candidate);
    expect(f.store.getKnowledge(f.knowledgeId)?.masteryStatus).toBe('untested');
    expect(proposed.context.effectiveGrading.status).toBe('pending_review');
    expect(f.store.getAttemptGradeCandidateReceipt('p', f.attempt.attemptId, 'candidate-1')).toMatchObject({ deduplicated: true, candidate: proposed.candidate });
    expect(f.store.saveAttemptGradeCandidate(f.candidate).deduplicated).toBe(true);
    expect(() => f.store.saveAttemptGradeCandidate({ ...f.candidate, proposedEarned: 5 })).toThrow();
    const reviewed = f.store.reviewAttemptGrade({ ...f.review, candidateId: proposed.candidate.candidateId, earned: 4 });
    expect(reviewed.review.source).toBe('model_reviewed');
    expect(reviewed.context.candidates[0]?.status).toBe('approved');
    expect(() => f.store.reviewAttemptGrade({ ...f.review, requestId: 'again', expectedReviewVersion: 1, candidateId: proposed.candidate.candidateId })).toThrow();
  });
  it('rejects a candidate without applying grading and makes older candidates stale', () => {
    const f = fixture(); const c = f.store.saveAttemptGradeCandidate(f.candidate).candidate;
    const input = { projectId: 'p', attemptId: f.attempt.attemptId, expectedReviewVersion: 0, requestId: 'reject', candidateId: c.candidateId, note: '依据不充分' };
    expect(f.store.rejectAttemptGradeCandidate(input).candidate.status).toBe('rejected');
    expect(f.store.rejectAttemptGradeCandidate(input).deduplicated).toBe(true);
    expect(f.store.getKnowledge(f.knowledgeId)?.masteryStatus).toBe('untested');
    const stale = f.store.saveAttemptGradeCandidate({ ...f.candidate, requestId: 'candidate-2' }).candidate;
    f.store.reviewAttemptGrade(f.review);
    expect(() => f.store.reviewAttemptGrade({ ...f.review, requestId: 'stale-candidate', expectedReviewVersion: 1, candidateId: stale.candidateId })).toThrow();
    expect(f.store.rejectAttemptGradeCandidate({ ...input, candidateId: stale.candidateId, expectedReviewVersion: 1, requestId: 'reject-stale' }).candidate.status).toBe('rejected');
  });
  it('checks current source and rule versions on new writes but preserves historical receipts', () => {
    const f = fixture(); f.store.reviewAttemptGrade(f.review);
    f.store.importMaterial({ projectId: 'p', displayName: '考纲', materialType: 'txt', rawText: '来源已修订。' });
    expect(f.store.getAttemptGradingContext('p', f.attempt.attemptId)?.canReview).toBe(false);
    expect(f.store.reviewAttemptGrade(f.review).deduplicated).toBe(true);
    expect(() => f.store.reviewAttemptGrade({ ...f.review, expectedReviewVersion: 1, requestId: 'changed-source' })).toThrow();
    expect(() => f.store.saveAttemptGradeCandidate({ ...f.candidate, expectedReviewVersion: 1 })).toThrow();
  });
  it('rejects simulation and missing rules and refuses version changes', () => {
    const f = fixture(); const simulated = f.submit('peer_ai');
    expect(f.store.getAttemptGradingContext('p', simulated.attemptId)).toBeNull();
    expect(() => f.store.reviewAttemptGrade({ ...f.review, attemptId: simulated.attemptId })).toThrow();
    const db = createNodeSqliteDriver().open(f.file); db.prepare('UPDATE questions SET revision=2 WHERE question_id=?').run(f.question.questionId); db.close();
    expect(() => f.store.getAttemptGradingContext('p', f.attempt.attemptId)).toThrow();
    expect(() => f.store.reviewAttemptGrade(f.review)).toThrow();
  });
  it('never approves a model candidate that declined to assign a score', () => {
    const f = fixture(); const c = f.store.saveAttemptGradeCandidate({ ...f.candidate, proposedEarned: null }).candidate;
    expect(() => f.store.reviewAttemptGrade({ ...f.review, candidateId: c.candidateId })).toThrow();
    expect(f.store.getAttemptGradingContext('p', f.attempt.attemptId)?.currentReviewVersion).toBe(0);
    expect(f.store.reviewAttemptGrade(f.review).review.source).toBe('manual');
  });
  it('does not let a late historical review overwrite newer graded learning', () => {
    const f = fixture(); const later = f.submit();
    f.store.reviewAttemptGrade({ ...f.review, attemptId: later.attemptId, requestId: 'later', earned: 0 });
    const historical = f.store.reviewAttemptGrade(f.review);
    expect(historical.review.masteryApplied).toBe(false);
    expect(f.store.getKnowledge(f.knowledgeId)?.masteryStatus).toBe('to_reinforce');
  });
  it('rolls back review and mastery if final receipt write fails', () => {
    const f = fixture(); const db = createNodeSqliteDriver().open(f.file);
    db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON attempt_grade_receipts BEGIN SELECT RAISE(ABORT, 'receipt_failed'); END;"); db.close();
    expect(() => f.store.reviewAttemptGrade(f.review)).toThrow();
    expect(f.store.getAttemptGradingContext('p', f.attempt.attemptId)?.reviews).toHaveLength(0);
    expect(f.store.getKnowledge(f.knowledgeId)?.masteryStatus).toBe('untested');
  });
  it('rejects corrupt authoritative review data and survives reopen', () => {
    const f = fixture(); f.store.reviewAttemptGrade(f.review); f.store.close(); stores.splice(stores.indexOf(f.store), 1);
    const reopened = StudyStore.open({ file: f.file }); stores.push(reopened);
    expect(reopened.getAttemptGradingContext('p', f.attempt.attemptId)?.effectiveGrading.earned).toBe(5);
    const db = createNodeSqliteDriver().open(f.file); db.prepare('UPDATE attempt_grade_reviews SET review_json=?').run('{"invalid":true}'); db.close();
    expect(() => reopened.getAttemptGradingContext('p', f.attempt.attemptId)).toThrow();
  });
  it('upgrades v16 without modifying original submission bytes', () => {
    const f = fixture(); const db = createNodeSqliteDriver().open(f.file);
    const before = db.prepare('SELECT * FROM attempts').all();
    // Reconstruct the historical v16 fixture; later feature tables are absent there.
    const laterTables = MIGRATIONS.filter(migration => migration.version > 16)
      .flatMap(migration => [...migration.sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? ([a-z_]+)/g)].map(match => match[1]!));
    db.exec('PRAGMA foreign_keys=OFF');
    for (const table of laterTables.reverse()) db.exec(`DROP TABLE IF EXISTS ${table}`);
    // v28 给 v14 就存在的 lesson_reviews 补了两列：重建历史库时要一并移除，否则重放迁移会撞上重复列。
    db.exec('ALTER TABLE lesson_reviews DROP COLUMN plan_revision; ALTER TABLE lesson_reviews DROP COLUMN plan_digest;');
    db.exec('DELETE FROM schema_migrations WHERE version>=17;');
    db.close(); f.store.close(); stores.splice(stores.indexOf(f.store), 1);
    const reopened = StudyStore.open({ file: f.file }); stores.push(reopened);
    const check = createNodeSqliteDriver().open(f.file); expect(check.prepare('SELECT * FROM attempts').all()).toEqual(before); check.close();
    expect(MIGRATIONS.at(-1)?.version).toBeGreaterThanOrEqual(19);
    expect(reopened.getAttemptGradingContext('p', f.attempt.attemptId)?.currentReviewVersion).toBe(0);
  });
  it('preserves started/failed generation intent across reopen and rejects cross-action reuse', () => {
    const f = fixture(); const command = { projectId: 'p', attemptId: f.attempt.attemptId, expectedReviewVersion: 0, requestId: 'durable-call' };
    f.store.createRun('r', 'plan_confirmed', { knowledgeTableDigest: f.store.knowledgeTableDigest(), materialRevisions: {}, planVersion: 1, lessonVersion: null, teachingPreferenceVersion: 0, roleConfigDigest: null, modelProfileId: null });
    f.store.startAttemptGradeGenerationCall(command, 'r', 100);
    expect(() => f.store.startAttemptGradeGenerationCall(command, 'r', 100)).toThrow();
    expect(() => f.store.reviewAttemptGrade({ ...f.review, requestId: command.requestId })).toThrow();
    f.store.close(); stores.splice(stores.indexOf(f.store), 1);
    const reopened = StudyStore.open({ file: f.file }); stores.push(reopened);
    expect(reopened.getAttemptGradeGenerationCall(command)?.state).toBe('started');
    expect(reopened.modelCallUsage('r')).toMatchObject({ calls: 1, tokens: 100 });
    expect(reopened.modelCallUsage('r', command.requestId)).toMatchObject({ calls: 0, tokens: 0 });
    expect(() => reopened.getAttemptGradeGenerationCall({ ...command, expectedReviewVersion: 1 })).toThrow();
    reopened.settleAttemptGradeGenerationCall(command, { code: 'INVALID_ARGUMENT', message: '输出不符合评分结构' });
    expect(reopened.getAttemptGradeGenerationCall(command)).toMatchObject({ state: 'failed', failure: { code: 'INVALID_ARGUMENT' } });
    // 请求已经发出，只是结果不能用：按 BUDGET-01 保守口径继续保留预占，不能当成没花钱。
    expect(reopened.modelCallUsage('r')).toMatchObject({ calls: 1, tokens: 100 });
    // 显式声明「用量确知为 0」时才释放预占。
    expect(reopened.modelUsageReport('r', { maxCalls: 8, maxTokens: 1_000, maxWallClockMs: 600_000 }).total.unknownTokens).toBe(100);
    expect(() => reopened.startAttemptGradeGenerationCall(command, 'r', 100)).toThrow();
    expect(() => reopened.settleAttemptGradeGenerationCall(command, null)).toThrow();
    expect(reopened.listAttempts()[0]).toEqual(f.attempt);
  });
  it('keeps unknown dispatches in the shared budget even if SQLite settlement and ledger both roll back', () => {
    const f = fixture(); const command = { projectId: 'p', attemptId: f.attempt.attemptId, expectedReviewVersion: 0, requestId: 'unknown' };
    const frozen = { knowledgeTableDigest: f.store.knowledgeTableDigest(), materialRevisions: {}, planVersion: 1, lessonVersion: null, teachingPreferenceVersion: 0, roleConfigDigest: null, modelProfileId: null };
    f.store.createRun('r', 'plan_confirmed', frozen); f.store.startAttemptGradeGenerationCall(command, 'r', 100);
    const db = createNodeSqliteDriver().open(f.file);
    db.exec("CREATE TRIGGER fail_settle BEFORE UPDATE ON attempt_grade_generation_calls BEGIN SELECT RAISE(ABORT, 'settle_failed'); END;"); db.close();
    expect(() => f.store.transaction(() => {
      f.store.appendNextRunEvent('r', { type: 'model_call', purpose: 'attempt_grading', ok: false, totalTokens: 12, message: '失败尝试' });
      f.store.settleAttemptGradeGenerationCall(command, { code: 'INTERNAL', message: '保存失败' });
    })).toThrow();
    expect(f.store.modelCallUsage('r')).toMatchObject({ calls: 1, tokens: 100 });
    for (const purpose of ['lesson_draft', 'teaching_prompt', 'attempt_grading'] as const) {
      expect(() => assertModelCallAdmitted({ purpose, run: { state: 'plan_confirmed', frozen }, currentKnowledgeTableDigest: frozen.knowledgeTableDigest,
        referencedKnowledgeIds: [f.knowledgeId], admittedKnowledgeIds: new Set([f.knowledgeId]), lesson: { status: 'published', reviewApproved: true }, usage: f.store.modelCallUsage('r'), limits: { maxCalls: 1, maxTokens: 100 } })).toThrow();
    }
  });
  it('applies only knowledge points not covered by newer evidence, including chained overlap', () => {
    const f = fixture();
    const ids = [f.knowledgeId];
    for (const name of ['条件', '推导']) {
      const p = f.store.createProposal({ projectId: 'p', name, concept: name, conditions: '', scopeStatus: 'in_syllabus', prerequisites: [], evidence: [{ materialId: f.material.materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }], acceptance: '', priority: 'medium', proposedBy: 'user' });
      ids.push(f.store.applyReview({ proposalId: p.proposalId, decision: 'approved', expectedRevision: p.revision, semanticReviewed: true }).knowledgePoint!.knowledgeId);
    }
    const submitShort = (knowledgeIds: string[], key: string) => {
      const question = f.store.createQuestion({ stem: '说明定义', answer: '参考', solution: '', knowledgeIds, requestedOrigin: 'ai_new', originRecord: null, assessment: { schemaVersion: 1, type: 'short_answer', options: [], correctAnswers: [], rubric: '解释定义', maxScore: 5, answerVersion: 1 } }).question;
      return f.store.submitAttempt({ projectId: 'p', questionId: question.questionId, idempotencyKey: key, actorType: 'human_learner', kind: 'real', answerText: '回答', processText: '' }).attempt;
    };
    const oldest = submitShort(ids, 'oldest'); const middle = submitShort(ids.slice(0, 2), 'middle'); const newest = submitShort([ids[0]!], 'newest');
    f.store.reviewAttemptGrade({ ...f.review, attemptId: newest.attemptId, requestId: 'newest-review', earned: 0 });
    const m = f.store.reviewAttemptGrade({ ...f.review, attemptId: middle.attemptId, requestId: 'middle-review', earned: 5 });
    expect(m.review.appliedKnowledgeIds).toEqual([ids[1]]); expect(m.review.skippedKnowledgeIds).toEqual([ids[0]]);
    const o = f.store.reviewAttemptGrade({ ...f.review, attemptId: oldest.attemptId, requestId: 'oldest-review', earned: 5 });
    expect(o.review.appliedKnowledgeIds).toEqual([ids[2]]); expect(o.review.skippedKnowledgeIds).toEqual(ids.slice(0, 2));
    expect(ids.map(id => f.store.getKnowledge(id)?.masteryStatus)).toEqual(['to_reinforce', 'passed', 'passed']);
  });
  /**
   * BUDGET-01：评分调用记在自己的表里，但必须出现在共享预算报告中。
   * 只合并 `started` 会让已结算的评分从报告里消失；未知用量若按 0 计，
   * 用户看到的剩余额度就是假的。
   */
  it('reports settled and unknown grading usage in the shared budget, never as zero', () => {
    const f = fixture();
    const limits = { maxCalls: 10, maxTokens: 10_000, maxWallClockMs: 600_000 };
    const frozen = { knowledgeTableDigest: f.store.knowledgeTableDigest(), materialRevisions: {}, planVersion: 1, lessonVersion: null, teachingPreferenceVersion: 0, roleConfigDigest: null, modelProfileId: null };
    f.store.createRun('run-budget', 'plan_confirmed', frozen);

    // 未结算：整笔预占计入并出现在未结算清单。
    const pending = { projectId: 'p', attemptId: f.attempt.attemptId, expectedReviewVersion: 0, requestId: 'grade-pending' };
    f.store.startAttemptGradeGenerationCall(pending, 'run-budget', 500);
    const started = f.store.modelUsageReport('run-budget', limits);
    expect(started.total.reservedTokens).toBe(500);
    expect(started.unsettled).toEqual([{ requestId: 'grade-pending', purpose: 'attempt_grading', reservedTokens: 500, createdAt: expect.any(String) }]);
    expect(started.byPurpose.map(item => item.purpose)).toContain('attempt_grading');

    // 用量未知地结算：整笔预占继续保留，绝不当成 0。
    f.store.settleAttemptGradeGenerationCall(pending, { code: 'INVALID_ARGUMENT', message: '输出不符合评分结构' }, { accountedTokens: 0, tokenMeasurement: 'unknown', elapsedMs: 700 });
    const unknown = f.store.modelUsageReport('run-budget', limits);
    expect(unknown.total.unknownTokens).toBe(500);
    expect(unknown.total.reservedTokens).toBe(0);
    expect(unknown.unsettled).toEqual([]);
    expect(unknown.total.elapsedMs).toBe(700);
    // 与 guard 实际使用的额度一致：报告说用掉 500，guard 也算 500。
    expect(f.store.modelCallUsage('run-budget').tokens).toBe(500);
    expect(f.store.modelCallUsage('run-budget').activeElapsedMs).toBe(700);

    // 有实际计数地结算：计入实际桶，不再保留预占。
    const settled = { projectId: 'p', attemptId: f.attempt.attemptId, expectedReviewVersion: 0, requestId: 'grade-actual' };
    f.store.startAttemptGradeGenerationCall(settled, 'run-budget', 400);
    f.store.appendNextRunEvent('run-budget', { type: 'model_call', purpose: 'attempt_grading', ok: true, totalTokens: 320, message: '' });
    f.store.settleAttemptGradeGenerationCall(settled, null, { accountedTokens: 320, tokenMeasurement: 'actual', elapsedMs: 300 });
    const actual = f.store.modelUsageReport('run-budget', limits);
    expect(actual.total.actualTokens).toBe(320);
    // 未知那笔的 500 仍然保留，不会被后来的一笔覆盖掉。
    expect(actual.total.unknownTokens).toBe(500);
    expect(f.store.modelCallUsage('run-budget').tokens).toBe(320 + 500);
  });

  /**
   * 按用途明细必须与总额相加一致：模型台账和评分台账可能都出现过 `attempt_grading`，
   * 合并时相加而不是互相覆盖，否则界面上的分项之和会小于总计。
   */
  it('merges model-ledger and grading-ledger attempt_grading details instead of overwriting', () => {
    const f = fixture();
    const limits = { maxCalls: 10, maxTokens: 10_000, maxWallClockMs: 600_000 };
    const frozen = { knowledgeTableDigest: f.store.knowledgeTableDigest(), materialRevisions: {}, planVersion: 1, lessonVersion: null, teachingPreferenceVersion: 0, roleConfigDigest: null, modelProfileId: null };
    f.store.createRun('run-merge', 'plan_confirmed', frozen);

    // 模型台账里也记一笔 attempt_grading（评分候选走模型台账的路径）。
    f.store.startModelUsageCall({
      projectId: 'p', requestId: 'ledger-grading', runId: 'run-merge', purpose: 'attempt_grading',
      sessionId: null, roundIndex: null, intent: 'a'.repeat(64), reservedTokens: 200,
      provider: 'openai-compatible', requestedModel: 'fixture-model',
    }, limits);
    f.store.appendNextRunEvent('run-merge', { type: 'model_call', purpose: 'attempt_grading', ok: true, totalTokens: 150, message: '' });
    f.store.settleModelUsageCall('p', 'ledger-grading', {
      state: 'completed', accountedTokens: 150, providerTokens: 150, tokenMeasurement: 'actual',
      cost: null, costMeasurement: 'unknown', returnedModel: null, elapsedMs: 50, result: null,
    });
    // 评分自己的表里也有一笔。
    const command = { projectId: 'p', attemptId: f.attempt.attemptId, expectedReviewVersion: 0, requestId: 'grade-merge' };
    f.store.startAttemptGradeGenerationCall(command, 'run-merge', 400);
    f.store.appendNextRunEvent('run-merge', { type: 'model_call', purpose: 'attempt_grading', ok: true, totalTokens: 260, message: '' });
    f.store.settleAttemptGradeGenerationCall(command, null, { accountedTokens: 260, tokenMeasurement: 'actual', elapsedMs: 70 });

    const report = f.store.modelUsageReport('run-merge', limits);
    const grading = report.byPurpose.find(item => item.purpose === 'attempt_grading')!;
    expect(grading.summary.calls).toBe(2);
    expect(grading.summary.actualTokens).toBe(150 + 260);
    expect(grading.summary.elapsedMs).toBe(120);
    // 分项之和必须等于总计。
    const sum = report.byPurpose.reduce((acc, item) => acc + item.summary.actualTokens, 0);
    expect(sum).toBe(report.total.actualTokens);
    expect(f.store.modelCallUsage('run-merge').tokens).toBe(150 + 260);
  });
});


describe('production shared grading budget regressions', () => {
  const limits = { maxCalls: 8, maxTokens: 16000, maxWallClockMs: 600000 };
  function prepare() {
    const f = fixture();
    f.store.savePlanVersion('p', 1, 'confirmed', { payloadVersion: 1, goal: '定义', examDate: null, dailyMinutes: 30,
      tasks: [{ knowledgeId: f.knowledgeId, name: '定义', minutes: 30, acceptance: '', evidence: [{ materialId: f.material.materialId, segmentId: 'S001' }] }],
      gaps: [], basis: '已确认', confirmedTaskKnowledgeIds: [f.knowledgeId] });
    f.store.createRun('r', 'plan_confirmed', { knowledgeTableDigest: f.store.knowledgeTableDigest(), materialRevisions: {}, planVersion: 1,
      lessonVersion: null, teachingPreferenceVersion: 0, roleConfigDigest: null, modelProfileId: null });
    const input = { scope: { projectId: 'p', generation: 1 }, attemptId: f.attempt.attemptId, expectedReviewVersion: 0, requestId: 'grade' };
    const outcome = { dispatched: true, ok: true, message: 'OK', text: JSON.stringify({ proposedEarned: 4, basis: '依据', uncertainty: '待本人核对' }),
      totalTokens: 320, providerTokens: 320, requestedModel: 'fake', elapsedMs: 1 };
    const connection = { status: () => ({ configured: true, persisted: false, lastTest: null, model: 'fake' }), generate: async () => outcome };
    return { ...f, input, outcome, connection };
  }
  it('counts one settled provider request once in guard, report and individual rows', async () => {
    const f = prepare(); await generateAttemptGradeCandidate({ store: f.store, projectId: 'p', connection: f.connection, limits }, f.input);
    const report = f.store.modelUsageReport('r', limits);
    expect(f.store.modelCallUsage('r')).toMatchObject({ calls: 1, tokens: 320, activeElapsedMs: report.activeElapsedMs });
    expect(report.total).toMatchObject({ calls: 1, actualTokens: 320 });
    expect(f.store.sharedModelUsageCalls('r')).toHaveLength(1);
  });
  it.each(['lesson_draft', 'attempt_grading'] as const)('isolates equal nonces by ledger source (%s) while checking grading overruns', async purpose => {
    const f = prepare(); f.input.requestId = 'same';
    f.store.startModelUsageCall({ projectId: 'p', requestId: 'same', runId: 'r', purpose, sessionId: null, roundIndex: null,
      intent: 'a'.repeat(64), reservedTokens: 1000, provider: null, requestedModel: null }, limits);
    f.store.appendNextRunEvent('r', { type: 'model_call', requestId: 'same', usageSource: 'model', purpose, ok: true, totalTokens: 1000, message: '' });
    f.store.settleModelUsageCall('p', 'same', { state: 'completed', accountedTokens: 1000, providerTokens: 1000, returnedModel: null, elapsedMs: 50, result: null });
    expect(f.store.modelCallUsage('r', 'same')).toMatchObject({ calls: 1, tokens: 1000, activeElapsedMs: 50 });
    f.outcome.totalTokens = f.outcome.providerTokens = 3500;
    await expect(generateAttemptGradeCandidate({ store: f.store, projectId: 'p', connection: f.connection, limits: { ...limits, maxTokens: 4000 } }, f.input)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(f.store.modelCallUsage('r', 'same')).toMatchObject({ calls: 1, tokens: 1000, activeElapsedMs: 50 });
    expect(f.store.modelCallUsage('r', undefined, 'same')).toMatchObject({ calls: 1, tokens: 3500 });
    expect(f.store.modelCallUsage('r')).toMatchObject({ calls: 2, tokens: 4500 });
    expect(f.store.modelUsageReport('r', limits).total).toMatchObject({ calls: 2, actualTokens: 4500 });
    expect(f.store.getAttemptGradingContext('p', f.attempt.attemptId)!.candidates).toEqual([]);
  });

  it('reserves prompt plus output and persists actual overruns while rejecting the candidate', async () => {
    const f = prepare(); f.outcome.totalTokens = f.outcome.providerTokens = 3100;
    let options: { maxTokens?: number } | undefined;
    f.connection.generate = async (_messages?: unknown, opts?: { maxTokens?: number }) => { options = opts; return f.outcome; };
    await expect(generateAttemptGradeCandidate({ store: f.store, projectId: 'p', connection: f.connection, limits: { ...limits, maxTokens: 3000 } }, f.input)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(options!.maxTokens).toBeLessThan(3000);
    expect(f.store.getAttemptGradingContext('p', f.attempt.attemptId)!.candidates).toEqual([]);
    expect(f.store.modelCallUsage('r')).toMatchObject({ calls: 1, tokens: 3100 });
    expect(f.store.modelUsageReport('r', limits).total.actualTokens).toBe(3100);
  });
  it('aborts within shared remaining execution time and rejects a provider ignoring abort', async () => {
    const f = prepare();
    f.store.startModelUsageCall({ projectId: 'p', requestId: 'old', runId: 'r', purpose: 'lesson_draft', sessionId: null, roundIndex: null,
      intent: 'a'.repeat(64), reservedTokens: 100, provider: null, requestedModel: null }, limits);
    f.store.settleModelUsageCall('p', 'old', { state: 'completed', accountedTokens: 100, providerTokens: 100, returnedModel: null, elapsedMs: 599999, result: null });
    let aborted = false;
    f.connection.generate = async (_messages?: unknown, options?: { signal?: AbortSignal }) => {
      await new Promise(resolve => setTimeout(resolve, 20)); aborted = options!.signal!.aborted; return f.outcome;
    };
    await expect(generateAttemptGradeCandidate({ store: f.store, projectId: 'p', connection: f.connection, limits }, f.input)).rejects.toBeDefined();
    expect(aborted).toBe(true); expect(f.store.getAttemptGradingContext('p', f.attempt.attemptId)!.candidates).toEqual([]);
    expect(f.store.modelUsageReport('r', limits).wallClockExhausted).toBe(true);
  });
  it.each([22, 24])('upgrades a real v%i schema and keeps old grading/event consumption exactly once', version => {
    const f = prepare(); const command = { projectId: 'p', attemptId: f.attempt.attemptId, expectedReviewVersion: 0, requestId: 'legacy' };
    f.store.startAttemptGradeGenerationCall(command, 'r', 500);
    f.store.appendNextRunEvent('r', { type: 'model_call', purpose: 'attempt_grading', ok: true, totalTokens: 320, message: '' });
    f.store.settleAttemptGradeGenerationCall(command, null, { accountedTokens: 320, tokenMeasurement: 'actual', elapsedMs: 4 });
    f.store.appendNextRunEvent('r', { type: 'model_call', purpose: 'lesson_draft', ok: true, totalTokens: 120, message: '' });
    f.store.close(); stores.splice(stores.indexOf(f.store), 1);
    const db = createNodeSqliteDriver().open(f.file);
    const answers = db.prepare('SELECT * FROM attempts').all(); const runs = db.prepare('SELECT * FROM runs').all();
    db.exec('ALTER TABLE attempt_grade_generation_calls DROP COLUMN accounted_tokens; ALTER TABLE attempt_grade_generation_calls DROP COLUMN token_measurement; ALTER TABLE attempt_grade_generation_calls DROP COLUMN elapsed_ms;');
    if (version === 22) db.exec('DROP TABLE model_usage_calls; DROP TABLE classroom_peer_turns; DROP TABLE classroom_session_peer_settings;');
    // 该版本早于陈述改写表（v26）：重建历史库时一并移除，避免重复建表。
    db.exec('DROP TABLE IF EXISTS lesson_statement_revisions; DROP TABLE IF EXISTS lesson_statement_revision_receipts; DROP TABLE IF EXISTS lesson_draft_receipts;');
    // 同理移除场景计划与完整课件候选表（v27）：历史库重放迁移时不能撞上已存在的表。
    db.exec('DROP TABLE IF EXISTS lesson_scene_plans; DROP TABLE IF EXISTS lesson_courseware_candidates; DROP TABLE IF EXISTS lesson_courseware_receipts;');
    // v28：计划命令回执表与 lesson_reviews 的两列（后者在 v14 建表，须单独移除列）。
    db.exec('DROP TABLE IF EXISTS lesson_scene_plan_receipts;');
    db.exec('ALTER TABLE lesson_reviews DROP COLUMN plan_revision; ALTER TABLE lesson_reviews DROP COLUMN plan_digest;');
    db.prepare('DELETE FROM schema_migrations WHERE version>?').run(version); db.close();
    const reopened = StudyStore.open({ file: f.file }); stores.push(reopened);
    const report = reopened.modelUsageReport('r', limits);
    expect(report.total).toMatchObject({ calls: 2, estimatedTokens: 440, unknownTokens: 0, reservedTokens: 0 });
    expect(reopened.modelCallUsage('r')).toMatchObject({ calls: 2, tokens: 440 });
    const check = createNodeSqliteDriver().open(f.file);
    expect(check.prepare('SELECT * FROM attempts').all()).toEqual(answers); expect(check.prepare('SELECT * FROM runs').all()).toEqual(runs); check.close();
  });
});
