/**
 * 外观与教学表达的默认值。
 *
 * 数值来源是 `docs/设计令牌.json`；`scripts/generate-theme-css.mjs` 生成 CSS 变量，
 * 这里提供运行时可读写的初始对象。设置是有版本的白名单对象，不做任意 CSS/脚本注入。
 */

import type { PreferencesDto, TeachingPreferenceDto } from '@sew/study-contracts';

export const PREFERENCES_KEY = 'appearance';

/** SSR and live preview use the same whitelisted reading styles on <html>. */
export const getAppearanceStyle = (preferences: PreferencesDto) => ({
  '--sew-reading-font-size': `${preferences.readingFontSizePx}px`,
  '--sew-reading-line-height': `${preferences.readingLineHeight}`,
  '--sew-reading-max-width': `${preferences.readingMaxWidthPx}px`,
  '--sew-reading-font-family': preferences.readingFont === 'system-serif'
    ? 'Georgia, "Noto Serif SC", "Songti SC", SimSun, serif'
    : 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif',
  '--sew-zoom': `${preferences.zoom}`,
});

export const DEFAULT_PREFERENCES: PreferencesDto = {
  version: 1,
  theme: 'paper',
  accentPreset: 'cinnabar',
  uiFont: 'system-sans',
  readingFont: 'system-sans',
  readingFontSizePx: 18,
  readingLineHeight: 1.8,
  readingMaxWidthPx: 760,
  zoom: 1,
  density: 'standard',
  reduceMotion: 'system',
  panelTreeWidth: 240,
  panelRightWidth: 300,
  bottomPanelHeight: 28,
};

export const DEFAULT_TEACHING_PREFERENCE: TeachingPreferenceDto = {
  version: 1,
  learningMode: 'beginner',
  explanation: 'intuitive',
  hintDepth: 'stepwise',
  exerciseBalance: 'balanced',
  selfExplanation: true,
  everydayExamples: 'moderate',
  extraPreference: '',
};

/** 教学表达的中文标签，界面与预览共用。 */
export const TEACHING_LABELS = {
  learningMode: { beginner: '零基础', review: '复习' },
  explanation: { intuitive: '直观示例', rigorous: '逐步严谨', concise: '简洁回顾' },
  hintDepth: { light: '轻提示', stepwise: '分步引导', full: '完整解析' },
  exerciseBalance: {
    'explanation-first': '讲解优先',
    balanced: '均衡',
    'practice-first': '练习优先',
  },
  everydayExamples: { moderate: '适量', minimal: '少量' },
} as const;
