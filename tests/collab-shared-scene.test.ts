import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { ClassroomSharedCourseDto } from '@sew/study-contracts';
import { CollabSharedScene } from '../apps/learning/components/collab-shared-scene';

const require = createRequire(new URL('../apps/learning/package.json', import.meta.url));
const { renderToStaticMarkup } = require('react-dom/server') as {
  renderToStaticMarkup: (element: unknown) => string;
};
const { createElement } = require('react') as {
  createElement: (type: unknown, props: unknown) => unknown;
};
const digest = 'a'.repeat(64);
const snapshot: ClassroomSharedCourseDto = {
  snapshotVersion: 1,
  course: {
    lessonId: 'lesson',
    lessonVersion: 1,
    title: '共同课程',
    stageId: 'stage',
    dslVersion: '0.11.2',
    documentDigest: digest,
    bundleDigest: digest,
  },
  scenes: [
    {
      sceneId: 'intro',
      type: 'slide',
      title: '引入',
      order: 0,
      elements: [
        {
          elementId: 'e1',
          type: 'text',
          left: 0,
          top: 0,
          width: 10,
          height: 10,
          rotate: 0,
          text: '旧场景材料',
        },
      ],
    },
    {
      sceneId: 'quiz',
      type: 'quiz',
      title: '共同练习',
      order: 1,
      questions: [
        {
          questionId: 'q1',
          type: 'single',
          stem: '公开题干',
          options: [
            { value: 'a', label: '候选甲' },
            { value: 'b', label: '候选乙' },
          ],
        },
      ],
    },
  ],
  evidence: {
    planVersion: 1,
    knowledgeVersions: [{ knowledgeId: 'k', revision: 1 }],
    statements: [],
    segments: [{ materialId: 'm', revision: 1, segmentId: 's', fingerprint: digest, text: '证据' }],
  },
  sceneSources: [
    { sceneId: 'intro', knowledgeIds: ['k'], questionId: null },
    { sceneId: 'quiz', knowledgeIds: ['k'], questionId: 'q1' },
  ],
  assets: [],
};

describe('共同课堂公共场景消费', () => {
  it('双方按服务端场景指针显示同一题干，推进后不残留旧场景', () => {
    const props = { snapshot, sceneId: 'quiz' };
    const host = renderToStaticMarkup(createElement(CollabSharedScene, props));
    const peer = renderToStaticMarkup(createElement(CollabSharedScene, props));
    expect(host).toBe(peer);
    expect(host).toContain('公开题干');
    expect(host).toContain('候选甲');
    expect(host).not.toContain('旧场景材料');
    expect(host).toContain('个人答案与评分保留在各自的个人课堂');
  });

  it('未知场景或缺少快照时显示等待，不擅自切回第一场', () => {
    const unknown = renderToStaticMarkup(
      createElement(CollabSharedScene, { snapshot, sceneId: 'missing' }),
    );
    expect(unknown).toContain('等待房主');
    expect(unknown).not.toContain('旧场景材料');
    const absent = renderToStaticMarkup(
      createElement(CollabSharedScene, { snapshot: null, sceneId: 'intro' }),
    );
    expect(absent).toContain('共享课程尚未读回');
  });
});
