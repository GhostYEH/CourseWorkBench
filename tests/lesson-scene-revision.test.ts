import { describe, expect, it } from 'vitest';
import {
  defaultRevisionTitle,
  hasLessonRevisionChanges,
} from '../apps/learning/components/lesson-scene-revision-state';

describe('逐场景改写的有效改动', () => {
  const lessonTitle = '函数单调性';
  const defaultTitle = defaultRevisionTitle(lessonTitle);
  const changed = (baseline: string[], selected: string[], title = defaultTitle): boolean =>
    hasLessonRevisionChanges(lessonTitle, baseline, title, selected);

  it('默认标题和未改变的选择不构成改动，候选包中额外场景不影响判断', () => {
    // 候选包 A/B、基线 A：未勾选的 B 不属于新草案内容。
    expect(changed(['A'], ['A'])).toBe(false);
    expect(changed(['A', 'B'], ['A', 'B'])).toBe(false);
  });

  it('新增、删除和等数量替换均按稳定 ID 判定为改动', () => {
    expect(changed(['A'], ['A', 'B'])).toBe(true);
    expect(changed(['A', 'B'], ['A'])).toBe(true);
    expect(changed(['A'], ['B'])).toBe(true);
  });

  it('取消勾选再恢复原选择不算改动，顺序不影响判断', () => {
    expect(changed(['A', 'B'], ['B', 'A'])).toBe(false);
    expect(changed(['A'], ['A'])).toBe(false);
  });

  it('单独编辑为新的标题算改动，前后空白、自动标题和原标题不算', () => {
    expect(changed(['A'], ['A'], '函数单调性的应用')).toBe(true);
    expect(changed(['A'], ['A'], `  ${defaultTitle}  `)).toBe(false);
    expect(changed(['A'], ['A'], `  ${lessonTitle}  `)).toBe(false);
  });

  it('保留默认标题后缀和 120 字符上限', () => {
    expect(defaultTitle).toBe('函数单调性（改写）');
    expect(defaultRevisionTitle('甲'.repeat(119))).toBe(`${'甲'.repeat(119)}（`);
  });
});
