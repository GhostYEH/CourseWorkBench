import { describe, expect, it } from 'vitest';
import { StudyError } from '@sew/study-contracts';
import {
  assertCollabCredentialRevocable,
  assertCollabCredentialUsable,
  assertCollabRegistrationCreatable,
  assertCollabSceneSyncable,
  assertCollabSessionIssuable,
  assertCollabSnapshotUploadable,
  collabSecretHash,
  collabSecretMatches,
  type CollabCredentialFacts,
} from '@sew/study-domain';

/**
 * 在线协作的认证与场景推进判定（ADR-0005）。
 *
 * 固定四件事：① 知道 UID 不能替他人登记/认证；② 吊销后一律拒绝；
 * ③ 场景同步必须课程身份/房间版本/序号/唯一教师执行权全部通过；
 * ④ 共享快照上传要求成员且与房间冻结摘要一致。
 */

const UID_A = 'uid_10000000-0000-4000-8000-000000000001';
const UID_B = 'uid_10000000-0000-4000-8000-000000000002';
const DIGEST = 'a'.repeat(64);
const SECRET = 'b'.repeat(64);

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

const credential = (overrides: Partial<CollabCredentialFacts> = {}): CollabCredentialFacts => ({
  credentialId: 'cred_a',
  uid: UID_A,
  status: 'active',
  createdAt: '2026-10-06T00:00:00.000Z',
  revokedAt: null,
  ...overrides,
});

describe('在线协作认证判定', () => {
  it('秘密哈希单向且恒定时间比较只认一致秘密', () => {
    const hash = collabSecretHash(SECRET);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toBe(SECRET);
    expect(collabSecretMatches(SECRET, hash)).toBe(true);
    expect(collabSecretMatches('c'.repeat(64), hash)).toBe(false);
    expect(collabSecretMatches(SECRET, 'z'.repeat(64))).toBe(false);
  });

  it('首次登记需一次性激活；同一 UID 追加凭据必须带有效证明，且不能复用他人句柄', () => {
    // 首次登记：该 UID 尚无凭据。
    expect(() =>
      assertCollabRegistrationCreatable({
        uid: UID_A,
        uidHasCredentials: false,
        enrollmentValid: true,
        credentialIdOwnerUid: null,
        proof: null,
      }),
    ).not.toThrow();
    expectReason(
      () =>
        assertCollabRegistrationCreatable({
          uid: UID_A,
          uidHasCredentials: false,
          credentialIdOwnerUid: null,
          proof: null,
        }),
      'PROJECT_NOT_AUTHORIZED',
      'collab_enrollment_required',
    );
    // 首次登记却夹带证明：拒绝（避免拿别人的凭据句柄当自己的）。
    expectReason(
      () =>
        assertCollabRegistrationCreatable({
          uid: UID_A,
          uidHasCredentials: false,
          credentialIdOwnerUid: null,
          proof: { credential: credential() },
        }),
      'INVALID_ARGUMENT',
      'collab_registration_proof_unexpected',
    );
    // 同一 UID 追加凭据但无证明：拒绝（知道 UID 不能替他人登记）。
    expectReason(
      () =>
        assertCollabRegistrationCreatable({
          uid: UID_A,
          uidHasCredentials: true,
          credentialIdOwnerUid: null,
          proof: null,
        }),
      'PROJECT_NOT_AUTHORIZED',
      'collab_registration_proof_required',
    );
    // 证明凭据属于别的 UID：拒绝。
    expectReason(
      () =>
        assertCollabRegistrationCreatable({
          uid: UID_A,
          uidHasCredentials: true,
          credentialIdOwnerUid: null,
          proof: { credential: credential({ uid: UID_B }) },
        }),
      'PROJECT_NOT_AUTHORIZED',
      'collab_identity_mismatch',
    );
    // 证明凭据已吊销：拒绝。
    expectReason(
      () =>
        assertCollabRegistrationCreatable({
          uid: UID_A,
          uidHasCredentials: true,
          credentialIdOwnerUid: null,
          proof: { credential: credential({ status: 'revoked' }) },
        }),
      'PROJECT_NOT_AUTHORIZED',
      'collab_credential_revoked',
    );
    // credentialId 已被他人占用：拒绝。
    expectReason(
      () =>
        assertCollabRegistrationCreatable({
          uid: UID_A,
          uidHasCredentials: true,
          credentialIdOwnerUid: UID_B,
          proof: { credential: credential() },
        }),
      'VERSION_CONFLICT',
      'collab_credential_taken',
    );
    // 有效证明：通过。
    expect(() =>
      assertCollabRegistrationCreatable({
        uid: UID_A,
        uidHasCredentials: true,
        credentialIdOwnerUid: null,
        proof: { credential: credential() },
      }),
    ).not.toThrow();
  });

  it('凭据可用性：未知、归属不符、已吊销都拒绝', () => {
    expectReason(
      () => assertCollabCredentialUsable({ credential: null, claimedUid: UID_A }),
      'PROJECT_NOT_AUTHORIZED',
      'collab_credential_unknown',
    );
    expectReason(
      () =>
        assertCollabCredentialUsable({ credential: credential({ uid: UID_B }), claimedUid: UID_A }),
      'PROJECT_NOT_AUTHORIZED',
      'collab_identity_mismatch',
    );
    expectReason(
      () =>
        assertCollabCredentialUsable({
          credential: credential({ status: 'revoked' }),
          claimedUid: UID_A,
        }),
      'PROJECT_NOT_AUTHORIZED',
      'collab_credential_revoked',
    );
    expect(() =>
      assertCollabCredentialUsable({ credential: credential(), claimedUid: UID_A }),
    ).not.toThrow();
  });

  it('会话签发要求凭据有效且协议版本一致', () => {
    expectReason(
      () =>
        assertCollabSessionIssuable({
          credential: credential(),
          claimedUid: UID_A,
          presentedProtocolVersion: 2,
          supportedProtocolVersion: 1,
        }),
      'VERSION_CONFLICT',
      'collab_protocol_mismatch',
    );
    expect(() =>
      assertCollabSessionIssuable({
        credential: credential(),
        claimedUid: UID_A,
        presentedProtocolVersion: 1,
        supportedProtocolVersion: 1,
      }),
    ).not.toThrow();
  });

  it('吊销凭据只有本人能做', () => {
    expectReason(
      () =>
        assertCollabCredentialRevocable({
          credential: credential({ uid: UID_B }),
          actorUid: UID_A,
        }),
      'ROLE_PERMISSION_DENIED',
      'collab_credential_not_owner',
    );
    expectReason(
      () => assertCollabCredentialRevocable({ credential: null, actorUid: UID_A }),
      'NOT_FOUND',
      'collab_credential_unknown',
    );
    expect(() =>
      assertCollabCredentialRevocable({ credential: credential(), actorUid: UID_A }),
    ).not.toThrow();
  });
});

describe('场景同步判定（SYNC-01 在线部分）', () => {
  const base = {
    actorUid: UID_A,
    ownerUid: UID_A,
    memberUids: [UID_A, UID_B],
    roomStatus: 'active' as const,
    roomCourse: { lessonId: 'lesson_1', lessonVersion: 3 },
    commandCourse: { lessonId: 'lesson_1', lessonVersion: 3 },
    roomRevision: 5,
    expectedRevision: 5,
    sceneId: 'scene_2',
    snapshotSceneIds: ['scene_1', 'scene_2'],
    expectedSeq: 3,
    tailSeq: 2,
  };

  it('房主在版本/序号一致且目标场景存在时可通过', () => {
    expect(() => assertCollabSceneSyncable(base)).not.toThrow();
  });

  it('非成员、非房主、已结束房间都拒绝', () => {
    expectReason(
      () =>
        assertCollabSceneSyncable({
          ...base,
          actorUid: 'uid_30000000-0000-4000-8000-000000000003',
        }),
      'ROLE_PERMISSION_DENIED',
      'not_room_member',
    );
    expectReason(
      () => assertCollabSceneSyncable({ ...base, actorUid: UID_B }),
      'ROLE_PERMISSION_DENIED',
      'only_owner_advances',
    );
    expectReason(
      () => assertCollabSceneSyncable({ ...base, roomStatus: 'ended' }),
      'RUN_TERMINATED',
      'room_ended',
    );
  });

  it('未开课（ready）不能借推进场景置为 active，绕过双人就绪校验', () => {
    expectReason(
      () => assertCollabSceneSyncable({ ...base, roomStatus: 'ready' }),
      'VERSION_CONFLICT',
      'collab_room_not_active',
    );
  });

  it('课程身份、房间版本、目标场景、序号任一不符都拒绝', () => {
    expectReason(
      () =>
        assertCollabSceneSyncable({
          ...base,
          commandCourse: { lessonId: 'lesson_1', lessonVersion: 4 },
        }),
      'VERSION_CONFLICT',
      'collab_course_changed',
    );
    expectReason(
      () => assertCollabSceneSyncable({ ...base, expectedRevision: 4 }),
      'VERSION_CONFLICT',
      'collab_room_revision_mismatch',
    );
    expectReason(
      () => assertCollabSceneSyncable({ ...base, sceneId: 'scene_9' }),
      'INVALID_ARGUMENT',
      'collab_scene_not_in_snapshot',
    );
    expectReason(
      () => assertCollabSceneSyncable({ ...base, expectedSeq: 9 }),
      'VERSION_CONFLICT',
      'collab_event_seq_mismatch',
    );
  });
});

describe('共享快照上传判定（ROOM-01 双端消费者）', () => {
  const base = {
    actorUid: UID_A,
    ownerUid: UID_A,
    memberUids: [UID_A, UID_B],
    roomEnded: false,
    roomCourse: { lessonId: 'lesson_1', lessonVersion: 3, snapshotDigest: DIGEST },
    snapshotCourse: { lessonId: 'lesson_1', lessonVersion: 3, documentDigest: DIGEST },
    snapshotDigest: DIGEST,
  };

  it('成员上传与房间冻结一致的投影可通过', () => {
    expect(() => assertCollabSnapshotUploadable(base)).not.toThrow();
  });

  it('非成员、已结束、课程身份或摘要不符都拒绝', () => {
    expectReason(
      () => assertCollabSnapshotUploadable({ ...base, actorUid: UID_B }),
      'ROLE_PERMISSION_DENIED',
      'only_owner_publishes',
    );
    expectReason(
      () =>
        assertCollabSnapshotUploadable({
          ...base,
          actorUid: 'uid_30000000-0000-4000-8000-000000000003',
        }),
      'ROLE_PERMISSION_DENIED',
      'not_room_member',
    );
    expectReason(
      () => assertCollabSnapshotUploadable({ ...base, roomEnded: true }),
      'RUN_TERMINATED',
      'room_ended',
    );
    expectReason(
      () =>
        assertCollabSnapshotUploadable({
          ...base,
          snapshotCourse: { lessonId: 'lesson_1', lessonVersion: 4, documentDigest: DIGEST },
        }),
      'VERSION_CONFLICT',
      'collab_course_changed',
    );
    expectReason(
      () => assertCollabSnapshotUploadable({ ...base, snapshotDigest: 'c'.repeat(64) }),
      'VERSION_CONFLICT',
      'collab_snapshot_digest_mismatch',
    );
  });
});
