import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFixedLessonDocument } from '../apps/learning/lib/classroom/reviewed-lesson';
import { runClassroomLoad } from '../apps/learning/components/openmaic-adaptation/classroom-load-lifecycle';
import { PlaybackEngine } from '../apps/learning/components/openmaic-adaptation/playback-engine';
import { createM0ActionExecutor, createM0AudioPlayer } from '../apps/learning/components/openmaic-adaptation/playback-adapters';

describe('OpenMAIC M0 classroom adaptation', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps distinct authoritative-load outcomes and discards stale completions', async () => {
    const document = { id: 'reviewed-stage' };
    const applyDocument = vi.fn();
    await expect(runClassroomLoad({ isCurrent: () => true, loadFromAuthoritativeStore: async () => document, applyDocument }))
      .resolves.toEqual({ outcome: 'ready', document });
    expect(applyDocument).toHaveBeenCalledWith(document);
    await expect(runClassroomLoad({ isCurrent: () => true, loadFromAuthoritativeStore: async () => undefined, applyDocument }))
      .resolves.toEqual({ outcome: 'absent' });
    await expect(runClassroomLoad({ isCurrent: () => true, loadFromAuthoritativeStore: async () => { throw new Error('offline'); }, applyDocument }))
      .resolves.toMatchObject({ outcome: 'unavailable' });
    const staleApply = vi.fn();
    await expect(runClassroomLoad({ isCurrent: () => false, loadFromAuthoritativeStore: async () => document, applyDocument: staleApply }))
      .resolves.toEqual({ outcome: 'cancelled' });
    expect(staleApply).not.toHaveBeenCalled();
  });

  it('plays only the selected real DSL scene through the upstream cursor and completion lifecycle', () => {
    vi.useFakeTimers();
    const quizScene = buildFixedLessonDocument().scenes.find((scene) => scene.type === 'quiz');
    if (!quizScene) throw new Error('fixed reviewed lesson has no quiz scene');
    const onSceneChange = vi.fn();
    const onComplete = vi.fn();
    const engine = new PlaybackEngine([quizScene], createM0ActionExecutor(), createM0AudioPlayer(), {
      onSceneChange,
      onComplete,
    });

    engine.start();
    expect(engine.getMode()).toBe('playing');
    expect(onSceneChange).toHaveBeenCalledOnce();
    expect(onSceneChange).toHaveBeenCalledWith(quizScene.id);
    vi.advanceTimersByTime(1_999);
    expect(onComplete).not.toHaveBeenCalled();
    engine.pause();
    expect(engine.getMode()).toBe('paused');
    vi.advanceTimersByTime(3_000);
    expect(onComplete).not.toHaveBeenCalled();
    engine.resume();
    vi.advanceTimersByTime(1_000);
    expect(engine.getMode()).toBe('idle');
    expect(onComplete).toHaveBeenCalledOnce();
    engine.stop();
    expect(engine.getMode()).toBe('idle');
  });
});
