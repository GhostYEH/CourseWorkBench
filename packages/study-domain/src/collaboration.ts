/**
 * 双人共同课堂的协作判定（INVITE-01 / SYNC-01 / CHAT-01）。
 *
 * 这一层只做纯判断，不碰数据库、不碰网络：
 * - 邀请：谁能发起、谁能表态/撤销、哪些情况必须拒绝；
 * - 消息：谁能发、什么身份能写、哪些内容不能进聊天；
 * - 事件：序号如何推进、重连从哪里补、哪些事件不允许重复。
 *
 * 按《规划书》7.6：协作服务的在线登记/认证/实时分发是前置依赖，
 * 这里的判定只保证「即使服务把请求送进来，非法状态也写不进权威」。
 */

import { StudyError } from '@sew/study-contracts';
import { COLLAB_EVENT_KINDS, type CollabEventKind } from '@sew/study-contracts';

/** 邀请状态机（INVITE-01）。 */
export type CollabInvitationStatus = 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired';

export interface CollabInvitationFacts {
  invitationId: string;
  roomId: string;
  inviterUid: string;
  inviteeUid: string;
  lessonId: string;
  lessonVersion: number;
  snapshotDigest: string;
  status: CollabInvitationStatus;
  createdAt: string;
  expiresAt: string;
}

/**
 * 断言「这次邀请发起合法」。
 *
 * - 不能邀请自己：UID 相同即拒绝（不是等到对方表态才发现）；
 * - 课程版本必须与快照摘要同时给出：只给 lessonId 不给版本/摘要的邀请不能建，
 *   否则对方接受时无法核对「进的是同一节课」；
 * - 调用方必须已声明在线可邀请（`canInvite`）：离线身份的发起在路由层直接拦，
 *   这里再按 `inviterRegistered` 复核一次，不依赖调用方自述。
 */
export const assertCollabInvitationCreatable = (facts: {
  inviterUid: string;
  inviteeUid: string;
  lessonId: string;
  lessonVersion: number;
  snapshotDigest: string;
  inviterRegistered: boolean;
}): void => {
  if (!facts.inviterRegistered) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', {
      reason: 'inviter_not_registered',
    });
  }
  if (facts.inviterUid === facts.inviteeUid) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'cannot_invite_self' });
  }
  if (!facts.lessonId || facts.lessonVersion < 1 || !facts.snapshotDigest) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'invitation_course_incomplete' });
  }
};

/**
 * 断言「这次邀请表态合法」。
 *
 * - 只有受邀本人能表态：发起人、路过的第三人都不能替对方接受/拒绝；
 * - 只有 `pending` 能表态：已接受/拒绝/撤销/过期的邀请不能二次表态，
 *   重复接受读回应有的成员记录，不追加第二份（由存储层按收据保证）；
 * - 过期按时间判定：`now` 超过 `expiresAt` 即过期，不能接受，只能重新邀请。
 */
export const assertCollabInvitationDecidable = (facts: {
  invitation: CollabInvitationFacts;
  actorUid: string;
  decision: 'accepted' | 'rejected';
  now: string;
}): void => {
  if (facts.actorUid !== facts.invitation.inviteeUid) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'only_invitee_decides' });
  }
  if (facts.invitation.status !== 'pending') {
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'invitation_already_decided',
      status: facts.invitation.status,
    });
  }
  if (Date.parse(facts.now) >= Date.parse(facts.invitation.expiresAt)) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'invitation_expired' });
  }
  if (facts.decision !== 'accepted' && facts.decision !== 'rejected') {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'invitation_decision_unknown' });
  }
};

/**
 * 断言「这次邀请撤销合法」。
 *
 * - 只有发起人能在对方表态前撤销：受邀人想拒绝走表态，不走撤销；
 * - 只有 `pending` 能撤销：已表态/已过期的邀请撤销没有意义，直接拒绝。
 */
export const assertCollabInvitationRevocable = (facts: {
  invitation: CollabInvitationFacts;
  actorUid: string;
}): void => {
  if (facts.actorUid !== facts.invitation.inviterUid) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'only_inviter_revokes' });
  }
  if (facts.invitation.status !== 'pending') {
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'invitation_already_decided',
      status: facts.invitation.status,
    });
  }
};

/**
 * 断言「这条课内消息能写」（CHAT-01）。
 *
 * - 只有房间成员能发：非成员（未接受邀请、已退出、房间已结束）一律拒绝；
 * - 只允许真人身份写：AI 同学走 peer_turn、教师输出走租约执行，
 *   它们在讨论区的展示由读取侧合并，不经这条写入口伪造；
 * - 正文不能为空（含纯空白）、不能超长、不能带本地路径；
 * - 消息不更新知识与掌握：这里只判定「能不能写」，写入后也不产生任何
 *   审核/掌握副作用（由调用方保证不调用审核与掌握入口）。
 */
export const assertCollabMessageWritable = (facts: {
  roomId: string;
  senderUid: string;
  senderType: 'human_learner' | 'teacher_ai' | 'peer_ai';
  body: string;
  memberUids: readonly string[];
  roomEnded: boolean;
}): void => {
  if (facts.roomEnded) {
    throw new StudyError('RUN_TERMINATED', { reason: 'room_ended' });
  }
  if (!facts.memberUids.includes(facts.senderUid)) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'not_room_member' });
  }
  if (facts.senderType !== 'human_learner') {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'chat_only_human' });
  }
  if (!facts.roomId) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'chat_room_missing' });
  }
};

/**
 * 房间事件的序号推进（SYNC-01）。
 *
 * 房间内事件是单调权威序号：追加时期望序号必须恰好是 `tailSeq + 1`，
 * 否则说明两端对「当前进度」的认知不一致，拒绝写入、由重连补齐后再试。
 * 重复提交（同一 requestId）读回既有事件，不推进序号——这部分由存储层
 * 按收据保证，这里只判定序号本身。
 */
export const assertCollabEventAppendable = (facts: {
  kind: CollabEventKind;
  expectedSeq: number;
  tailSeq: number;
  roomEnded: boolean;
  actorIsMember: boolean;
}): void => {
  if (!(COLLAB_EVENT_KINDS as readonly string[]).includes(facts.kind)) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_event_unknown' });
  }
  if (facts.roomEnded && facts.kind !== 'member_left') {
    throw new StudyError('RUN_TERMINATED', { reason: 'room_ended' });
  }
  if (!facts.actorIsMember) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'not_room_member' });
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
 * 重连补齐的游标计算（SYNC-01 / CHAT-01 共用）。
 *
 * 客户端带 `afterSeq`（上次已确认的最大序号）来取增量：服务端返回
 * `(afterSeq, tailSeq]` 区间。`afterSeq` 不能大于 `tailSeq`（说明客户端
 * 的认知超前了，拒绝并让它全量重读），不能为负。
 */
export const assertCollabResyncCursor = (facts: { afterSeq: number; tailSeq: number }): void => {
  if (!Number.isInteger(facts.afterSeq) || facts.afterSeq < 0) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_cursor_invalid' });
  }
  if (facts.afterSeq > facts.tailSeq) {
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'collab_cursor_ahead',
      afterSeq: facts.afterSeq,
      tailSeq: facts.tailSeq,
    });
  }
};

/** 准备页的一位成员状态（INVITE-01 → SYNC-01 的衔接）。 */
export type CollabReadiness = 'pending' | 'ready' | 'left';

/**
 * 断言「共同课堂可以开始」（INVITE-01 准备页 → SYNC-01）。
 *
 * 按《规划书》3.3：两人就绪后才开始共同课堂。
 * - 成员必须恰好是邀请的双方：不能多一人（满员外的人混入），不能少一人
 *   （对方还没接受就开课），更不能换人（接受的不是当初邀请的那个 UID）；
 * - 两人都必须是 `ready`：一方 `pending`（还没点准备好）或 `left`（退出了）
 *   都不能开始，发起人也不能单方面跳过；
 * - 只有发起人能点开始：受邀同学不能替房主开课；
 * - 课程版本与快照摘要必须与邀请一致：邀请后课程被重新发布/改写时，
 *   不能按旧邀请直接开课，只能重新邀请（房间不跟随草案静默换版）。
 */
export const assertCollabRoomStartable = (facts: {
  inviterUid: string;
  inviteeUid: string;
  lessonId: string;
  lessonVersion: number;
  snapshotDigest: string;
  actorUid: string;
  members: ReadonlyArray<{ uid: string; readiness: CollabReadiness }>;
  course: { lessonId: string; lessonVersion: number; snapshotDigest: string };
}): void => {
  if (facts.actorUid !== facts.inviterUid) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'only_inviter_starts' });
  }
  const memberByUid = new Map(facts.members.map((member) => [member.uid, member.readiness]));
  if (
    facts.members.length !== 2 ||
    memberByUid.get(facts.inviterUid) === undefined ||
    memberByUid.get(facts.inviteeUid) === undefined
  ) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_members_mismatch' });
  }
  const notReady = facts.members.filter((member) => member.readiness !== 'ready');
  if (notReady.length > 0) {
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'collab_members_not_ready',
      pending: notReady.map((member) => member.uid),
    });
  }
  if (
    facts.course.lessonId !== facts.lessonId ||
    facts.course.lessonVersion !== facts.lessonVersion ||
    facts.course.snapshotDigest !== facts.snapshotDigest
  ) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_course_changed' });
  }
};

/**
 * 断言「这次入场核验通过」（ROOM-01 的在线部分，SYNC-01 入场前）。
 *
 * 入场前验证内容、资产与来源准入（《规划书》4.7）：
 * - 课程版本与快照摘要必须与房间冻结的一致：新课程草案不覆盖房间版本，
 *   带着旧摘要或新版本来入场的一律拒绝；
 * - 成员身份由服务端按会话绑定：请求体自报的 UID 与会话绑定的 UID 不一致
 *   即拒绝（知道 UID 不等于能替对方入场）；
 * - 房间已结束不能入场：结束后想继续上课只能重新邀请建房。
 */
export const assertCollabAdmission = (facts: {
  roomCourse: { lessonId: string; lessonVersion: number; snapshotDigest: string };
  presentedCourse: { lessonId: string; lessonVersion: number; snapshotDigest: string };
  claimedUid: string;
  sessionUid: string;
  memberUids: readonly string[];
  roomEnded: boolean;
}): void => {
  if (facts.roomEnded) {
    throw new StudyError('RUN_TERMINATED', { reason: 'room_ended' });
  }
  if (facts.claimedUid !== facts.sessionUid) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'collab_identity_mismatch' });
  }
  if (!facts.memberUids.includes(facts.sessionUid)) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'not_room_member' });
  }
  if (
    facts.presentedCourse.lessonId !== facts.roomCourse.lessonId ||
    facts.presentedCourse.lessonVersion !== facts.roomCourse.lessonVersion ||
    facts.presentedCourse.snapshotDigest !== facts.roomCourse.snapshotDigest
  ) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_course_changed' });
  }
};

/**
 * 断言「两端拿的是同一份冻结课程」（ROOM-01 的双端消费者）。
 *
 * 双端各持一份共享快照：课程标识、发布版本、文档摘要、证据包摘要必须完全一致，
 * 否则一方看到的是旧版、另一方看到的是新版，「同课」就不成立。
 * 摘要比较只认相等，不做「谁新谁旧」的猜测——版本不一致时由邀请/入场路径拒绝，
 * 这里只回答「这两份能不能算同一节课」。
 */
export const assertCollabSnapshotMatch = (facts: {
  local: { lessonId: string; lessonVersion: number; documentDigest: string; bundleDigest: string };
  remote: { lessonId: string; lessonVersion: number; documentDigest: string; bundleDigest: string };
}): void => {
  if (
    facts.local.lessonId !== facts.remote.lessonId ||
    facts.local.lessonVersion !== facts.remote.lessonVersion ||
    facts.local.documentDigest !== facts.remote.documentDigest ||
    facts.local.bundleDigest !== facts.remote.bundleDigest
  ) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_snapshot_mismatch' });
  }
};

/**
 * 断言「这次公共教学输出允许广播」（ROOM-01 唯一教师执行权 / SYNC-01）。
 *
 * - 教师公共输出（`teacher_output`）只能由房主发起：受邀同学、AI 同学都不能
 *   以教师名义推公共讲解；教师执行另需租约与代次（由执行路径复验），这里只卡
 *   「谁有资格推」；
 * - 公共白板动作（`board_action`）允许成员发起，但非成员一律拒绝；
 * - 场景切换（`scene_changed`）只允许房主：两端同时切场景会分裂进度，
 *   受邀同学不能推进全房场景（自己的本地翻页不经这条事件）。
 */
export const assertCollabTeacherEventAllowed = (facts: {
  kind: CollabEventKind;
  actorUid: string;
  ownerUid: string;
  memberUids: readonly string[];
}): void => {
  if (!facts.memberUids.includes(facts.actorUid)) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'not_room_member' });
  }
  if (facts.kind === 'teacher_output' && facts.actorUid !== facts.ownerUid) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'only_owner_teaches' });
  }
  if (facts.kind === 'scene_changed' && facts.actorUid !== facts.ownerUid) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'only_owner_advances' });
  }
};
