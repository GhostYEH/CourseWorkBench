import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { PBLContent } from '@openmaic/dsl';
import {
  FormalPblSceneView,
  selectPblInitialDraft,
} from '../apps/learning/components/openmaic-adaptation/FormalPblSceneView';
import { PblProjectAuthor } from '../apps/learning/components/pbl-project-author';
import type { PblDeliverableDraftDto } from '@sew/study-contracts';

const require = createRequire(new URL('../apps/learning/package.json', import.meta.url));
const { renderToStaticMarkup } = require('react-dom/server') as {
  renderToStaticMarkup: (element: unknown) => string;
};
const { createElement } = require('react') as {
  createElement: (type: unknown, props: unknown) => unknown;
};
const uid = 'uid_00000000-0000-4000-8000-000000000001';
const draftFor = (taskId: string, artifactTitle: string): PblDeliverableDraftDto => ({
  version: 1,
  uid,
  recordScope: 'formal',
  binding: {
    version: 1,
    stageId: 'stage',
    definitionId: 'definition',
    documentDigest: 'document',
    definitionDigest: 'definition',
  },
  updatedAt: '2026-10-08T00:00:00.000Z',
  nonce: `nonce-${taskId}`,
  taskId,
  milestoneId: null,
  artifactKind: 'report',
  artifactTitle,
  artifactText: `${artifactTitle}正文`,
  assetRefs: [],
  goalIds: [],
});

describe('PBL authorship and formal scene UI', () => {
  it('restores the authoritative latest draft before older per-task entries and ignores drafts for removed tasks', () => {
    const oldestTaskDraft = draftFor('task-a', '先创建的任务草稿');
    const latestTaskDraft = draftFor('task-b', '服务端最新草稿');
    const removedTaskDraft = draftFor('removed-task', '无效任务草稿');

    expect(
      selectPblInitialDraft({
        tasks: [{ id: 'task-a' }, { id: 'task-b' }],
        ownDraft: latestTaskDraft,
        ownDrafts: [oldestTaskDraft, removedTaskDraft],
      })?.artifactTitle,
    ).toBe('服务端最新草稿');
    expect(
      selectPblInitialDraft({
        tasks: [{ id: 'task-a' }],
        ownDraft: removedTaskDraft,
        ownDrafts: [removedTaskDraft, oldestTaskDraft],
      })?.artifactTitle,
    ).toBe('先创建的任务草稿');
  });

  it('renders a schema-valid editable author template but requires a fresh human semantic review before freeze', () => {
    const markup = renderToStaticMarkup(
      createElement(PblProjectAuthor, {
        projectId: 'project',
        generation: 1,
        learnerUid: uid,
        lesson: {
          lessonId: 'lesson',
          version: 1,
          title: '测试课程',
          statementIds: ['statement-1'],
        },
        statements: [
          {
            statementId: 'statement-1',
            knowledgeId: 'knowledge-1',
            text: '在光照充足条件下植物生长更快。',
            conditions: '温度保持适宜时',
            evidence: [
              { materialId: 'book', revision: 2, segmentId: 'segment-4', use: 'concept_basis' },
            ],
          },
        ],
      }),
    );

    expect(markup).toContain('data-pbl-author');
    expect(markup).toContain('data-pbl-definition');
    expect(markup).toContain('data-pbl-semantic-review');
    expect(markup).toContain('data-pbl-freeze');
    expect(markup).toContain('在光照充足条件下植物生长更快。');
    expect(markup).toContain('适用条件：温度保持适宜时');
    expect(markup).toContain('book v2 · segment-4 · concept_basis');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('语义审核勾选初始为否');
  });

  it('does not expose member actions or private records before authoritative state has loaded', () => {
    const content = {
      type: 'pbl',
      definitionId: 'project-definition',
      projectV2: { title: '公开项目' },
    } as PBLContent & { definitionId: string };
    const markup = renderToStaticMarkup(
      createElement(FormalPblSceneView, {
        stageId: 'stage',
        sceneId: 'scene-pbl-project',
        scope: { projectId: 'project', generation: 1 },
        content,
      }),
    );

    expect(markup).toContain('公开项目');
    expect(markup).toContain('正在读取该项目状态');
    expect(markup).toContain('data-pbl-demo');
    expect(markup).toContain('data-pbl-demo-open');
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain('本人历史产物');
    expect(markup).not.toContain('data-pbl-submit');
  });
});
