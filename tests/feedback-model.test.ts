import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyStore, createNodeSqliteDriver } from '@sew/study-storage';
import { StudyError, feedbackModelInputSchema, type FeedbackModelInput } from '@sew/study-contracts';
import { generateFeedbackCandidate } from '../apps/learning/lib/server/feedback-model';
import type { ModelCallDeps } from '../apps/learning/lib/server/model-call';
import type { ModelGenerateOutcome } from '../apps/learning/lib/server/model-connection';

const uid = 'uid_12345678-1234-4123-8123-123456789abc';
const otherUid = 'uid_22345678-1234-4123-8123-123456789abc';
const roots: string[] = [];
const stores = new Set<StudyStore>();
afterEach(() => { for (const store of stores) store.close(); stores.clear(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const conclusion = { tags: ['method'], explanation: '可能未检查条件', evidence: [{ start: 0, end: 4, quote: '先套公式' }], uncertainty: '仅为候选，请人工核对' };
const suggestion = { dueInDays: 2, reason: '重新解释适用条件，再独立复做原题' };
const outcome = (text: unknown = conclusion, overrides: Partial<ModelGenerateOutcome> = {}): ModelGenerateOutcome => ({
  dispatched: true, ok: true, message: 'fake provider', text: JSON.stringify(text), totalTokens: 80,
  providerTokens: 80, requestedModel: 'fake', returnedModel: 'fake', elapsedMs: 5, ...overrides,
});
function fixture(options: { process?: string; noRun?: boolean; outsidePlan?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sew-feedback-model-')); roots.push(root);
  const file = join(root, 'study.sqlite'); let store = StudyStore.open({ file }); stores.add(store);
  const projectId = 'feedback-model-project';
  store.createProject({ projectId, displayName: '数学' }); store.bindLocalLearner(projectId, uid);
  const material = store.importMaterial({ projectId, displayName: '考纲', materialType: 'txt', rawText: '定义需要检查适用条件。' }).material;
  const knowledge = (name: string) => {
    const proposal = store.createProposal({ projectId, name, concept: name, conditions: '条件', scopeStatus: 'in_syllabus', prerequisites: [],
      evidence: [{ materialId: material.materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }], acceptance: '', priority: 'medium', proposedBy: 'user' });
    return store.applyReview({ proposalId: proposal.proposalId, decision: 'approved', expectedRevision: proposal.revision, semanticReviewed: true }).knowledgePoint!;
  };
  const kp = knowledge('定义'); const planned = options.outsidePlan ? knowledge('另一个计划知识点') : kp;
  store.savePlanVersion(projectId, 1, 'confirmed', { payloadVersion: 1, goal: '核对条件', examDate: null, dailyMinutes: 20,
    tasks: [{ knowledgeId: planned.knowledgeId, name: planned.name, minutes: 20, acceptance: '', evidence: [{ materialId: material.materialId, segmentId: 'S001' }] }],
    gaps: [], basis: '测试夹具', confirmedTaskKnowledgeIds: [planned.knowledgeId] });
  if (!options.noRun) store.startPlanRun(projectId);
  const question = store.createQuestion({ stem: '解释条件', answer: '参考答案', solution: '参考分析', knowledgeIds: [kp.knowledgeId], requestedOrigin: 'ai_new', originRecord: null,
    assessment: { schemaVersion: 1, type: 'short_answer', options: [], correctAnswers: [], rubric: '核对条件', maxScore: 5, answerVersion: 1 } }).question;
  let count = 0;
  const submit = (actorType: 'human_learner' | 'peer_ai' = 'human_learner') => store.submitAttempt({ projectId, questionId: question.questionId,
    idempotencyKey: `attempt-${++count}`, actorType, kind: 'real', answerText: '个人答案', processText: options.process ?? '先套公式，未检查条件' }).attempt;
  const attempt = submit();
  const generate = vi.fn<ModelCallDeps['connection']['generate']>(async () => outcome());
  const deps = (): ModelCallDeps & { learnerUid: string } => ({ store, projectId, learnerUid: uid,
    connection: { status: () => ({ configured: true, persisted: false, lastTest: null, model: 'fake' }), generate } });
  let request = 0;
  const input = (purpose: FeedbackModelInput['purpose'] = 'error_attribution'): FeedbackModelInput => ({ scope: { projectId, generation: 1 },
    attemptId: attempt.attemptId, expectedVersion: store.getFeedbackContext(projectId, uid, attempt.attemptId).version, requestId: `model-${++request}`, purpose });
  const context = () => store.getFeedbackContext(projectId, uid, attempt.attemptId);
  const reopen = () => { store.close(); stores.delete(store); store = StudyStore.open({ file }); stores.add(store); };
  return { get store() { return store; }, projectId, file, material, kp, attempt, question, generate, deps, input, context, submit, reopen };
}

describe('feedback model candidates use the real immutable store and shared ledger', () => {
  it.each(['error_attribution', 'review_suggestion'] as const)('%s only saves model-origin pending facts and keeps personal grading/mastery immutable', async purpose => {
    const f = fixture(); f.generate.mockResolvedValue(outcome(purpose === 'error_attribution' ? conclusion : suggestion));
    const attempts = f.store.listAttempts(); const knowledge = f.store.getKnowledge(f.kp.knowledgeId);
    const result = await generateFeedbackCandidate(f.deps(), f.input(purpose));
    expect(result.generation.ok).toBe(true);
    expect(result.feedback.context.entries).toHaveLength(1);
    expect(result.feedback.context.entries[0]).toMatchObject({ origin: 'model', action: purpose === 'error_attribution' ? 'propose' : 'draft' });
    if (purpose === 'review_suggestion') expect(result.feedback.tasks[0]).toMatchObject({ origin: 'model', status: 'draft', confirmedAt: null, completionAttemptId: null });
    else expect(result.feedback.tasks).toEqual([]);
    expect(f.store.listAttempts()).toEqual(attempts); expect(f.store.getKnowledge(f.kp.knowledgeId)).toEqual(knowledge);
    expect(f.store.modelCallUsage(f.store.getLatestRun()!.runId)).toMatchObject({ calls: 1, tokens: 80 });
  });

  it('replays the persisted result without provider calls and rejects nonce intent changes', async () => {
    const f = fixture(); const input = f.input(); const first = await generateFeedbackCandidate(f.deps(), input);
    f.reopen(); const retry = await generateFeedbackCandidate(f.deps(), input);
    expect(retry.generation).toEqual(first.generation); expect(retry.feedback.deduplicated).toBe(true);
    expect(f.generate).toHaveBeenCalledTimes(1); expect(f.context().entries).toHaveLength(1);
    await expect(generateFeedbackCandidate(f.deps(), { ...input, purpose: 'review_suggestion' })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(generateFeedbackCandidate(f.deps(), { ...input, expectedVersion: 1 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it.each(['source', 'uid', 'version', 'run', 'plan'] as const)('%s preflight failures do not dispatch or reserve usage', async reason => {
    const f = fixture({ noRun: reason === 'run', outsidePlan: reason === 'plan' }); const input = f.input(); const deps = f.deps();
    if (reason === 'source') f.store.importMaterial({ projectId: f.projectId, displayName: '考纲', materialType: 'txt', rawText: '来源修订。' });
    if (reason === 'uid') deps.learnerUid = otherUid;
    if (reason === 'version') input.expectedVersion = 9;
    await expect(generateFeedbackCandidate(deps, input)).rejects.toBeInstanceOf(StudyError);
    expect(f.generate).not.toHaveBeenCalled(); expect(f.store.listModelUsageCalls(f.projectId)).toEqual([]); expect(f.context().entries).toEqual([]);
  });

  it.each(['quote', 'missing-process', 'overflow-end'] as const)('rejects %s concrete attribution but charges dispatched provider usage', async reason => {
    const f = fixture({ process: reason === 'missing-process' ? '' : undefined });
    f.generate.mockResolvedValue(outcome(reason === 'quote' ? { ...conclusion, evidence: [{ start: 1, end: 5, quote: '先套公式' }] }
      : reason === 'overflow-end' ? { ...conclusion, evidence: [{ start: 0, end: 999, quote: f.context().snapshot.processText }] } : conclusion));
    const result = await generateFeedbackCandidate(f.deps(), f.input());
    expect(result.generation.ok).toBe(false); expect(result.generation.callState).toBe('failed');
    expect(f.context().entries).toEqual([]); expect(f.store.modelCallUsage(f.store.getLatestRun()!.runId)).toMatchObject({ calls: 1, tokens: 80 });
  });

  it.each(['tokens', 'time'] as const)('shared %s overage rejects the candidate and preserves actual usage', async axis => {
    const f = fixture(); const runId = f.store.getLatestRun()!.runId;
    f.store.startModelUsageCall({ projectId: f.projectId, runId, requestId: 'other-purpose', purpose: 'lesson_draft', intent: 'a'.repeat(64),
      reservedTokens: 1000, sessionId: null, roundIndex: null, roleProfileId: null, peerTurnIndex: null, provider: null, requestedModel: 'fake' },
      { maxCalls: 8, maxTokens: 10000, maxWallClockMs: 1000 });
    f.store.settleModelUsageCall(f.projectId, 'other-purpose', { state: 'completed', accountedTokens: 1000, providerTokens: 1000,
      tokenMeasurement: 'actual', returnedModel: 'fake', elapsedMs: 500, result: null });
    const deps = { ...f.deps(), limits: { maxCalls: 8, maxTokens: 10000, maxWallClockMs: 1000 } };
    f.generate.mockResolvedValue(outcome(conclusion, axis === 'tokens' ? { totalTokens: 9001, providerTokens: 9001 } : { elapsedMs: 600 }));
    const result = await generateFeedbackCandidate(deps, f.input());
    expect(result.generation.ok).toBe(false); expect(f.context().entries).toEqual([]);
    expect(f.store.modelCallUsage(runId)).toMatchObject({ calls: 2, tokens: axis === 'tokens' ? 10001 : 1080 });
    if (axis === 'time') expect(f.store.modelCallUsage(runId).activeElapsedMs).toBeGreaterThanOrEqual(1100);
  });

  it('abort before dispatch has no cost; abort after dispatch records usage without saving candidate', async () => {
    const f = fixture(); const pre = new AbortController(); pre.abort();
    await expect(generateFeedbackCandidate(f.deps(), f.input(), pre.signal)).rejects.toMatchObject({ code: 'RUN_TERMINATED' });
    expect(f.generate).not.toHaveBeenCalled(); expect(f.store.listModelUsageCalls(f.projectId)).toEqual([]);
    const post = new AbortController(); f.generate.mockImplementation(async () => { post.abort(); return outcome(); });
    const result = await generateFeedbackCandidate(f.deps(), f.input(), post.signal);
    expect(result.generation.ok).toBe(false); expect(f.context().entries).toEqual([]);
    expect(f.store.modelCallUsage(f.store.getLatestRun()!.runId)).toMatchObject({ calls: 1, tokens: 80 });
  });

  it('unknown dispatched provider failures retain the reservation and never retry the provider automatically', async () => {
    const f = fixture(); const input = f.input(); f.generate.mockRejectedValue(new Error('dispatched connection lost'));
    const result = await generateFeedbackCandidate(f.deps(), input);
    expect(result.generation).toMatchObject({ ok: false, callState: 'failed', totalTokens: 0, providerTokens: null });
    const call = f.store.getModelUsageCall(f.projectId, input.requestId)!;
    expect(call).toMatchObject({ state: 'failed', accountedTokens: null, tokenMeasurement: 'unknown' });
    expect(f.store.modelCallUsage(f.store.getLatestRun()!.runId).tokens).toBe(call.reservedTokens);
    expect(f.context().entries).toEqual([]); f.reopen();
    expect((await generateFeedbackCandidate(f.deps(), input)).generation).toEqual(result.generation);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it('model output cannot promote a draft to confirmed authority', async () => {
    const f = fixture(); f.generate.mockResolvedValue(outcome({ ...suggestion, status: 'confirmed', origin: 'manual' }));
    const result = await generateFeedbackCandidate(f.deps(), f.input('review_suggestion'));
    expect(result.generation.ok).toBe(false); expect(f.context().entries).toEqual([]);
    expect(f.store.listReviewTasks(f.projectId, uid)).toEqual([]);
    expect(f.store.modelCallUsage(f.store.getLatestRun()!.runId)).toMatchObject({ calls: 1, tokens: 80 });
  });

  it('scope replacement leaves an unknown started reservation that is never resent after reopen', async () => {
    const f = fixture(); const input = f.input(); let valid = true;
    const deps = { ...f.deps(), revalidateScope: () => { if (!valid) throw new StudyError('PROJECT_NOT_AUTHORIZED'); } };
    f.generate.mockImplementation(async () => { valid = false; return outcome(); });
    await expect(generateFeedbackCandidate(deps, input)).rejects.toMatchObject({ code: 'PROJECT_NOT_AUTHORIZED' });
    expect(f.store.getModelUsageCall(f.projectId, input.requestId)).toMatchObject({ state: 'started', result: null });
    expect(f.context().entries).toEqual([]); f.reopen();
    const retry = await generateFeedbackCandidate(f.deps(), input);
    expect(retry.generation).toMatchObject({ ok: false, callState: 'started' }); expect(retry.feedback.deduplicated).toBe(true);
    expect(f.generate).toHaveBeenCalledTimes(1); expect(f.store.modelCallUsage(f.store.getLatestRun()!.runId).tokens).toBeGreaterThan(0);
  });

  it('a failed candidate transaction rolls back facts and candidate receipt, preserving provider cost and a failed call receipt', async () => {
    const f = fixture(); const db = createNodeSqliteDriver().open(f.file);
    db.exec("CREATE TRIGGER fail_feedback_save BEFORE INSERT ON feedback_entries BEGIN SELECT RAISE(ABORT,'save_failed'); END;"); db.close();
    const input = f.input(); const result = await generateFeedbackCandidate(f.deps(), input);
    expect(result.generation.ok).toBe(false); expect(f.context().entries).toEqual([]); expect(f.store.listReviewTasks(f.projectId, uid)).toEqual([]);
    const read = createNodeSqliteDriver().open(f.file);
    expect(read.prepare('SELECT COUNT(*) AS count FROM feedback_receipts').get()).toMatchObject({ count: 0 }); read.close();
    expect(f.store.getModelUsageCall(f.projectId, input.requestId)).toMatchObject({ state: 'failed', accountedTokens: 80 });
    expect((await generateFeedbackCandidate(f.deps(), input)).generation.ok).toBe(false); expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it('model review drafts require manual confirmation and a new personal submission before completion', async () => {
    const f = fixture(); f.generate.mockResolvedValue(outcome(suggestion));
    const generated = await generateFeedbackCandidate(f.deps(), f.input('review_suggestion')); const task = generated.feedback.tasks[0]!;
    const command = () => ({ scope: { projectId: f.projectId, generation: 1 }, attemptId: f.attempt.attemptId,
      expectedVersion: f.context().version, requestId: `human-${f.context().version}` });
    expect(() => f.store.feedbackCommand(f.projectId, uid, { ...command(), action: 'complete', taskId: task.taskId, completionAttemptId: f.attempt.attemptId })).toThrow();
    const old = f.submit();
    expect(() => f.store.feedbackCommand(f.projectId, uid, { ...command(), action: 'confirm', taskId: task.taskId,
      semanticReviewed: false } as never)).toThrow();
    const confirmed = f.store.feedbackCommand(f.projectId, uid, { ...command(), action: 'confirm', taskId: task.taskId, semanticReviewed: true });
    expect(confirmed.context.entries.at(-1)).toMatchObject({ action: 'confirm', origin: 'manual' });
    expect(() => f.store.feedbackCommand(f.projectId, uid, { ...command(), action: 'complete', taskId: task.taskId, completionAttemptId: old.attemptId })).toThrow();
    const simulated = f.submit('peer_ai');
    expect(() => f.store.feedbackCommand(f.projectId, uid, { ...command(), action: 'complete', taskId: task.taskId, completionAttemptId: simulated.attemptId })).toThrow();
    const fresh = f.submit(); const done = f.store.feedbackCommand(f.projectId, uid, { ...command(), action: 'complete', taskId: task.taskId, completionAttemptId: fresh.attemptId });
    expect(done.tasks[0]).toMatchObject({ status: 'completed', completionAttemptId: fresh.attemptId });
  });

  it('strict generation request schemas reject self-reported origin and identity', () => {
    const f = fixture(); const input = f.input();
    for (const forged of [{ origin: 'manual' }, { uid: otherUid }, { learnerUid: otherUid }, { scope: { ...input.scope, uid: otherUid } }]) {
      expect(feedbackModelInputSchema.safeParse({ ...input, ...forged }).success).toBe(false);
    }
  });
});
