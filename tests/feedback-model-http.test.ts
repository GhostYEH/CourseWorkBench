import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { feedbackModelResultSchema } from '@sew/study-contracts';
import { POST } from '../apps/learning/app/api/study/feedback/generate/route';
import { modelConnection } from '../apps/learning/lib/server/model-connection';
import { closeProject, openProjectFromDisk, type Session } from '../apps/learning/lib/server/service';

describe('feedback model HTTP authority', () => {
  let root: string;
  let session: Session;
  let attemptId: string;
  let questionId: string;
  let nonce: number;
  const scope = () => ({ projectId: session.projectId, generation: session.generation });
  const post = (patch: Record<string, unknown> = {}) => POST(new Request('http://127.0.0.1/api/study/feedback', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: scope(), attemptId, expectedVersion: 0,
      requestId: `feedback-http-${++nonce}`, purpose: 'error_attribution', ...patch }) }));
  beforeEach(() => {
    nonce = 0; root = mkdtempSync(join(tmpdir(), 'sew-feedback-http-')); session = openProjectFromDisk(root);
    const material = session.store.importMaterial({ projectId: session.projectId, displayName: '条件', materialType: 'txt', rawText: '公式须满足适用条件。' }).material;
    const proposal = session.store.createProposal({ projectId: session.projectId, name: '条件', concept: '检查条件', conditions: '', scopeStatus: 'in_syllabus',
      prerequisites: [], evidence: [{ materialId: material.materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }], acceptance: '', priority: 'medium', proposedBy: 'user' });
    const knowledgeId = session.store.applyReview({ proposalId: proposal.proposalId, decision: 'approved', expectedRevision: proposal.revision, semanticReviewed: true }).knowledgePoint!.knowledgeId;
    session.store.savePlanVersion(session.projectId, 1, 'confirmed', { payloadVersion: 1, goal: '核对条件', examDate: null, dailyMinutes: 20,
      tasks: [{ knowledgeId, name: '条件', minutes: 20, acceptance: '', evidence: [{ materialId: material.materialId, segmentId: 'S001' }] }],
      gaps: [], basis: '夹具', confirmedTaskKnowledgeIds: [knowledgeId] });
    session.store.startPlanRun(session.projectId);
    questionId = session.store.createQuestion({ stem: '说明公式条件', answer: '条件完整', solution: '逐项核对', knowledgeIds: [knowledgeId], requestedOrigin: 'ai_new', originRecord: null,
      assessment: { schemaVersion: 1, type: 'short_answer', options: [], correctAnswers: [], maxScore: 3, answerVersion: 1, rubric: '解释适用条件' } }).question.questionId;
    attemptId = session.store.submitAttempt({ projectId: session.projectId, questionId, kind: 'real', actorType: 'human_learner', idempotencyKey: 'feedback-http-original',
      answerText: '本人答案', processText: '' }).attempt.attemptId;
  });
  afterEach(() => { vi.restoreAllMocks(); closeProject(); rmSync(root, { recursive: true, force: true }); });

  const fakeProvider = () => {
    vi.spyOn(modelConnection, 'status').mockReturnValue({ configured: true, persisted: false, lastTest: null, model: 'fake' });
    return vi.spyOn(modelConnection, 'generate').mockResolvedValue({ dispatched: true, ok: true, message: 'fake',
      text: JSON.stringify({ tags: ['unknown'], explanation: '缺少过程，请补充诊断步骤', evidence: [], uncertainty: '无法确定具体错因' }),
      totalTokens: 55, providerTokens: 55, requestedModel: 'fake', elapsedMs: 5 });
  };
  it('actual route writes model-origin pending candidates, returns no-store receipts, and never dispatches malformed identities', async () => {
    const generate = fakeProvider();
    for (const patch of [{ origin: 'manual' }, { uid: session.learnerUid }, { learnerUid: session.learnerUid },
      { scope: { ...scope(), uid: session.learnerUid } }]) expect((await post(patch)).status).toBe(400);
    expect(generate).not.toHaveBeenCalled();
    const response = await post({ requestId: 'http-receipt' }); expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = feedbackModelResultSchema.parse((await response.json()).data);
    expect(result.generation.ok).toBe(true); expect(result.feedback.context.entries[0]).toMatchObject({ action: 'propose', origin: 'model' });
    const retry = await post({ requestId: 'http-receipt' }); expect(retry.status).toBe(200);
    expect(feedbackModelResultSchema.parse((await retry.json()).data).feedback.deduplicated).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await post({ requestId: 'http-receipt', purpose: 'review_suggestion' })).status).toBe(409);
  });
  it('stale scopes and simulation attempts fail before dispatch', async () => {
    const generate = fakeProvider();
    const simulated = session.store.submitAttempt({ projectId: session.projectId, questionId, kind: 'real', actorType: 'peer_ai',
      idempotencyKey: 'model-http-simulation', answerText: '模拟', processText: '' }).attempt;
    expect((await post({ attemptId: simulated.attemptId })).status).toBe(404);
    const oldScope = scope(); closeProject(); session = openProjectFromDisk(root);
    expect((await post({ scope: oldScope })).status).toBe(409);
    expect(generate).not.toHaveBeenCalled(); expect(session.store.listModelUsageCalls(session.projectId)).toEqual([]);
  });
});
