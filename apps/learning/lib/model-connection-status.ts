'use client';

import { useSyncExternalStore } from 'react';
import { modelConnectionStatusSchema, type ModelConnectionStatus } from '@sew/study-contracts';
import { apiFetch, getSessionToken, subscribeSessionToken } from './client';

export const MODEL_CONNECTION_CHANGED = 'sew-model-connection-changed';
const listeners = new Set<() => void>();
let status: ModelConnectionStatus | null = null;
let revision = 0;
let controller: AbortController | null = null;
let inFlight: Promise<ModelConnectionStatus | undefined> | null = null;
const emit = () => { for (const listener of listeners) listener(); };

export const refreshModelStatus = (force = false): Promise<ModelConnectionStatus | undefined> => {
  if (inFlight && !force) return inFlight;
  controller?.abort();
  const epoch = ++revision;
  if (!getSessionToken()) {
    inFlight = null;
    status = null;
    emit();
    return Promise.resolve(undefined);
  }
  const abort = new AbortController();
  controller = abort;
  const pending = apiFetch('/api/study/models', modelConnectionStatusSchema, {
    cache: 'no-store', signal: abort.signal,
  }).then(value => {
    if (epoch !== revision || abort.signal.aborted) return undefined;
    status = value;
    emit();
    return value;
  }).finally(() => {
    if (epoch === revision) { inFlight = null; controller = null; }
  });
  inFlight = pending;
  return pending;
};

const onChange = () => { void refreshModelStatus(true).catch(() => undefined); };
let unsubscribeToken: (() => void) | null = null;
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  if (listeners.size === 1) {
    unsubscribeToken = subscribeSessionToken(onChange);
    window.addEventListener(MODEL_CONNECTION_CHANGED, onChange);
    window.addEventListener('focus', onChange);
    onChange();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    unsubscribeToken?.(); unsubscribeToken = null;
    window.removeEventListener(MODEL_CONNECTION_CHANGED, onChange);
    window.removeEventListener('focus', onChange);
    revision += 1;
    controller?.abort(); controller = null; inFlight = null;
  };
};

export const useModelStatus = () => ({
  status: useSyncExternalStore(subscribe, () => status, () => null),
  refresh: () => refreshModelStatus(true),
});
