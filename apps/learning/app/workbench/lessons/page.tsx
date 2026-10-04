import type { ReactNode } from 'react';
import Link from 'next/link';
import { LessonDraftGeneration } from '../../../components/lesson-draft-generation';
import { LessonWorkbench } from '../../../components/lesson-workbench';
import { bootstrapFromEnvironment, getSession } from '../../../lib/server/service';
import { readWorkbenchKnowledge, readWorkbenchQuestions } from '../../../lib/server/workbench-data';
import { toKnowledgePointDto, toLessonReviewDto, toLessonVersionDto } from '../../../lib/server/dto';
import { modelConnection } from '../../../lib/server/model-connection';

export const dynamic = 'force-dynamic';

/**
 * 课程与证据包（LESSON-01 / LESSON-02）。
 *
 * 只有已确认计划的准入知识点能进入证据包；草案须经本地用户审核后才能发布，
 * 来源之后失效不会改写已发布课程，而是让课堂入口与生成入口按准入受阻。
 */
export default function LessonsPage(): ReactNode {
  const session = (getSession() ?? bootstrapFromEnvironment())!;
  const projectId = session.projectId;
  const view = readWorkbenchKnowledge(session);
  const knowledge = view.rows.map((point) => ({
    ...toKnowledgePointDto(point),
    admitted: view.admittedIds.has(point.knowledgeId),
  }));
  const questions = readWorkbenchQuestions(session);
  const bundles = session.store.listEvidenceBundles(projectId).map((row) => ({
    bundleId: row.bundleId,
    digest: row.digest,
    frozenAt: row.frozenAt,
    bundle: row.bundle,
  }));
  const lessons = session.store.listLessons(projectId).map(toLessonVersionDto);
  const versions = lessons.flatMap((lesson) => session.store.listLessonVersions(lesson.lessonId, projectId).map(toLessonVersionDto));
  const reviews = versions
    .map((version) => session.store.getLessonReview(version.lessonId, version.version, projectId))
    .filter((review): review is NonNullable<typeof review> => review !== null)
    .map(toLessonReviewDto);
  const confirmedPlan = session.store.getConfirmedPlan(projectId);

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>课程与证据包</h1>
          <p>
            课程只引用冻结后的证据包。当前已确认计划：
            {confirmedPlan ? <span className="mono"> v{confirmedPlan.version}</span> : ' 尚未确认（不能冻结证据包）'}。
            课堂入口在场景来源缺失或知识点失效时会被阻断，而不是回退到未核实内容。
          </p>
        </div>
        <div className="actions">
          <Link className="btn" href="/workbench/plan">回到备考计划</Link>
          <Link className="btn" href="/workbench/knowledge">查看已确认知识</Link>
        </div>
      </div>

      <LessonWorkbench
        projectId={projectId}
        generation={session.generation}
        bundles={bundles}
        lessons={lessons}
        versions={versions}
        reviews={reviews}
        knowledge={knowledge}
        questions={questions}
      />

      <LessonDraftGeneration
        projectId={projectId}
        generation={session.generation}
        bundles={bundles}
        configured={modelConnection.status().configured}
      />
    </div>
  );
}
