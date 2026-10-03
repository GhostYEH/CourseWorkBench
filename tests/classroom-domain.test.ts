import { describe, expect, it } from 'vitest';
import { StudyError } from '@sew/study-contracts';
import {
  assertSceneSourceBindings,
  canonicalJson,
  classroomDocumentDigest,
  dslVersionState,
  stripQuizAnswers,
  type SceneSourceBinding,
} from '@sew/study-domain';

/** 课堂文档的纯判断（无 IO），真实 DSL 合同行为在 classroom-document-store 用例里覆盖。 */

const quizDocument = {
  stage: { id: 'stg', name: 'n', createdAt: 1, updatedAt: 1 },
  scenes: [
    {
      id: 'sc-quiz',
      stageId: 'stg',
      title: 't',
      order: 0,
      type: 'quiz',
      content: {
        type: 'quiz',
        questions: [{ id: 'q1', type: 'single', question: '?', options: [{ label: 'A', value: 'A' }], answer: ['A'], analysis: '因为' }],
      },
    },
    {
      id: 'sc-slide',
      stageId: 'stg',
      title: 's',
      order: 1,
      type: 'slide',
      content: { type: 'slide', canvas: { id: 'p', viewportSize: 1000, viewportRatio: 0.5625, theme: { backgroundColor: '#fff', themeColors: ['#000'], fontColor: '#000', fontName: 'x' }, elements: [] } },
    },
  ],
};

describe('课堂文档纯判断', () => {
  it('稳定序列化只看内容不看键序', () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalJson({ b: { d: 3, c: 2 }, a: 1 }));
    expect(classroomDocumentDigest(quizDocument)).toBe(classroomDocumentDigest(structuredClone(quizDocument)));
    expect(() => canonicalJson({ a: undefined })).toThrow(StudyError);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(StudyError);
  });

  it('去答案只影响测验判分依据，其余场景原样保留', () => {
    const stripped = stripQuizAnswers(quizDocument);
    const text = JSON.stringify(stripped.document);
    expect(text).not.toContain('"answer"');
    expect(text).not.toContain('"analysis"');
    expect(text).toContain('"question"');
    expect(text).toContain('"options"');
    expect(stripped.stripped).toEqual([{ sceneId: 'sc-quiz', questionIds: ['q1'] }]);
    const slide = (stripped.document as { scenes: Array<Record<string, unknown>> }).scenes.find(
      (scene) => scene['id'] === 'sc-slide',
    );
    expect(slide).toBeTruthy();
  });

  it('缺失来源绑定的场景不能进入教学', () => {
    const bindings = new Map<string, SceneSourceBinding>([
      ['sc-quiz', { sceneId: 'sc-quiz', knowledgeIds: ['k1'], questionId: 'q1', reviewedBy: 'r', reviewNote: '' }],
      ['sc-slide', { sceneId: 'sc-slide', knowledgeIds: [], questionId: null, reviewedBy: 'r', reviewNote: '' }],
    ]);
    try {
      assertSceneSourceBindings(['sc-quiz', 'sc-slide', 'sc-ghost'], bindings);
      throw new Error('应当抛出 CLASSROOM_SCENE_SOURCE_MISSING');
    } catch (error) {
      expect((error as StudyError).code).toBe('CLASSROOM_SCENE_SOURCE_MISSING');
      expect((error as StudyError).details).toMatchObject({ sceneIds: ['sc-slide', 'sc-ghost'] });
    }
    expect(() =>
      assertSceneSourceBindings(['sc-quiz'], new Map([['sc-quiz', bindings.get('sc-quiz')!]])),
    ).not.toThrow();
  });

  it('DSL 版本判定把未来版本与无版本区分开', () => {
    expect(dslVersionState(undefined, '0.3.0')).toBe('unversioned');
    expect(dslVersionState('0.3.0', '0.3.0')).toBe('current');
    expect(dslVersionState('0.2.9', '0.3.0')).toBe('legacy');
    expect(dslVersionState('0.3.1', '0.3.0')).toBe('future');
    expect(dslVersionState('1.0', '0.3.0')).toBe('future');
    expect(dslVersionState('not-a-version', '0.3.0')).toBe('future');
    expect(dslVersionState(7, '0.3.0')).toBe('future');
  });
});
