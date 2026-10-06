import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyError, type ClassroomSharedCourseDto } from '@sew/study-contracts';
import { CollabServiceStore, createNodeSqliteDriver } from '@sew/study-storage';

/**
 * 独立协作服务的存储（ADR-0005 在线部分）。
 *
 * 覆盖：在线登记 authority=online 与幂等、凭据轮换/吊销/认证、结构化场景同步的
 * 原子提交与乐观并发、共享快照上传/下载与隐私投影、以及非成员/越权负例。
 * 这些是**独立服务库**的回归；双客户端真实链路见 tests/collab-two-client-link.test.ts。
 */

const UID_A = 'uid_10000000-0000-4000-8000-000000000001';
const UID_B = 'uid_10000000-0000-4000-8000-000000000002';
const UID_C = 'uid_10000000-0000-4000-8000-000000000003';
const SECRET_A = 'a'.repeat(64);
const SECRET_A2 = 'b'.repeat(64);
const DIGEST = 'd'.repeat(64);
const ROOM = 'room_online_1';
const roots: string[] = [];
const stores: CollabServiceStore[] = [];
const claims = new WeakMap<CollabServiceStore, Map<string, string>>();

const activationFor = (store: CollabServiceStore, uid: string): string => {
  const tokens = claims.get(store) ?? new Map<string, string>();
  claims.set(store, tokens);
  const token = tokens.get(uid) ?? store.issueRegistrationClaim(uid);
  tokens.set(uid, token);
  return token;
};

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const openStore = (): CollabServiceStore => {
  const root = mkdtempSync(join(tmpdir(), 'sew-collab-service-'));
  roots.push(root);
  const store = CollabServiceStore.open({ file: join(root, 'collab.db') });
  stores.push(store);
  return store;
};

const expectReason = (action: () => unknown, code: string, reason: string): void => {
  try {
    action();
  } catch (error) {
    expect((error as StudyError).code).toBe(code);
    expect((error as StudyError).details?.['reason']).toBe(reason);
    return;
  }
  throw new Error(`预期抛出 ${code}/${reason}，但调用成功了`);
};

const register = (
  store: CollabServiceStore,
  uid: string,
  credentialId: string,
  secret: string,
  requestId: string,
) =>
  store.registerOnline({
    uid,
    displayName: uid === UID_A ? '甲' : '乙',
    credentialId,
    secret,
    activationToken: activationFor(store, uid),
    proof: null,
    requestId,
  });

const snapshotFixture = (): ClassroomSharedCourseDto => ({
  snapshotVersion: 1,
  course: {
    lessonId: 'lesson_1',
    lessonVersion: 1,
    title: '单调性',
    stageId: 'stage_1',
    dslVersion: '0.11.2',
    documentDigest: DIGEST,
    bundleDigest: DIGEST,
  },
  scenes: [
    {
      sceneId: 'scene_1',
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
          text: '内容',
        },
      ],
    },
  ],
  evidence: {
    planVersion: 1,
    knowledgeVersions: [{ knowledgeId: 'k1', revision: 0 }],
    statements: [],
    segments: [
      { materialId: 'm1', revision: 1, segmentId: 'S001', fingerprint: DIGEST, text: '文本' },
    ],
  },
  sceneSources: [{ sceneId: 'scene_1', knowledgeIds: ['k1'], questionId: null }],
  assets: [],
});

/** 建好一个双方已 ready 并开始的房间，返回快照。 */
const readyRoom = (store: CollabServiceStore) => {
  register(store, UID_A, 'cred_a', SECRET_A, 'reg-a');
  register(store, UID_B, 'cred_b', 'c'.repeat(64), 'reg-b');
  const invitation = store.collaboration.invite({
    roomId: ROOM,
    inviterUid: UID_A,
    inviteeUid: UID_B,
    lessonId: 'lesson_1',
    lessonVersion: 1,
    snapshotDigest: DIGEST,
    requestId: 'inv-1',
  }).invitation;
  store.collaboration.decide({
    invitationId: invitation.invitationId,
    actorUid: UID_B,
    decision: 'accepted',
    requestId: 'acc-1',
  });
  store.collaboration.setReadiness({
    roomId: ROOM,
    uid: UID_A,
    readiness: 'ready',
    requestId: 'r-a',
  });
  store.collaboration.setReadiness({
    roomId: ROOM,
    uid: UID_B,
    readiness: 'ready',
    requestId: 'r-b',
  });
  return store.collaboration.startRoom({ roomId: ROOM, actorUid: UID_A, requestId: 'start-1' })
    .room;
};

describe('独立协作服务：在线登记与凭据', () => {
  it('公开 UID 无法抢注，激活令牌不能跨 UID 使用或替代本人凭据', () => {
    const store = openStore();
    const command = {
      uid: UID_A,
      displayName: '甲',
      credentialId: 'attacker',
      secret: SECRET_A,
      proof: null,
      requestId: 'steal-uid',
    };
    expectReason(
      () => store.registerOnline(command),
      'PROJECT_NOT_AUTHORIZED',
      'collab_enrollment_required',
    );
    const tokenA = activationFor(store, UID_A);
    expectReason(
      () => store.registerOnline({ ...command, uid: UID_B, activationToken: tokenA }),
      'PROJECT_NOT_AUTHORIZED',
      'collab_enrollment_required',
    );
    register(store, UID_A, 'cred_a', SECRET_A, 'reg-a');
    expectReason(
      () => store.registerOnline({ ...command, activationToken: tokenA }),
      'PROJECT_NOT_AUTHORIZED',
      'collab_registration_proof_required',
    );
    expectReason(
      () => store.issueRegistrationClaim(UID_A),
      'VERSION_CONFLICT',
      'collab_uid_already_registered',
    );
    expectReason(
      () =>
        store.registerOnline({
          ...command,
          credentialId: 'cred_a',
          requestId: 'reg-a',
          activationToken: tokenA,
          secret: SECRET_A2,
        }),
      'VERSION_CONFLICT',
      'collab_request_reused',
    );
  });
  it('登记写入 authority=online；重复登记幂等；新增凭据必须带证明', () => {
    const store = openStore();
    const first = register(store, UID_A, 'cred_a', SECRET_A, 'reg-a');
    expect(first.registration.authority).toBe('online');
    expect(first.registration.credentialId).toBe('cred_a');
    expect(first.deduplicated).toBe(false);

    // 同一 credentialId 重复登记：幂等读回，不重复占用。
    const again = register(store, UID_A, 'cred_a', SECRET_A, 'reg-a-2');
    expect(again.deduplicated).toBe(true);
    expect(again.registration.credentialId).toBe('cred_a');

    // 同一 UID 追加凭据但无证明：拒绝。
    expectReason(
      () => register(store, UID_A, 'cred_a2', SECRET_A2, 'reg-a2'),
      'PROJECT_NOT_AUTHORIZED',
      'collab_registration_proof_required',
    );
    // 带有效证明追加：通过。
    const added = store.registerOnline({
      uid: UID_A,
      displayName: '甲',
      credentialId: 'cred_a2',
      secret: SECRET_A2,
      proof: { credentialId: 'cred_a', secret: SECRET_A },
      requestId: 'reg-a2-proof',
    });
    expect(added.credential.credentialId).toBe('cred_a2');
    expect(store.listCredentials(UID_A)).toHaveLength(2);
  });

  it('认证只认一致秘密；吊销后一律拒绝；不能吊销他人凭据', () => {
    const store = openStore();
    register(store, UID_A, 'cred_a', SECRET_A, 'reg-a');
    expect(store.verifyCredential('cred_a', SECRET_A)?.uid).toBe(UID_A);
    expect(store.verifyCredential('cred_a', SECRET_A2)).toBeNull();
    expect(store.verifyCredential('cred_unknown', SECRET_A)).toBeNull();

    expectReason(
      () =>
        store.revokeCredential({
          credentialId: 'cred_a',
          actorUid: UID_B,
          requestId: 'rev-forged',
        }),
      'ROLE_PERMISSION_DENIED',
      'collab_credential_not_owner',
    );
    const revoked = store.revokeCredential({
      credentialId: 'cred_a',
      actorUid: UID_A,
      requestId: 'rev-1',
    });
    expect(revoked.credential.status).toBe('revoked');
    expect(store.verifyCredential('cred_a', SECRET_A)).toBeNull();
    // 吊销幂等。
    expect(
      store.revokeCredential({ credentialId: 'cred_a', actorUid: UID_A, requestId: 'rev-1' })
        .deduplicated,
    ).toBe(true);
  });

  it('同一 requestId 重试登记读回既有结果（丢失响应后不伪报失败）', () => {
    const store = openStore();
    const first = register(store, UID_A, 'cred_a', SECRET_A, 'reg-a');
    expect(first.deduplicated).toBe(false);
    const retry = register(store, UID_A, 'cred_a', SECRET_A, 'reg-a');
    expect(retry.deduplicated).toBe(true);
    expect(retry.registration.credentialId).toBe('cred_a');
    expect(retry.credential.credentialId).toBe('cred_a');
    expect(store.listCredentials(UID_A)).toHaveLength(1);
  });

  it('凭据秘密永不落库：收据/列表序列化不含明文 secret', () => {
    const store = openStore();
    register(store, UID_A, 'cred_a', SECRET_A, 'reg-a');
    store.registerOnline({
      uid: UID_A,
      displayName: '甲',
      credentialId: 'cred_a2',
      secret: SECRET_A2,
      proof: { credentialId: 'cred_a', secret: SECRET_A },
      requestId: 'reg-a2',
    });
    const dump = JSON.stringify({
      credentials: store.listCredentials(UID_A),
      registration: store.collaboration.getRegistration(UID_A),
    });
    expect(dump).not.toContain(SECRET_A);
    expect(dump).not.toContain(SECRET_A2);
  });
});

describe('独立协作服务：结构化场景同步', () => {
  it('上传共享快照后可原子推进场景，房间状态/版本/事件一致，重复提交幂等', () => {
    const store = openStore();
    const room = readyRoom(store);
    expect(room.status).toBe('active');

    const uploaded = store.collaboration.uploadSnapshot({
      roomId: ROOM,
      actorUid: UID_A,
      snapshot: snapshotFixture(),
      snapshotDigest: DIGEST,
      requestId: 'snap-1',
    });
    expect(uploaded.snapshotDigest).toBe(DIGEST);

    const synced = store.collaboration.syncScene({
      roomId: ROOM,
      actorUid: UID_A,
      sceneId: 'scene_1',
      lessonId: 'lesson_1',
      lessonVersion: 1,
      expectedRevision: room.revision,
      expectedSeq: 1,
      eventId: 'evt-scene-1',
      requestId: 'sync-1',
    });
    expect(synced.room.currentSceneId).toBe('scene_1');
    expect(synced.room.revision).toBe(room.revision + 1);
    expect(synced.event.kind).toBe('scene_changed');
    expect(synced.event.seq).toBe(1);
    expect(synced.deduplicated).toBe(false);

    // 重复提交同一 requestId：读回既有结果，不推进第二个版本/事件。
    const retry = store.collaboration.syncScene({
      roomId: ROOM,
      actorUid: UID_A,
      sceneId: 'scene_1',
      lessonId: 'lesson_1',
      lessonVersion: 1,
      expectedRevision: room.revision,
      expectedSeq: 1,
      eventId: 'evt-scene-1',
      requestId: 'sync-1',
    });
    expect(retry.deduplicated).toBe(true);
    expect(store.collaboration.getRoom(ROOM)?.revision).toBe(room.revision + 1);
    expect(store.collaboration.listEvents(ROOM, 0).events).toHaveLength(1);
  });

  it('房间版本不符、课程身份不符、非房主、无快照场景都拒绝', () => {
    const store = openStore();
    const room = readyRoom(store);
    store.collaboration.uploadSnapshot({
      roomId: ROOM,
      actorUid: UID_A,
      snapshot: snapshotFixture(),
      snapshotDigest: DIGEST,
      requestId: 'snap-1',
    });
    const base = {
      roomId: ROOM,
      actorUid: UID_A,
      sceneId: 'scene_1',
      lessonId: 'lesson_1',
      lessonVersion: 1,
      expectedRevision: room.revision,
      expectedSeq: 1,
      eventId: 'evt-1',
      requestId: 'sync-1',
    };
    expectReason(
      () => store.collaboration.syncScene({ ...base, expectedRevision: room.revision + 1 }),
      'VERSION_CONFLICT',
      'collab_room_revision_mismatch',
    );
    expectReason(
      () => store.collaboration.syncScene({ ...base, lessonVersion: 2 }),
      'VERSION_CONFLICT',
      'collab_course_changed',
    );
    expectReason(
      () => store.collaboration.syncScene({ ...base, actorUid: UID_B }),
      'ROLE_PERMISSION_DENIED',
      'only_owner_advances',
    );
    expectReason(
      () => store.collaboration.syncScene({ ...base, sceneId: 'scene_missing' }),
      'INVALID_ARGUMENT',
      'collab_scene_not_in_snapshot',
    );
  });

  it('未开课的房间不能借推进场景置为 active（不绕过双人就绪校验）', () => {
    const store = openStore();
    // 建房但未 start：房间处于 ready。
    register(store, UID_A, 'cred_a', SECRET_A, 'reg-a');
    register(store, UID_B, 'cred_b', 'c'.repeat(64), 'reg-b');
    const invitation = store.collaboration.invite({
      roomId: ROOM,
      inviterUid: UID_A,
      inviteeUid: UID_B,
      lessonId: 'lesson_1',
      lessonVersion: 1,
      snapshotDigest: DIGEST,
      requestId: 'inv-1',
    }).invitation;
    store.collaboration.decide({
      invitationId: invitation.invitationId,
      actorUid: UID_B,
      decision: 'accepted',
      requestId: 'acc-1',
    });
    store.collaboration.uploadSnapshot({
      roomId: ROOM,
      actorUid: UID_A,
      snapshot: snapshotFixture(),
      snapshotDigest: DIGEST,
      requestId: 'snap-1',
    });
    const room = store.collaboration.getRoom(ROOM);
    expect(room?.status).toBe('ready');
    expectReason(
      () =>
        store.collaboration.syncScene({
          roomId: ROOM,
          actorUid: UID_A,
          sceneId: 'scene_1',
          lessonId: 'lesson_1',
          lessonVersion: 1,
          expectedRevision: room!.revision,
          expectedSeq: 1,
          eventId: 'evt-1',
          requestId: 'sync-1',
        }),
      'VERSION_CONFLICT',
      'collab_room_not_active',
    );
    expect(store.collaboration.getRoom(ROOM)?.status).toBe('ready');
  });

  it('无快照时场景推进被拒（摘要管道不能冒充同步）', () => {
    const store = openStore();
    const room = readyRoom(store);
    expectReason(
      () =>
        store.collaboration.syncScene({
          roomId: ROOM,
          actorUid: UID_A,
          sceneId: 'scene_1',
          lessonId: 'lesson_1',
          lessonVersion: 1,
          expectedRevision: room.revision,
          expectedSeq: 1,
          eventId: 'evt-1',
          requestId: 'sync-1',
        }),
      'INVALID_ARGUMENT',
      'collab_scene_not_in_snapshot',
    );
  });
});

describe('独立协作服务：共享快照与隐私投影', () => {
  it('共享投影由房主首次冻结；同摘要不能替换正文，退出后不能重放上传收据', () => {
    const store = openStore();
    readyRoom(store);
    const input = {
      roomId: ROOM,
      actorUid: UID_A,
      snapshot: snapshotFixture(),
      snapshotDigest: DIGEST,
      requestId: 'frozen-snapshot',
    };
    store.collaboration.uploadSnapshot(input);
    const changed = snapshotFixture();
    changed.scenes[0]!.title = '替换标题';
    expectReason(
      () =>
        store.collaboration.uploadSnapshot({
          ...input,
          snapshot: changed,
          requestId: 'replace-snapshot',
        }),
      'VERSION_CONFLICT',
      'collab_snapshot_frozen',
    );
    expectReason(
      () =>
        store.collaboration.uploadSnapshot({
          ...input,
          actorUid: UID_B,
          requestId: 'peer-snapshot',
        }),
      'ROLE_PERMISSION_DENIED',
      'only_owner_publishes',
    );
    store.collaboration.setReadiness({
      roomId: ROOM,
      uid: UID_A,
      readiness: 'left',
      requestId: 'leave-after-snapshot',
    });
    expectReason(
      () => store.collaboration.uploadSnapshot(input),
      'ROLE_PERMISSION_DENIED',
      'not_room_member',
    );
  });
  it('快照上传后下载一致；非成员不能上传', () => {
    const store = openStore();
    readyRoom(store);
    const snapshot = snapshotFixture();
    store.collaboration.uploadSnapshot({
      roomId: ROOM,
      actorUid: UID_A,
      snapshot,
      snapshotDigest: DIGEST,
      requestId: 'snap-1',
    });
    const view = store.collaboration.snapshotView(ROOM);
    expect(view.snapshotDigest).toBe(DIGEST);
    expect(view.snapshot).toEqual(snapshot);

    expectReason(
      () =>
        store.collaboration.uploadSnapshot({
          roomId: ROOM,
          actorUid: UID_C,
          snapshot,
          snapshotDigest: DIGEST,
          requestId: 'snap-outsider',
        }),
      'ROLE_PERMISSION_DENIED',
      'not_room_member',
    );
  });

  it('共享投影不含测验答案、排序正确顺序与关系正确目标', () => {
    const store = openStore();
    readyRoom(store);
    // 构造带答案痕迹的场景：quiz 只有题干/选项（无 answer），interactive 只含公开定义。
    const snapshot = snapshotFixture();
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of ['"answer"', 'correctOrder', '"analysis"', '"points"']) {
      expect(serialized).not.toContain(forbidden);
    }
    store.collaboration.uploadSnapshot({
      roomId: ROOM,
      actorUid: UID_A,
      snapshot,
      snapshotDigest: DIGEST,
      requestId: 'snap-1',
    });
    const view = store.collaboration.snapshotView(ROOM);
    expect(JSON.stringify(view.snapshot)).not.toContain('correctOrder');
  });

  it('快照正文被外部改写时读取复验内容哈希并拒绝（内容哈希绑定）', () => {
    const store = openStore();
    readyRoom(store);
    store.collaboration.uploadSnapshot({
      roomId: ROOM,
      actorUid: UID_A,
      snapshot: snapshotFixture(),
      snapshotDigest: DIGEST,
      requestId: 'snap-1',
    });
    // 直接改写存储中的投影正文（模拟存储被外部工具篡改）。
    const db = createNodeSqliteDriver().open(store.databaseFile);
    try {
      const tampered = snapshotFixture();
      (tampered.scenes[0] as { title: string }).title = '被换掉的内容';
      db.prepare('UPDATE collab_room_snapshots SET snapshot_json=? WHERE room_id=?').run(
        JSON.stringify(tampered),
        ROOM,
      );
    } finally {
      db.close();
    }
    expectReason(
      () => store.collaboration.snapshotView(ROOM),
      'INTERNAL',
      'collab_snapshot_content_mismatch',
    );
  });
});
