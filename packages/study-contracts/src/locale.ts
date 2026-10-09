/**
 * 界面与课程语言的 locale 注册表（OMA-081）。
 *
 * 基线要求 12 个 locale 全部注册，且 UI 语言与课程语言可分别设置。这里只放**数据**：
 * 语言标签、书写方向与匹配优先级；翻译文本按需在界面层按 key 取用。语言推断是纯函数，
 * 供服务端（Accept-Language）与渲染层（navigator.languages）共用同一份判定。
 */

import { z } from 'zod';

export const LOCALE_IDS = [
  'zh-CN',
  'zh-TW',
  'en-US',
  'ja-JP',
  'ru-RU',
  'ar-SA',
  'pt-BR',
  'ko-KR',
  'es-MX',
  'fr-FR',
  'vi-VN',
  'de-DE',
] as const;
export type LocaleId = (typeof LOCALE_IDS)[number];

export const localeIdSchema = z.enum(LOCALE_IDS);

export interface LocaleMeta {
  /** 该 locale 的自称，用于语言选择器。 */
  nativeName: string;
  /** 书写方向；阿拉伯语为 rtl。 */
  direction: 'ltr' | 'rtl';
  /** 主语言子标签（小写），用于把 `zh-Hans` 之类映射到注册 locale。 */
  language: string;
}

export const LOCALE_META: Record<LocaleId, LocaleMeta> = {
  'zh-CN': { nativeName: '简体中文', direction: 'ltr', language: 'zh' },
  'zh-TW': { nativeName: '繁體中文', direction: 'ltr', language: 'zh' },
  'en-US': { nativeName: 'English (US)', direction: 'ltr', language: 'en' },
  'ja-JP': { nativeName: '日本語', direction: 'ltr', language: 'ja' },
  'ru-RU': { nativeName: 'Русский', direction: 'ltr', language: 'ru' },
  'ar-SA': { nativeName: 'العربية', direction: 'rtl', language: 'ar' },
  'pt-BR': { nativeName: 'Português (BR)', direction: 'ltr', language: 'pt' },
  'ko-KR': { nativeName: '한국어', direction: 'ltr', language: 'ko' },
  'es-MX': { nativeName: 'Español (MX)', direction: 'ltr', language: 'es' },
  'fr-FR': { nativeName: 'Français', direction: 'ltr', language: 'fr' },
  'vi-VN': { nativeName: 'Tiếng Việt', direction: 'ltr', language: 'vi' },
  'de-DE': { nativeName: 'Deutsch', direction: 'ltr', language: 'de' },
};

/** 默认与回退 locale：推断不出时使用，保证 UI 永远有一个合法语言。 */
export const DEFAULT_LOCALE: LocaleId = 'zh-CN';

/** 中文脚本偏好：把 `zh-Hans`/`zh-Hant` 映射到具体中文 locale。 */
const CHINESE_SCRIPT: Record<string, LocaleId> = {
  hans: 'zh-CN',
  hant: 'zh-TW',
};

const isLocaleId = (value: string): value is LocaleId =>
  (LOCALE_IDS as readonly string[]).includes(value);

/**
 * 把单个语言标签（BCP-47 片段，如 `zh-Hant-TW`、`en`、`en-GB`）解析为注册 locale。
 *
 * 匹配顺序：完整标签 → 中文脚本（hans/hant）→ 精确语言-地区 → 语言族唯一候选。
 * 无法唯一确定时返回 null，交给调用方继续尝试下一个候选或回退默认。
 */
export const matchLocale = (tag: string): LocaleId | null => {
  const parts = tag.trim().replace(/_/g, '-').split('-').filter(Boolean);
  if (parts.length === 0) return null;
  const language = parts[0]!.toLowerCase();
  const region = parts.length > 1 ? parts[parts.length - 1]!.toUpperCase() : '';
  const script = parts.length > 2 ? parts[1]!.toLowerCase() : '';
  const exact = `${language}-${region}`;
  if (isLocaleId(exact)) return exact;
  if (language === 'zh') {
    const byScript = CHINESE_SCRIPT[script];
    if (byScript) return byScript;
    // 无脚本信息时，`zh` 与 `zh-Hans` 归简体；`zh-Hant` 已在上面处理。
    return 'zh-CN';
  }
  // 语言族唯一候选：`en` → en-US、`pt` → pt-BR、`es` → es-MX、`ar` → ar-SA 等。
  const candidates = LOCALE_IDS.filter((id) => LOCALE_META[id].language === language);
  return candidates.length === 1 ? candidates[0]! : null;
};

/**
 * 从一组有序语言候选（浏览器 `navigator.languages` 或 `Accept-Language` 拆分结果）
 * 推断最合适的注册 locale；全部落空时回退 `DEFAULT_LOCALE`。
 */
export const inferLocale = (candidates: readonly string[]): LocaleId => {
  for (const candidate of candidates) {
    const matched = matchLocale(candidate);
    if (matched) return matched;
  }
  return DEFAULT_LOCALE;
};

/**
 * 解析 HTTP `Accept-Language` 头：按 q 值从高到低排序（缺省 q=1），同 q 保持出现顺序。
 * 只做语言匹配，不涉及任何内容协商的业务授权。
 */
export const parseAcceptLanguage = (header: string | null): LocaleId => {
  if (!header) return DEFAULT_LOCALE;
  const scored = header
    .split(',')
    .map((entry, index) => {
      const [tag, ...params] = entry.trim().split(';');
      const qParam = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
      const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
      return { tag: (tag ?? '').trim(), q: Number.isFinite(q) ? q : 1, index };
    })
    .filter((item) => item.tag.length > 0 && item.q > 0)
    .sort((a, b) => (b.q === a.q ? a.index - b.index : b.q - a.q));
  return inferLocale(scored.map((item) => item.tag));
};

/** 该 locale 的书写方向。 */
export const localeDirection = (locale: LocaleId): 'ltr' | 'rtl' => LOCALE_META[locale].direction;
