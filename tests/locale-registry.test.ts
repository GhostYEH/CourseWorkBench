import { describe, expect, it } from 'vitest';
import {
  LOCALE_IDS,
  LOCALE_META,
  DEFAULT_LOCALE,
  inferLocale,
  localeDirection,
  matchLocale,
  parseAcceptLanguage,
  preferencesSchema,
} from '@sew/study-contracts';
import { DEFAULT_PREFERENCES } from '../apps/learning/lib/preferences';

/**
 * OMA-081：12 个 locale 注册表、语言推断与界面/课程语言设置。
 *
 * 固定：① 12 个 locale 全部注册且自带书写方向；② 语言标签按完整→中文脚本→语言族唯一候选匹配；
 * ③ `Accept-Language` 按 q 值排序后推断；④ 推断不出回退默认；⑤ 偏好 schema 接受并默认两个语言字段。
 */
describe('OMA-081 国际化 locale 注册与语言推断', () => {
  it('注册基线要求的 12 个 locale 且每个都有方向与自称', () => {
    expect(LOCALE_IDS).toHaveLength(12);
    for (const id of LOCALE_IDS) {
      expect(LOCALE_META[id].nativeName.length).toBeGreaterThan(0);
      expect(['ltr', 'rtl']).toContain(LOCALE_META[id].direction);
    }
    expect(localeDirection('ar-SA')).toBe('rtl');
    expect(localeDirection('zh-CN')).toBe('ltr');
  });

  it('匹配完整标签、中文脚本与语言族唯一候选', () => {
    expect(matchLocale('en-US')).toBe('en-US');
    expect(matchLocale('zh-Hant-TW')).toBe('zh-TW');
    expect(matchLocale('zh-Hans')).toBe('zh-CN');
    expect(matchLocale('zh')).toBe('zh-CN');
    expect(matchLocale('en')).toBe('en-US');
    expect(matchLocale('pt')).toBe('pt-BR');
    expect(matchLocale('de-DE')).toBe('de-DE');
    expect(matchLocale('xx-YY')).toBeNull();
  });

  it('推断有序候选并在全部落空时回退默认', () => {
    expect(inferLocale(['xx', 'ja-JP', 'en-US'])).toBe('ja-JP');
    expect(inferLocale([])).toBe(DEFAULT_LOCALE);
    expect(inferLocale(['not-a-locale'])).toBe(DEFAULT_LOCALE);
  });

  it('解析 Accept-Language 时按 q 值排序并回退默认', () => {
    expect(parseAcceptLanguage('en-US;q=0.3, ja-JP;q=0.9, fr;q=0.5')).toBe('ja-JP');
    expect(parseAcceptLanguage('de-DE, en-US;q=0.8')).toBe('de-DE');
    expect(parseAcceptLanguage('')).toBe(DEFAULT_LOCALE);
    expect(parseAcceptLanguage(null)).toBe(DEFAULT_LOCALE);
    // 全部 q=0 视为无可用偏好。
    expect(parseAcceptLanguage('en-US;q=0')).toBe(DEFAULT_LOCALE);
  });

  it('偏好 schema 接受并默认界面/课程语言字段', () => {
    const parsed = preferencesSchema.parse(DEFAULT_PREFERENCES);
    expect(parsed.uiLocale).toBe('zh-CN');
    expect(parsed.courseLocale).toBe('zh-CN');
    expect(preferencesSchema.parse({ ...DEFAULT_PREFERENCES, uiLocale: 'ar-SA', courseLocale: 'de-DE' }))
      .toMatchObject({ uiLocale: 'ar-SA', courseLocale: 'de-DE' });
    // 未注册的 locale 被拒绝。
    expect(preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, uiLocale: 'xx-YY' }).success).toBe(false);
  });
});
