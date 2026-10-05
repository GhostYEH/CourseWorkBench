'use client';

import { useSyncExternalStore } from 'react';
import { modelConnectionStatusSchema } from '@sew/study-contracts';
import { apiFetch, getSessionToken, subscribeSessionToken } from './client';
import { createModelStatusStore, emptyModelStatus } from './model-status-store';

export const MODEL_CONNECTION_CHANGED = 'sew-model-connection-changed';
const modelStatus = createModelStatusStore({
  token: getSessionToken,
  read: (signal) =>
    apiFetch('/api/study/models', modelConnectionStatusSchema, { cache: 'no-store', signal }),
  subscribeChanges: (listener) => {
    const unsubscribeToken = subscribeSessionToken(listener);
    window.addEventListener(MODEL_CONNECTION_CHANGED, listener);
    window.addEventListener('focus', listener);
    return () => {
      unsubscribeToken();
      window.removeEventListener(MODEL_CONNECTION_CHANGED, listener);
      window.removeEventListener('focus', listener);
    };
  },
});

export const refreshModelStatus = modelStatus.refresh;

export const useModelStatus = () => ({
  ...useSyncExternalStore(modelStatus.subscribe, modelStatus.getSnapshot, () => emptyModelStatus),
  refresh: () => refreshModelStatus(true),
});
