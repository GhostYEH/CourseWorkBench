import type { ModelConnectionStatus } from '@sew/study-contracts';
import { describeApiError } from './client';

export interface ModelStatusSnapshot {
  status: ModelConnectionStatus | null;
  error: string | null;
  refreshing: boolean;
}

export const emptyModelStatus: ModelStatusSnapshot = {
  status: null,
  error: null,
  refreshing: false,
};

/** Shared read-only connection status. A changed session revokes cached and late results. */
export const createModelStatusStore = (deps: {
  token: () => string | null;
  read: (signal: AbortSignal) => Promise<ModelConnectionStatus>;
  subscribeChanges: (listener: () => void) => () => void;
}) => {
  let snapshot = emptyModelStatus;
  let session: string | null = null;
  let revision = 0;
  let controller: AbortController | null = null;
  let pending: Promise<ModelConnectionStatus | undefined> | null = null;
  let unsubscribeEvents: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const update = (next: ModelStatusSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const refresh = (force = false): Promise<ModelConnectionStatus | undefined> => {
    const token = deps.token();
    if (token !== session) {
      revision += 1;
      controller?.abort();
      controller = null;
      pending = null;
      session = token;
      update(emptyModelStatus);
    }
    if (!token) return Promise.resolve(undefined);
    if (pending && !force) return pending;
    controller?.abort();
    const epoch = ++revision;
    const abort = new AbortController();
    controller = abort;
    update({ ...snapshot, error: null, refreshing: true });
    const current = () => epoch === revision && !abort.signal.aborted && deps.token() === token;
    const request = Promise.resolve()
      .then(() => {
        if (!current()) return undefined;
        return deps.read(abort.signal);
      })
      .then((value) => {
        if (!current() || value === undefined) return undefined;
        update({ status: value, error: null, refreshing: true });
        return value;
      })
      .catch((caught) => {
        if (!current()) return undefined;
        update({ ...snapshot, error: describeApiError(caught), refreshing: true });
        throw caught;
      })
      .finally(() => {
        if (epoch !== revision) return;
        pending = null;
        controller = null;
        update({ ...snapshot, refreshing: false });
      });
    pending = request;
    return request;
  };
  const changed = () => {
    void refresh(true).catch(() => undefined);
  };
  return {
    getSnapshot: () => (deps.token() === session ? snapshot : emptyModelStatus),
    refresh,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        unsubscribeEvents = deps.subscribeChanges(changed);
        changed();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size !== 0) return;
        unsubscribeEvents?.();
        unsubscribeEvents = null;
        revision += 1;
        controller?.abort();
        controller = null;
        pending = null;
        snapshot = { ...snapshot, refreshing: false };
      };
    },
  };
};
