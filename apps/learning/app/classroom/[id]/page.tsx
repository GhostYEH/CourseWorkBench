import { Notice } from '../../../components/ui';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { isStudyError } from '@sew/study-contracts';
import { ClassroomSurface } from '../../../components/classroom-surface';
import { ClassroomDemoSetup } from '../../../components/classroom-demo-setup';
import { bootstrapFromEnvironment, getSession } from '../../../lib/server/service';
import { loadRenderableDocument, reviewedLesson } from '../../../lib/server/classroom-service';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * 课堂宿主路由。
 *
 * 服务端仅读取并复验已明确导入的演示课件；页面读取不登记审核或写入知识。
 * 课堂文档在此按固定材料与来源侧表准入；客户端 `ClassroomSurface` 只经
 * HttpDocumentStore 读取 SQLite 权威文档，并挂载 OpenMAIC Stage/播放适配子图。
 * 教师、白板和 AI 同学继续由独立能力项接入。
 */
export default async function ClassroomPage({ params }: PageProps): Promise<ReactNode> {
  const { id } = await params;
  const session = getSession() ?? bootstrapFromEnvironment();
  if (!session) redirect('/no-project');
  if (id !== reviewedLesson.lessonId) redirect('/workbench/study');
  let document: ReturnType<typeof loadRenderableDocument>;
  try {
    document = loadRenderableDocument(session, reviewedLesson.stageId);
  } catch (error) {
    const code = isStudyError(error) ? error.code : 'INTERNAL';
    return (
      <div className="classroom">
        <header className="shell-top">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true">堂</span>
            学习空间
          </span>
        </header>
        <div className="classroom-stage">
          <Notice tone="pending" role="status">
            课堂未就绪：课件的来源与审核未通过准入（{code}）。
            请先完成材料导入与知识点审核，课堂不会用未核实内容授课。
          </Notice>
        </div>
      </div>
    );
  }
  if (!document) {
    return <div className="classroom-stage"><ClassroomDemoSetup projectId={session.projectId} generation={session.generation} /></div>;
  }
  const sources = session.store.listClassroomSceneSources(session.projectId, document.stageId);
  const bindings = reviewedLesson.document.scenes.map((scene) => ({
    ...sources.get(scene.id)!,
    sceneType: scene.type,
  }));
  const state = session.store.readClassroomState(session.projectId, document.stageId);

  return (
    <ClassroomSurface
      key={`${session.projectId}:${session.generation}:${document.stageId}`}
      lessonId={id}
      projectId={session.projectId}
      generation={session.generation}
      stageId={document.stageId}
      bindings={bindings}
      initialSceneId={state?.currentSceneId ?? bindings[0]?.sceneId ?? ''}
    />
  );
}
