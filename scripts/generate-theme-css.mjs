#!/usr/bin/env node
/**
 * 由 docs/设计令牌.json 生成渲染层 CSS 变量。
 *
 * 设计令牌是唯一权威来源；页面里不允许散落硬编码色值。
 * 用法：pnpm gen:theme
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tokenFile = join(root, 'docs', '设计令牌.json');
const outFile = join(root, 'apps', 'learning', 'app', 'theme-tokens.css');

const tokens = JSON.parse(readFileSync(tokenFile, 'utf8'));

const flatten = (prefix, value, lines) => {
  for (const [key, inner] of Object.entries(value)) {
    const name = prefix ? `${prefix}-${key}` : key;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      flatten(name, inner, lines);
    } else {
      lines.push(`  --sew-${name}: ${inner};`);
    }
  }
};

const lines = [
  '/* 由 scripts/generate-theme-css.mjs 从 docs/设计令牌.json 生成，请勿手工编辑。 */',
  '',
  ':root {',
];

// 几何与间距：与主题无关。
const geo = tokens.geometryPx;
lines.push(`  --sew-titlebar-height: ${geo.titleBarHeight}px;`);
lines.push(`  --sew-activitybar-width: ${geo.activityBarWidth}px;`);
lines.push(`  --sew-tree-width: ${geo.projectTree.default}px;`);
lines.push(`  --sew-tree-min: ${geo.projectTree.min}px;`);
lines.push(`  --sew-tree-max: ${geo.projectTree.max}px;`);
lines.push(`  --sew-tab-height: ${geo.documentTabHeight}px;`);
lines.push(`  --sew-right-width: ${geo.rightPanel.default}px;`);
lines.push(`  --sew-right-min: ${geo.rightPanel.min}px;`);
lines.push(`  --sew-right-max: ${geo.rightPanel.max}px;`);
lines.push(`  --sew-rail-width: ${geo.rightToolRailWidth}px;`);
lines.push(`  --sew-bottom-collapsed: ${geo.bottomPanel.collapsed}px;`);
lines.push(`  --sew-bottom-expanded: ${geo.bottomPanel.expandedDefault}px;`);
lines.push(`  --sew-statusbar-height: ${geo.statusBarHeight}px;`);
lines.push(`  --sew-card-radius: ${geo.cardRadius}px;`);
lines.push(`  --sew-control-radius: ${geo.controlRadius}px;`);
geo.spacing.forEach((value, index) => lines.push(`  --sew-space-${index + 1}: ${value}px;`));
lines.push(`  --sew-wide-threshold: ${geo.wideLayoutThreshold}px;`);
lines.push(`  --sew-single-column: ${geo.singleColumnThreshold}px;`);
lines.push('');

// 阅读排版：由外观设置覆盖。
const appearance = tokens.appearanceDefaults;
lines.push(`  --sew-ui-font-size: 14px;`);
lines.push(`  --sew-reading-font-size: ${appearance.readingFontSizePx}px;`);
lines.push(`  --sew-reading-line-height: ${appearance.readingLineHeight};`);
lines.push(`  --sew-reading-max-width: ${appearance.readingMaxWidthPx}px;`);
lines.push(`  --sew-reading-padding: 32px;`);
lines.push(`  --sew-zoom: ${appearance.zoom};`);
lines.push('}');
lines.push('');

// 三套主题 + 三套强调色预设。
for (const [themeId, theme] of Object.entries(tokens.themes)) {
  const selector = themeId === tokens.defaultTheme ? `:root, [data-theme='${themeId}']` : `[data-theme='${themeId}']`;
  const themeLines = [];
  flatten('', theme, themeLines);
  lines.push(`${selector} {`);
  lines.push(`  color-scheme: ${themeId === 'dark' ? 'dark' : 'light'};`);
  lines.push(...themeLines.map((line) => `  ${line}`));
  lines.push('}');
  lines.push('');
}

for (const [presetId, perTheme] of Object.entries(tokens.accentPresets)) {
  for (const [themeId, colors] of Object.entries(perTheme)) {
    const selector =
      themeId === tokens.defaultTheme
        ? `:root[data-accent='${presetId}'], [data-theme='${themeId}'][data-accent='${presetId}']`
        : `[data-theme='${themeId}'][data-accent='${presetId}']`;
    lines.push(`${selector} {`);
    lines.push(`  --sew-action-accent: ${colors.accent};`);
    lines.push(`  --sew-action-accentText: ${colors.text};`);
    lines.push(`  --sew-action-focus: ${colors.accent};`);
    lines.push('}');
    lines.push('');
  }
}

// 系统主题跟随：仅在用户选择 system 时生效。
lines.push(`[data-theme-choice='system'] {`);
lines.push('  /* 由渲染层在运行时解析为 light / dark，避免 CSS 与主进程判断不一致。 */');
lines.push('}');
lines.push('');

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${lines.join('\n')}`, 'utf8');
console.log(`已生成 ${outFile}`);
