import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { AttemptGradeCandidateDto, AttemptGradingContextDto } from '@sew/study-contracts';
import { AttemptGradingPanel } from '../apps/learning/components/attempt-grading-panel';
import { candidateApprovalBlocked, effectiveGradeLabel } from '../apps/learning/lib/attempt-grading';
import MistakesPage from '../apps/learning/app/workbench/mistakes/page';

const service = vi.hoisted(() => ({ session: null as unknown }));
vi.mock('../apps/learning/lib/server/service', () => ({ getSession: () => service.session, bootstrapFromEnvironment: () => service.session }));
const require = createRequire(new URL('../apps/learning/package.json', import.meta.url));
const { createElement } = require('react') as { createElement: (type: unknown, props: unknown, ...children: unknown[]) => unknown };
const { renderToStaticMarkup } = require('react-dom/server') as { renderToStaticMarkup: (node: unknown) => string };
const { AppRouterContext } = require('next/dist/shared/lib/app-router-context.shared-runtime') as { AppRouterContext: { Provider: unknown } };
const render = (element: unknown) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh: () => {} } }, element));
const pending = { status: 'pending_review' as const, correct: null, earned: null, maxScore: 10, answerVersion: 1, basis: '等待审核' };
const context = (): AttemptGradingContextDto => ({
  attemptId: 'formal-human', questionId: 'short', questionRevision: 2, answerVersion: 1,
  stem: '说明你的推导', answerText: '原始作答不可覆盖', processText: '原过程', referenceAnswer: '冻结参考答案',
  solution: '冻结解析', rubric: '冻结标准', maxScore: 10, submissionGrading: pending, effectiveGrading: pending,
  currentReviewVersion: 0, reviews: [], candidates: [], knowledgeIds: ['knowledge'], canReview: true, reviewBlockedReason: null,
});
const candidate = (patch: Partial<AttemptGradeCandidateDto> = {}): AttemptGradeCandidateDto => ({
  candidateId: 'candidate', attemptId: 'formal-human', questionRevision: 2, answerVersion: 1, expectedReviewVersion: 0,
  proposedEarned: 7, basis: '部分推导成立', uncertainty: '需核对条件', status: 'pending', requestedModel: 'test-model',
  runId: 'run', createdAt: '2026-10-04T00:00:00Z', reviewNote: '', ...patch,
});

describe('已提交简答人工审核界面', () => {
  it('显示冻结原答和待判分，不自动把模型候选当有效评分', () => {
    const value = context(); value.candidates = [candidate()];
    const html = render(createElement(AttemptGradingPanel, { projectId: 'project', generation: 1, initialContext: value }));
    expect(html).toContain('当前有效：待判分');
    expect(html).toContain('冻结参考答案'); expect(html).toContain('原始作答不可覆盖');
    expect(html).toContain('id="attempt-formal-human"');
    expect(html).toContain('待人工审核'); expect(html).toContain('建议得分：7/10');
    expect(html).toContain('候选属于待审核建议，不直接更新掌握');
    expect(html).toMatch(/data-grade-submit="true"[^>]*disabled=""/);
  });
  it('部分得分以部分得分展示，历史明确来源与掌握是否应用', () => {
    const value = context(); value.currentReviewVersion = 1;
    value.effectiveGrading = { ...pending, status: 'incorrect', correct: false, earned: 6, basis: '遗漏关键条件' };
    value.reviews = [{ reviewId: 'review', attemptId: value.attemptId, reviewVersion: 1, questionRevision: 2, answerVersion: 1,
      grading: value.effectiveGrading, basis: '遗漏关键条件', uncertainty: '无其他疑点', source: 'manual', candidateId: null,
      reviewer: 'local_user', masteryApplied: true, createdAt: '2026-10-04T00:00:00Z' }];
    const html = render(createElement(AttemptGradingPanel, { projectId: 'project', generation: 1, initialContext: value }));
    expect(html).toContain('当前有效：部分得分 · 6/10 分');
    expect(html).toContain('提交时：待判分'); expect(html).toContain('掌握更新：已应用');
    expect(html).toContain('独立人工审核');
  });
  it('已失效来源保留历史读取，同时禁用评分与模型生成', () => {
    const value = context(); value.canReview = false; value.reviewBlockedReason = '来源已撤销';
    const html = render(createElement(AttemptGradingPanel, { projectId: 'project', generation: 1, initialContext: value }));
    expect(html).toContain('来源已撤销'); expect(html).toContain('原始作答不可覆盖');
    expect(html).toContain('<fieldset disabled=""');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>请求模型评分候选/);
  });
  it('空分值、过期版本和已处理候选不能批准，拒绝仍独立可见', () => {
    expect(candidateApprovalBlocked(candidate({ proposedEarned: null }), 0)).toContain('没有确定得分');
    expect(candidateApprovalBlocked(candidate(), 1)).toContain('旧审核版本');
    expect(candidateApprovalBlocked(candidate({ status: 'approved' }), 0)).toContain('已处理');
    expect(candidateApprovalBlocked(candidate(), 0)).toBeNull();
    const value = context(); value.candidates = [candidate({ proposedEarned: null })];
    const html = render(createElement(AttemptGradingPanel, { projectId: 'project', generation: 1, initialContext: value }));
    expect(html).toContain('未能确定');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>载入候选进行人工审核/);
    expect(html).toContain('拒绝候选');
  });
  it('表格评分入口只展示具备已提交审核context的记录，未提交题参考答案不公开', async () => {
    const value = context();
    const attempt = (attemptId: string, kind: string, actorType: string) => ({
      attemptId, questionId: 'short', kind, actorType, recordScope: kind === 'simulation' ? 'simulation' : 'real',
      grading: pending, questionRevision: 2, answerVersion: 1, answerText: '作答', processText: '',
      attributionStatus: 'pending_process', masteryAfter: null, submittedAt: '2026-10-04T00:00:00Z',
    });
    service.session = { projectId: 'project', generation: 1, store: {
      listReviewTasks: () => [],
      listAttempts: () => [attempt('formal-human', 'formal', 'human'), attempt('demo', 'demo', 'human'), attempt('simulation', 'simulation', 'ai')],
      listQuestions: () => [{ questionId: 'short', stem: '题干', answer: '未提交题绝密参考答案' }],
      getAttemptGradingContext: (_project: string, id: string) => id === 'formal-human' ? value : null,
    } };
    const realHtml = render(await MistakesPage({ searchParams: Promise.resolve({ tab: 'real' }) }));
    expect(realHtml.match(/data-attempt-grading=/g)).toHaveLength(1);
    expect(realHtml).not.toContain('未提交题绝密参考答案');
    const simulationHtml = render(await MistakesPage({ searchParams: Promise.resolve({ tab: 'simulation' }) }));
    expect(simulationHtml).not.toContain('data-attempt-grading'); expect(simulationHtml).not.toContain('冻结参考答案');
  });
  it('评分标签准确区分待判分、零分、部分分和满分', () => {
    expect(effectiveGradeLabel(pending)).toBe('待判分');
    expect(effectiveGradeLabel({ ...pending, status: 'incorrect', correct: false, earned: 0 })).toBe('未得分 · 0/10 分');
    expect(effectiveGradeLabel({ ...pending, status: 'incorrect', correct: false, earned: 4 })).toBe('部分得分 · 4/10 分');
    expect(effectiveGradeLabel({ ...pending, status: 'correct', correct: true, earned: 10 })).toBe('满分 · 10/10 分');
  });
});
