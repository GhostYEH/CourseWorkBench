import { StudyError } from '@sew/study-contracts';
import { Fragment,type ReactNode } from 'react';
import { AttemptGradingPanel } from '../../../components/attempt-grading-panel';
import { FeedbackReviewPanel } from '../../../components/feedback-review-panel';
import { Empty } from '../../../components/ui';
import { effectiveGradeLabel } from '../../../lib/attempt-grading';
import { requireSession } from '../../../lib/server/service';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ tab?: string }>;
}

export default async function MistakesPage({ searchParams }: PageProps): Promise<ReactNode> {
  const session = requireSession();
  const tab = (await searchParams).tab === 'simulation' ? 'simulation' : 'real';
  const attempts = session.store.listAttempts(tab);
  const questions = new Map(session.store.listQuestions().map((q) => [q.questionId, q]));
  const gradingContexts = new Map(attempts.map((attempt) => [attempt.attemptId,
    tab === 'real' ? session.store.getAttemptGradingContext(session.projectId, attempt.attemptId) : null]));
  const reviewTasks = tab === 'real' ? session.store.listReviewTasks(session.projectId, session.learnerUid) : [];
  const feedbackContexts = new Map(attempts.map(attempt => {
    if (tab !== 'real' || attempt.actorType !== 'human_learner') return [attempt.attemptId, null] as const;
    try { return [attempt.attemptId, session.store.getFeedbackContext(session.projectId, session.learnerUid, attempt.attemptId)] as const; }
    catch (error) { if (error instanceof StudyError && error.code === 'VERSION_CONFLICT') return [attempt.attemptId, null] as const; throw error; }
  }));
  const due = reviewTasks.filter(task => task.status === 'confirmed' && task.dueAt <= new Date().toISOString());

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>错题本</h1>
          <p>
            本页按题显示已保存的作答原貌、过程文字与归因状态，并区分本人作答与模拟数据。
            错因候选需独立人工审核，订正与复做分别保留历史。缺少过程时保留证据不足；
            复习安排先保存草案，经人工确认后才等待新的本人作答。
          </p>
        </div>
      </div>

      {tab === 'real' ? <div className="card"><h2>已到期复习（{due.length}）</h2>
        {due.length ? due.map(task => <p key={task.taskId}>{task.reason} · {task.dueAt.slice(0, 19)} · 作答 {task.attemptId}（在对应反馈卡核验新收据）</p>)
          : <p className="muted">目前没有已确认且到期的复习安排。草案不计入待完成任务。</p>}</div> : null}

      <div className="card">
        <h2>{tab === 'real' ? '本人真实作答' : '模拟数据（不进入掌握统计）'}</h2>
        {attempts.length === 0 ? (
          <Empty>还没有{tab === 'real' ? '真实' : '模拟'}作答记录。</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>题目</th>
                <th>作答</th>
                <th>过程</th>
                <th>判分与版本</th>
                <th>归因状态</th>
                <th>掌握影响</th>
                <th>提交时间</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((attempt) => {
                const gradingContext = gradingContexts.get(attempt.attemptId);
                const effectiveGrading = gradingContext?.effectiveGrading ?? attempt.grading;
                return <Fragment key={attempt.attemptId}>
                <tr key={attempt.attemptId}>
                  <td>{questions.get(attempt.questionId)?.stem ?? attempt.questionId}</td>
                  <td>{attempt.answerText || '（未作答）'}</td>
                  <td className="secondary">{attempt.processText || '（缺少过程）'}</td>
                  <td>
                    <span className="pill" data-tone={effectiveGrading?.status === 'correct' ? 'verified' : 'pending'}>
                      {effectiveGrading ? effectiveGradeLabel(effectiveGrading) : '历史记录未保存判分依据'}
                    </span>
                    <div className="muted">
                      题目 {attempt.questionRevision === null ? '版本未记录' : `v${attempt.questionRevision}`} ·
                      答案 {attempt.answerVersion === null ? '版本未登记' : `v${attempt.answerVersion}`}
                    </div>
                  </td>
                  <td>
                    <span className="pill" data-tone={attempt.attributionStatus === 'proposed' ? 'info' : 'pending'}>
                      {attempt.attributionStatus === 'proposed' ? '过程已保存，等待错因核对' : '依据不足，需要补充过程'}
                    </span>
                  </td>
                  <td className="muted">{gradingContext?.reviews.length
                    ? gradingContext.reviews[gradingContext.reviews.length - 1]?.masteryApplied ? '最新审核已更新掌握' : '最新审核未更新掌握'
                    : attempt.masteryAfter ?? '不影响本人掌握'}</td>
                  <td className="muted mono">{attempt.submittedAt.slice(0, 19).replace('T', ' ')}</td>
                </tr>
                {gradingContext ? <tr><td colSpan={7}><AttemptGradingPanel
                  key={`${session.projectId}:${session.generation}:${attempt.attemptId}:${gradingContext.currentReviewVersion}`}
                  projectId={session.projectId} generation={session.generation} initialContext={gradingContext} /></td></tr> : null}
                {feedbackContexts.get(attempt.attemptId) ? <tr><td colSpan={7}><FeedbackReviewPanel
                  key={`${session.projectId}:${session.generation}:${attempt.attemptId}:${feedbackContexts.get(attempt.attemptId)!.version}`}
                  projectId={session.projectId} generation={session.generation} initialContext={feedbackContexts.get(attempt.attemptId)!}
                  initialTasks={reviewTasks} newAttempts={attempts.filter(next => next.attemptId !== attempt.attemptId && next.questionId === attempt.questionId
                    && next.actorType === 'human_learner').map(next => ({ attemptId: next.attemptId, answerText: next.answerText, submittedAt: next.submittedAt }))} /></td></tr>
                  : tab === 'real' ? <tr><td colSpan={7} className="muted">原题规则版本不可恢复，请保留历史并重新作答。</td></tr> : null}
                </Fragment>;
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>数据分区约定</h2>
        <p className="secondary">
          AI 同学的作答保存在 simulation 分区，不写入本人 attempt、错题正确率、考纲掌握率或复习完成数。
          模拟数据可以参与软件评测，不能更新实际掌握状态。
        </p>
      </div>
    </div>
  );
}
