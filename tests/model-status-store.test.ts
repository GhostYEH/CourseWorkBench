import { describe, expect, it, vi } from 'vitest';
import type { ModelConnectionStatus } from '@sew/study-contracts';
import { createModelStatusStore, emptyModelStatus } from '../apps/learning/lib/model-status-store';

const status: ModelConnectionStatus = { configured: false, persisted: false, lastTest: null };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const fixture = (read: (signal: AbortSignal) => Promise<ModelConnectionStatus>) => {
  let token: string | null = 'session-a';
  let changed: (() => void) | undefined;
  const stop = vi.fn();
  const store = createModelStatusStore({
    token: () => token,
    read,
    subscribeChanges: (listener) => {
      changed = listener;
      return stop;
    },
  });
  return {
    store,
    stop,
    setToken: (value: string | null) => {
      token = value;
    },
    change: () => changed?.(),
  };
};

describe('shared model status lifecycle', () => {
  it('keeps initial failures visible and clears them only when retry succeeds', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('local service unavailable'))
      .mockResolvedValue(status);
    const { store } = fixture(read);
    await expect(store.refresh()).rejects.toThrow('local service unavailable');
    expect(store.getSnapshot()).toMatchObject({
      status: null,
      error: expect.stringContaining('local service unavailable'),
      refreshing: false,
    });
    await store.refresh(true);
    expect(store.getSnapshot()).toEqual({ status, error: null, refreshing: false });
  });

  it('shares concurrent consumers and cancels only after the final unsubscribe', async () => {
    const result = deferred<ModelConnectionStatus>();
    let signal: AbortSignal | undefined;
    const read = vi.fn(async (value: AbortSignal) => {
      signal = value;
      return result.promise;
    });
    const { store, stop } = fixture(read);
    const leaveFirst = store.subscribe(vi.fn());
    const leaveSecond = store.subscribe(vi.fn());
    const pending = store.refresh();
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    leaveFirst();
    expect(signal?.aborted).toBe(false);
    leaveSecond();
    expect(signal?.aborted).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    result.resolve(status);
    await pending;
    expect(store.getSnapshot().status).toBeNull();
  });

  it('discards a late response after token rotation even when read ignores Abort', async () => {
    const old = deferred<ModelConnectionStatus>();
    const replacement = { ...status, configured: true, model: 'new-model' };
    const read = vi
      .fn()
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValue(replacement);
    const { store, setToken } = fixture(read);
    const previous = store.refresh();
    await Promise.resolve();
    setToken('session-b');
    expect(store.getSnapshot()).toBe(emptyModelStatus);
    await store.refresh();
    old.resolve({ ...status, configured: true, model: 'old-model' });
    await previous;
    expect(store.getSnapshot()).toEqual({ status: replacement, error: null, refreshing: false });
  });

  it('invalidates a cached status on sign-out and never reads without a session', async () => {
    const read = vi.fn().mockResolvedValue(status);
    const { store, setToken } = fixture(read);
    await store.refresh();
    setToken(null);
    expect(store.getSnapshot()).toBe(emptyModelStatus);
    await store.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe(emptyModelStatus);
  });

  it('refreshes on configuration events and preserves the last status with a visible error', async () => {
    const read = vi.fn().mockResolvedValueOnce(status).mockRejectedValue(new Error('retry failed'));
    const { store, change } = fixture(read);
    const leave = store.subscribe(vi.fn());
    await store.refresh();
    change();
    await expect(store.refresh()).rejects.toThrow('retry failed');
    expect(store.getSnapshot()).toMatchObject({
      status,
      error: expect.stringContaining('retry failed'),
      refreshing: false,
    });
    leave();
  });
});
