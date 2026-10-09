import type { ReactNode } from 'react';
import Link from 'next/link';
import { Notice } from './ui';
import { ClassroomSurface } from './classroom-surface';
import { loadRenderableFormalDocument } from '../lib/server/classroom-service';
import type { Session } from '../lib/server/service';
import type { ClassroomSceneBinding } from '@sew/study-contracts';

/**
 * Pro 工作台直接挂载真实课堂（OMA-011）。
 *
 * 使用与课堂宿主路由**同一个** `ClassroomSurface`（真实上游 Stage/PlaybackEngine），
 * 不是预览图或缩略视图。只挂载**已发布且有课件文档**的课程版本；未就绪时给出明确指引，
 * 不降级成「先上着再说」。`lessonId` 由查询参数选择，默认取第一个已发布版本。
 */
export const ProClassroomMount = ({
  session,
  lessonId,
}: {
  session: Session;
  lessonId?: string;
}): ReactNode => {
  const published = session.store
    .listLessons(session.projectId)
    .filter((lesson) => lesson.status === 'published');
  if (published.length === 0) {
    return (
      <Notice tone="pending" role="status">
        还没有已发布课程，无法挂载真实课堂。请先在
        <Link className="btn" href="/workbench/lessons">
          课程页
        </Link>
        完成审核与发布。
      </Notice>
    );
  }
  const selected = lessonId
    ? published.find((lesson) => lesson.lessonId === lessonId)
    : published[0];
  if (!selected) {
    return (
      <Notice tone="pending" role="status">
        指定的课程不是已发布版本，无法挂载真实课堂。
      </Notice>
    );
  }

  let formal: ReturnType<typeof loadRenderableFormalDocument>;
  try {
    formal = loadRenderableFormalDocument(session, selected.lessonId);
  } catch {
    return (
      <Notice tone="pending" role="status">
        该课程版本的来源、审核或课件指纹未通过复核，Pro 工作台不会按旧内容挂载课堂。
      </Notice>
    );
  }
  if (!formal) {
    return (
      <Notice tone="pending" role="status">
        课程已发布，但还没有生成课件文档（stage/scenes）。到
        <Link className="btn" href="/workbench/lessons">
          课程页
        </Link>
        对同一版本执行「生成课件文档」后再挂载。
      </Notice>
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
  const state = session.store.readClassroomState(session.projectId, formal.stageId);
  const initialSceneId =
    state?.currentSceneId && formal.scenes.some((scene) => scene.sceneId === state.currentSceneId)
      ? state.currentSceneId
      : (formal.scenes[0]?.sceneId ?? '');

  return (
    <div>
      <div className="row-inline" style={{ flexWrap: 'wrap', gap: 'var(--sew-space-2)' }}>
        {published.map((lesson) => (
          <Link
            key={lesson.lessonId}
            className={`btn${lesson.lessonId === selected.lessonId ? ' btn-primary' : ''}`}
            href={`/workbench/pro?lesson=${encodeURIComponent(lesson.lessonId)}`}
            data-pro-classroom-option={lesson.lessonId}
          >
            {lesson.title} · v{lesson.version}
          </Link>
        ))}
      </div>
      <ClassroomSurface
        key={`${session.projectId}:${session.generation}:${formal.stageId}:${formal.digest}`}
        lessonId={selected.lessonId}
        projectId={session.projectId}
        generation={session.generation}
        stageId={formal.stageId}
        bindings={bindings}
        initialSceneId={initialSceneId}
        recordScope="formal"
        lessonTitle={`${selected.title} · v${formal.lessonVersion}`}
        teacher={{ lessonVersion: formal.lessonVersion, stageId: formal.stageId }}
      />
    </div>
  );
};
