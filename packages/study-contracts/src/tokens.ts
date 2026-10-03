/**
 * 设计令牌的类型合同。数值与色值的权威来源是 `docs/设计令牌.json`；
 * 渲染层通过 `scripts/generate-theme-css.mjs` 生成 CSS 变量，不在页面里散落硬编码色值。
 */

export const THEME_IDS = ['paper', 'light', 'dark'] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export type ThemeChoice = ThemeId | 'system';

export const ACCENT_PRESETS = ['cinnabar', 'teal', 'indigo'] as const;
export type AccentPreset = (typeof ACCENT_PRESETS)[number];

export interface ThemeTokens {
  surface: { app: string; sidebar: string; document: string; card: string; control: string };
  text: { primary: string; secondary: string; muted: string };
  border: { divider: string; control: string };
  action: { accent: string; accentText: string; focus: string };
  status: { verified: string; pending: string; error: string; info: string };
}

export interface DesignTokens {
  schemaVersion: number;
  defaultTheme: ThemeId;
  themeChoices: ThemeChoice[];
  themes: Record<ThemeId, ThemeTokens>;
  accentPresets: Record<AccentPreset, Record<ThemeId, { accent: string; text: string }>>;
  geometryPx: {
    defaultWindow: { width: number; height: number };
    minimumWindow: { width: number; height: number };
    titleBarHeight: number;
    activityBarWidth: number;
    projectTree: { default: number; min: number; max: number };
    documentTabHeight: number;
    rightPanel: { default: number; min: number; max: number };
    rightToolRailWidth: number;
    bottomPanel: { collapsed: number; expandedDefault: number };
    statusBarHeight: number;
    cardRadius: number;
    controlRadius: number;
    spacing: number[];
    wideLayoutThreshold: number;
    singleColumnThreshold: number;
  };
  appearanceDefaults: Record<string, unknown>;
  appearanceLimits: Record<string, unknown>;
  teachingDefaults: Record<string, unknown>;
  teachingLimits: Record<string, unknown>;
}

/** 状态语义色不随强调色变化；用户改强调色不能改变状态标签含义。 */
export const STATUS_TOKEN_KEYS = ['verified', 'pending', 'error', 'info'] as const;
export type StatusTokenKey = (typeof STATUS_TOKEN_KEYS)[number];
