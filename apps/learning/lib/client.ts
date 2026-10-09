'use client';

/**
 * 渲染层 API 客户端与视图状态。
 *
 * 持久记录以本地服务的 SQLite 为准，浏览器缓存只作非权威缓存
 * （应用 origin 端口会变化，IndexedDB/localStorage 不能作为唯一恢复来源）。
 */

import { create } from 'zustand';
import { apiEnvelopeSchema, runtimeApiFailureSchema, type PreferencesDto, type ProjectScope } from '@sew/study-contracts';
import { z } from 'zod';
import { getAppearanceStyle } from './preferences';

export interface ApiErrorPayload {
  code: string;
  message: string;
  pending: boolean;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly code: string;
  readonly pending: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(payload: ApiErrorPayload) {
    super(payload.message);
    this.name = 'ApiError';
    this.code = payload.code;
    this.pending = payload.pending;
    this.details = payload.details;
  }
}

export const describeApiError = (error: unknown): string =>
  error instanceof ApiError ? `${error.code}：${error.message}` : String(error);

/** 会话凭据只保存在内存中：由 preload 在窗口建立后注入，不写入 URL 或持久存储。 */
let sessionToken: string | null = null;
const sessionTokenListeners = new Set<() => void>();

export const setSessionToken = (token: string | null): void => {
  if (sessionToken === token) return;
  sessionToken = token;
  for (const listener of sessionTokenListeners) listener();
};

export const getSessionToken = (): string | null => sessionToken;

export const subscribeSessionToken = (listener: () => void): (() => void) => {
  sessionTokenListeners.add(listener);
  return () => { sessionTokenListeners.delete(listener); };
};

export const projectScopeHeaders = (scope: ProjectScope): Record<string, string> => ({
  ...(sessionToken ? { 'x-sew-session': sessionToken } : {}),
  'x-sew-project-id': scope.projectId,
  'x-sew-generation': String(scope.generation),
});

export const waitForSessionToken = (signal?: AbortSignal): Promise<string> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return; }
  if (sessionToken) { resolve(sessionToken); return; }
  const timeout = setTimeout(() => {
    cleanup();
    reject(new Error('课堂会话凭据尚未就绪，请重试。'));
  }, 3000);
  const changed = () => {
    if (!sessionToken) return;
    const token = sessionToken;
    cleanup();
    resolve(token);
  };
  const aborted = () => {
    cleanup();
    reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
  };
  const cleanup = () => {
    clearTimeout(timeout);
    sessionTokenListeners.delete(changed);
    signal?.removeEventListener('abort', aborted);
  };
  sessionTokenListeners.add(changed);
  signal?.addEventListener('abort', aborted, { once: true });
});

export const apiFetch = async <S extends z.ZodTypeAny>(path: string, schema: S, init?: RequestInit): Promise<z.infer<S>> => {
  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json');
  if (sessionToken) headers.set('x-sew-session', sessionToken);

  const response = await fetch(path, { ...init, headers });
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    throw new ApiError({ code: 'API_RESPONSE_INVALID', message: '服务响应不是有效 JSON，请重试或查看服务日志', pending: false });
  }
  const parsed = apiEnvelopeSchema(z.unknown()).safeParse(raw);
  if (!parsed.success) {
    // RuntimeStore deliberately has its own error shape; never apply this fallback to study endpoints.
    if (!response.ok && path.startsWith('/api/maic/runtime/')) {
      const failure = runtimeApiFailureSchema.safeParse(raw);
      if (failure.success) throw new ApiError({ ...failure.data.error, pending: false });
    }
    throw new ApiError({ code: 'API_RESPONSE_INVALID', message: '服务响应与数据合同不一致，请刷新后重试', pending: false });
  }
  if (!parsed.data.ok) throw new ApiError(parsed.data.error);
  if (!response.ok) throw new ApiError({ code: 'API_HTTP_ERROR', message: `服务请求失败（HTTP ${response.status}），请重试`, pending: false });
  const result = schema.safeParse(parsed.data.data);
  if (!('data' in parsed.data) || !result.success) {
    throw new ApiError({ code: 'API_RESPONSE_INVALID', message: '服务响应与数据合同不一致，请刷新后重试', pending: false });
  }
  return result.data;
};

export interface PanelState {
  tree: boolean;
  right: boolean;
  bottom: boolean;
  rightTab: 'assistant' | 'source' | 'review';
}

interface AppState {
  panels: PanelState;
  toggleTree: () => void;
  toggleRight: () => void;
  toggleBottom: () => void;
  setRightTab: (tab: PanelState['rightTab']) => void;
}

export const useAppStore = create<AppState>((set) => ({
  panels: { tree: false, right: false, bottom: false, rightTab: 'assistant' },
  toggleTree: () => set((state) => ({ panels: { ...state.panels, tree: !state.panels.tree } })),
  toggleRight: () => set((state) => ({ panels: { ...state.panels, right: !state.panels.right } })),
  toggleBottom: () => set((state) => ({ panels: { ...state.panels, bottom: !state.panels.bottom } })),
  setRightTab: (rightTab) => set((state) => ({ panels: { ...state.panels, rightTab } })),
}));

export const applyThemeToDocument = (preferences: PreferencesDto): void => {
  const root = document.documentElement;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = preferences.theme === 'system' ? (prefersDark ? 'dark' : 'light') : preferences.theme;
  root.dataset.theme = resolved;
  root.dataset.themeChoice = preferences.theme;
  root.dataset.accent = preferences.accentPreset;
  root.dataset.density = preferences.density;
  root.dataset.reduceMotion = preferences.reduceMotion === 'on' ? 'on' : 'off';
  for (const [name, value] of Object.entries(getAppearanceStyle(preferences))) {
    root.style.setProperty(name, value);
  }
};
