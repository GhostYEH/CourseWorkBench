/**
 * 双人共同课堂界面消费端的纯判定（INVITE-01 / ROOM-01 / CHAT-01）。
 *
 * 界面不重算权限，只做「服务端结论的可读呈现 + 按钮该不该亮」：
 * - 邀请能不能表态，取决于这条邀请是不是发给本人的、本人是不是发起人；
 * - 房间能不能开始，取决于本人是不是房主、成员是否恰为双方且都已 ready；
 * - 消息与事件按服务端 `seq` 单调序消费，重试读回不重复渲染。
 *
 * 时间只在「服务端尚未折算过期」时用于显示提示，不用于本地判定放行：
 * 真正的过期结论以服务端读回的 `status` 为准，避免两端时钟差换来一个假的可点按钮。
 */

import type {
  CollabEventDto,
  CollabMessageDto,
  CollabRoomDto,
  CollabRoomMemberDto,
  ClassroomInvitationDto,
} from '@sew/study-contracts';

export type CollabInvitationDirection = 'incoming' | 'outgoing';

export interface CollabInvitationView {
  direction: CollabInvitationDirection;
  stateLabel: string;
  /** 本人受邀且服务端仍记为待决时才可表态。 */
  canDecide: boolean;
  /** 本人发起且尚未被对方表态时才可撤销。 */
  canRevoke: boolean;
  /** 按钮不亮的原因，供界面直接说明而不是让同学猜。 */
  blockedReason: string | null;
  /** 本地已过期但服务端仍返回 pending：只提示，不放行也不自行改判。 */
  expiryPending: boolean;
}

const INVITATION_STATE_LABEL: Record<ClassroomInvitationDto['status'], string> = {
  pending: '待接受',
  accepted: '已接受',
  rejected: '已拒绝',
  revoked: '已撤销',
  expired: '已过期',
};

export const collabInvitationView = (
  invitation: ClassroomInvitationDto,
  selfUid: string,
  now: number = Date.now(),
): CollabInvitationView => {
  const direction: CollabInvitationDirection =
    invitation.inviteeUid === selfUid ? 'incoming' : 'outgoing';
  const open = invitation.status === 'pending';
  const expiryPending = open && Date.parse(invitation.expiresAt) <= now;
  const decided = !open;

  let canDecide = false;
  let canRevoke = false;
  let blockedReason: string | null = null;

  if (invitation.inviterUid !== selfUid && invitation.inviteeUid !== selfUid) {
    blockedReason = '此邀请不属于本人';
  } else if (decided) {
    blockedReason = `邀请已${INVITATION_STATE_LABEL[invitation.status]}，不能再改`;
  } else if (expiryPending) {
    blockedReason = '本地时间已过期，等待服务端折算后才能重新邀请';
  } else if (direction === 'incoming') {
    canDecide = true;
  } else {
    canRevoke = true;
  }

  return {
    direction,
    stateLabel: INVITATION_STATE_LABEL[invitation.status],
    canDecide,
    canRevoke,
    blockedReason,
    expiryPending,
  };
};

export interface CollabRoomActions {
  /** 成员本人可在房间开始后之前的准备阶段改自己的准备状态。 */
  canSetReadiness: boolean;
  /** 只有房主能点开始；服务端仍会复验成员恰为双方且都已 ready。 */
  canStart: boolean;
  /** 房间已开始后本人可发消息（服务端另做成员校验）。 */
  canSend: boolean;
  blockedReason: string | null;
  selfReadiness: CollabRoomMemberDto['readiness'] | null;
}

export const collabRoomActions = (facts: {
  room: CollabRoomDto | null;
  members: CollabRoomMemberDto[];
  selfUid: string;
  invitationAccepted: boolean;
}): CollabRoomActions => {
  const { room, members, selfUid, invitationAccepted } = facts;
  const self = members.find((member) => member.uid === selfUid) ?? null;
  const base = {
    canSetReadiness: false,
    canStart: false,
    canSend: false,
    selfReadiness: self?.readiness ?? null,
  };

  // 房间行由服务端在「受邀本人接受邀请」时建立，房主＝发起人；界面不提供也不该有建房按钮。
  if (!room) {
    return {
      ...base,
      blockedReason: invitationAccepted
        ? '邀请已接受，房间由发起人侧建立'
        : '还没有已接受的邀请，先邀请同学并由对方接受',
    };
  }
  if (!self || self.readiness === 'left') {
    return {
      ...base,
      blockedReason: self ? '本人已退出，请重新邀请建立新课堂' : '本人不是该房间成员',
    };
  }
  if (room.status === 'ended') {
    return { ...base, blockedReason: '本课已结束，历史记录只读' };
  }
  if (room.status === 'active') {
    return {
      ...base,
      canSend: true,
      blockedReason: '课堂已开始，准备状态不再变更',
    };
  }
  // status === 'ready'：准备阶段。
  const owner = room.ownerUid === selfUid;
  const bothReady = members.length === 2 && members.every((member) => member.readiness === 'ready');
  return {
    ...base,
    canSetReadiness: self !== null,
    canStart: owner && bothReady,
    blockedReason: owner
      ? bothReady
        ? null
        : '等待双方都点「我已准备」后才能开始'
      : '只有房主能开始课堂',
  };
};

/** 增量读取的游标：取已见最大 `seq`，空集合回 0。 */
export const collabCursor = (items: readonly { seq: number }[]): number =>
  items.reduce((tail, item) => (item.seq > tail ? item.seq : tail), 0);

/**
 * 读回合并：按 `seq` 升序去重。
 *
 * 重试或断连补齐时服务端会返回既有消息，界面不能把同一序号渲染两遍。
 */
export const collabMergeBySeq = <T extends { seq: number }>(
  current: readonly T[],
  incoming: readonly T[],
): T[] => {
  const bySeq = new Map<number, T>();
  for (const item of current) bySeq.set(item.seq, item);
  for (const item of incoming) bySeq.set(item.seq, item);
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
};

/** 讨论区身份标注：真人同学、AI 同学与教师必须视觉可区分（《规划书》3.3）。 */
export const collabSenderLabel = (
  message: CollabMessageDto,
  selfUid: string,
  peerNames: Record<string, string>,
): string => {
  if (message.senderType === 'peer_ai') return 'AI 同学（模拟）';
  if (message.senderType === 'teacher_ai') return '教师（AI）';
  return message.senderUid === selfUid ? '我' : (peerNames[message.senderUid] ?? message.senderUid);
};

/** 事件摘要只呈现「发生了什么」，私人答案与判分不在此流内。 */
export const collabEventLabel = (event: CollabEventDto): string => `${event.kind} #${event.seq}`;

/**
 * 在线能力是否可用（ADR-0005）。
 *
 * 只有真实连接与本人认证都成功才开放在线能力；离线或未配置时界面继续显示
 * 「不能联网邀请」。`reason` 给出不可用的可读原因，供界面直接说明。
 */
export const collabOnlineGate = (online: {
  configured: boolean;
  connected: boolean;
  authenticated: boolean;
  error: string | null;
}): { available: boolean; reason: string | null } => {
  if (online.authenticated && online.connected && !online.error)
    return { available: true, reason: null };
  if (!online.configured) return { available: false, reason: '未配置在线协作服务地址。' };
  if (!online.connected)
    return { available: false, reason: online.error ?? '在线协作服务不可达。' };
  return { available: false, reason: online.error ?? '尚未完成在线身份认证。' };
};
