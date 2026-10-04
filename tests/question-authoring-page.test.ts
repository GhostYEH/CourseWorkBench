import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { QuestionAuthoring } from '../apps/learning/components/question-authoring';
import { readMultipleAnswer, writeMultipleAnswer, quizResultFeedback, hasQuizAnswer, selectSceneAttempt } from '../apps/learning/lib/quiz-answer';

const require = createRequire(new URL('../apps/learning/package.json', import.meta.url));
const { createElement } = require('react') as { createElement: (type: unknown, props: unknown, ...children: unknown[]) => unknown };
const { renderToStaticMarkup } = require('react-dom/server') as { renderToStaticMarkup: (node: unknown) => string };
const { AppRouterContext } = require('next/dist/shared/lib/app-router-context.shared-runtime') as { AppRouterContext: { Provider: unknown } };
const render = (knowledge: Array<{ knowledgeId: string; name: string; admitted: boolean }>) => renderToStaticMarkup(createElement(
  AppRouterContext.Provider, { value: { refresh: () => {} } },
  createElement(QuestionAuthoring, { projectId: 'project-test', generation: 1, knowledge }),
));

describe('题目录入与本人测验界面合同', () => {
  it('没有准入知识点时阻止保存，解释后续人工审核步骤', () => {
    const html = render([{ knowledgeId: 'unapproved', name: '待核知识', admitted: false }]);
    expect(html).toContain('当前不能保存题目');
    expect(html).toContain('<fieldset disabled=""');
    expect(html).not.toContain('data-knowledge-id="unapproved"');
    expect(html).toContain('对课程版本进行人工审核后才能正式上课');
  });

  it('只给准入知识点选择项，提供三种题型与显式新编来源', () => {
    const html = render([
      { knowledgeId: 'admitted', name: '已审核定义', admitted: true },
      { knowledgeId: 'unapproved', name: '待核定义', admitted: false },
    ]);
    expect(html).toContain('data-knowledge-id="admitted"');
    expect(html).not.toContain('data-knowledge-id="unapproved"');
    expect(html).toContain('value="multiple"');
    expect(html).toContain('value="short_answer"');
    expect(html).toContain('出处类别：新编');
    expect(html).toContain('id="qa-rubric"');
    expect(html).toContain('保存新编题与评分规则');
  });

  it('多选草稿重启恢复保留选项集合且提交统一排序去重', () => {
    expect(readMultipleAnswer('["C","A"]', ['A', 'B', 'C'])).toEqual(['A', 'C']);
    expect(writeMultipleAnswer(['C', 'A', 'C'])).toBe('["A","C"]');
    expect(readMultipleAnswer('', ['A'])).toEqual([]);
    for (const text of ['broken', '["A","A"]', '["unknown"]', '[true]', '{}']) {
      expect(() => readMultipleAnswer(text, ['A', 'B'])).toThrow('无法恢复');
    }
  });

  it('待判分和未知判分绝不显示正确或零分', () => {
    expect(quizResultFeedback({ status: 'pending_review', correct: null, earned: null })).toBe('作答已保存：待判分，尚未更新掌握。');
    expect(quizResultFeedback({ correct: null, earned: null })).toContain('判分结果待确认');
    expect(quizResultFeedback({ correct: null, earned: null })).not.toContain('得分');
    expect(quizResultFeedback({ correct: false, earned: 0 })).toContain('错误，得分 0');
  });
  it('空作答不能提交，损坏或未知选项不得作为已作答继续提交', () => {
    expect(hasQuizAnswer('multiple', '[]', ['A'])).toBe(false);
    expect(hasQuizAnswer('multiple', '', ['A'])).toBe(false);
    expect(hasQuizAnswer('short_answer', '  ', [])).toBe(false);
    expect(hasQuizAnswer('single', 'unknown', ['A'])).toBe(false);
    expect(hasQuizAnswer('multiple', '["A"]', ['A'])).toBe(true);
    expect(() => hasQuizAnswer('multiple', '["unknown"]', ['A'])).toThrow('无法恢复');
  });
  it('A场景草稿不会被B场景选为会话，B新建空会话优先于B旧完成记录', () => {
    const attempt = (id: string, createdAt: string, status: string, sceneIds: string[]) => ({
      session: { id, createdAt, status }, records: sceneIds.map((sceneId, seq) => ({ sceneId, seq })),
    });
    const a = attempt('base-A', '2026-10-04T00:03:00Z', 'active', ['A']);
    const bCompleted = attempt('base-B', '2026-10-04T00:01:00Z', 'completed', ['B']);
    const bEmpty = attempt('base-B:retry:1', '2026-10-04T00:02:00Z', 'active', []);
    expect(selectSceneAttempt([a], 'B', 'base-B')).toBeUndefined();
    expect(selectSceneAttempt([a, bCompleted, bEmpty], 'B', 'base-B')).toBe(bEmpty);
    expect(selectSceneAttempt([attempt('base-A', '2026-10-04T00:03:00Z', 'active', [])], 'B', 'base-B')).toBeUndefined();
    expect(selectSceneAttempt([attempt('base-B:retry:1:foreign', '2026-10-04T00:03:00Z', 'active', [])], 'B', 'base-B')).toBeUndefined();
    expect(() => selectSceneAttempt([attempt('base-B', '2026-10-04T00:03:00Z', 'active', ['A', 'B'])], 'B', 'base-B')).toThrow('其他场景');
  });
});
