import { describe, expect, it } from 'vitest';
import { renderPlanRichText } from '../apps/learning/lib/classroom/plan-rich-text';
import {
  coursewareOutputSchema,
  scenePlanSaveSchema,
  SCENE_PLAN_WRITE_LIMIT,
} from '@sew/study-contracts';
import { FORMAL_SCENE_LIMIT } from '../apps/learning/lib/classroom/formal-lesson-document';
import { initialLessonPlanScenes } from '../apps/learning/components/lesson-scene-plan-state';

describe('计划正文的安全富文本', () => {
  it('保留嵌套行内样式与换行，中文比较式保持文本', () => {
    expect(renderPlanRichText('<b>中文 <i>x</i></b>\n1 < 2 & 3 > 2<br/>')).toBe(
      '<b>中文 <i>x</i></b><br>1 &lt; 2 &amp; 3 &gt; 2<br>',
    );
  });
  it('文本实体只解码一次，编码的标签与事件不能变成 markup', () => {
    expect(
      renderPlanRichText(
        '&lt;script&gt;alert(1)&lt;/script&gt; &#60;img onerror=x&#62; &amp;lt;b&amp;gt;',
      ),
    ).toBe('&lt;script&gt;alert(1)&lt;/script&gt; &lt;img onerror=x&gt; &amp;lt;b&amp;gt;');
    expect(renderPlanRichText('<b>&amp;&#x1f600;&nbsp;</b>')).toBe('<b>&amp;😀\u00a0</b>');
  });
  it.each([
    '<script>alert(1)</script>',
    '<span onclick="x">文本</span>',
    '<b style="color:red">正文</b>',
    '<img src=x onerror=x>',
    '<svg/onload=x>',
    '<!--<b>-->',
    '<b\nonclick=x>',
  ])('未知标签、属性与畸形 markup 不获得执行能力：%s', (input) => {
    const result = renderPlanRichText(input);
    expect(result).not.toMatch(/<(?:script|img|svg)\b|<\w+\s+[^>]*=/i);
    expect(result).toContain('&lt;');
  });
  it('未闭合标签自动平衡，错序闭合与自闭合非 br 标签显示为文本', () => {
    expect(renderPlanRichText('<b><i>正文</b>')).toBe('<b><i>正文&lt;/b&gt;</i></b>');
    expect(renderPlanRichText('<span/><br></br>')).toBe('&lt;span/&gt;<br>&lt;/br&gt;');
  });
  it('新保存与模型生成上限和正式课件一致，超过上限不会作为成功输入', () => {
    expect(SCENE_PLAN_WRITE_LIMIT).toBe(FORMAL_SCENE_LIMIT);
    const scene = {
      sceneId: 'scene_test',
      kind: 'slide',
      title: '标题',
      statementId: 'stmt_test',
      questionId: null,
      knowledgeIds: ['kp_test'],
      elements: [],
      note: '',
    };
    const save = {
      scope: { projectId: 'proj_test', generation: 1 },
      action: 'save-scene-plan',
      requestId: 'request_test',
      lessonId: 'lesson_test',
      version: 1,
      baseRevision: 0,
      scenes: Array.from({ length: 25 }, (_, index) => ({ ...scene, sceneId: `scene_${index}` })),
    };
    expect(scenePlanSaveSchema.safeParse(save).success).toBe(false);
    expect(
      coursewareOutputSchema.safeParse({
        scenes: save.scenes.map(({ kind, title, statementId, questionId }) => ({
          kind,
          title,
          statementId,
          questionId,
        })),
      }).success,
    ).toBe(false);
  });
  it('首次保存默认计划包含已选题目，排除未选题目，题目课也不会变成空计划', () => {
    const bundle = {
      statements: [{ statementId: 'stmt_a', knowledgeId: 'kp_a' }],
      questions: [
        { questionId: 'question_a', knowledgeIds: ['kp_a'] },
        { questionId: 'question_b', knowledgeIds: ['kp_b'] },
      ],
    };
    const selected = { statementIds: ['stmt_a'], questionIds: ['question_a'] };
    expect(
      initialLessonPlanScenes(bundle, selected).map(({ kind, statementId, questionId }) => ({
        kind,
        statementId,
        questionId,
      })),
    ).toEqual([
      { kind: 'slide', statementId: 'stmt_a', questionId: null },
      { kind: 'quiz', statementId: null, questionId: 'question_a' },
    ]);
    expect(
      initialLessonPlanScenes(bundle, { statementIds: [], questionIds: ['question_a'] }),
    ).toHaveLength(1);
  });
});
