import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import tokens from '../docs/设计令牌.json';
import channels from '../packages/study-contracts/ipc-channels.json';
import { IPC } from '@sew/study-contracts';

/**
 * 生成物与合同的同步检查。
 *
 * 设计令牌是唯一权威来源，渲染层 CSS 由脚本生成；忘记重新生成时本用例会失败。
 */

const root = join(__dirname, '..');
const css = readFileSync(join(root, 'apps', 'learning', 'app', 'theme-tokens.css'), 'utf8');

const flatten = (prefix: string, value: Record<string, unknown>, out: string[] = []): string[] => {
  for (const [key, inner] of Object.entries(value)) {
    const name = prefix ? `${prefix}-${key}` : key;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      flatten(name, inner as Record<string, unknown>, out);
    } else {
      out.push(`--sew-${name}`);
    }
  }
  return out;
};

describe('主题令牌生成物', () => {
  it('每套主题的每个令牌都出现在 CSS 中', () => {
    for (const [themeId, theme] of Object.entries(tokens.themes)) {
      const names = flatten('', theme as unknown as Record<string, unknown>);
      for (const name of names) {
        expect(css, `${themeId} 缺少 ${name}`).toContain(name);
      }
      expect(css).toContain(`[data-theme='${themeId}']`);
    }
  });

  it('三套强调色预设都有对应选择器', () => {
    for (const presetId of Object.keys(tokens.accentPresets)) {
      expect(css).toContain(`data-accent='${presetId}'`);
    }
  });

  it('几何尺寸来自设计令牌而不是页面硬编码', () => {
    expect(css).toContain(`--sew-titlebar-height: ${tokens.geometryPx.titleBarHeight}px`);
    expect(css).toContain(`--sew-activitybar-width: ${tokens.geometryPx.activityBarWidth}px`);
    expect(css).toContain(`--sew-statusbar-height: ${tokens.geometryPx.statusBarHeight}px`);
  });
});

describe('IPC 通道名单', () => {
  it('合同导出与 JSON 完全一致（主进程与渲染层共用同一份）', () => {
    expect(IPC).toEqual(channels);
  });

  it('通道名统一使用 sew: 前缀，避免与上游通道冲突', () => {
    for (const value of Object.values(channels)) {
      expect(value.startsWith('sew:')).toBe(true);
    }
  });
});
