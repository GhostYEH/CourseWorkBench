import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { ClassroomSharedCourseDto, CollabTeachingStateDto } from '@sew/study-contracts';
import {
  CollabTeachingPanel,
  collabBoardContents,
  collabSceneStatements,
  currentSceneTeaching,
  parseBoardDiagram,
} from '../apps/learning/components/collab-teaching-panel';

const require = createRequire(new URL('../apps/learning/package.json', import.meta.url));
const { renderToStaticMarkup } = require('react-dom/server') as {
  renderToStaticMarkup: (element: unknown) => string;
};
const { createElement } = require('react') as {
  createElement: (type: unknown, props: unknown) => unknown;
};
const digest = 'b'.repeat(64);
const selfUid = 'uid_00000000-0000-4000-8000-000000000001';
const peerUid = 'uid_00000000-0000-4000-8000-000000000002';
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
      sceneId: 'one',
      type: 'slide',
      title: '第一场',
      order: 0,
      elements: [
        {
          elementId: 'slide-element',
          type: 'text',
          left: 0,
          top: 0,
          width: 10,
          height: 10,
          rotate: 0,
          text: '可聚焦内容',
        },
      ],
    },
    {
      sceneId: 'two',
      type: 'slide',
      title: '第二场',
      order: 1,
      elements: [
        {
          elementId: 'other-element',
          type: 'text',
          left: 0,
          top: 0,
          width: 10,
          height: 10,
          rotate: 0,
          text: '另一场内容',
        },
      ],
    },
  ],
  evidence: {
    planVersion: 1,
    knowledgeVersions: [
      { knowledgeId: 'k-one', revision: 1 },
      { knowledgeId: 'k-two', revision: 1 },
    ],
    statements: [
      {
        statementId: 'statement-one',
        knowledgeId: 'k-one',
        text: '当前场景已审核陈述',
        conditions: '',
        evidence: [
          { materialId: 'source-a', revision: 3, segmentId: 'segment-a', use: 'concept_basis' },
        ],
      },
      {
        statementId: 'statement-two',
        knowledgeId: 'k-two',
        text: '另一场景陈述',
        conditions: '',
        evidence: [
          { materialId: 'source-b', revision: 1, segmentId: 'segment-b', use: 'method_basis' },
        ],
      },
    ],
    segments: [
      {
        materialId: 'source-a',
        revision: 3,
        segmentId: 'segment-a',
        fingerprint: digest,
        text: '来源材料',
      },
      {
        materialId: 'source-b',
        revision: 1,
        segmentId: 'segment-b',
        fingerprint: digest,
        text: '其他材料',
      },
    ],
  },
  sceneSources: [
    { sceneId: 'one', knowledgeIds: ['k-one'], questionId: null },
    { sceneId: 'two', knowledgeIds: ['k-two'], questionId: null },
  ],
  assets: [],
};

const waitingState = (acknowledged: boolean): CollabTeachingStateDto => ({
  schemaVersion: 1,
  roomId: 'room',
  sceneId: 'one',
  board: {
    focusElementId: 'slide-element',
    laserElementId: null,
    history: {
      baseline: { focusElementId: null, laserElementId: null },
      actions: [
        {
          eventId: 'focus-action',
          seq: 1,
          kind: 'focus',
          elementId: 'slide-element',
          applied: true,
        },
        {
          eventId: 'laser-action',
          seq: 3,
          kind: 'laser',
          elementId: 'old-element',
          applied: false,
        },
      ],
    },
  },
  waiting: {
    waitEventId: 'wait-event',
    sceneId: 'one',
    targetUid: peerUid,
    acknowledged,
  },
  outputs: [
    {
      eventId: 'speech-event',
      seq: 2,
      sceneId: 'one',
      statementId: 'statement-one',
      body: '当前场景已审核陈述',
      conditions: '在条件甲成立时',
      source: 'reviewed_statement',
      createdAt: '2026-10-06T00:00:00.000Z',
    },
  ],
});

const writeState = (): CollabTeachingStateDto => ({
  schemaVersion: 1,
  roomId: 'room',
  sceneId: 'one',
  board: {
    focusElementId: null,
    laserElementId: null,
    contents: [
      {
        eventId: 'write-action',
        seq: 1,
        statementId: 'statement-one',
        content: { kind: 'text', text: '公共板书内容' },
      },
    ],
    history: {
      baseline: { focusElementId: null, laserElementId: null },
      actions: [
        {
          eventId: 'write-action',
          seq: 1,
          kind: 'write',
          statementId: 'statement-one',
          content: { kind: 'text', text: '公共板书内容' },
          applied: true,
        },
      ],
    },
  },
  waiting: null,
  outputs: [],
});

describe('共同课堂教师教学消费', () => {
  it('讲解选项只来自当前场景知识点，并在状态场景变化时清空旧状态', () => {
    expect(collabSceneStatements(snapshot, 'one').map((item) => item.statementId)).toEqual([
      'statement-one',
    ]);
    expect(currentSceneTeaching(waitingState(false), 'two')).toBeNull();
    expect(currentSceneTeaching(waitingState(false), 'one')?.sceneId).toBe('one');
  });

  it('目标同学看到本人确认，房主只在确认后看到继续与取消等待', () => {
    const members = [
      {
        uid: selfUid,
        role: 'owner' as const,
        identityAuthority: 'online_authenticated' as const,
        readiness: 'ready' as const,
      },
      {
        uid: peerUid,
        role: 'participant' as const,
        identityAuthority: 'online_authenticated' as const,
        readiness: 'ready' as const,
      },
    ];
    const peerMarkup = renderToStaticMarkup(
      createElement(CollabTeachingPanel, {
        snapshot,
        sceneId: 'one',
        selfUid: peerUid,
        owner: false,
        enabled: true,
        members,
        state: waitingState(false),
        onOperation: () => undefined,
      }),
    );
    const ownerBeforeAck = renderToStaticMarkup(
      createElement(CollabTeachingPanel, {
        snapshot,
        sceneId: 'one',
        selfUid,
        owner: true,
        enabled: true,
        members,
        state: waitingState(false),
        onOperation: () => undefined,
      }),
    );
    const ownerAfterAck = renderToStaticMarkup(
      createElement(CollabTeachingPanel, {
        snapshot,
        sceneId: 'one',
        selfUid,
        owner: true,
        enabled: true,
        members,
        state: waitingState(true),
        onOperation: () => undefined,
      }),
    );

    expect(peerMarkup).toContain('data-collab-teaching-acknowledge');
    expect(peerMarkup).not.toContain('data-collab-teaching-release-wait');
    expect(peerMarkup).not.toContain('data-collab-teaching-owner-controls');
    expect(peerMarkup).toContain('data-collab-board-action="focus-action"');
    expect(peerMarkup).toContain('data-collab-board-action="laser-action"');
    expect(peerMarkup).toContain('laser-action');
    expect(peerMarkup).toContain('已撤销');
    expect(peerMarkup).not.toContain('data-collab-board-undo');
    expect(peerMarkup).not.toContain('data-collab-board-replay');
    expect(ownerBeforeAck).not.toContain('data-collab-teaching-release-wait');
    expect(ownerAfterAck).toContain('data-collab-teaching-release-wait');
    expect(ownerAfterAck).toContain('data-collab-teaching-cancel-wait');
    expect(ownerAfterAck).toContain('来源 statement-one · source-a@v3/segment-a');
    expect(ownerAfterAck).toContain('适用条件：在条件甲成立时');
    expect(ownerAfterAck).toMatch(/data-collab-teaching-speak="true" disabled=""/);
    expect(ownerAfterAck).toMatch(/data-collab-teaching-focus="true" disabled=""/);
    expect(ownerAfterAck).toMatch(/data-collab-teaching-laser="true" disabled=""/);
    expect(ownerAfterAck).not.toMatch(/data-collab-teaching-clear-board="true" disabled=""/);
    expect(ownerAfterAck).toContain('data-collab-board-undo="focus-action"');
    expect(ownerAfterAck).toContain('data-collab-board-replay="laser-action"');
    expect(ownerAfterAck).toMatch(/data-collab-board-undo="focus-action" disabled=""/);
    expect(ownerAfterAck).toMatch(/data-collab-board-replay="laser-action" disabled=""/);
  });

  it('旧状态缺少动作历史时继续渲染，不合成空白基线', () => {
    const legacyState: CollabTeachingStateDto = {
      ...waitingState(false),
      board: { focusElementId: null, laserElementId: null },
    };
    const markup = renderToStaticMarkup(
      createElement(CollabTeachingPanel, {
        snapshot,
        sceneId: 'one',
        selfUid,
        owner: true,
        enabled: true,
        members: [],
        state: legacyState,
        onOperation: () => undefined,
      }),
    );
    expect(markup).not.toContain('data-collab-board-history');
  });

  it('场景动作历史到200项后禁用新增动作但保留撤销和重放', () => {
    const fullState: CollabTeachingStateDto = {
      ...waitingState(false),
      waiting: null,
      board: {
        focusElementId: 'slide-element',
        laserElementId: null,
        history: {
          baseline: { focusElementId: null, laserElementId: null },
          actions: Array.from({ length: 200 }, (_, index) => ({
            eventId: `board-action-${index + 1}`,
            seq: index + 1,
            kind: 'focus' as const,
            elementId: 'slide-element',
            applied: index !== 1,
          })),
        },
      },
    };
    const markup = renderToStaticMarkup(
      createElement(CollabTeachingPanel, {
        snapshot,
        sceneId: 'one',
        selfUid,
        owner: true,
        enabled: true,
        members: [],
        state: fullState,
        onOperation: () => undefined,
      }),
    );

    expect(markup).toContain('data-collab-board-history-limit');
    expect(markup).toMatch(/data-collab-teaching-focus="true" disabled=""/);
    expect(markup).toMatch(/data-collab-teaching-laser="true" disabled=""/);
    expect(markup).toMatch(/data-collab-teaching-clear-board="true" disabled=""/);
    expect(markup).toContain('data-collab-board-undo="board-action-1"');
    expect(markup).not.toMatch(/data-collab-board-undo="board-action-1" disabled=""/);
    expect(markup).toContain('data-collab-board-replay="board-action-2"');
    expect(markup).not.toMatch(/data-collab-board-replay="board-action-2" disabled=""/);
  });

  it('渲染已写公共白板内容、擦除按钮，并解析合法简图', () => {
    const members = [
      {
        uid: selfUid,
        role: 'owner' as const,
        identityAuthority: 'online_authenticated' as const,
        readiness: 'ready' as const,
      },
    ];
    const ownerMarkup = renderToStaticMarkup(
      createElement(CollabTeachingPanel, {
        snapshot,
        sceneId: 'one',
        selfUid,
        owner: true,
        enabled: true,
        members,
        state: writeState(),
        onOperation: () => undefined,
      }),
    );
    const peerMarkup = renderToStaticMarkup(
      createElement(CollabTeachingPanel, {
        snapshot,
        sceneId: 'one',
        selfUid: peerUid,
        owner: false,
        enabled: true,
        members,
        state: writeState(),
        onOperation: () => undefined,
      }),
    );

    expect(ownerMarkup).toContain('data-collab-board-contents');
    expect(ownerMarkup).toContain('data-collab-board-content="write-action"');
    expect(ownerMarkup).toContain('公共板书内容');
    expect(ownerMarkup).toContain('data-collab-teaching-write');
    expect(ownerMarkup).toContain('data-collab-board-erase="write-action"');
    expect(ownerMarkup).toContain('data-collab-board-action="write-action"');
    // 普通成员只看内容，没有擦除/写入控制。
    expect(peerMarkup).toContain('data-collab-board-content="write-action"');
    expect(peerMarkup).not.toContain('data-collab-board-erase');
    expect(peerMarkup).not.toContain('data-collab-teaching-write');

    expect(collabBoardContents(writeState())).toHaveLength(1);
    expect(collabBoardContents(null)).toEqual([]);
    expect(parseBoardDiagram('a | 起点\nb | 终点', 'a -> b | 连接')).toEqual({
      kind: 'diagram',
      nodes: [
        { id: 'a', label: '起点', x: 20, y: 20 },
        { id: 'b', label: '终点', x: 20, y: 80 },
      ],
      edges: [{ from: 'a', to: 'b', label: '连接' }],
    });
    // 连线引用不存在的节点：解析失败，界面据此禁用写入，而不是提交一个非法形状。
    expect(parseBoardDiagram('a | 起点', 'a -> missing')).toBeNull();
  });
});
