import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFixedLessonDocument } from '../apps/learning/lib/classroom/reviewed-lesson';
import { runClassroomLoad } from '../apps/learning/components/openmaic-adaptation/classroom-load-lifecycle';
import { createClassroomLifecycle } from '../apps/learning/components/openmaic-adaptation/host-lifecycle';
import { loadOpenMaicClassroom, resolveOpenMaicClassroomView, type OpenMaicHostLoadResult } from '../apps/learning/components/openmaic-adaptation/classroom-host-load';
import { PlaybackEngine } from '../apps/learning/components/openmaic-adaptation/playback-engine';
import { createM0ActionExecutor, createM0AudioPlayer } from '../apps/learning/components/openmaic-adaptation/playback-adapters';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function hostPresentation() {
  const state = { notFound: false, unavailable: false, error: null as string | null, loading: true };
  return {
    state,
    setters: {
      setNotFound: (value: boolean) => { state.notFound = value; },
      setLoadUnavailable: (value: boolean) => { state.unavailable = value; },
      setError: (value: string | null) => { state.error = value; },
      setLoading: (value: boolean) => { state.loading = value; },
    },
  };
}

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

  it.each(['success', 'failure'] as const)('discards a delayed document %s after another classroom takes ownership', async (outcome) => {
    const lifecycle = createClassroomLifecycle();
    const first = lifecycle.claim();
    const read = deferred<{ id: string }>();
    const applyDocument = vi.fn();
    const loading = runClassroomLoad({
      isCurrent: first.isCurrent,
      loadFromAuthoritativeStore: () => read.promise,
      applyDocument,
    });
    const second = lifecycle.claim();
    if (outcome === 'success') read.resolve({ id: 'old-course' });
    else read.reject(new Error('old-course offline'));
    await expect(loading).resolves.toEqual({ outcome: 'cancelled' });
    expect(applyDocument).not.toHaveBeenCalled();
    expect(second.isCurrent()).toBe(true);
  });

  it.each(['success', 'failure'] as const)('does not apply a delayed position %s to a newly loaded classroom', async (outcome) => {
    const lifecycle = createClassroomLifecycle();
    const lease = lifecycle.claim();
    const write = deferred<string>();
    let visible = 'new-course';
    const pending = (async () => {
      try {
        const savedSceneId = await write.promise;
        lease.applyIfCurrent(() => { visible = savedSceneId; });
      } catch {
        lease.applyIfCurrent(() => { visible = 'old-course save failed'; });
      }
    })();
    lifecycle.claim();
    if (outcome === 'success') write.resolve('old-course scene');
    else write.reject(new Error('old generation rejected'));
    await pending;
    expect(visible).toBe('new-course');
  });

  it('rechecks ownership after asynchronous asset cleanup before exposing an old load error', async () => {
    const lifecycle = createClassroomLifecycle();
    const lease = lifecycle.claim();
    const cleanup = deferred<void>();
    const cleanupStarted = deferred<void>();
    const showError = vi.fn();
    const pending = (async () => {
      const result = await runClassroomLoad({
        isCurrent: lease.isCurrent,
        loadFromAuthoritativeStore: async () => { throw new Error('asset unavailable'); },
        applyDocument: vi.fn(),
      });
      if (result.outcome !== 'unavailable') throw new Error('expected an active failed load');
      cleanupStarted.resolve();
      await cleanup.promise;
      lease.applyIfCurrent(() => showError(result.error));
    })();
    await cleanupStarted.promise;
    lease.cancel();
    const successor = lifecycle.claim();
    cleanup.resolve();
    await pending;
    expect(showError).not.toHaveBeenCalled();
    expect(successor.isCurrent()).toBe(true);
  });

  it('keeps late cleanup and independent hosts from cancelling the current classroom', () => {
    const lifecycle = createClassroomLifecycle();
    const old = lifecycle.claim();
    const current = lifecycle.claim();
    old.cancel();
    const unrelated = createClassroomLifecycle().claim();
    expect(current.applyIfCurrent(() => {})).toBe(true);
    expect(unrelated.isCurrent()).toBe(true);
    current.cancel();
    expect(current.applyIfCurrent(() => { throw new Error('cancelled commit'); })).toBe(false);
    expect(unrelated.isCurrent()).toBe(true);
  });

  it('adopts the original page host absent/error/ready outcome branches with a defensive classroom fence', async () => {
    const cases: Array<{ result: OpenMaicHostLoadResult; outcome: string; notFound: boolean; unavailable: boolean }> = [
      { result: { outcome: 'ready', classroomId: 'current' }, outcome: 'loaded', notFound: false, unavailable: false },
      { result: { outcome: 'ready', classroomId: 'other' }, outcome: 'failed', notFound: false, unavailable: true },
      { result: { outcome: 'absent' }, outcome: 'absent', notFound: true, unavailable: false },
      { result: { outcome: 'unavailable' }, outcome: 'failed', notFound: false, unavailable: true },
      { result: { outcome: 'failed', error: '来源已失效' }, outcome: 'failed', notFound: false, unavailable: false },
    ];
    for (const testCase of cases) {
      const presentation = hostPresentation();
      const outcome = await loadOpenMaicClassroom({
        classroomId: 'current',
        isCurrent: () => true,
        loadDocumentAndAssets: async () => testCase.result,
        ...presentation.setters,
      });
      expect(outcome).toBe(testCase.outcome);
      expect(presentation.state.notFound).toBe(testCase.notFound);
      expect(presentation.state.unavailable).toBe(testCase.unavailable);
      expect(presentation.state.loading).toBe(false);
      if (testCase.result.outcome === 'failed') expect(presentation.state.error).toBe('来源已失效');
    }
  });

  it.each(['ready', 'absent', 'unavailable', 'failed', 'exception'] as const)('does not mutate a successor host for stale %s completion', async (outcome) => {
    const lifecycle = createClassroomLifecycle();
    const lease = lifecycle.claim();
    const load = deferred<OpenMaicHostLoadResult>();
    const presentation = hostPresentation();
    const pending = loadOpenMaicClassroom({
      classroomId: 'old',
      isCurrent: lease.isCurrent,
      loadDocumentAndAssets: () => load.promise,
      ...presentation.setters,
    });
    lifecycle.claim();
    if (outcome === 'exception') load.reject(new Error('old exception'));
    else if (outcome === 'ready') load.resolve({ outcome, classroomId: 'old' });
    else if (outcome === 'failed') load.resolve({ outcome, error: 'old failure' });
    else load.resolve({ outcome });
    await expect(pending).resolves.toBe('cancelled');
    expect(presentation.state).toEqual({ notFound: false, unavailable: false, error: null, loading: true });
  });

  it('allows a fresh manual retry after an unavailable load without claiming positive absence', async () => {
    const lifecycle = createClassroomLifecycle();
    const first = lifecycle.claim();
    const presentation = hostPresentation();
    await expect(loadOpenMaicClassroom({
      classroomId: 'current', isCurrent: first.isCurrent,
      loadDocumentAndAssets: async () => ({ outcome: 'unavailable' }), ...presentation.setters,
    })).resolves.toBe('failed');
    expect(presentation.state.notFound).toBe(false);
    const retry = lifecycle.claim();
    // The copied retryClassroom clears presentation before starting the new port.
    presentation.setters.setError(null);
    presentation.setters.setNotFound(false);
    presentation.setters.setLoadUnavailable(false);
    presentation.setters.setLoading(true);
    await expect(loadOpenMaicClassroom({
      classroomId: 'current', isCurrent: retry.isCurrent,
      loadDocumentAndAssets: async () => ({ outcome: 'ready', classroomId: 'current' }), ...presentation.setters,
    })).resolves.toBe('loaded');
    expect(presentation.state).toEqual({ notFound: false, unavailable: false, error: null, loading: false });
  });

  it('turns an active port exception into a retryable error without exposing raw paths', async () => {
    const presentation = hostPresentation();
    await expect(loadOpenMaicClassroom({
      classroomId: 'current', isCurrent: () => true,
      loadDocumentAndAssets: async () => { throw new Error('C:/private/owner/database.sqlite unavailable'); },
      ...presentation.setters,
    })).resolves.toBe('failed');
    expect(presentation.state.notFound).toBe(false);
    expect(presentation.state.error).not.toContain('C:/private');
    expect(presentation.state.loading).toBe(false);
  });

  it('fences Stage before effects run on a project switch without obscuring terminal errors', () => {
    const previous = { loading: false, error: null, notFound: false, loadedIdentity: 'project-a:1:stage', identity: 'project-b:2:stage' };
    expect(resolveOpenMaicClassroomView(previous)).toBe('loading');
    expect(resolveOpenMaicClassroomView({ ...previous, notFound: true })).toBe('not-found');
    expect(resolveOpenMaicClassroomView({ ...previous, error: 'retriable' })).toBe('error');
    expect(resolveOpenMaicClassroomView({ ...previous, loadedIdentity: previous.identity })).toBe('stage');
    expect(resolveOpenMaicClassroomView({ ...previous, loadedIdentity: previous.identity, loading: true })).toBe('loading');
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
