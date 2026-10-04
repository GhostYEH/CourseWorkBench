'use client';

import { SlideCanvas } from '@openmaic/renderer';
import type { Action, InteractiveContent, QuizContent, Scene, SlideContent } from '@openmaic/dsl';
import type { ClassroomSceneBinding } from '@sew/study-contracts';
import { QuizSceneView } from './QuizSceneView';
import { InteractiveSceneView } from './InteractiveSceneView';

export type ClassroomScene = Scene<Action, SlideContent | QuizContent | InteractiveContent>;

/** Adapted from OpenMAIC's components/stage/scene-renderer.tsx discriminant dispatcher. */
export function SceneRenderer({
  scene,
  bindings,
  scope,
}: {
  scene: ClassroomScene;
  bindings: ClassroomSceneBinding[];
  scope: { projectId: string; generation: number };
}) {
  const binding = bindings.find((item) => item.sceneId === scene.id);
  switch (scene.type) {
    case 'slide':
      return scene.content.type === 'slide' ? (
        <div className="card" data-scene="slide" data-scene-id={scene.id}>
          <h2>{scene.title}</h2>
          <div style={{ width: '100%', aspectRatio: '16 / 9', background: 'var(--sew-surface-document)' }}>
            <SlideCanvas slide={scene.content.canvas} />
          </div>
          <p className="muted">本页为演示课件，来源与审核记录见右侧。</p>
        </div>
      ) : <p role="alert">幻灯片场景结构无效。</p>;
    case 'quiz':
      return scene.content.type === 'quiz' ? (
        <QuizSceneView
          content={scene.content}
          sceneId={scene.id}
          stageId={scene.stageId}
          scope={scope}
          questionId={binding?.questionId ?? undefined}
          reviewedBy={binding?.reviewedBy}
        />
      ) : <p role="alert">测验场景结构无效。</p>;
    case 'interactive':
      return scene.content.type === 'interactive'
        ? <InteractiveSceneView sceneId={scene.id} stageId={scene.stageId} content={scene.content} scope={scope} />
        : <p role="alert">互动场景结构无效。</p>;
    default:
      return <p role="status">未知场景类型暂不能播放。</p>;
  }
}
