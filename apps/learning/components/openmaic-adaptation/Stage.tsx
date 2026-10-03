'use client';

import type { ReactNode } from 'react';
import type { Action, InteractiveContent, QuizContent, Scene, SlideContent } from '@openmaic/dsl';
import { PlaybackChromeRoot } from './PlaybackChromeRoot';

type ClassroomScene = Scene<Action, SlideContent | QuizContent | InteractiveContent>;

/**
 * Adapted OpenMAIC Stage dispatcher. M0 deliberately locks the dispatcher to
 * the real playback root; editor and autonomous modes stay disabled until
 * their permissions and runtimes are implemented by this application.
 */
export function Stage({
  scenes,
  currentSceneId,
  onPrevious,
  onNext,
  children,
}: {
  scenes: readonly ClassroomScene[];
  currentSceneId: string;
  onPrevious: () => void;
  onNext: () => void;
  children: ReactNode;
}) {
  const currentSceneIndex = scenes.findIndex((scene) => scene.id === currentSceneId);
  const currentScene = scenes[currentSceneIndex];
  if (!currentScene) return <div role="status">课堂场景正在加载…</div>;
  return (
    <PlaybackChromeRoot
      scenes={scenes}
      currentScene={currentScene}
      currentSceneIndex={currentSceneIndex}
      onPrevious={onPrevious}
      onNext={onNext}
    >
      {children}
    </PlaybackChromeRoot>
  );
}
