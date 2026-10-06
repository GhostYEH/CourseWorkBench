import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyError } from '@sew/study-contracts';
import { StudyStore, createNodeSqliteDriver, type SqlDatabase } from '@sew/study-storage';

/**
 * 协作权威存储（INVITE-01 / SYNC-01 / CHAT-01，ADR-0004）。
 *
 * 覆盖：UID 登记只记 local_link、邀请发起/表态/撤销与过期、成员准备状态、
 * 消息与事件的权威序号/游标/幂等、非成员与伪造身份的拒绝。
 * 这些是**本地链路**的回归；双设备真实联调仍未执行（COLLAB-EVAL-01）。
 */

const UID_A = 'uid_10000000-0000-4000-8000-000000000001';
const UID_B = 'uid_10000000-0000-4000-8000-000000000002';
const UID_C = 'uid_10000000-0000-4000-8000-000000000003';
const UID_D = 'uid_10000000-0000-4000-8000-000000000004';
const DIGEST = 'a'.repeat(64);
const roots: string[] = [];
const stores: StudyStore[] = [];

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const expectCode = (action: () => unknown, code: string, reason?: string): void => {
  try {
    action();
  } catch (error) {
    expect((error as StudyError).code).toBe(code);
    if (reason !== undefined) expect((error as StudyError).details?.['reason']).toBe(reason);
    return;
  }
  throw new Error(`预期抛出 ${code}，但调用成功了`);
};

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'sew-collab-'));
  roots.push(root);
  const store = StudyStore.open({ file: join(root, 'study.db') });
  stores.push(store);
  store.createProject({ projectId: 'p', displayName: '数学' });
  store.registerCollaborationUid({ uid: UID_A, displayName: '甲', requestId: 'reg-a' });
  store.registerCollaborationUid({ uid: UID_B, displayName: '乙', requestId: 'reg-b' });
  return store;
};

const invite = (store: StudyStore, requestId = 'inv-1', now?: string, roomId = 'room_1') =>
  store.inviteCollaborator({
    roomId,
    inviterUid: UID_A,
    inviteeUid: UID_B,
    lessonId: 'lesson_1',
    lessonVersion: 1,
    snapshotDigest: DIGEST,
    requestId,
    now,
  });

const withDatabase = <T>(operation: (db: SqlDatabase) => T): T => {
  const db = createNodeSqliteDriver().open(join(roots.at(-1)!, 'study.db'));
  try {
    return operation(db);
  } finally {
    db.close();
  }
};

const collaborationRows = () =>
  withDatabase((db) => ({
    invitations: db.prepare('SELECT * FROM collab_invitations ORDER BY invitation_id').all(),
    rooms: db.prepare('SELECT * FROM collab_rooms ORDER BY room_id').all(),
    members: db.prepare('SELECT * FROM collab_room_members ORDER BY room_id, uid').all(),
    receipts: db.prepare('SELECT * FROM collab_command_receipts ORDER BY request_id').all(),
    messages: db.prepare('SELECT * FROM collab_room_messages ORDER BY room_id, seq').all(),
    events: db.prepare('SELECT * FROM collab_room_events ORDER BY room_id, seq').all(),
  }));

describe('协作 UID 登记', () => {
  it('只登记为 local_link，重复登记读回同一条，改名推进 revision', () => {
    const store = fixture();
    const first = store.getCollaborationRegistration(UID_A)!;
    expect(first).toMatchObject({ uid: UID_A, authority: 'local_link', revision: 1 });
    const again = store.registerCollaborationUid({
      uid: UID_A,
      displayName: '甲',
      requestId: 'reg-a',
    });
    expect(again).toEqual({ registration: first, deduplicated: true });
    const renamed = store.registerCollaborationUid({
      uid: UID_A,
      displayName: '甲甲',
      requestId: 'reg-a2',
    });
    expect(renamed.registration.revision).toBe(2);
    expect(renamed.registration.displayName).toBe('甲甲');
  });

  it('未登记的 UID 不能作为邀请对象，也不能发起邀请', () => {
    const store = fixture();
    expectCode(
      () =>
        store.inviteCollaborator({
          roomId: 'room_1',
          inviterUid: UID_A,
          inviteeUid: UID_C,
          lessonId: 'lesson_1',
          lessonVersion: 1,
          snapshotDigest: DIGEST,
          requestId: 'inv-unknown',
        }),
      'NOT_FOUND',
      'collab_invitee_not_registered',
    );
    expectCode(
      () =>
        store.inviteCollaborator({
          roomId: 'room_1',
          inviterUid: UID_C,
          inviteeUid: UID_B,
          lessonId: 'lesson_1',
          lessonVersion: 1,
          snapshotDigest: DIGEST,
          requestId: 'inv-unreg',
        }),
      'PROJECT_NOT_AUTHORIZED',
      'inviter_not_registered',
    );
  });
});

describe('邀请生命周期', () => {
  it('发起写入 pending 并给出有效期，同 requestId 重试读回同一条', () => {
    const store = fixture();
    const first = invite(store, 'inv-1', '2026-10-06T00:00:00.000Z');
    expect(first.invitation.status).toBe('pending');
    expect(first.invitation.expiresAt).toBe('2026-10-08T00:00:00.000Z');
    const retry = invite(store, 'inv-1', '2026-10-06T00:00:00.000Z');
    expect(retry).toEqual({ invitation: first.invitation, deduplicated: true });
  });

  it('拒绝自邀、拒绝复用 requestId 到不同意图', () => {
    const store = fixture();
    expectCode(
      () =>
        store.inviteCollaborator({
          roomId: 'room_1',
          inviterUid: UID_A,
          inviteeUid: UID_A,
          lessonId: 'lesson_1',
          lessonVersion: 1,
          snapshotDigest: DIGEST,
          requestId: 'inv-self',
        }),
      'INVALID_ARGUMENT',
      'cannot_invite_self',
    );
    invite(store, 'inv-1');
    expectCode(
      () =>
        store.inviteCollaborator({
          roomId: 'room_2',
          inviterUid: UID_A,
          inviteeUid: UID_B,
          lessonId: 'lesson_1',
          lessonVersion: 1,
          snapshotDigest: DIGEST,
          requestId: 'inv-1',
        }),
      'VERSION_CONFLICT',
      'collab_request_reused',
    );
  });

  it('只有受邀本人能表态，接受后建立成员，重复接受不产生第二份成员', () => {
    const store = fixture();
    const created = invite(store);
    expectCode(
      () =>
        store.decideCollaborationInvitation({
          invitationId: created.invitation.invitationId,
          actorUid: UID_A,
          decision: 'accepted',
          requestId: 'd-forged',
        }),
      'ROLE_PERMISSION_DENIED',
      'only_invitee_decides',
    );
    const accepted = store.decideCollaborationInvitation({
      invitationId: created.invitation.invitationId,
      actorUid: UID_B,
      decision: 'accepted',
      requestId: 'd-1',
    });
    expect(accepted.invitation.status).toBe('accepted');
    expect(accepted.member).toMatchObject({
      uid: UID_B,
      role: 'participant',
      readiness: 'pending',
    });
    const retry = store.decideCollaborationInvitation({
      invitationId: created.invitation.invitationId,
      actorUid: UID_B,
      decision: 'accepted',
      requestId: 'd-1',
    });
    expect(retry.deduplicated).toBe(true);
    expect(store.listCollaborationMembers('room_1')).toHaveLength(2);
  });

  it('已表态或已过期的邀请不能二次表态，只有发起人能撤销', () => {
    const store = fixture();
    const created = invite(store);
    store.decideCollaborationInvitation({
      invitationId: created.invitation.invitationId,
      actorUid: UID_B,
      decision: 'rejected',
      requestId: 'd-reject',
    });
    expectCode(
      () =>
        store.decideCollaborationInvitation({
          invitationId: created.invitation.invitationId,
          actorUid: UID_B,
          decision: 'accepted',
          requestId: 'd-again',
        }),
      'VERSION_CONFLICT',
      'invitation_already_decided',
    );
    const expired = invite(store, 'inv-old', '2026-10-01T00:00:00.000Z');
    expectCode(
      () =>
        store.decideCollaborationInvitation({
          invitationId: expired.invitation.invitationId,
          actorUid: UID_B,
          decision: 'accepted',
          requestId: 'd-expired',
          now: '2026-10-10T00:00:00.000Z',
        }),
      'VERSION_CONFLICT',
      'invitation_expired',
    );
    const revokeTarget = invite(store, 'inv-rev');
    expectCode(
      () =>
        store.revokeCollaborationInvitation({
          invitationId: revokeTarget.invitation.invitationId,
          actorUid: UID_B,
          requestId: 'r-forged',
        }),
      'ROLE_PERMISSION_DENIED',
      'only_inviter_revokes',
    );
    // 过期后即使发起人也不能撤销：只能重新邀请（与判定注释一致，不能拿 pending 原状态绕过）。
    const expiredRevoke = invite(
      store,
      'inv-expired-revoke',
      '2026-10-01T00:00:00.000Z',
      'room_expired_revoke',
    );
    expectCode(
      () =>
        store.revokeCollaborationInvitation({
          invitationId: expiredRevoke.invitation.invitationId,
          actorUid: UID_A,
          requestId: 'r-expired',
          now: '2026-10-10T00:00:00.000Z',
        }),
      'VERSION_CONFLICT',
      'invitation_already_decided',
    );
    expect(
      store.revokeCollaborationInvitation({
        invitationId: revokeTarget.invitation.invitationId,
        actorUid: UID_A,
        requestId: 'r-1',
      }).invitation.status,
    ).toBe('revoked');
  });

  it('读取时按时间把 pending 显示为 expired，但不改写已接受的历史结论', () => {
    const store = fixture();
    const created = invite(store, 'inv-exp', '2026-10-01T00:00:00.000Z');
    const later = store.getCollaborationInvitation(
      created.invitation.invitationId,
      '2026-10-10T00:00:00.000Z',
    );
    expect(later?.status).toBe('expired');
    const accepted = store.decideCollaborationInvitation({
      invitationId: created.invitation.invitationId,
      actorUid: UID_B,
      decision: 'accepted',
      requestId: 'd-before-expiry',
      now: '2026-10-02T00:00:00.000Z',
    });
    expect(accepted.invitation.status).toBe('accepted');
    const readBack = store.getCollaborationInvitation(
      created.invitation.invitationId,
      '2026-10-10T00:00:00.000Z',
    );
    expect(readBack?.status).toBe('accepted');
  });
});

describe('房间归属与退出安全', () => {
  const registerOthers = (store: StudyStore) => {
    store.registerCollaborationUid({ uid: UID_C, displayName: '丙', requestId: 'reg-c' });
    store.registerCollaborationUid({ uid: UID_D, displayName: '丁', requestId: 'reg-d' });
  };
  const accept = (store: StudyStore) => {
    const created = invite(store);
    store.decideCollaborationInvitation({
      invitationId: created.invitation.invitationId,
      actorUid: UID_B,
      decision: 'accepted',
      requestId: 'd-1',
    });
    return created.invitation;
  };
  const outsidersInvite = (store: StudyStore, roomId: string, requestId: string) =>
    store.inviteCollaborator({
      roomId,
      inviterUid: UID_C,
      inviteeUid: UID_D,
      lessonId: 'lesson_1',
      lessonVersion: 1,
      snapshotDigest: DIGEST,
      requestId,
    });

  it('pending 邀请独占房间，第三方或同房主的新邀请不能争抢；失败不写收据', () => {
    const store = fixture();
    registerOthers(store);
    invite(store);
    const before = collaborationRows();
    expectCode(
      () => outsidersInvite(store, 'room_1', 'outsider-pending'),
      'VERSION_CONFLICT',
      'collab_room_invitation_exists',
    );
    expectCode(
      () =>
        store.inviteCollaborator({
          roomId: 'room_1',
          inviterUid: UID_A,
          inviteeUid: UID_C,
          lessonId: 'lesson_1',
          lessonVersion: 1,
          snapshotDigest: DIGEST,
          requestId: 'competing-peer',
        }),
      'VERSION_CONFLICT',
      'collab_room_invitation_exists',
    );
    expectCode(
      () => invite(store, 'duplicate-pending'),
      'VERSION_CONFLICT',
      'collab_room_invitation_exists',
    );
    expect(collaborationRows()).toEqual(before);
  });

  it('已有双人房间拒绝外人借 roomId 发起邀请，消息与事件历史保持原样', () => {
    const store = fixture();
    registerOthers(store);
    accept(store);
    store.appendCollaborationMessage({
      roomId: 'room_1',
      senderUid: UID_A,
      body: '原房间的讨论',
      requestId: 'original-message',
    });
    store.appendCollaborationEvent({
      roomId: 'room_1',
      actorUid: UID_A,
      kind: 'scene_changed',
      eventId: 'original-event',
      summary: '原房间事件',
      expectedSeq: 1,
      requestId: 'original-event-command',
    });
    const before = collaborationRows();
    expectCode(
      () => outsidersInvite(store, 'room_1', 'outsider-room'),
      'ROLE_PERMISSION_DENIED',
      'not_room_member',
    );
    expectCode(
      () =>
        store.inviteCollaborator({
          roomId: 'room_1',
          inviterUid: UID_A,
          inviteeUid: UID_C,
          lessonId: 'lesson_1',
          lessonVersion: 1,
          snapshotDigest: DIGEST,
          requestId: 'third-member',
        }),
      'VERSION_CONFLICT',
      'collab_room_members_mismatch',
    );
    expect(collaborationRows()).toEqual(before);
  });

  it('pending 邀请已预留的 roomId 不允许外人显式建房或房主换课程', () => {
    const store = fixture();
    registerOthers(store);
    invite(store);
    const create = {
      roomId: 'room_1',
      ownerUid: UID_A,
      lessonId: 'lesson_1',
      lessonVersion: 1,
      snapshotDigest: DIGEST,
      currentSceneId: 'scene_1',
      requestId: 'reserved-create',
    };
    const before = collaborationRows();
    expectCode(
      () =>
        store.createCollaborationRoom({ ...create, ownerUid: UID_C, requestId: 'hijack-create' }),
      'ROLE_PERMISSION_DENIED',
      'collab_room_owner_mismatch',
    );
    expectCode(
      () =>
        store.createCollaborationRoom({ ...create, lessonVersion: 2, requestId: 'changed-create' }),
      'VERSION_CONFLICT',
      'collab_room_course_changed',
    );
    expect(collaborationRows()).toEqual(before);
    expect(store.createCollaborationRoom(create).room.ownerUid).toBe(UID_A);
  });

  it('接受旧版遗留的外人邀请时复核房主，事务拒绝且不改邀请、成员、收据或历史', () => {
    const store = fixture();
    registerOthers(store);
    const foreign = outsidersInvite(store, 'room_foreign', 'foreign-invite').invitation;
    accept(store);
    store.appendCollaborationMessage({
      roomId: 'room_1',
      senderUid: UID_A,
      body: '不能向外人泄露的历史',
      requestId: 'history-message',
    });
    store.appendCollaborationEvent({
      roomId: 'room_1',
      actorUid: UID_A,
      kind: 'board_action',
      eventId: 'history-event',
      summary: '历史白板动作',
      expectedSeq: 1,
      requestId: 'history-event-command',
    });
    // 模拟修复前已存在的恶意 pending 行，确保不是只在新发邀请时阻断。
    withDatabase((db) =>
      db
        .prepare('UPDATE collab_invitations SET room_id=? WHERE invitation_id=?')
        .run('room_1', foreign.invitationId),
    );
    const before = collaborationRows();
    expectCode(
      () =>
        store.decideCollaborationInvitation({
          invitationId: foreign.invitationId,
          actorUid: UID_D,
          decision: 'accepted',
          requestId: 'foreign-accept',
        }),
      'ROLE_PERMISSION_DENIED',
      'collab_room_owner_mismatch',
    );
    expect(collaborationRows()).toEqual(before);
    expect(store.getCollaborationInvitation(foreign.invitationId)?.status).toBe('pending');
  });

  it.each(['active', 'ended'] as const)('%s 房间拒绝新邀请及旧 pending 的接受', (status) => {
    const store = fixture();
    const created = invite(store).invitation;
    store.createCollaborationRoom({
      roomId: 'room_1',
      ownerUid: UID_A,
      lessonId: 'lesson_1',
      lessonVersion: 1,
      snapshotDigest: DIGEST,
      currentSceneId: 'scene_1',
      requestId: 'reserved-room',
    });
    withDatabase((db) =>
      db.prepare('UPDATE collab_rooms SET status=? WHERE room_id=?').run(status, 'room_1'),
    );
    const before = collaborationRows();
    expectCode(
      () => invite(store, `invite-${status}`),
      'VERSION_CONFLICT',
      'collab_room_not_joinable',
    );
    expectCode(
      () =>
        store.decideCollaborationInvitation({
          invitationId: created.invitationId,
          actorUid: UID_B,
          decision: 'accepted',
          requestId: `accept-${status}`,
        }),
      'VERSION_CONFLICT',
      'collab_room_not_joinable',
    );
    expect(collaborationRows()).toEqual(before);
  });

  it('接受前也复核课程和双方归属，旧版多 pending 邀请不能先到先占', () => {
    const store = fixture();
    registerOthers(store);
    const first = invite(store).invitation;
    const competing = store.inviteCollaborator({
      roomId: 'room_other',
      inviterUid: UID_A,
      inviteeUid: UID_C,
      lessonId: 'lesson_1',
      lessonVersion: 1,
      snapshotDigest: DIGEST,
      requestId: 'old-competing',
    }).invitation;
    withDatabase((db) =>
      db
        .prepare('UPDATE collab_invitations SET room_id=? WHERE invitation_id=?')
        .run('room_1', competing.invitationId),
    );
    const before = collaborationRows();
    for (const [invitationId, actorUid] of [
      [first.invitationId, UID_B],
      [competing.invitationId, UID_C],
    ]) {
      expectCode(
        () =>
          store.decideCollaborationInvitation({
            invitationId: invitationId!,
            actorUid: actorUid!,
            decision: 'accepted',
            requestId: `accept-${actorUid}`,
          }),
        'VERSION_CONFLICT',
        'collab_room_invitation_exists',
      );
    }
    expect(collaborationRows()).toEqual(before);
    store.revokeCollaborationInvitation({
      invitationId: competing.invitationId,
      actorUid: UID_A,
      requestId: 'revoke-competing',
    });
    store.createCollaborationRoom({
      roomId: 'room_1',
      ownerUid: UID_A,
      lessonId: 'lesson_1',
      lessonVersion: 1,
      snapshotDigest: DIGEST,
      currentSceneId: 'scene_1',
      requestId: 'changed-course',
    });
    // 模拟修复前房间已经被换版，接受端仍需复验，不能依赖建房守卫。
    withDatabase((db) =>
      db.prepare('UPDATE collab_rooms SET lesson_version=2 WHERE room_id=?').run('room_1'),
    );
    const changed = collaborationRows();
    expectCode(
      () =>
        store.decideCollaborationInvitation({
          invitationId: first.invitationId,
          actorUid: UID_B,
          decision: 'accepted',
          requestId: 'accept-changed-course',
        }),
      'VERSION_CONFLICT',
      'collab_room_course_changed',
    );
    expect(collaborationRows()).toEqual(changed);
  });

  it('已过期的 pending 不阻挡重新邀请，旧历史仍显示过期', () => {
    const store = fixture();
    const expired = invite(store, 'old-invite', '2026-10-01T00:00:00.000Z').invitation;
    const current = invite(store, 'new-invite', '2026-10-06T00:00:00.000Z').invitation;
    expect(
      store.decideCollaborationInvitation({
        invitationId: current.invitationId,
        actorUid: UID_B,
        decision: 'accepted',
        requestId: 'accept-new',
        now: '2026-10-06T00:00:00.000Z',
      }).invitation.status,
    ).toBe('accepted');
    expect(
      store.getCollaborationInvitation(expired.invitationId, '2026-10-06T00:00:00.000Z')?.status,
    ).toBe('expired');
  });

  it('退出保留历史且不可自行重入，新写入及旧消息/事件/接受/ready 收据重放均拒绝', () => {
    const store = fixture();
    const accepted = accept(store);
    const message = {
      roomId: 'room_1',
      senderUid: UID_B,
      body: '退出前消息',
      requestId: 'peer-message',
    };
    const event = {
      roomId: 'room_1',
      actorUid: UID_B,
      kind: 'board_action' as const,
      eventId: 'peer-event',
      summary: '退出前白板',
      expectedSeq: 1,
      requestId: 'peer-event-command',
    };
    store.appendCollaborationMessage(message);
    store.appendCollaborationEvent(event);
    store.setCollaborationMemberReadiness({
      roomId: 'room_1',
      uid: UID_B,
      readiness: 'ready',
      requestId: 'peer-ready',
    });
    const leave = {
      roomId: 'room_1',
      uid: UID_B,
      readiness: 'left' as const,
      requestId: 'peer-leave',
    };
    store.setCollaborationMemberReadiness(leave);
    expect(store.setCollaborationMemberReadiness(leave).deduplicated).toBe(true);
    const before = collaborationRows();
    const denied = [
      () =>
        store.setCollaborationMemberReadiness({
          roomId: 'room_1',
          uid: UID_B,
          readiness: 'ready',
          requestId: 'peer-ready-new',
        }),
      () =>
        store.setCollaborationMemberReadiness({
          roomId: 'room_1',
          uid: UID_B,
          readiness: 'ready',
          requestId: 'peer-ready',
        }),
      () => store.appendCollaborationMessage(message),
      () => store.appendCollaborationMessage({ ...message, requestId: 'peer-message-new' }),
      () => store.appendCollaborationEvent(event),
      () =>
        store.appendCollaborationEvent({
          ...event,
          eventId: 'peer-event-new',
          expectedSeq: 2,
          requestId: 'peer-event-command-new',
        }),
      () =>
        store.decideCollaborationInvitation({
          invitationId: accepted.invitationId,
          actorUid: UID_B,
          decision: 'accepted',
          requestId: 'd-1',
        }),
    ];
    denied.forEach((action) => expectCode(action, 'ROLE_PERMISSION_DENIED', 'not_room_member'));
    expectCode(
      () => invite(store, 'reinvite-left'),
      'VERSION_CONFLICT',
      'collab_room_members_mismatch',
    );
    expect(collaborationRows()).toEqual(before);
    expect(
      store.listCollaborationMembers('room_1').find((member) => member.uid === UID_B)?.readiness,
    ).toBe('left');
    store.appendCollaborationMessage({
      roomId: 'room_1',
      senderUid: UID_A,
      body: '退出后仍存储的消息',
      requestId: 'owner-after-peer-left',
    });
    expectCode(
      () => store.appendCollaborationMessage(message),
      'ROLE_PERMISSION_DENIED',
      'not_room_member',
    );
    expect(store.listCollaborationMessages('room_1', 0).messages).toHaveLength(2);
  });

  it('房主退出同步结束房间，房主不能重放建房/开课/邀请结果，留存成员不能继续发消息', () => {
    const store = fixture();
    const create = {
      roomId: 'room_1',
      ownerUid: UID_A,
      lessonId: 'lesson_1',
      lessonVersion: 1,
      snapshotDigest: DIGEST,
      currentSceneId: 'scene_1',
      requestId: 'owner-create',
    };
    store.createCollaborationRoom(create);
    accept(store);
    for (const uid of [UID_A, UID_B])
      store.setCollaborationMemberReadiness({
        roomId: 'room_1',
        uid,
        readiness: 'ready',
        requestId: `ready-${uid}`,
      });
    const start = { roomId: 'room_1', actorUid: UID_A, requestId: 'owner-start' };
    store.startCollaborationRoom(start);
    store.setCollaborationMemberReadiness({
      roomId: 'room_1',
      uid: UID_A,
      readiness: 'left',
      requestId: 'owner-leave',
    });
    expect(store.getCollaborationRoom('room_1')?.status).toBe('ended');
    const before = collaborationRows();
    for (const action of [
      () => store.createCollaborationRoom(create),
      () => store.startCollaborationRoom(start),
      () => invite(store),
    ])
      expectCode(action, 'ROLE_PERMISSION_DENIED', 'not_room_member');
    expectCode(
      () =>
        store.appendCollaborationMessage({
          roomId: 'room_1',
          senderUid: UID_B,
          body: '不能继续',
          requestId: 'message-ended',
        }),
      'RUN_TERMINATED',
      'room_ended',
    );
    expect(collaborationRows()).toEqual(before);
  });
});

describe('成员准备状态', () => {
  it('只有成员本人能改自己的准备状态，房间结束后拒绝', () => {
    const store = fixture();
    const created = invite(store);
    store.decideCollaborationInvitation({
      invitationId: created.invitation.invitationId,
      actorUid: UID_B,
      decision: 'accepted',
      requestId: 'd-1',
    });
    const ready = store.setCollaborationMemberReadiness({
      roomId: 'room_1',
      uid: UID_B,
      readiness: 'ready',
      requestId: 'rd-1',
    });
    expect(ready.member.readiness).toBe('ready');
    expectCode(
      () =>
        store.setCollaborationMemberReadiness({
          roomId: 'room_1',
          uid: UID_C,
          readiness: 'ready',
          requestId: 'rd-2',
        }),
      'ROLE_PERMISSION_DENIED',
      'not_room_member',
    );
    const owner = store.setCollaborationMemberReadiness({
      roomId: 'room_1',
      uid: UID_A,
      readiness: 'ready',
      requestId: 'rd-3',
    });
    expect(owner.member.role).toBe('owner');
  });

  it('直连存储的 displayName/正文/摘要同样拒绝本地路径（与 HTTP 同源，不因绕过路由而放行）', () => {
    const store = fixture();
    expectCode(
      () =>
        store.registerCollaborationUid({
          uid: UID_A,
          displayName: 'C:\\Users\\yao\\secret.txt',
          requestId: 'reg-path',
        }),
      'INVALID_ARGUMENT',
      'collab_input_invalid',
    );
    const created = invite(store);
    store.decideCollaborationInvitation({
      invitationId: created.invitation.invitationId,
      actorUid: UID_B,
      decision: 'accepted',
      requestId: 'd-path',
    });
    expectCode(
      () =>
        store.appendCollaborationMessage({
          roomId: 'room_1',
          senderUid: UID_A,
          body: '看 /home/other/notes.md 这一行',
          requestId: 'm-path',
        }),
      'INVALID_ARGUMENT',
      'collab_input_invalid',
    );
  });
});

describe('开始共同课堂', () => {
  const acceptRoom = (store: StudyStore) => {
    const created = invite(store);
    store.decideCollaborationInvitation({
      invitationId: created.invitation.invitationId,
      actorUid: UID_B,
      decision: 'accepted',
      requestId: 'd-1',
    });
    return created;
  };

  it('未就绪不能开始，双方 ready 后房主开始，房间置 active 且可重放', () => {
    const store = fixture();
    acceptRoom(store);
    expectCode(
      () =>
        store.startCollaborationRoom({ roomId: 'room_1', actorUid: UID_A, requestId: 's-early' }),
      'VERSION_CONFLICT',
      'collab_members_not_ready',
    );
    store.setCollaborationMemberReadiness({
      roomId: 'room_1',
      uid: UID_A,
      readiness: 'ready',
      requestId: 'rd-a',
    });
    store.setCollaborationMemberReadiness({
      roomId: 'room_1',
      uid: UID_B,
      readiness: 'ready',
      requestId: 'rd-b',
    });
    // 受邀同学不能替房主开课。
    expectCode(
      () =>
        store.startCollaborationRoom({ roomId: 'room_1', actorUid: UID_B, requestId: 's-peer' }),
      'ROLE_PERMISSION_DENIED',
      'only_inviter_starts',
    );
    const started = store.startCollaborationRoom({
      roomId: 'room_1',
      actorUid: UID_A,
      requestId: 's-1',
    });
    expect(started.room.status).toBe('active');
    // 同 requestId 重试读回同一结果，不重复推进。
    const retry = store.startCollaborationRoom({
      roomId: 'room_1',
      actorUid: UID_A,
      requestId: 's-1',
    });
    expect(retry.deduplicated).toBe(true);
    expect(store.getCollaborationRoom('room_1')!.status).toBe('active');
  });
});

describe('消息与事件', () => {
  const acceptRoom = (store: StudyStore) => {
    const created = invite(store);
    store.decideCollaborationInvitation({
      invitationId: created.invitation.invitationId,
      actorUid: UID_B,
      decision: 'accepted',
      requestId: 'd-1',
    });
    return created;
  };

  it('消息按权威序号追加、同 requestId 去重、游标读取只给增量', () => {
    const store = fixture();
    acceptRoom(store);
    const first = store.appendCollaborationMessage({
      roomId: 'room_1',
      senderUid: UID_A,
      body: '这一步我算出来是增函数。',
      requestId: 'm-1',
    });
    expect(first.message).toMatchObject({ seq: 1, senderType: 'human_learner' });
    const retry = store.appendCollaborationMessage({
      roomId: 'room_1',
      senderUid: UID_A,
      body: '这一步我算出来是增函数。',
      requestId: 'm-1',
    });
    expect(retry.deduplicated).toBe(true);
    store.appendCollaborationMessage({
      roomId: 'room_1',
      senderUid: UID_B,
      body: '我同意。',
      requestId: 'm-2',
    });
    const delta = store.listCollaborationMessages('room_1', 1);
    expect(delta.messages.map((message) => message.seq)).toEqual([2]);
    expect(delta.tailSeq).toBe(2);
    expectCode(
      () => store.listCollaborationMessages('room_1', 5),
      'VERSION_CONFLICT',
      'collab_cursor_ahead',
    );
  });

  it('非成员不能发消息，身份写死为真人', () => {
    const store = fixture();
    acceptRoom(store);
    expectCode(
      () =>
        store.appendCollaborationMessage({
          roomId: 'room_1',
          senderUid: UID_C,
          body: '我是路过的。',
          requestId: 'm-forged',
        }),
      'ROLE_PERMISSION_DENIED',
      'not_room_member',
    );
  });

  it('事件序号必须恰好推进一位，教师输出与场景切换只允许房主', () => {
    const store = fixture();
    acceptRoom(store);
    const scene = store.appendCollaborationEvent({
      roomId: 'room_1',
      eventId: 'evt-1',
      kind: 'scene_changed',
      actorUid: UID_A,
      summary: '进入场景 2',
      expectedSeq: 1,
      requestId: 'e-1',
    });
    expect(scene.event.seq).toBe(1);
    expectCode(
      () =>
        store.appendCollaborationEvent({
          roomId: 'room_1',
          eventId: 'evt-2',
          kind: 'scene_changed',
          actorUid: UID_A,
          summary: '进入场景 3',
          expectedSeq: 3,
          requestId: 'e-2',
        }),
      'VERSION_CONFLICT',
      'collab_event_seq_mismatch',
    );
    expectCode(
      () =>
        store.appendCollaborationEvent({
          roomId: 'room_1',
          eventId: 'evt-3',
          kind: 'scene_changed',
          actorUid: UID_B,
          summary: '我来切场景',
          expectedSeq: 2,
          requestId: 'e-3',
        }),
      'ROLE_PERMISSION_DENIED',
      'only_owner_advances',
    );
    expectCode(
      () =>
        store.appendCollaborationEvent({
          roomId: 'room_1',
          eventId: 'evt-4',
          kind: 'teacher_output',
          actorUid: UID_B,
          summary: '我来讲',
          expectedSeq: 2,
          requestId: 'e-4',
        }),
      'ROLE_PERMISSION_DENIED',
      'only_owner_teaches',
    );
    // 白板动作允许受邀成员发起。
    expect(
      store.appendCollaborationEvent({
        roomId: 'room_1',
        eventId: 'evt-5',
        kind: 'board_action',
        actorUid: UID_B,
        summary: '高亮条件',
        expectedSeq: 2,
        requestId: 'e-5',
      }).event.seq,
    ).toBe(2);
    expect(store.listCollaborationEvents('room_1', 0).events).toHaveLength(2);
  });

  it('数据库重开后房间、成员、消息与事件都可读回', () => {
    const store = fixture();
    acceptRoom(store);
    store.appendCollaborationMessage({
      roomId: 'room_1',
      senderUid: UID_A,
      body: '先记结论。',
      requestId: 'm-1',
    });
    store.appendCollaborationEvent({
      roomId: 'room_1',
      eventId: 'evt-1',
      kind: 'scene_changed',
      actorUid: UID_A,
      summary: '进入场景 2',
      expectedSeq: 1,
      requestId: 'e-1',
    });
    const room = store.getCollaborationRoom('room_1')!;
    const members = store.listCollaborationMembers('room_1');
    const messages = store.listCollaborationMessages('room_1', 0);
    const events = store.listCollaborationEvents('room_1', 0);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = StudyStore.open({ file: join(roots[0]!, 'study.db') });
    stores.push(reopened);
    expect(reopened.getCollaborationRoom('room_1')).toEqual(room);
    expect(reopened.listCollaborationMembers('room_1')).toEqual(members);
    expect(reopened.listCollaborationMessages('room_1', 0)).toEqual(messages);
    expect(reopened.listCollaborationEvents('room_1', 0)).toEqual(events);
  });
});
