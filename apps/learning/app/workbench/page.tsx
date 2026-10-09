import Link from 'next/link';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { StudyGoalEntry } from '../../components/study-goal-entry';
import { Stat } from '../../components/ui';
import { bootstrapFromEnvironment, getSession } from '../../lib/server/service';
import { readWorkbenchKnowledge, readWorkbenchState } from '../../lib/server/workbench-data';
import { studyNextStep } from '../../lib/study-next-step';

export const dynamic = 'force-dynamic';

export default function WorkbenchOverview(): ReactNode {
  const session = getSession() ?? bootstrapFromEnvironment();
  if (!session) redirect('/no-project');
  const state = readWorkbenchState(session);
  const hasGoal = Boolean(state.project.subject.trim() && state.project.goal.trim());
  const admitted = readWorkbenchKnowledge(session).admittedIds.size;
  const reviewTasks = session.store.listReviewTasks(session.projectId, session.learnerUid);
  const due = reviewTasks.filter(
    (task) => task.status === 'confirmed' && task.dueAt <= new Date().toISOString(),
  ).length;
  const classrooms = session.store.listClassroomDocuments(session.projectId).filter((document) => {
    if (document.recordScope !== 'formal') return false;
    const link = session.store.getLessonClassroomLink(document.lessonId, session.projectId);
    return link?.status === 'published' && link.stageId === document.stageId;
  });
  const next = studyNextStep({
    hasGoal,
    materials: state.counts.materials,
    pending: state.counts.proposalsPending,
    admitted,
    hasPlan: state.plan.confirmedVersion !== null,
    hasClassroom: classrooms.length > 0,
  });

  return (
    <div className="study-home">
      <section className="study-hero">
        <p className="study-eyebrow">学科备考工作台 · 学习从这里开始</p>
        <h1>{hasGoal ? '今天，向你的备考目标再进一步' : '你准备学习什么？'}</h1>
        <p className="secondary">
          用你的教材和考纲，安排备考计划，在互动课堂里学懂，再通过练习巩固。
        </p>
        {hasGoal ? (
          <div className="study-goal-summary">
            <span className="pill" data-tone="info">
              {state.project.subject}
            </span>
            <p>{state.project.goal}</p>
            <span className="muted">
              {state.project.dailyMinutes > 0
                ? `每天 ${state.project.dailyMinutes} 分钟`
                : '学习时间待设置'}
              {state.project.examDate ? ` · 考试日期 ${state.project.examDate}` : ''}
            </span>
            <Link href="/workbench/settings">调整目标与时间</Link>
          </div>
        ) : (
          <div id="study-goal-entry">
            <StudyGoalEntry
              key={`${session.projectId}:${session.generation}`}
              project={state.project}
            />
          </div>
        )}
      </section>

      {hasGoal ? (
        <section className="study-next" aria-label="当前下一步">
          <div>
            <p className="study-eyebrow">接下来</p>
            <h2>{next.title}</h2>
            <p className="secondary">{next.description}</p>
          </div>
          <Link className="btn btn-primary" href={next.href}>
            {next.action} →
          </Link>
        </section>
      ) : null}

      <div className="study-actions">
        <Link className="study-action-card" href="/workbench/materials">
          <span aria-hidden="true">01</span>
          <h2>学习材料</h2>
          <p>导入教材、考纲和讲义，整理要学的内容。</p>
          <strong>{state.counts.materials} 份材料 →</strong>
        </Link>
        <Link className="study-action-card" href="/workbench/lessons">
          <span aria-hidden="true">02</span>
          <h2>互动课堂</h2>
          <p>准备课程、听讲解，跟随课堂完成互动。</p>
          <strong>
            {classrooms.length > 0 ? `${classrooms.length} 节已发布课程` : '准备第一节课'} →
          </strong>
        </Link>
        <Link
          className="study-action-card"
          href={due > 0 ? '/workbench/mistakes' : '/workbench/study'}
        >
          <span aria-hidden="true">03</span>
          <h2>练习与复习</h2>
          <p>独立作答，再回到错题本查看反馈和复习。</p>
          <strong>
            {due > 0 ? `${due} 项到期复习` : `${state.counts.questions} 道可用题目`} →
          </strong>
        </Link>
      </div>

      <section className="study-course-section">
        <div className="page-head">
          <h2>我的课程</h2>
          <Link href="/workbench/library">查看课程库 →</Link>
        </div>
        {classrooms.length > 0 ? (
          <div className="study-actions">
            {classrooms.slice(0, 3).map((document) => (
              <Link
                className="study-action-card"
                key={document.stageId}
                href={`/classroom/${encodeURIComponent(document.lessonId)}`}
              >
                <span className="pill" data-tone="verified">
                  已发布
                </span>
                <h3>{document.name}</h3>
                <p>{document.description || `${document.sceneCount} 个课堂环节`}</p>
                <strong>进入课堂 →</strong>
              </Link>
            ))}
          </div>
        ) : (
          <div className="card">
            <p>还没有已发布的课程。{next.description}</p>
            <Link className="btn" href={next.href}>
              {next.action}
            </Link>
            <Link className="btn btn-ghost" href="/classroom/lesson-demo-monotonicity-1">
              先体验函数单调性演示课
            </Link>
            <p className="muted">演示课使用独立示例内容，不计入你的备考进度。</p>
          </div>
        )}
      </section>
      <div className="study-stats">
        <Stat value={admitted} label="可学习知识点" />
        <Stat value={state.plan.taskCount} label="计划任务" />
        <Stat value={state.counts.attemptsReal} label="已提交练习" />
        <Stat value={due} label="到期复习" />
      </div>
    </div>
  );
}
