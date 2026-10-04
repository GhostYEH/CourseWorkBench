import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { feedbackContextSchema, feedbackResultSchema } from '@sew/study-contracts';
import { GET, POST } from '../apps/learning/app/api/study/feedback/route';
import { closeProject, openProjectFromDisk, type Session } from '../apps/learning/lib/server/service';

describe('feedback HTTP authority', () => {
  let root: string;
  let session: Session;
  let attemptId: string;
  let questionId: string;
  let nonce: number;
  const scope = () => ({ projectId: session.projectId, generation: session.generation });
  const get = (id: string | null = attemptId, requestScope = scope()) => GET(new Request(`http://127.0.0.1/api/study/feedback?${new URLSearchParams({
    projectId: requestScope.projectId, generation: String(requestScope.generation), ...(id ? { attemptId: id } : {}),
  })}`));
  const post = (patch: Record<string, unknown> = {}) => POST(new Request('http://127.0.0.1/api/study/feedback', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: scope(), attemptId, expectedVersion: 0,
      requestId: `feedback-http-${++nonce}`, action: 'correct', correction: '补充完整订正。', ...patch }) }));
  beforeEach(() => {
    nonce = 0; root = mkdtempSync(join(tmpdir(), 'sew-feedback-http-')); session = openProjectFromDisk(root);
    const material = session.store.importMaterial({ projectId: session.projectId, displayName: '条件', materialType: 'txt', rawText: '公式须满足适用条件。' }).material;
    const proposal = session.store.createProposal({ projectId: session.projectId, name: '条件', concept: '检查条件', conditions: '', scopeStatus: 'in_syllabus',
      prerequisites: [], evidence: [{ materialId: material.materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }], acceptance: '', priority: 'medium', proposedBy: 'user' });
    const knowledgeId = session.store.applyReview({ proposalId: proposal.proposalId, decision: 'approved', expectedRevision: proposal.revision, semanticReviewed: true }).knowledgePoint!.knowledgeId;
    questionId = session.store.createQuestion({ stem: '说明公式条件', answer: '条件完整', solution: '逐项核对', knowledgeIds: [knowledgeId], requestedOrigin: 'ai_new', originRecord: null,
      assessment: { schemaVersion: 1, type: 'short_answer', options: [], correctAnswers: [], maxScore: 3, answerVersion: 1, rubric: '解释适用条件' } }).question.questionId;
    attemptId = session.store.submitAttempt({ projectId: session.projectId, questionId, kind: 'real', actorType: 'human_learner', idempotencyKey: 'feedback-http-original',
      answerText: '本人答案', processText: '' }).attempt.attemptId;
  });
  afterEach(() => { closeProject(); rmSync(root, { recursive: true, force: true }); });
  it('exposes only uncached scoped personal history; read and simulation visits cannot create feedback', async () => {
    const response = await get(); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const context = feedbackContextSchema.parse((await response.json()).data);
    expect(context.version).toBe(0); expect(context.entries).toEqual([]);
    expect((await (await get(null)).json()).data).toEqual([]);
    expect(session.store.getFeedbackContext(session.projectId, session.learnerUid, attemptId).entries).toEqual([]);
    const simulated = session.store.submitAttempt({ projectId: session.projectId, questionId, kind: 'real', actorType: 'peer_ai',
      idempotencyKey: 'feedback-http-simulation', answerText: '模拟答案', processText: '模拟过程' }).attempt;
    expect((await get(simulated.attemptId)).status).toBe(404);
    expect((await post({ attemptId: simulated.attemptId })).status).toBe(404);
    expect((await get(attemptId, { ...scope(), generation: scope().generation + 1 })).status).toBe(409);
  });
  it('rejects caller identities, unreviewed authority and invented process evidence', async () => {
    const concrete = { tags: ['calculation'], explanation: '算错', evidence: [], uncertainty: '待核对' };
    for (const patch of [{ uid: session.learnerUid }, { reviewer: 'teacher_ai' }, { action: 'review', correction: undefined, semanticReviewed: false,
      candidateId: null, conclusion: concrete }, { action: 'propose', correction: undefined, conclusion: concrete }]) {
      expect((await post(patch)).status).toBe(400);
    }
    const response = await post({ action: 'propose', correction: undefined, conclusion: { ...concrete, tags: ['unknown'], explanation: '缺过程，错因待确认' } });
    expect(response.status).toBe(200);
    expect(feedbackResultSchema.parse((await response.json()).data).context.entries[0]?.action).toBe('propose');
  });
  it('deduplicates exact intent, restores after reopen, rejects stale scopes and CAS', async () => {
    const requestId = 'feedback-http-dedup';
    const response = await post({ requestId }); expect(response.status).toBe(200);
    expect((await (await post({ requestId })).json()).data.deduplicated).toBe(true);
    expect((await post({ requestId, correction: '其他订正' })).status).toBe(409);
    expect((await post()).status).toBe(409);
    const oldScope = scope(); closeProject(); session = openProjectFromDisk(root);
    expect((await get()).status).toBe(200);
    expect((await (await get()).json()).data.entries).toHaveLength(1);
    expect((await post({ scope: oldScope, expectedVersion: 1 })).status).toBe(409);
    expect((await post({ expectedVersion: 1 })).status).toBe(200);
  });
});
