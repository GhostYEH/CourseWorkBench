import { RICH_TEXT_TAGS } from '@sew/study-contracts';

export const escapePlanText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

// Decode only within text tokens, then escape again. Encoded tags never become markup.
const decodeTextEntities = (value: string): string =>
  value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, key: string) => {
    if (!key.startsWith('#')) return entities[key.toLowerCase()] ?? entity;
    const point =
      key[1]?.toLowerCase() === 'x'
        ? Number.parseInt(key.slice(2), 16)
        : Number.parseInt(key.slice(1), 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point)
      : '\ufffd';
  });

/** Reconstruct attribute-free inline tags; every other token is displayed as text. */
export const renderPlanRichText = (value: string): string => {
  const stack: string[] = [];
  let html = '';
  for (const token of value.match(/<[^>]*>|[^<]+|</g) ?? []) {
    const match = /^<(\/?)([a-z]+)\s*(\/?)>$/i.exec(token);
    const tag = match?.[2]?.toLowerCase();
    if (!match || !tag || !(RICH_TEXT_TAGS as readonly string[]).includes(tag)) {
      html += escapePlanText(decodeTextEntities(token)).replace(/\r?\n/g, '<br>');
    } else if (tag === 'br' && !match[1]) {
      html += '<br>';
    } else if (!match[1] && !match[3]) {
      html += `<${tag}>`;
      stack.push(tag);
    } else if (match[1] && !match[3] && stack.at(-1) === tag) {
      stack.pop();
      html += `</${tag}>`;
    } else {
      html += escapePlanText(token);
    }
  }
  return (
    html +
    stack
      .reverse()
      .map((tag) => `</${tag}>`)
      .join('')
  );
};
