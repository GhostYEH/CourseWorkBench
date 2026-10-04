import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiResponses } from '@sew/study-contracts';
import { GET, POST } from '../apps/learning/app/api/study/grading/route';
import { closeProject, openProjectFromDisk, type Session } from '../apps/learning/lib/server/service';

describe('personal grading HTTP boundary', () => {
  let root: string;
  let session: Session;
  let attemptId: string;
  let questionId: string;
  let knowledgeId: string;
  const scope = () => ({ projectId: session.projectId, generation: session.generation });
  const get = (id = attemptId, requestScope = scope()) => GET(new Request(
    `http://127.0.0.1/api/study/grading?${new URLSearchParams({ attemptId: id, projectId: requestScope.projectId, generation: String(requestScope.generation) })}`,
  ));
  const review = (patch: Record<string, unknown> = {}) => POST(new Request('http://127.0.0.1/api/study/grading', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'review', scope: scope(), attemptId, expectedReviewVersion: 0,
      requestId: 'human-review-1', earned: 3, basis: '已逐项核对区间和任意两点两个条件。',
      uncertainty: '本题依据完整；不推断其他题目的表现。', semanticReviewed: true, candidateId: null, ...patch }),
  }));
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-grading-http-'));
    session = openProjectFromDisk(root);
    const imported = session.store.importMaterial({ projectId: session.projectId,
      displayName: '评分来源.md', materialType: 'md', rawText: '增函数在同一区间内任取 x1 < x2 时 f(x1) < f(x2)。' });
    const proposal = session.store.createProposal({ projectId: session.projectId, name: '增函数定义', concept: '区间内任意两点次序一致',
      conditions: '同一区间内', scopeStatus: 'in_syllabus', prerequisites: [], evidence: [{ materialId: imported.material.materialId,
        revision: 1, segmentId: imported.segments[0]!.segmentId, use: 'concept_basis' }], acceptance: '', priority: 'medium', proposedBy: 'user' });
    knowledgeId = session.store.applyReview({ proposalId: proposal.proposalId, expectedRevision: proposal.revision,
      decision: 'approved', semanticReviewed: true }).knowledgePoint!.knowledgeId;
    questionId = session.store.createQuestion({ stem: '说明增函数定义的两个条件', answer: '同一区间内任意两点',
      solution: '须同时核对区间与任意取值。', knowledgeIds: [knowledgeId], requestedOrigin: 'ai_new', originRecord: null,
      assessment: { schemaVersion: 1, type: 'short_answer', options: [], correctAnswers: [], maxScore: 3,
        answerVersion: 1, rubric: '同一区间与任意两点都说明得满分，否则根据完整程度给部分分。' } }).question.questionId;
    attemptId = session.store.submitAttempt({ projectId: session.projectId, questionId, kind: 'real', actorType: 'human_learner',
      idempotencyKey: 'raw-submission-1', answerText: '同一区间任意两点', processText: '先限制区间，再取任意两点比较。' }).attempt.attemptId;
  });
  afterEach(() => { closeProject(); rmSync(root, { recursive: true, force: true }); });

  it('returns the submitted answer and reference only with current scope and does not cache it', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { data } = await response.json();
    expect(apiResponses.attemptGradingContext.safeParse(data).success).toBe(true);
    expect(data).toMatchObject({ attemptId, referenceAnswer: '同一区间内任意两点', currentReviewVersion: 0,
      submissionGrading: { status: 'pending_review' }, effectiveGrading: { status: 'pending_review' } });
    expect((await get('not-submitted')).status).toBe(404);
    const byReceipt = await GET(new Request(`http://127.0.0.1/api/study/grading?${new URLSearchParams({
      idempotencyKey: 'raw-submission-1', projectId: session.projectId, generation: String(session.generation),
    })}`));
    expect((await byReceipt.json()).data.attemptId).toBe(attemptId);
    expect((await GET(new Request(`http://127.0.0.1/api/study/grading?attemptId=${attemptId}`))).status).toBe(400);
    expect((await get(attemptId, { ...scope(), generation: session.generation + 1 })).status).toBe(409);
  });

  it('appends a human score, preserves the original attempt and replay remains unique', async () => {
    const response = await review();
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(apiResponses.attemptGradeReview.safeParse(data).success).toBe(true);
    expect(data.context).toMatchObject({ currentReviewVersion: 1, effectiveGrading: { status: 'correct', earned: 3 } });
    const original = session.store.getAttemptByIdempotencyKey('raw-submission-1')!;
    expect(original).toMatchObject({ answerText: '同一区间任意两点', processText: '先限制区间，再取任意两点比较。',
      grading: { status: 'pending_review', earned: null }, masteryAfter: null });
    expect(session.store.getKnowledge(knowledgeId)!.masteryStatus).toBe('passed');
    const replay = await (await review()).json();
    expect(replay.data.deduplicated).toBe(true);
    expect(replay.data.context.reviews).toHaveLength(1);
    expect((await review({ earned: 2 })).status).toBe(409);
    expect((await review({ requestId: 'another-review', earned: 2 })).status).toBe(409);
  });

  it('rejects impersonation, unconfirmed review and out-of-range score without a result', async () => {
    for (const patch of [{ reviewer: 'teacher_ai' }, { actorType: 'human_learner' }, { semanticReviewed: false },
      { basis: ' ' }, { uncertainty: ' ' }, { earned: 4 }, { earned: -1 }]) {
      expect((await review(patch)).status).toBe(400);
    }
    const context = await (await get()).json();
    expect(context.data.currentReviewVersion).toBe(0);
    expect(session.store.getKnowledge(knowledgeId)!.masteryStatus).toBe('untested');
  });

  it('does not expose simulation as a personal grading context', async () => {
    const simulated = session.store.submitAttempt({ projectId: session.projectId, questionId, kind: 'real', actorType: 'peer_ai',
      idempotencyKey: 'simulated-submission', answerText: 'AI 模拟答案', processText: '模拟过程' }).attempt;
    const response = await get(simulated.attemptId);
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain('referenceAnswer');
    expect((await review({ attemptId: simulated.attemptId })).status).not.toBe(200);
    expect(session.store.getKnowledge(knowledgeId)!.masteryStatus).toBe('untested');
  });

  it('keeps historical feedback after reopening and rejects every old-scope write', async () => {
    await review();
    const previousScope = scope();
    closeProject();
    session = openProjectFromDisk(root);
    expect((await get(attemptId, previousScope)).status).toBe(409);
    expect((await review({ scope: previousScope, expectedReviewVersion: 1, requestId: 'late-review' })).status).toBe(409);
    const { data } = await (await get()).json();
    expect(data.currentReviewVersion).toBe(1);
    expect(data.reviews).toHaveLength(1);
    expect(data.effectiveGrading.earned).toBe(3);
  });
});
