import { Notice } from '../../../components/ui';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { StudyError, isStudyError, type ClassroomSceneBinding, type ClassroomRoomDto } from '@sew/study-contracts';
import { ClassroomSurface } from '../../../components/classroom-surface';
import { ClassroomDemoSetup } from '../../../components/classroom-demo-setup';
import { bootstrapFromEnvironment, getSession } from '../../../lib/server/service';
import {
  loadRenderableDocument,
  loadRenderableFormalDocument,
  reviewedLesson,
} from '../../../lib/server/classroom-service';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ room?: string }>;
}

const shell = (children: ReactNode): ReactNode => (
  <div className="classroom">
    <header className="shell-top">
      <span className="brand">
        <span className="brand-mark" aria-hidden="true">堂</span>
        学习空间
      </span>
    </header>
    <div className="classroom-stage">{children}</div>
  </div>
);

/**
 * 课堂宿主路由。
 *
 * 两类入口共用同一个真实渲染面：登记的演示课件按仓库内登记的指纹与来源准入读取；
 * 正式课时按**已发布版本的课堂映射**读取课件文档，课件文本来自该版本冻结的证据包。
 * 页面读取不登记审核、不写入知识，也不把未发布或未审核的课程降级成可上内容。
 */
export default async function ClassroomPage({ params, searchParams }: PageProps): Promise<ReactNode> {
  const { id } = await params;
  const session = getSession() ?? bootstrapFromEnvironment();
  if (!session) redirect('/no-project');

  const blocked = (code: string, message: string): ReactNode => shell(
    <Notice tone="pending" role="status">
      课堂未就绪：课件的来源与审核未通过准入（{code}）。{message}
      课堂不会用未核实内容授课。
      <Link className="btn" href="/workbench/lessons">回到课程页</Link>
    </Notice>,
  );

  if (id === reviewedLesson.lessonId) {
    let document: ReturnType<typeof loadRenderableDocument>;
    try {
      document = loadRenderableDocument(session, reviewedLesson.stageId);
    } catch (error) {
      return blocked(isStudyError(error) ? error.code : 'INTERNAL', '演示课件需要先完成来源登记与审核导入。');
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
        recordScope="demo"
        lessonTitle="函数单调性（演示课件）"
      />
    );
  }

  // 正式课时：不存在的课程回工作台，存在但未发布/未审核由领域错误给出具体原因。
  if (session.store.listLessonVersions(id, session.projectId).length === 0) redirect('/workbench/study');
  let formal: ReturnType<typeof loadRenderableFormalDocument>;
  try {
    formal = loadRenderableFormalDocument(session, id);
  } catch (error) {
    const code = isStudyError(error) ? error.code : 'INTERNAL';
    const reason = isStudyError(error) ? String(error.details?.['reason'] ?? '') : '';
    return blocked(code, reason === 'no_published_link'
      ? '这一课还没有发布版本，或发布后被停用；请先在课程页完成审核与发布。'
      : '该课程版本的来源、审核或课件指纹未通过复核，页面不会按旧内容继续授课。');
  }
  if (!formal) {
    return shell(
      <Notice tone="pending" role="status">
        课程已发布，但还没有生成课件文档（stage/scenes）。到课程页对同一版本执行「生成课件文档」，
        再以该文档指纹发布后，课堂才会读取它。
        <Link className="btn" href="/workbench/lessons">生成课件文档</Link>
      </Notice>,
    );
  }

  const bindings: ClassroomSceneBinding[] = formal.scenes.map((scene) => ({
    sceneId: scene.sceneId,
    sceneType: scene.sceneType,
    knowledgeIds: scene.knowledgeIds,
    questionId: scene.questionId,
    reviewedBy: scene.reviewedBy,
    reviewNote: scene.reviewNote,
  }));
  let room: ClassroomRoomDto | null = null;
  try {
    const roomId = (await searchParams)?.room;
    if (roomId) {
      room = session.store.getClassroomRoom(session.projectId, roomId, session.learnerUid);
      if (!room || room.status === 'ended' || room.course.lessonId !== id || room.course.lessonVersion !== formal.lessonVersion
        || room.course.stageId !== formal.stageId || room.course.documentDigest !== formal.digest) {
        throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED');
      }
      session.store.readClassroomRoomSnapshot(session.projectId, room.roomId, session.learnerUid);
    }
  } catch (error) {
    return blocked(isStudyError(error) ? error.code : 'INTERNAL', '该课堂已结束，或冻结版本与当前可用课程不一致。请核对课堂记录后重新进入。');
  }
  const state = session.store.readClassroomState(session.projectId, formal.stageId);
  return (
    <ClassroomSurface
      key={`${session.projectId}:${session.generation}:${formal.stageId}:${formal.digest}`}
      lessonId={id}
      projectId={session.projectId}
      generation={session.generation}
      stageId={formal.stageId}
      bindings={bindings}
      initialSceneId={room?.currentSceneId ?? (state?.currentSceneId && formal.scenes.some((scene) => scene.sceneId === state.currentSceneId)
        ? state.currentSceneId
        : formal.scenes[0]?.sceneId ?? '')}
      recordScope="formal"
      lessonTitle={`${session.store.getLessonVersion(id, formal.lessonVersion, session.projectId)?.title ?? '正式课时'} · v${formal.lessonVersion}`}
      teacher={{ lessonVersion: formal.lessonVersion, stageId: formal.stageId, ...(room ? { roomId: room.roomId } : {}) }}
    />
  );
}
