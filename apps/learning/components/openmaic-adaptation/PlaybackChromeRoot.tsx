'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Action, InteractiveContent, QuizContent, Scene, SlideContent } from '@openmaic/dsl';
import type { PlaybackEngine } from './playback-engine';
import { PlaybackEngine as OpenMaicPlaybackEngine } from './playback-engine';
import { createM0ActionExecutor, createM0AudioPlayer } from './playback-adapters';
import type { EngineMode } from './playback-types';

type ClassroomScene = Scene<Action, SlideContent | QuizContent | InteractiveContent>;

/**
 * M0 playback chrome adapted from OpenMAIC's PlaybackChromeRoot. The upstream
 * engine remains responsible for timing, state changes, cursor advancement,
 * completion and teardown; controls here only expose those lifecycle actions.
 */
export function PlaybackChromeRoot({
  scenes,
  currentScene,
  currentSceneIndex,
  onPrevious,
  onNext,
  children,
}: {
  scenes: readonly ClassroomScene[];
  currentScene: ClassroomScene;
  currentSceneIndex: number;
  onPrevious: () => void;
  onNext: () => void;
  children: ReactNode;
}) {
  const [mode, setMode] = useState<EngineMode>('idle');
  const [completion, setCompletion] = useState(false);
  const engineRef = useRef<PlaybackEngine | null>(null);
  const media = useMemo(() => createM0AudioPlayer(), []);
  const actions = useMemo(() => createM0ActionExecutor(), []);

  useEffect(() => {
    setCompletion(false);
    const engine = new OpenMaicPlaybackEngine([currentScene], actions, media, {
      onModeChange: setMode,
      onComplete: () => setCompletion(true),
    });
    engineRef.current = engine;
    return () => {
      engine.stop();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, [actions, currentScene, media]);

  const startOrResume = (): void => {
    setCompletion(false);
    if (mode === 'paused') engineRef.current?.resume();
    else engineRef.current?.start();
  };
  const pause = (): void => engineRef.current?.pause();

  return (
    <section className="openmaic-stage" data-testid="openmaic-stage" data-scene-id={currentScene.id}>
      <header className="openmaic-playback-controls">
        <div>
          <strong>{currentScene.title}</strong>
          <span className="muted">场景 {currentSceneIndex + 1} / {scenes.length}</span>
        </div>
        <div className="top-actions">
          <button type="button" className="btn" disabled={currentSceneIndex === 0} onClick={onPrevious}>
            上一场景
          </button>
          {mode === 'playing' ? (
            <button type="button" className="btn" onClick={pause}>暂停时间线</button>
          ) : (
            <button type="button" className="btn" onClick={startOrResume}>播放场景时间线</button>
          )}
          <button type="button" className="btn" disabled={currentSceneIndex >= scenes.length - 1} onClick={onNext}>
            下一场景
          </button>
        </div>
      </header>
      {completion ? <p className="muted" role="status" data-playback-result="complete">本场景时间线已完成。</p> : null}
      {children}
    </section>
  );
}
