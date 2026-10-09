import Link from 'next/link';
import type { ReactNode } from 'react';
import { LessonDraftGeneration } from '../../../components/lesson-draft-generation';
import { GenerationPipelinePanel } from '../../../components/generation-pipeline-panel';
import { LessonTeaching } from '../../../components/lesson-teaching';
import { LessonWorkbench } from '../../../components/lesson-workbench';
import { QuestionAuthoring } from '../../../components/question-authoring';
import { TeachingClassroom } from '../../../components/teaching-classroom';
import {
  toClassroomSessionDto,
  toExplanationDto,
  toKnowledgePointDto,
  toLessonReviewDto,
  toLessonVersionDto,
} from '../../../lib/server/dto';
import { readFormalInteractionDefinitions } from '../../../lib/server/formal-interaction-definition-store';
import { formalInteractionSceneId, pblProjectSceneId } from '@sew/study-domain';
import { readPblDefinition } from '../../../lib/server/pbl-definition-store';
import { modelConnection } from '../../../lib/server/model-connection';
import { requireSession } from '../../../lib/server/service';
import { readWorkbenchKnowledge, readWorkbenchQuestions } from '../../../lib/server/workbench-data';

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
  const versions = lessons.flatMap((lesson) =>
    session.store.listLessonVersions(lesson.lessonId, projectId).map(toLessonVersionDto),
  );
  const reviews = versions
    .map((version) => session.store.getLessonReview(version.lessonId, version.version, projectId))
    .filter((review): review is NonNullable<typeof review> => review !== null)
    .map(toLessonReviewDto);
  const confirmedPlan = session.store.getConfirmedPlan(projectId);
  const activeSession = session.store.getOpenClassroomSession(projectId);
  const statementRevisions = session.store.listProjectStatementRevisions(projectId);
  const scenePlans = session.store.listProjectScenePlans(projectId);
  const coursewareCandidates = session.store.listProjectCoursewareCandidates(projectId);
  const scenePlanPatchCandidates = session.store.listProjectScenePlanPatchCandidates(projectId);
  /** 持久编辑草稿（OMA-024）：按课程 + 版本取用，跨端口/重启恢复。 */
  const scenePlanDrafts = versions
    .map((version) => session.store.getScenePlanDraft(projectId, version.lessonId, version.version))
    .filter((draft): draft is NonNullable<typeof draft> => draft !== null);

  /** 每个课程版本已审核的正式互动定义 → 场景编号；默认计划据此与冻结定义一一对应。 */
  const reviewedInteractions = new Map<string, Array<{ sceneId: string; title: string }>>();
  for (const version of versions) {
    const frozen = readFormalInteractionDefinitions(session, version.lessonId, version.version);
    reviewedInteractions.set(
      `${version.lessonId}:${version.version}`,
      (frozen?.frozen.definitions ?? []).map((definition) => ({
        sceneId: formalInteractionSceneId(definition.id),
        title: definition.title,
      })),
    );
  }
  /** Only locally frozen definitions can be selected by the scene-plan editor. */
  const reviewedPbl = new Map<string, Array<{ sceneId: string; title: string }>>();
  for (const version of versions) {
    const frozen = readPblDefinition(session, version.lessonId, version.version);
    reviewedPbl.set(
      `${version.lessonId}:${version.version}`,
      frozen
        ? [
            {
              sceneId: pblProjectSceneId(frozen.frozen.definition.id),
              title: frozen.frozen.definition.title,
            },
          ]
        : [],
    );
  }

  /** 已发布版本 → 已挂接的课件文档（场景编号取自文档本身，不从讲解卡反推）。 */
  const classroomDocuments = versions
    .filter((version) => version.status === 'published')
    .map((version) => {
      const link = session.store.getLessonClassroomLink(version.lessonId, projectId);
      if (
        !link ||
        link.status !== 'published' ||
        link.lessonVersion !== version.version ||
        !link.stageId
      )
        return null;
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
  const documentOf = (
    lessonId: string,
    lessonVersion: number,
  ): (typeof classroomDocuments)[number] | null =>
    classroomDocuments.find(
      (item) => item.lessonId === lessonId && item.lessonVersion === lessonVersion,
    ) ?? null;

  // 教学工作面只挂在已发布版本上：卡片、播放与课堂都引用这一份证据包。
  const teaching = versions
    .filter((version) => version.status === 'published')
    .map((version) => {
      const bundle = session.store.getEvidenceBundle(projectId, version.bundleId);
      return {
        lesson: version,
        statements: bundle?.bundle.statements ?? [],
        cards: session.store
          .listExplanationCards(version.lessonId, version.version, projectId)
          .map(toExplanationDto),
        document: documentOf(version.lessonId, version.version),
      };
    });
  const classroomLessons = versions
    .filter(
      (version) =>
        version.status === 'published' ||
        (version.lessonId === activeSession?.lessonId &&
          version.version === activeSession.lessonVersion),
    )
    .map((version) => {
      const attached = documentOf(version.lessonId, version.version);
      const sceneIds =
        attached && attached.sceneIds.length > 0
          ? attached.sceneIds
          : [
              ...new Set(
                session.store
                  .listExplanationCards(version.lessonId, version.version, projectId)
                  .map((card) => card.sceneId),
              ),
            ];
      return {
        lessonId: version.lessonId,
        version: version.version,
        title: version.title,
        stageId: attached?.stageId ?? null,
        sceneIds: sceneIds.length > 0 ? sceneIds : ['scene-1'],
      };
    });

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>互动课堂</h1>
          <p>
            选择已发布的课程开始学习，或按备考计划准备一节新课。
            {confirmedPlan
              ? '学习计划已确认，可以准备课程。'
              : '还没有确认学习计划，请先完成知识点核对与计划确认。'}
          </p>
        </div>
        <div className="actions">
          <Link className="btn" href="/workbench/plan">
            回到备考计划
          </Link>
          <Link className="btn" href="/workbench/knowledge">
            查看已确认知识
          </Link>
        </div>
      </div>

      <TeachingClassroom
        key={activeSession?.sessionId ?? 'classroom-prepare'}
        projectId={projectId}
        generation={session.generation}
        lessons={classroomLessons}
        activeSession={activeSession ? toClassroomSessionDto(activeSession) : null}
      />
      <div className="workflow-guide">
        <h2>{classroomLessons.length > 0 ? '准备下一节课' : '准备你的第一节课'}</h2>
        <ol>
          <li>
            <Link href="/workbench/materials">导入教材或讲义</Link>，
            <Link href="/workbench/review">核对知识点与原文</Link>。
          </li>
          <li>
            <Link href="/workbench/plan">确认备考计划</Link>，在下面选择这节课要讲的知识点。
          </li>
          <li>生成课程后检查内容，审核并发布，再进入课堂。</li>
        </ol>
        <p>
          <Link href="/classroom/lesson-demo-monotonicity-1">先体验演示课 →</Link>{' '}
          <span className="muted">示例内容不计入备考进度。</span>
        </p>
      </div>
      <details className="advanced-tools" open={confirmedPlan !== null && bundles.length === 0}>
        <summary>选择课程内容、检查并发布课程</summary>
        <p className="secondary">
          先选择知识点并保存课程依据（证据包），再生成课程；课程版本的审核与发布也在这里操作。
        </p>
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
          scenePlans={scenePlans}
          coursewareCandidates={coursewareCandidates}
          scenePlanPatchCandidates={scenePlanPatchCandidates}
          scenePlanDrafts={scenePlanDrafts}
          reviewedInteractions={reviewedInteractions}
          reviewedPbl={reviewedPbl}
          learnerUid={session.learnerUid}
          modelConfigured={modelConnection.status().configured}
        />
      </details>
      <details
        className="advanced-tools"
        open={bundles.length > 0 && classroomLessons.length === 0}
      >
        <summary>生成课程与课件</summary>
        <GenerationPipelinePanel
          projectId={projectId}
          generation={session.generation}
          bundles={bundles}
        />
      </details>
      <details className="advanced-tools">
        <summary>高级备课：手动出题、讲解卡与逐步修订</summary>
        <QuestionAuthoring
          projectId={projectId}
          generation={session.generation}
          knowledge={knowledge}
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
      </details>
    </div>
  );
}
