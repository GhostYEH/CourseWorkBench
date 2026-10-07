import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  prepareOnlineCommand,
  confirmOnlineCommand,
} from '../apps/learning/lib/server/collab-command-outbox';
import type { Session } from '../apps/learning/lib/server/service';

const uid = 'uid_10000000-0000-4000-8000-000000000001';
const session = { projectId: 'project-outbox', learnerUid: uid } as unknown as Session;
const message = {
  action: 'message' as const,
  roomId: 'room',
  body: '共同讨论',
  requestId: 'first',
};
let root: string;
let original: string | undefined;
beforeEach(() => {
  original = process.env.SEW_USER_DATA_DIR;
  root = mkdtempSync(join(tmpdir(), 'sew-collab-outbox-'));
  process.env.SEW_USER_DATA_DIR = root;
});
afterEach(() => {
  if (original === undefined) delete process.env.SEW_USER_DATA_DIR;
  else process.env.SEW_USER_DATA_DIR = original;
  rmSync(root, { recursive: true, force: true });
});

describe('受控客户端跨应用重启命令恢复', () => {
  it('公共白板撤销恢复保留原版本与事件，重放同目标不混用撤销收据', () => {
    const undo = {
      action: 'teaching' as const,
      roomId: 'room',
      sceneId: 'scene',
      expectedRevision: 3,
      expectedSeq: 8,
      eventId: 'undo-event',
      requestId: 'undo-request',
      operation: { kind: 'undo-board' as const, actionEventId: 'board-original' },
    };
    prepareOnlineCommand(session, undo);
    const regenerated = {
      ...undo,
      expectedRevision: 12,
      expectedSeq: 20,
      eventId: 'new-event',
      requestId: 'new-request',
    };
    expect(prepareOnlineCommand({ ...session }, regenerated)).toEqual(undo);
    const replay = {
      ...regenerated,
      requestId: 'replay-request',
      operation: { kind: 'replay-board' as const, actionEventId: 'board-original' },
    };
    expect(prepareOnlineCommand(session, replay)).toEqual(replay);
    confirmOnlineCommand(session, undo.requestId);
    expect(
      prepareOnlineCommand({ ...session }, { ...replay, requestId: 'restarted-replay' }),
    ).toEqual(replay);
    expect(prepareOnlineCommand(session, regenerated)).toEqual(regenerated);
  });
  it('教学等待重启恢复沿用完整原命令，另一目标UID保持独立', () => {
    const teaching = {
      action: 'teaching' as const,
      roomId: 'room',
      sceneId: 'scene',
      expectedRevision: 3,
      expectedSeq: 8,
      eventId: 'teach-event',
      requestId: 'teach-request',
      operation: { kind: 'wait' as const, targetUid: uid },
    };
    prepareOnlineCommand(session, teaching);
    expect(
      prepareOnlineCommand(
        { ...session },
        {
          ...teaching,
          expectedRevision: 5,
          expectedSeq: 10,
          eventId: 'new-event',
          requestId: 'new-request',
        },
      ),
    ).toEqual(teaching);
    const other = {
      ...teaching,
      requestId: 'other-target',
      operation: { kind: 'wait' as const, targetUid: 'uid_10000000-0000-4000-8000-000000000002' },
    };
    expect(prepareOnlineCommand(session, other)).toEqual(other);
    confirmOnlineCommand(session, teaching.requestId);
    expect(prepareOnlineCommand(session, { ...teaching, requestId: 'fresh' }).requestId).toBe(
      'fresh',
    );
  });
  it('新页面重新生成 requestId 仍复用原命令；明确确认后才允许相同正文的新发言', () => {
    expect(prepareOnlineCommand(session, message)).toEqual(message);
    const restarted = { ...session };
    expect(prepareOnlineCommand(restarted, { ...message, requestId: 'after-restart' })).toEqual(
      message,
    );
    confirmOnlineCommand(restarted, message.requestId);
    expect(
      prepareOnlineCommand(restarted, { ...message, requestId: 'new-message' }).requestId,
    ).toBe('new-message');
  });
  it('恢复完整房间/场景/序号意图，不能被新随机值或新读回版本替换', () => {
    const invite = {
      action: 'invite' as const,
      roomId: 'original-room',
      inviteeUid: uid,
      lessonId: 'lesson',
      lessonVersion: 1,
      snapshotDigest: 'a'.repeat(64),
      requestId: 'invite-first',
    };
    prepareOnlineCommand(session, invite);
    expect(
      prepareOnlineCommand(session, { ...invite, roomId: 'new-random-room', requestId: 'new-id' }),
    ).toEqual(invite);
    const scene = {
      action: 'scene' as const,
      roomId: 'room',
      sceneId: 'scene',
      expectedRevision: 3,
      expectedSeq: 8,
      eventId: 'event-first',
      requestId: 'scene-first',
    };
    prepareOnlineCommand(session, scene);
    expect(
      prepareOnlineCommand(session, {
        ...scene,
        expectedRevision: 4,
        expectedSeq: 9,
        eventId: 'new-event',
        requestId: 'new-scene-id',
      }),
    ).toEqual(scene);
  });
  it('项目和本人隔离；损坏文件拒绝发送而非清空后创建新 requestId', () => {
    prepareOnlineCommand(session, message);
    expect(
      prepareOnlineCommand(
        { ...session, projectId: 'other' },
        { ...message, requestId: 'other-project' },
      ).requestId,
    ).toBe('other-project');
    expect(
      prepareOnlineCommand(
        { ...session, learnerUid: 'uid_10000000-0000-4000-8000-000000000002' },
        { ...message, requestId: 'other-user' },
      ).requestId,
    ).toBe('other-user');
    for (const file of readdirSync(join(root, 'collab-command-outbox'))) {
      writeFileSync(join(root, 'collab-command-outbox', file), '{corrupt');
    }
    expect(() => prepareOnlineCommand(session, message)).toThrow();
  });
});
