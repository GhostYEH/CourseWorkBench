/**
 * 在线协作的认证与场景推进判定（UID-01 / ROOM-01 / SYNC-01 的在线部分）。
 *
 * 只做纯判断，不碰数据库、网络或文件系统；与 `collaboration.ts` 同层同风格。
 * 本文件回答四类问题：
 * - 这次在线登记/轮换凭据能不能成立（知道 UID 不能替他人登记）；
 * - 这份凭据现在能不能用来认证（吊销、过期、归属不符都要拒绝）；
 * - 这条会话能不能签发（凭据有效 + 协议版本一致）；
 * - 这次场景同步能不能原子提交（课程身份、房间版本、序号、唯一教师执行权）。
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { StudyError } from '@sew/study-contracts';

/**
 * 凭据秘密的存储哈希。
 *
 * 服务端只保存哈希：`secret` 本身既不落库也不进日志/快照/导出。哈希是单向的，
 * 拿到哈希无法反推出可用于认证的凭据。
 */
export const collabSecretHash = (secret: string): string =>
  createHash('sha256').update(secret, 'utf8').digest('hex');

/**
 * 恒定时间比较：把待验秘密哈希后与已存哈希按字节比较，避免按前缀提前返回的计时侧信道。
 * 长度不一致时直接判否（不调用 timingSafeEqual，避免其抛错）。
 */
export const collabSecretMatches = (provided: string, storedHash: string): boolean => {
  const actual = Buffer.from(collabSecretHash(provided), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

/** 凭据在服务端的可见状态。`secret` 与哈希都不进入判定输入。 */
export type CollabCredentialStatus = 'active' | 'revoked';

export interface CollabCredentialFacts {
  credentialId: string;
  uid: string;
  status: CollabCredentialStatus;
  createdAt: string;
  revokedAt: string | null;
}

/**
 * 断言「这次在线登记合法」。
 *
 * - 首次登记（该 UID 尚无凭据）必须验证管理员线下签发的一次性 UID 激活令牌；
 * - 追加/轮换凭据（该 UID 已有凭据）必须带一个**属于同一 UID 且有效**的证明凭据：
 *   知道 UID 不能替他人登记，凭据吊销后也不能再用来证明归属；
 * - 同一 `credentialId` 不能跨 UID 复用：否则一个凭据句柄会指向两个身份。
 */
export const assertCollabRegistrationCreatable = (facts: {
  uid: string;
  /** 该 UID 当前是否已有凭据记录。 */
  uidHasCredentials: boolean;
  /** 首次登记的一次性 UID 激活令牌已经由存储边界验证。 */
  enrollmentValid?: boolean;
  /** 该 `credentialId` 已被哪个 UID 占用；未被占用为 null。 */
  credentialIdOwnerUid: string | null;
  /** 追加/轮换时的证明凭据；首次登记为 null。 */
  proof: { credential: CollabCredentialFacts | null } | null;
}): void => {
  if (facts.credentialIdOwnerUid !== null && facts.credentialIdOwnerUid !== facts.uid) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_credential_taken' });
  }
  if (!facts.uidHasCredentials) {
    // 首次登记以预置激活令牌证明 UID 归属，不接受他人的旧凭据当作激活证明。
    if (facts.proof) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_registration_proof_unexpected' });
    }
    if (!facts.enrollmentValid) {
      throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'collab_enrollment_required' });
    }
    return;
  }
  if (!facts.proof || !facts.proof.credential) {
    // 区分「根本没带证明」与「带了但无效」：后者常是秘密写错或凭据已吊销，提示更精确。
    throw new StudyError('PROJECT_NOT_AUTHORIZED', {
      reason: facts.proof
        ? 'collab_registration_proof_invalid'
        : 'collab_registration_proof_required',
    });
  }
  const proof = facts.proof.credential;
  if (proof.uid !== facts.uid) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'collab_identity_mismatch' });
  }
  if (proof.status !== 'active') {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'collab_credential_revoked' });
  }
};

/**
 * 断言「这份凭据现在可用于认证」。
 *
 * - 必须存在且归属声明的 UID；
 * - 必须仍是 `active`（吊销后一律拒绝，不给任何重放窗口）；
 * - 只接受服务端持有且未吊销的凭据，不接受请求体自报的身份。
 */
export const assertCollabCredentialUsable = (facts: {
  credential: CollabCredentialFacts | null;
  claimedUid: string;
}): void => {
  if (!facts.credential) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'collab_credential_unknown' });
  }
  if (facts.credential.uid !== facts.claimedUid) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'collab_identity_mismatch' });
  }
  if (facts.credential.status !== 'active') {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'collab_credential_revoked' });
  }
};

/** 断言「这条会话可以签发」：凭据有效且协议版本一致。 */
export const assertCollabSessionIssuable = (facts: {
  credential: CollabCredentialFacts | null;
  claimedUid: string;
  presentedProtocolVersion: number;
  supportedProtocolVersion: number;
}): void => {
  assertCollabCredentialUsable({ credential: facts.credential, claimedUid: facts.claimedUid });
  if (facts.presentedProtocolVersion !== facts.supportedProtocolVersion) {
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'collab_protocol_mismatch',
      supported: facts.supportedProtocolVersion,
      presented: facts.presentedProtocolVersion,
    });
  }
};

/** 断言「这条凭据可以吊销」：只有本人能吊销自己的凭据。 */
export const assertCollabCredentialRevocable = (facts: {
  credential: CollabCredentialFacts | null;
  actorUid: string;
}): void => {
  if (!facts.credential) {
    throw new StudyError('NOT_FOUND', { reason: 'collab_credential_unknown' });
  }
  if (facts.credential.uid !== facts.actorUid) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'collab_credential_not_owner' });
  }
};

/**
 * 断言「这次场景同步可以原子提交」（SYNC-01 在线部分）。
 *
 * - 房间必须已经 `active`：场景推进是**开课之后**的动作，不能在 `ready` 阶段
 *   顺带把房间置为 active，否则会绕过 `assertCollabRoomStartable` 的双人就绪校验；
 * - 课程身份必须与房间冻结的一致：拿旧版本或别的课来推进一律拒绝；
 * - 目标场景必须在房间冻结的快照里：不能切到一个共享投影里不存在的场景；
 * - 房间版本必须与客户端读到的一致（乐观并发）：并发推进时只允许一个成功；
 * - 序号必须恰好是 `tailSeq + 1`：与 `assertCollabEventAppendable` 同口径；
 * - 唯一教师执行权：只有房主能推进全房场景。
 */
export const assertCollabSceneSyncable = (facts: {
  actorUid: string;
  ownerUid: string;
  memberUids: readonly string[];
  roomStatus: 'ready' | 'active' | 'ended';
  roomCourse: { lessonId: string; lessonVersion: number };
  commandCourse: { lessonId: string; lessonVersion: number };
  roomRevision: number;
  expectedRevision: number;
  sceneId: string;
  snapshotSceneIds: readonly string[];
  expectedSeq: number;
  tailSeq: number;
}): void => {
  if (!facts.memberUids.includes(facts.actorUid)) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'not_room_member' });
  }
  if (facts.actorUid !== facts.ownerUid) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'only_owner_advances' });
  }
  if (facts.roomStatus === 'ended') {
    throw new StudyError('RUN_TERMINATED', { reason: 'room_ended' });
  }
  if (facts.roomStatus !== 'active') {
    // 未开课：不能借推进场景把房间从 ready 直接置为 active。
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_room_not_active' });
  }
  if (
    facts.roomCourse.lessonId !== facts.commandCourse.lessonId ||
    facts.roomCourse.lessonVersion !== facts.commandCourse.lessonVersion
  ) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_course_changed' });
  }
  if (facts.roomRevision !== facts.expectedRevision) {
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'collab_room_revision_mismatch',
      expectedRevision: facts.expectedRevision,
      roomRevision: facts.roomRevision,
    });
  }
  if (!facts.snapshotSceneIds.includes(facts.sceneId)) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_scene_not_in_snapshot' });
  }
  if (facts.expectedSeq !== facts.tailSeq + 1) {
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'collab_event_seq_mismatch',
      expectedSeq: facts.expectedSeq,
      tailSeq: facts.tailSeq,
    });
  }
};

/**
 * 断言「这次共享快照上传合法」。
 *
 * - 上传者必须是房间成员：非成员不能把内容塞进别人的房间；
 * - 快照的课程身份与房间冻结的一致：不能拿另一版/另一节课的投影冒充同一份；
 * - 快照携带的文档摘要必须与房间冻结的课程摘要一致（`snapshotDigest` 同域），
 *   否则拒绝——避免上传端与房间冻结的版本不一致的投影。
 */
export const assertCollabSnapshotUploadable = (facts: {
  actorUid: string;
  ownerUid: string;
  memberUids: readonly string[];
  roomEnded: boolean;
  roomCourse: { lessonId: string; lessonVersion: number; snapshotDigest: string };
  snapshotCourse: { lessonId: string; lessonVersion: number; documentDigest: string };
  snapshotDigest: string;
}): void => {
  if (!facts.memberUids.includes(facts.actorUid)) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'not_room_member' });
  }
  if (facts.actorUid !== facts.ownerUid) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'only_owner_publishes' });
  }
  if (facts.roomEnded) {
    throw new StudyError('RUN_TERMINATED', { reason: 'room_ended' });
  }
  if (
    facts.roomCourse.lessonId !== facts.snapshotCourse.lessonId ||
    facts.roomCourse.lessonVersion !== facts.snapshotCourse.lessonVersion
  ) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_course_changed' });
  }
  if (
    facts.snapshotDigest !== facts.snapshotCourse.documentDigest ||
    facts.roomCourse.snapshotDigest !== facts.snapshotCourse.documentDigest
  ) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_snapshot_digest_mismatch' });
  }
};
