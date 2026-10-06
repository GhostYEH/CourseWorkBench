import { describe, expect, it } from 'vitest';
import {
  collabEventAppendSchema,
  collabInvitationCommandSchema,
  collabOnlineCommandSchema,
} from '@sew/study-contracts';
import {
  createCollabCommandTracker,
  type CollabCommandIdKind,
} from '../apps/learning/lib/classroom/collab-command-state';

const INVITATIONS = '/api/study/collab/invitations';
const EVENTS = '/api/study/collab/events';
const MESSAGES = '/api/study/collab/messages';
const UID_A = 'uid_10000000-0000-4000-8000-000000000001';
const UID_B = 'uid_10000000-0000-4000-8000-000000000002';

const trackerFixture = () => {
  const generated: CollabCommandIdKind[] = [];
  const tracker = createCollabCommandTracker({
    idFactory(kind) {
      generated.push(kind);
      return `${kind}_${generated.length}`;
    },
  });
  return { tracker, generated };
};

const memoryStorage = new Map<string, string>();
const persistenceFor = (projectId: string, uid: string) => ({
  projectId,
  uid,
  storageKey: `pending:${projectId}:${uid}`,
  storage: {
    getItem: (key: string) => memoryStorage.get(key) ?? null,
    setItem: (key: string, value: string) => void memoryStorage.set(key, value),
    removeItem: (key: string) => void memoryStorage.delete(key),
  },
});
const persistentTracker = (projectId: string, uid: string, serial: { value: number }) =>
  createCollabCommandTracker({
    persistence: persistenceFor(projectId, uid),
    validatePayload: (
      value,
    ): value is import('../apps/learning/lib/classroom/collab-command-state').CollabCommandPayload =>
      collabOnlineCommandSchema.safeParse(value).success,
    idFactory: (kind) => `${kind}_${++serial.value}`,
  });

const invitation = () => ({
  action: 'invite',
  inviterUid: UID_A,
  inviteeUid: UID_B,
  lessonId: 'lesson_1',
  lessonVersion: 1,
  snapshotDigest: 'a'.repeat(64),
});

const event = () => ({
  roomId: 'room_1',
  kind: 'board_action',
  actorUid: UID_A,
  summary: '高亮共同条件',
});

const message = () => ({
  roomId: 'room_1',
  senderUid: UID_A,
  senderType: 'human_learner',
  body: '这一步我们意见相同。',
});

describe('未确认协作命令', () => {
  it('服务端已提交但响应丢失后，刷新重建的同 scope tracker 复用完整场景请求', () => {
    memoryStorage.clear();
    const serial = { value: 0 };
    const firstTracker = persistentTracker('project_a', UID_A, serial);
    const first = firstTracker.prepare(
      '/api/study/collab/online',
      { action: 'scene', roomId: 'room_1', sceneId: 'scene_2', expectedRevision: 3 },
      { tailSeq: 8 },
    );
    const reloadedTracker = persistentTracker('project_a', UID_A, serial);
    const retry = reloadedTracker.prepare(
      '/api/study/collab/online',
      { action: 'scene', roomId: 'room_1', sceneId: 'scene_2', expectedRevision: 3 },
      { tailSeq: 14 },
    );
    expect(retry).toEqual(first);
    expect(retry).toMatchObject({ roomId: 'room_1', eventId: 'event_1', expectedSeq: 9 });
    expect(serial.value).toBe(2);
  });

  it('持久化按项目和本人 UID 隔离，切换 scope 不带入旧命令', () => {
    memoryStorage.clear();
    const serial = { value: 0 };
    const original = persistentTracker('project_a', UID_A, serial);
    const first = original.prepare('/api/study/collab/online', {
      action: 'message',
      roomId: 'room_1',
      body: '未确认消息',
    });
    const otherProject = persistentTracker('project_b', UID_A, serial);
    const otherUid = persistentTracker('project_a', UID_B, serial);
    expect(
      otherProject.prepare('/api/study/collab/online', {
        action: 'message',
        roomId: 'room_1',
        body: '未确认消息',
      }).requestId,
    ).not.toBe(first.requestId);
    expect(
      otherUid.prepare('/api/study/collab/online', {
        action: 'message',
        roomId: 'room_1',
        body: '未确认消息',
      }).requestId,
    ).not.toBe(first.requestId);
  });

  it('损坏或不符合合同的存储记录会被拒绝并清除', () => {
    memoryStorage.clear();
    const persistence = persistenceFor('project_a', UID_A);
    memoryStorage.set(
      persistence.storageKey,
      JSON.stringify({
        version: 1,
        projectId: 'project_a',
        uid: UID_A,
        commands: [
          {
            path: '/api/study/collab/online',
            key: 'bad',
            payload: {
              action: 'message',
              roomId: 'room_1',
              body: 'x',
              requestId: 'request_1',
              secret: 'must not persist',
            },
          },
        ],
      }),
    );
    const serial = { value: 0 };
    const tracker = persistentTracker('project_a', UID_A, serial);
    expect(
      tracker.prepare('/api/study/collab/online', {
        action: 'message',
        roomId: 'room_1',
        body: 'clean',
      }).body,
    ).toBe('clean');
    expect(memoryStorage.get(persistence.storageKey)).not.toContain('must not persist');
  });

  it('确认后从本地 pending 中移除，新的同意图命令使用新 requestId', () => {
    memoryStorage.clear();
    const serial = { value: 0 };
    const tracker = persistentTracker('project_a', UID_A, serial);
    const first = tracker.prepare('/api/study/collab/online', {
      action: 'message',
      roomId: 'room_1',
      body: '已确认消息',
    });
    expect(tracker.confirm('/api/study/collab/online', first)).toBe(true);
    const recreated = persistentTracker('project_a', UID_A, serial);
    const next = recreated.prepare('/api/study/collab/online', {
      action: 'message',
      roomId: 'room_1',
      body: '已确认消息',
    });
    expect(next.requestId).not.toBe(first.requestId);
    expect(recreated.confirm('/api/study/collab/online', first)).toBe(false);
  });

  it('邀请提交已成功但响应丢失时复用整份请求，不生成第二个房间或 requestId', () => {
    const { tracker, generated } = trackerFixture();
    const first = tracker.prepare(INVITATIONS, invitation());
    const sent = JSON.stringify(first);
    // 未收到成功响应，不 confirm；刷新后的组件即使误传新生成字段也不能改变原意图。
    const retry = tracker.prepare(INVITATIONS, {
      ...invitation(),
      roomId: 'accidental-new-room',
      requestId: 'accidental-new-request',
    });
    expect(JSON.stringify(retry)).toBe(sent);
    expect(retry).toBe(first);
    expect(generated).toEqual(['room', 'request']);
    expect(collabInvitationCommandSchema.safeParse(first).success).toBe(true);
  });

  it('事件尾序号推进后仍重放原 eventId、requestId、expectedSeq 与正文', () => {
    const { tracker, generated } = trackerFixture();
    const first = tracker.prepare(EVENTS, event(), { tailSeq: 4 });
    const retry = tracker.prepare(
      EVENTS,
      {
        ...event(),
        eventId: 'regenerated-event',
        expectedSeq: 12,
        requestId: 'regenerated-request',
      },
      { tailSeq: 11 },
    );
    expect(retry).toBe(first);
    expect(retry).toMatchObject({ eventId: 'event_1', requestId: 'request_2', expectedSeq: 5 });
    expect(generated).toEqual(['event', 'request']);
    expect(collabEventAppendSchema.safeParse(retry).success).toBe(true);
    // 未确认重试不依赖调用方再次提供尾序号。
    expect(tracker.prepare(EVENTS, event())).toBe(first);
  });

  it('成功确认之后，相同消息正文属于新的发送请求', () => {
    const { tracker } = trackerFixture();
    const first = tracker.prepare(MESSAGES, message());
    expect(tracker.confirm(MESSAGES, first)).toBe(true);
    const second = tracker.prepare(MESSAGES, message());
    expect(second.requestId).not.toBe(first.requestId);
    expect(second['body']).toBe(first['body']);
  });

  it('迟到的旧确认及旧 discard 不能清掉相同意图的后继 pending', () => {
    const { tracker } = trackerFixture();
    const first = tracker.prepare(MESSAGES, message());
    expect(tracker.confirm(MESSAGES, first)).toBe(true);
    const second = tracker.prepare(MESSAGES, message());
    expect(tracker.confirm(MESSAGES, first)).toBe(false);
    expect(tracker.discard(MESSAGES, first)).toBe(false);
    expect(tracker.prepare(MESSAGES, message())).toBe(second);
    expect(tracker.confirm(MESSAGES, { ...second })).toBe(true);
  });

  it('服务端明确拒绝后可 discard，事件再次提交按最新 tailSeq 生成新请求', () => {
    const { tracker } = trackerFixture();
    const rejected = tracker.prepare(EVENTS, event(), { tailSeq: 2 });
    expect(tracker.discard(EVENTS, rejected)).toBe(true);
    const next = tracker.prepare(EVENTS, event(), { tailSeq: 7 });
    expect(next).toMatchObject({ expectedSeq: 8 });
    expect(next.requestId).not.toBe(rejected.requestId);
    expect(next['eventId']).not.toBe(rejected['eventId']);
  });

  it('path 和完整逻辑意图分别隔离 pending，消息 roomId 始终是业务身份', () => {
    const { tracker } = trackerFixture();
    const first = tracker.prepare(MESSAGES, message());
    const otherRoom = tracker.prepare(MESSAGES, { ...message(), roomId: 'room_2' });
    const otherBody = tracker.prepare(MESSAGES, { ...message(), body: '另一条消息' });
    const otherPath = tracker.prepare('/api/study/collab/custom', message());
    expect(
      new Set([first, otherRoom, otherBody, otherPath].map((payload) => payload.requestId)).size,
    ).toBe(4);
    expect(tracker.confirm('/api/study/collab/custom', first)).toBe(false);
    expect(tracker.prepare(MESSAGES, message())).toBe(first);
  });

  it('调用方修改原输入或键顺序不能改变已发送的请求快照', () => {
    const { tracker } = trackerFixture();
    const intent = { action: 'custom', detail: { title: '原内容', numbers: [1, 2] } };
    const first = tracker.prepare('/api/study/collab/custom', intent);
    intent.detail.title = '已修改';
    intent.detail.numbers.push(3);
    expect(first['detail']).toEqual({ title: '原内容', numbers: [1, 2] });
    const retry = tracker.prepare('/api/study/collab/custom', {
      detail: { numbers: [1, 2], title: '原内容' },
      action: 'custom',
    });
    expect(retry).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first['detail'])).toBe(true);
    expect(
      tracker.confirm('/api/study/collab/custom', {
        ...first,
        detail: { title: '篡改正文', numbers: [1, 2] },
      }),
    ).toBe(false);
    expect(
      tracker.prepare('/api/study/collab/custom', {
        detail: { numbers: [1, 2], title: '原内容' },
        action: 'custom',
      }),
    ).toBe(first);
  });

  it('tracker 随 UI scope 重建，旧 scope 的请求不进入新 scope', () => {
    let serial = 0;
    const options = { idFactory: (kind: CollabCommandIdKind) => `${kind}_${++serial}` };
    const firstScope = createCollabCommandTracker(options);
    const first = firstScope.prepare(MESSAGES, message());
    const nextScope = createCollabCommandTracker(options);
    const next = nextScope.prepare(MESSAGES, message());
    expect(next.requestId).not.toBe(first.requestId);
    expect(nextScope.confirm(MESSAGES, first)).toBe(false);
    expect(nextScope.prepare(MESSAGES, message())).toBe(next);
  });

  it.each([undefined, -1, 0.5, Number.MAX_SAFE_INTEGER, Number.NaN])(
    '首次事件拒绝无效 tailSeq %s 且不生成 pending',
    (tailSeq) => {
      const { tracker, generated } = trackerFixture();
      expect(() => tracker.prepare(EVENTS, event(), { tailSeq })).toThrow(RangeError);
      expect(generated).toEqual([]);
      expect(tracker.prepare(EVENTS, event(), { tailSeq: 0 })['expectedSeq']).toBe(1);
    },
  );

  it('未注入 factory 时使用独立随机身份', () => {
    const tracker = createCollabCommandTracker();
    const first = tracker.prepare(INVITATIONS, invitation());
    expect(first.requestId).toMatch(/^request_[a-f0-9-]{36}$/);
    expect(first['roomId']).toMatch(/^room_[a-f0-9-]{36}$/);
    expect(tracker.confirm(INVITATIONS, first)).toBe(true);
    expect(tracker.prepare(INVITATIONS, invitation()).requestId).not.toBe(first.requestId);
  });
});
