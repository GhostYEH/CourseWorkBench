import { z } from 'zod';
import { projectScopeSchema } from './project';

export const preferencesSchema = z.object({
  version: z.number().int().positive().default(1),
  theme: z.enum(['paper', 'light', 'dark', 'system']),
  accentPreset: z.enum(['cinnabar', 'teal', 'indigo']),
  uiFont: z.literal('system-sans'),
  readingFont: z.enum(['system-sans', 'system-serif']),
  readingFontSizePx: z.number().int().min(16).max(24),
  readingLineHeight: z.number().min(1.5).max(2),
  readingMaxWidthPx: z.number().int().min(640).max(920),
  zoom: z.number().min(0.8).max(1.5),
  density: z.enum(['standard', 'compact']),
  reduceMotion: z.enum(['system', 'on', 'off']),
  panelTreeWidth: z.number().int().min(180).max(360),
  panelRightWidth: z.number().int().min(260).max(440),
  bottomPanelHeight: z.number().int().min(28).max(400),
});
export type PreferencesDto = z.infer<typeof preferencesSchema>;

export const teachingPreferenceSchema = z.object({
  version: z.number().int().positive().default(1),
  learningMode: z.enum(['beginner', 'review']),
  explanation: z.enum(['intuitive', 'rigorous', 'concise']),
  hintDepth: z.enum(['light', 'stepwise', 'full']),
  exerciseBalance: z.enum(['explanation-first', 'balanced', 'practice-first']),
  selfExplanation: z.boolean(),
  everydayExamples: z.enum(['moderate', 'minimal']),
  extraPreference: z.string().max(500),
});
export type TeachingPreferenceDto = z.infer<typeof teachingPreferenceSchema>;

/**
 * 偏好写入请求（共享 schema）。
 *
 * - 外观/阅读是**用户级全局**偏好，不需要 scope；
 * - 教学表达是**项目级**事实，写入必须显式携带 scope，由服务复验打开代次，
 *   避免过期请求写进重新打开的项目。
 */
export const preferencesWriteSchema = z
  .object({
    scope: projectScopeSchema.optional(),
    appearance: preferencesSchema.optional(),
    teaching: teachingPreferenceSchema.optional(),
  })
  .refine((value) => value.appearance !== undefined || value.teaching !== undefined, {
    message: '至少需要提供 appearance 或 teaching 之一',
  })
  .refine((value) => value.teaching === undefined || value.scope !== undefined, {
    message: '教学表达属于项目，写入必须携带 scope',
  });
export type PreferencesWriteInput = z.infer<typeof preferencesWriteSchema>;
