'use client';

/**
 * 渲染层 API 客户端与视图状态。
 *
 * 持久记录以本地服务的 SQLite 为准，浏览器缓存只作非权威缓存
 * （应用 origin 端口会变化，IndexedDB/localStorage 不能作为唯一恢复来源）。
 */

import { create } from 'zustand';
import type { ApiEnvelope, PreferencesDto } from '@sew/study-contracts';
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

export const setSessionToken = (token: string | null): void => {
  sessionToken = token;
};

export const getSessionToken = (): string | null => sessionToken;

export const apiFetch = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json');
  if (sessionToken) headers.set('x-sew-session', sessionToken);

  const response = await fetch(path, { ...init, headers });
  const payload = (await response.json()) as ApiEnvelope<T>;

  if (!payload.ok) throw new ApiError(payload.error);
  return payload.data;
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
  panels: { tree: true, right: true, bottom: false, rightTab: 'assistant' },
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
