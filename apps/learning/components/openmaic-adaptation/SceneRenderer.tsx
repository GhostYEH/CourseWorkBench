'use client';

import { SlideCanvas } from '@openmaic/renderer';
import type { Action, InteractiveContent, PBLContent, QuizContent, Scene, SlideContent } from '@openmaic/dsl';
import type { ClassroomSceneBinding } from '@sew/study-contracts';
import { QuizSceneView } from './QuizSceneView';
import { InteractiveSceneView } from './InteractiveSceneView';
import { FormalPblSceneView } from './FormalPblSceneView';

export type ClassroomScene = Scene<Action, SlideContent | QuizContent | InteractiveContent | (PBLContent & { definitionId?: string; statementIds?: string[] })>;

/**
 * 上游 SlideCanvas 的 effects 只认画布里真实存在的元素：线型元素没有可框住的矩形，
 * 改用按几何定位的聚光；文档里找不到该元素时不高亮，绝不凭客户端字段凭空指对象。
 */
const slideEffects = (scene: ClassroomScene, elementId: string | null) => {
  if (!elementId || scene.type !== 'slide' || scene.content.type !== 'slide') return undefined;
  const element = scene.content.canvas.elements.find((item) => item.id === elementId);
  if (!element) return undefined;
  return element.type === 'line' ? { spotlight: { elementId } } : { highlights: [{ elementId }] };
};

/** Adapted from OpenMAIC's components/stage/scene-renderer.tsx discriminant dispatcher. */
export function SceneRenderer({
  scene,
  bindings,
  scope,
  focusElementId = null,
}: {
  scene: ClassroomScene;
  bindings: ClassroomSceneBinding[];
  scope: { projectId: string; generation: number };
  focusElementId?: string | null;
}) {
  const binding = bindings.find((item) => item.sceneId === scene.id);
  switch (scene.type) {
    case 'slide':
      return scene.content.type === 'slide' ? (
        <div className="card" data-scene="slide" data-scene-id={scene.id}>
          <h2>{scene.title}</h2>
          <div style={{ width: '100%', aspectRatio: '16 / 9', background: 'var(--sew-surface-document)' }}>
            <SlideCanvas slide={scene.content.canvas} effects={slideEffects(scene, focusElementId)} />
          </div>
          <p className="muted">本页的来源与审核记录见右侧。</p>
        </div>
      ) : <p role="alert">幻灯片场景结构无效。</p>;
    case 'quiz':
      return scene.content.type === 'quiz' ? (
        <QuizSceneView
          key={`${scope.projectId}:${scope.generation}:${scene.stageId}:${scene.id}:${binding?.questionId ?? ''}`}
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
    case 'pbl':
      return scene.content.type === 'pbl'
        ? <FormalPblSceneView key={`${scope.projectId}:${scope.generation}:${scene.stageId}:${scene.id}:${scene.content.definitionId ?? ''}`} sceneId={scene.id} stageId={scene.stageId} content={scene.content} scope={scope} />
        : <p role="alert">PBL 场景结构无效。</p>;
    default:
      return <p role="status">未知场景类型暂不能播放。</p>;
  }
}
