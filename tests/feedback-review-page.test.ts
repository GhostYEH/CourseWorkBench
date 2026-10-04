import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import MistakesPage from '../apps/learning/app/workbench/mistakes/page';
import StudyPage from '../apps/learning/app/workbench/study/page';
import { closeProject, openProjectFromDisk, type Session } from '../apps/learning/lib/server/service';

const require = createRequire(new URL('../apps/learning/package.json', import.meta.url));
const { renderToStaticMarkup } = require('react-dom/server') as { renderToStaticMarkup: (element: unknown) => string };
const { createElement } = require('react') as { createElement: (type: unknown, props: unknown, ...children: unknown[]) => unknown };
const { AppRouterContext } = require('next/dist/shared/lib/app-router-context.shared-runtime') as { AppRouterContext: { Provider: unknown } };
const render = (element: unknown) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {
  back: () => {}, forward: () => {}, refresh: () => {}, hmrRefresh: () => {}, push: () => {}, replace: () => {}, prefetch: () => {},
} }, element));
describe('real feedback consumers', () => {
  let root: string;
  let session: Session;
  let attemptId: string;
  let questionId: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-feedback-page-')); session = openProjectFromDisk(root);
    const material = session.store.importMaterial({ projectId: session.projectId, displayName: '条件', materialType: 'txt', rawText: '使用前检查条件。' }).material;
    const proposal = session.store.createProposal({ projectId: session.projectId, name: '条件', concept: '核对条件', conditions: '', scopeStatus: 'in_syllabus', prerequisites: [],
      evidence: [{ materialId: material.materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }], acceptance: '', priority: 'medium', proposedBy: 'user' });
    const knowledgeId = session.store.applyReview({ proposalId: proposal.proposalId, decision: 'approved', expectedRevision: proposal.revision, semanticReviewed: true }).knowledgePoint!.knowledgeId;
    questionId = session.store.createQuestion({ stem: '请解释适用条件', answer: '提交前不可见的参考答案', solution: '参考分析', knowledgeIds: [knowledgeId], requestedOrigin: 'ai_new', originRecord: null,
      assessment: { schemaVersion: 1, type: 'short_answer', options: [], correctAnswers: [], maxScore: 3, answerVersion: 1, rubric: '说明适用条件' } }).question.questionId;
    attemptId = session.store.submitAttempt({ projectId: session.projectId, questionId, kind: 'real', actorType: 'human_learner', idempotencyKey: 'feedback-page-original',
      answerText: '本人原答案', processText: '' }).attempt.attemptId;
  });
  afterEach(() => { closeProject(); rmSync(root, { recursive: true, force: true }); });
  it('renders actionable personal review, correction, retry and confirmed due tasks without implicit changes', async () => {
    const base = { scope: { projectId: session.projectId, generation: session.generation }, attemptId, expectedVersion: 0, requestId: 'page-draft' };
    const draft = session.store.feedbackCommand(session.projectId, session.learnerUid, { ...base, action: 'draft', dueAt: '2026-01-01T00:00:00.000Z', reason: '到期核对条件' });
    let html = render(await MistakesPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('已到期复习（0）'); expect(html).toContain('保存待审错因候选'); expect(html).toContain('保存订正历史');
    expect(html).toContain('关联独立复做记录'); expect(html).toContain('人工确认复习安排');
    expect(session.store.getFeedbackContext(session.projectId, session.learnerUid, attemptId).version).toBe(1);
    session.store.feedbackCommand(session.projectId, session.learnerUid, { ...base, expectedVersion: 1, requestId: 'page-confirm', action: 'confirm', taskId: draft.tasks[0]!.taskId, semanticReviewed: true });
    html = render(await MistakesPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('已到期复习（1）'); expect(html).toContain('核验所选新作答并完成复习');
    expect(session.store.listReviewTasks(session.projectId, session.learnerUid)[0]?.status).toBe('confirmed');
  });
  it('keeps simulation feedback isolated and exposes a real submission consumer without pre-submission answers', async () => {
    session.store.submitAttempt({ projectId: session.projectId, questionId, kind: 'real', actorType: 'peer_ai', idempotencyKey: 'feedback-page-sim', answerText: '模拟答案', processText: '模拟过程' });
    const simulation = render(await MistakesPage({ searchParams: Promise.resolve({ tab: 'simulation' }) }));
    expect(simulation).toContain('模拟答案'); expect(simulation).not.toContain('本人原答案'); expect(simulation).not.toContain('保存待审错因候选');
    const study = render(StudyPage());
    expect(study).toContain('保存新的本人作答'); expect(study).toContain('解题过程'); expect(study).not.toContain('提交前不可见的参考答案');
  });
});
