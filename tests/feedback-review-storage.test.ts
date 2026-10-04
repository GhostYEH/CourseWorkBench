import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyStore, createNodeSqliteDriver } from '@sew/study-storage';
import type { FeedbackReviewCommand } from '@sew/study-contracts';

const uid = 'uid_12345678-1234-4123-8123-123456789abc';
const otherUid = 'uid_22345678-1234-4123-8123-123456789abc';
const stores: StudyStore[] = [];
const roots: string[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sew-feedback-')); roots.push(root);
  const file = join(root, 'study.sqlite'); const store = StudyStore.open({ file }); stores.push(store);
  store.createProject({ projectId: 'p', displayName: '数学' }); store.bindLocalLearner('p', uid);
  const material = store.importMaterial({ projectId: 'p', displayName: '考纲', materialType: 'txt', rawText: '定义需要适用条件。' }).material;
  const proposal = store.createProposal({ projectId: 'p', name: '定义', concept: '定义', conditions: '条件', scopeStatus: 'in_syllabus', prerequisites: [],
    evidence: [{ materialId: material.materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }], acceptance: '', priority: 'medium', proposedBy: 'user' });
  const knowledge = store.applyReview({ proposalId: proposal.proposalId, decision: 'approved', expectedRevision: proposal.revision, semanticReviewed: true }).knowledgePoint!;
  const question = store.createQuestion({ stem: '解释条件', answer: '参考答案', solution: '参考分析', knowledgeIds: [knowledge.knowledgeId], requestedOrigin: 'ai_new', originRecord: null,
    assessment: { schemaVersion: 1, type: 'short_answer', options: [], correctAnswers: [], rubric: '核对条件', maxScore: 5, answerVersion: 1 } }).question;
  let nonce = 0;
  const submit = (processText = '先套公式，未检查条件', actorType: 'human_learner' | 'peer_ai' = 'human_learner') => store.submitAttempt({
    projectId: 'p', questionId: question.questionId, idempotencyKey: `feedback-attempt-${++nonce}`, actorType, kind: 'real', answerText: '个人答案', processText }).attempt;
  const attempt = submit();
  let request = 0;
  const base = () => ({ scope: { projectId: 'p', generation: 1 }, attemptId: attempt.attemptId,
    expectedVersion: store.getFeedbackContext('p', uid, attempt.attemptId).version, requestId: `feedback-${++request}` });
  const command = (value: FeedbackReviewCommand) => store.feedbackCommand('p', uid, value);
  return { store, file, material, question, knowledge, attempt, submit, base, command };
}
const unknown = { tags: ['unknown' as const], explanation: '无法确定错因', evidence: [], uncertainty: '缺少可核对的过程证据' };
describe('personal error and review history', () => {
  it('freezes the original submission basis, reads without side effects, reviews by CAS and keeps corrections separate', () => {
    const f = fixture();
    const original = f.store.listAttempts()[0];
    const before = f.store.getFeedbackContext('p', uid, f.attempt.attemptId);
    expect(before).toMatchObject({ version: 0, canWrite: true, snapshot: { questionRevision: 1, answerText: '个人答案', processText: '先套公式，未检查条件' } });
    expect(before.snapshot.evidence[0]).toMatchObject({ knowledgeId: f.knowledge.knowledgeId, revision: f.knowledge.revision });
    expect(f.store.getFeedbackContext('p', uid, f.attempt.attemptId)).toEqual(before);
    expect(f.store.listReviewTasks('p', uid)).toEqual([]);
    const proposed = f.command({ ...f.base(), action: 'propose', conclusion: unknown });
    expect(proposed.context.entries[0]?.action).toBe('propose');
    expect(f.store.getKnowledge(f.knowledge.knowledgeId)?.masteryStatus).toBe('untested');
    const reviewedInput = { ...f.base(), action: 'review' as const, candidateId: proposed.context.entries[0]!.entryId, conclusion: unknown, semanticReviewed: true as const };
    const reviewed = f.command(reviewedInput);
    expect(reviewed.context.entries).toHaveLength(2);
    expect(f.command(reviewedInput)).toMatchObject({ deduplicated: true });
    expect(() => f.command({ ...reviewedInput, requestId: 'stale-review' })).toThrow();
    expect(() => f.command({ ...f.base(), action: 'review', candidateId: proposed.context.entries[0]!.entryId, conclusion: unknown, semanticReviewed: true })).toThrow();
    const corrected = f.command({ ...f.base(), action: 'correct', correction: '先检查条件，再套公式。' });
    expect(corrected.context.entries.at(-1)).toMatchObject({ action: 'correct', retryAttemptId: null });
    expect(f.store.listAttempts()[0]).toEqual(original);
    expect(f.store.listReviewTasks('p', uid)).toEqual([]);
  });
  it('requires exact immutable process positions for concrete conclusions; no-process answers remain unknown', () => {
    const f = fixture();
    const conclusion = { tags: ['method' as const], explanation: '方法候选：先套公式', evidence: [{ start: 0, end: 4, quote: '先套公式' }], uncertainty: '仅为候选，需独立核对' };
    expect(f.command({ ...f.base(), action: 'propose', conclusion }).context.entries.at(-1)?.conclusion).toEqual(conclusion);
    expect(() => f.command({ ...f.base(), action: 'propose', conclusion: { ...conclusion, evidence: [{ start: 1, end: 5, quote: '先套公式' }] } })).toThrow();
    expect(() => f.command({ ...f.base(), action: 'propose', conclusion: { ...conclusion, evidence: [] } })).toThrow();
    const noProcess = f.submit('');
    const base = { ...f.base(), attemptId: noProcess.attemptId, expectedVersion: 0 };
    expect(() => f.command({ ...base, action: 'review', candidateId: null, conclusion, semanticReviewed: true })).toThrow();
    expect(f.command({ ...base, action: 'propose', conclusion: unknown }).context.entries.at(-1)?.conclusion?.tags).toEqual(['unknown']);
    expect(() => f.store.getFeedbackContext('p', otherUid, f.attempt.attemptId)).toThrow();
    f.store.createProject({ projectId: 'other-project', displayName: '另一个项目' }); f.store.bindLocalLearner('other-project', uid);
    expect(() => f.store.getFeedbackContext('other-project', uid, f.attempt.attemptId)).toThrow();
    expect(() => f.store.getFeedbackContext('p', uid, f.submit('', 'peer_ai').attemptId)).toThrow();
  });
  it('requires confirmed tasks and genuinely new personal attempts; a completion attempt cannot be reused', () => {
    const f = fixture();
    const draftInput = { ...f.base(), action: 'draft' as const, dueAt: '2026-01-01T00:00:00.000Z', reason: '复做并核对条件' };
    const draft = f.command(draftInput).tasks[0]!;
    expect(draft.status).toBe('draft');
    expect(f.command(draftInput).deduplicated).toBe(true);
    expect(() => f.command({ ...f.base(), action: 'complete', taskId: draft.taskId, completionAttemptId: f.attempt.attemptId })).toThrow();
    const beforeConfirmation = f.submit();
    const confirmed = f.command({ ...f.base(), action: 'confirm', taskId: draft.taskId, semanticReviewed: true }).tasks[0]!;
    expect(confirmed.status).toBe('confirmed');
    expect(() => f.command({ ...f.base(), action: 'complete', taskId: draft.taskId, completionAttemptId: beforeConfirmation.attemptId })).toThrow();
    expect(() => f.command({ ...f.base(), action: 'complete', taskId: draft.taskId, completionAttemptId: f.submit('', 'peer_ai').attemptId })).toThrow();
    const fresh = f.submit();
    const completeInput = { ...f.base(), action: 'complete' as const, taskId: draft.taskId, completionAttemptId: fresh.attemptId };
    const done = f.command(completeInput);
    expect(done.tasks[0]).toMatchObject({ status: 'completed', completionAttemptId: fresh.attemptId });
    expect(f.command(completeInput).deduplicated).toBe(true);
    const draft2 = f.command({ ...f.base(), action: 'draft', dueAt: '2026-01-02T00:00:00.000Z', reason: '再次复测' }).tasks.find(t => t.status === 'draft')!;
    f.command({ ...f.base(), action: 'confirm', taskId: draft2.taskId, semanticReviewed: true });
    expect(() => f.command({ ...f.base(), action: 'complete', taskId: draft2.taskId, completionAttemptId: fresh.attemptId })).toThrow();
    const another = f.submit();
    const linked = f.command({ ...f.base(), action: 'retry', retryAttemptId: another.attemptId });
    expect(linked.context.entries.at(-1)).toMatchObject({ action: 'retry', retryAttemptId: another.attemptId });
    expect(() => f.command({ ...f.base(), action: 'retry', retryAttemptId: another.attemptId })).toThrow();
  });
  it('restores immutable facts and pending tasks after reopen; invalidation blocks fresh actions but preserves receipts', () => {
    const f = fixture();
    const correction = { ...f.base(), action: 'correct' as const, correction: '完整订正' };
    const result = f.command(correction);
    f.command({ ...f.base(), action: 'draft', dueAt: '2026-01-01T00:00:00.000Z', reason: '复测条件' });
    const history = f.store.getFeedbackContext('p', uid, f.attempt.attemptId);
    f.store.close(); stores.splice(stores.indexOf(f.store), 1);
    const reopened = StudyStore.open({ file: f.file }); stores.push(reopened);
    expect(reopened.getFeedbackContext('p', uid, f.attempt.attemptId)).toEqual(history);
    expect(reopened.listReviewTasks('p', uid)[0]?.status).toBe('draft');
    reopened.importMaterial({ projectId: 'p', displayName: '考纲', materialType: 'txt', rawText: '修改后的定义条件。' });
    const invalid = reopened.getFeedbackContext('p', uid, f.attempt.attemptId);
    expect(invalid.canWrite).toBe(false); expect(invalid.snapshot).toEqual(history.snapshot);
    expect(reopened.feedbackCommand('p', uid, correction)).toEqual({ ...result, deduplicated: true });
    expect(() => reopened.feedbackCommand('p', uid, { ...correction, requestId: 'after-source-change', expectedVersion: invalid.version })).toThrow();
  });
  it('never fabricates a frozen basis for legacy submissions and rejects nonce conflicts', () => {
    const f = fixture();
    const command = { ...f.base(), action: 'correct' as const, correction: '订正' };
    f.command(command);
    expect(() => f.command({ ...command, correction: '不同内容' })).toThrow();
    const db = createNodeSqliteDriver().open(f.file);
    db.prepare('DELETE FROM feedback_originals WHERE attempt_id=?').run(f.attempt.attemptId); db.close();
    const legacy = f.store.getFeedbackContext('p', uid, f.attempt.attemptId);
    expect(legacy.canWrite).toBe(false); expect(legacy.snapshot.evidence).toEqual([]);
    expect(() => f.command({ ...f.base(), action: 'propose', conclusion: unknown })).toThrow();
  });
});
