import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessmentGradingSchema, questionAssessmentSchema, type QuestionAssessmentDto } from '@sew/study-contracts';
import { buildEvidenceBundle, evidenceBundleDigest, fingerprintOf, gradeQuestionAssessment } from '@sew/study-domain';
import { StudyStore, createNodeSqliteDriver } from '@sew/study-storage';
import { MIGRATIONS } from '../packages/study-storage/src/schema';
import { toQuestionListItemDto } from '../apps/learning/lib/server/dto';

const single: QuestionAssessmentDto = { schemaVersion: 1, type: 'single', options: [{ value: 'A', label: '甲' }, { value: 'B', label: '乙' }], correctAnswers: ['A'], maxScore: 5, rubric: '', answerVersion: 1 };
const multiple: QuestionAssessmentDto = { ...single, type: 'multiple', correctAnswers: ['A', 'B'] };

describe('objective assessment boundaries', () => {
  it('rejects duplicate options, outside answers and invalid question types', () => {
    for (const value of [
      { ...single, options: [single.options[0], single.options[0]] },
      { ...single, correctAnswers: ['Z'] }, { ...single, correctAnswers: ['A', 'B'] },
      { ...multiple, correctAnswers: [] }, { ...multiple, correctAnswers: ['A', 'A'] },
      { ...single, answerVersion: 2 },
      { ...single, type: 'short_answer', options: [], correctAnswers: [], rubric: '' },
    ]) expect(questionAssessmentSchema.safeParse(value).success).toBe(false);
  });
  it('uses exact keys and exact answer sets without partial credit', () => {
    expect(gradeQuestionAssessment(single, 'A')).toMatchObject({ status: 'correct', earned: 5, answerVersion: 1 });
    expect(gradeQuestionAssessment(single, 'B')).toMatchObject({ status: 'incorrect', earned: 0 });
    expect(gradeQuestionAssessment(multiple, '["B","A"]')).toMatchObject({ status: 'correct', earned: 5 });
    expect(gradeQuestionAssessment(multiple, '["A"]')).toMatchObject({ status: 'incorrect', earned: 0 });
    for (const value of ['', 'a', ' A ', '甲']) expect(() => gradeQuestionAssessment(single, value)).toThrow();
  });
  it('rejects malformed multiple submissions rather than assigning a grade', () => {
    for (const value of ['', 'A,B', '{}', '"A"', '[]', '[1]', '["A","A"]', '["Z"]']) {
      expect(() => gradeQuestionAssessment(multiple, value)).toThrow();
    }
  });
  it('retains short answers as pending even for the reference text', () => {
    const rule: QuestionAssessmentDto = { ...single, type: 'short_answer', options: [], correctAnswers: [], rubric: '说明推理与适用条件' };
    expect(gradeQuestionAssessment(rule, '标准答案')).toMatchObject({ status: 'pending_review', correct: null, earned: null, basis: 'short_answer_requires_review' });
  });
  it('rejects contradictory or out-of-range stored grading outcomes', () => {
    const valid = gradeQuestionAssessment(single, 'A');
    for (const outcome of [{ ...valid, status: 'pending_review' }, { ...valid, correct: false }, { ...valid, earned: 6 }, { ...valid, earned: null }]) {
      expect(assessmentGradingSchema.safeParse(outcome).success).toBe(false);
    }
  });
  it('retains legacy bundles without injected snapshots and freezes new rule snapshots', () => {
    const input = {
      projectId: 'p', subject: '数学', recordScope: 'formal' as const, planVersion: 1, teachingPreferenceVersion: 1, roleConfigDigest: null,
      statements: [{ knowledgeId: 'k', text: '定义陈述', conditions: '', evidence: [{ materialId: 'm', revision: 1, segmentId: 'S001', use: 'concept_basis' as const }] }],
      questionIds: ['q'], admittedKnowledgeIds: new Set(['k']), knowledgeVersions: [{ knowledgeId: 'k', revision: 1 }], materialRevisions: { m: 1 },
      lookupSegment: () => ({ materialId: 'm', revision: 1, segmentId: 'S001', text: '定义陈述', fingerprint: fingerprintOf('定义陈述') }),
    };
    const question = { questionId: 'q', revision: 1, origin: 'ai_new' as const, knowledgeIds: ['k'] };
    const legacy = buildEvidenceBundle({ ...input, questions: new Map([['q', question]]) });
    expect(legacy.bundle.questions[0]).not.toHaveProperty('snapshot');
    const frozen = buildEvidenceBundle({ ...input, questions: new Map([['q', { ...question, snapshot: { stem: '选择题', answer: 'A', solution: '解析', assessment: single } }]]) });
    expect(frozen.bundle.questions[0]?.snapshot?.assessment).toEqual(single);
    expect(frozen.digest).not.toBe(legacy.digest);
  });
});

describe('immutable assessment persistence', () => {
  const roots: string[] = [];
  const stores: StudyStore[] = [];
  afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-assessment-')); roots.push(root);
    const file = join(root, 'study.sqlite');
    const store = StudyStore.open({ file }); stores.push(store);
    store.createProject({ projectId: 'p', displayName: '数学', subject: '数学', dailyMinutes: 30 });
    const imported = store.importMaterial({ projectId: 'p', displayName: '考纲', materialType: 'txt', rawText: '理解并运用数学定义。' });
    const proposal = store.createProposal({ projectId: 'p', name: '定义', concept: '理解数学定义', conditions: '', scopeStatus: 'in_syllabus', prerequisites: [], evidence: [{ materialId: imported.material.materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }], acceptance: '', priority: 'medium', proposedBy: 'user' });
    const knowledgeId = store.applyReview({ proposalId: proposal.proposalId, decision: 'approved', expectedRevision: proposal.revision, semanticReviewed: true }).knowledgePoint!.knowledgeId;
    const question = (assessment: QuestionAssessmentDto | null) => store.createQuestion({ stem: '请选择正确选项', answer: 'A', solution: '解析', assessment, knowledgeIds: [knowledgeId], requestedOrigin: 'ai_new', originRecord: null }).question;
    return { store, file, knowledgeId, question };
  };
  it('freezes grading and process, deduplicates, and excludes simulation from mastery', () => {
    const { store, knowledgeId, question } = fixture(); const q = question(single);
    const input = { projectId: 'p', questionId: q.questionId, idempotencyKey: 'assessment-attempt-1', actorType: 'human_learner' as const, kind: 'real' as const, answerText: 'A', processText: '我的原始过程' };
    const submitted = store.submitAttempt(input);
    expect(submitted.attempt).toMatchObject({ questionRevision: 1, answerVersion: 1, processText: '我的原始过程', grading: { status: 'correct', earned: 5 }, masteryAfter: 'passed' });
    expect(store.submitAttempt(input)).toMatchObject({ deduplicated: true, attempt: { attemptId: submitted.attempt.attemptId } });
    expect(() => store.submitAttempt({ ...input, answerText: 'B' })).toThrow();
    const simulated = store.submitAttempt({ ...input, idempotencyKey: 'assessment-attempt-2', actorType: 'peer_ai', answerText: 'B' });
    expect(simulated.attempt).toMatchObject({ kind: 'simulation', masteryAfter: null, grading: { status: 'incorrect' } });
    expect(store.getKnowledge(knowledgeId)?.masteryStatus).toBe('passed');
  });
  it('keeps unregistered formal rules pending without granting mastery', () => {
    const { store, knowledgeId, question } = fixture(); const q = question(null);
    const submitted = store.submitAttempt({ projectId: 'p', questionId: q.questionId, idempotencyKey: 'pending-attempt-1', actorType: 'human_learner', kind: 'real', answerText: 'A', processText: '' });
    expect(submitted.attempt).toMatchObject({ masteryAfter: null, grading: { status: 'pending_review', correct: null, earned: null, answerVersion: null } });
    expect(store.getKnowledge(knowledgeId)?.masteryStatus).toBe('untested');
  });
  it('does not expose answer keys or rubric in public metadata and fails closed on corrupted grading JSON', () => {
    const { store, file, question } = fixture(); const q = question(single);
    const publicDto = toQuestionListItemDto(q);
    expect(publicDto.assessment).toEqual({ type: 'single', options: single.options, maxScore: 5, answerVersion: 1 });
    expect(JSON.stringify(publicDto)).not.toContain('correctAnswers');
    const db = createNodeSqliteDriver().open(file);
    db.prepare('UPDATE questions SET assessment_json = ? WHERE question_id = ?').run('{"broken":true}', q.questionId);
    db.close();
    expect(() => store.getQuestion(q.questionId)).toThrow();
  });
  it('reads frozen grades after reopening and refuses damaged authoritative submission JSON', () => {
    const { store, file, question } = fixture(); const q = question(single);
    const input = { projectId: 'p', questionId: q.questionId, idempotencyKey: 'persist-attempt-1', actorType: 'human_learner' as const, kind: 'real' as const, answerText: 'A', processText: '原始过程' };
    store.submitAttempt(input);
    const reopened = StudyStore.open({ file }); stores.push(reopened);
    expect(reopened.submitAttempt(input)).toMatchObject({ deduplicated: true, attempt: { questionRevision: 1, answerVersion: 1, grading: { earned: 5, basis: 'exact_answer_set' } } });
    const db = createNodeSqliteDriver().open(file);
    db.prepare('UPDATE attempts SET grading_json = ? WHERE idempotency_key = ?').run('{"broken":true}', input.idempotencyKey);
    db.close();
    expect(() => reopened.submitAttempt(input)).toThrow();
  });
  it('migrates a v15 question and legacy bundle without changing frozen JSON or digest', () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-assessment-v15-')); roots.push(root);
    const file = join(root, 'study.sqlite'); const db = createNodeSqliteDriver().open(file);
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 15)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(migration.version, migration.name, '2026-10-04');
    }
    db.prepare('INSERT INTO questions (question_id, stem, answer, solution, knowledge_ids_json, origin, origin_label, created_at, record_scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('legacy-q', '旧题干', 'A', '旧解析', '["k"]', 'ai_new', '新编题', '2026-10-04', 'formal');
    const legacy = buildEvidenceBundle({
      projectId: 'p', subject: '数学', recordScope: 'formal', planVersion: 1, teachingPreferenceVersion: 1, roleConfigDigest: null,
      statements: [{ knowledgeId: 'k', text: '旧陈述', conditions: '', evidence: [{ materialId: 'm', revision: 1, segmentId: 'S001', use: 'concept_basis' }] }],
      questionIds: ['legacy-q'], admittedKnowledgeIds: new Set(['k']), knowledgeVersions: [{ knowledgeId: 'k', revision: 1 }], materialRevisions: { m: 1 },
      lookupSegment: () => ({ materialId: 'm', revision: 1, segmentId: 'S001', text: '旧陈述', fingerprint: fingerprintOf('旧陈述') }),
      questions: new Map([['legacy-q', { questionId: 'legacy-q', revision: 1, origin: 'ai_new', knowledgeIds: ['k'] }]]),
    });
    const originalJson = JSON.stringify(legacy.bundle);
    db.prepare('INSERT INTO evidence_bundles VALUES (?, ?, ?, ?, ?)').run('legacy-bundle', 'p', legacy.digest, originalJson, '2026-10-04'); db.close();
    const store = StudyStore.open({ file }); stores.push(store);
    expect(store.getQuestion('legacy-q')).toMatchObject({ assessment: null, answer: 'A', revision: 1 });
    const bundle = store.listEvidenceBundles('p')[0]!;
    expect(bundle.bundle.questions[0]).not.toHaveProperty('snapshot');
    expect(evidenceBundleDigest(bundle.bundle)).toBe(legacy.digest);
    const reopenedDb = createNodeSqliteDriver().open(file);
    expect(reopenedDb.prepare('SELECT bundle_json, digest FROM evidence_bundles WHERE bundle_id = ?').get('legacy-bundle')).toEqual({ bundle_json: originalJson, digest: legacy.digest });
    reopenedDb.close();
  });
});
