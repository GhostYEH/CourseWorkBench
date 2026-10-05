import Link from 'next/link';
import type { ReactNode } from 'react';
import { LessonDraftGeneration } from '../../../components/lesson-draft-generation';
import { LessonTeaching } from '../../../components/lesson-teaching';
import { LessonWorkbench } from '../../../components/lesson-workbench';
import { QuestionAuthoring } from '../../../components/question-authoring';
import { TeachingClassroom } from '../../../components/teaching-classroom';
import { toClassroomSessionDto,toExplanationDto,toKnowledgePointDto,toLessonReviewDto,toLessonVersionDto } from '../../../lib/server/dto';
import { modelConnection } from '../../../lib/server/model-connection';
import { requireSession } from '../../../lib/server/service';
import { readWorkbenchKnowledge,readWorkbenchQuestions } from '../../../lib/server/workbench-data';

export const dynamic = 'force-dynamic';

/**
 * 课程与证据包（LESSON-01 / LESSON-02）。
 *
 * 只有已确认计划的准入知识点能进入证据包；草案须经本地用户审核后才能发布，
 * 来源之后失效不会改写已发布课程，而是让课堂入口与生成入口按准入受阻。
 */
export default function LessonsPage(): ReactNode {
  const session = requireSession();
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
  const activeSession = session.store.getOpenClassroomSession(projectId);
  const statementRevisions = session.store.listProjectStatementRevisions(projectId);

  /** 已发布版本 → 已挂接的课件文档（场景编号取自文档本身，不从讲解卡反推）。 */
  const classroomDocuments = versions
    .filter((version) => version.status === 'published')
    .map((version) => {
      const link = session.store.getLessonClassroomLink(version.lessonId, projectId);
      if (!link || link.status !== 'published' || link.lessonVersion !== version.version || !link.stageId) return null;
      const stored = session.store.getClassroomDocument(projectId, link.stageId);
      const sceneIds = stored
        ? ((stored.document as { scenes?: Array<{ id?: string }> }).scenes ?? [])
          .map((scene) => String(scene?.id ?? ''))
          .filter((sceneId) => sceneId.length > 0)
        : [];
      return {
        lessonId: version.lessonId,
        lessonVersion: version.version,
        stageId: link.stageId,
        documentDigest: link.documentDigest ?? '',
        sceneIds,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  const documentOf = (lessonId: string, lessonVersion: number): (typeof classroomDocuments)[number] | null =>
    classroomDocuments.find((item) => item.lessonId === lessonId && item.lessonVersion === lessonVersion) ?? null;

  // 教学工作面只挂在已发布版本上：卡片、播放与课堂都引用这一份证据包。
  const teaching = versions
    .filter((version) => version.status === 'published')
    .map((version) => {
      const bundle = session.store.getEvidenceBundle(projectId, version.bundleId);
      return {
        lesson: version,
        statements: bundle?.bundle.statements ?? [],
        cards: session.store.listExplanationCards(version.lessonId, version.version, projectId).map(toExplanationDto),
        document: documentOf(version.lessonId, version.version),
      };
    });
  const classroomLessons = versions
    .filter((version) => version.status === 'published'
      || (version.lessonId === activeSession?.lessonId && version.version === activeSession.lessonVersion))
    .map((version) => {
      const attached = documentOf(version.lessonId, version.version);
      const sceneIds = attached && attached.sceneIds.length > 0
        ? attached.sceneIds
        : [...new Set(session.store.listExplanationCards(version.lessonId, version.version, projectId).map((card) => card.sceneId))];
      return {
        lessonId: version.lessonId, version: version.version, title: version.title,
        stageId: attached?.stageId ?? null,
        sceneIds: sceneIds.length > 0 ? sceneIds : ['scene-1'],
      };
    });

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

      <QuestionAuthoring projectId={projectId} generation={session.generation} knowledge={knowledge} />
      <LessonWorkbench
        projectId={projectId}
        generation={session.generation}
        bundles={bundles}
        lessons={lessons}
        versions={versions}
        reviews={reviews}
        knowledge={knowledge}
        questions={questions}
        documents={classroomDocuments}
        statementRevisions={statementRevisions}
        modelConfigured={modelConnection.status().configured}
      />

      <LessonDraftGeneration
        projectId={projectId}
        generation={session.generation}
        bundles={bundles}
        publishedLessons={versions.filter((version) => version.status === 'published')}
        configured={modelConnection.status().configured}
      />

      {teaching.map((item) => (
        <LessonTeaching
          key={`${item.lesson.lessonId}-v${item.lesson.version}`}
          projectId={projectId}
          generation={session.generation}
          lesson={item.lesson}
          statements={item.statements}
          cards={item.cards}
          sceneIds={item.document?.sceneIds ?? []}
        />
      ))}
      <TeachingClassroom
        key={activeSession?.sessionId ?? 'classroom-prepare'}
        projectId={projectId}
        generation={session.generation}
        lessons={classroomLessons}
        activeSession={activeSession ? toClassroomSessionDto(activeSession) : null}
      />
    </div>
  );
}
