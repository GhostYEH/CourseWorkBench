import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type {
  CollabEventDto,
  CollabMessageDto,
  CollabRoomDto,
  CollabRoomMemberDto,
  ClassroomInvitationDto,
} from '@sew/study-contracts';
import {
  collabCursor,
  collabInvitationView,
  collabMergeBySeq,
  collabRoomActions,
  collabSenderLabel,
} from '../apps/learning/lib/classroom/collab-panel-state';

/**
 * 双人共同课堂消费端的界面判定回归（INVITE-01 / ROOM-01 / CHAT-01）。
 *
 * 固定四件事：表态权只属于受邀本人、撤销权只属于发起人且本地过期不自行放行；
 * 开始权只属于房主且必须双方都 ready；游标读回按 `seq` 去重不重复渲染。
 * 房间建立不在界面侧——受邀接受时服务端就建好房间行。
 */

const require = createRequire(new URL('../apps/learning/package.json', import.meta.url));
const { createElement } = require('react') as {
  createElement: (type: unknown, props: unknown) => unknown;
};
const { renderToStaticMarkup } = require('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

const SELF = 'uid_11111111-1111-4111-8111-111111111111';
const PEER = 'uid_22222222-2222-4222-8222-222222222222';
const STRANGER = 'uid_33333333-3333-4333-8333-333333333333';
const DIGEST = 'a'.repeat(64);

const invitation = (over: Partial<ClassroomInvitationDto> = {}): ClassroomInvitationDto => ({
  invitationId: 'inv_1',
  roomId: 'room_1',
  inviterUid: SELF,
  inviteeUid: PEER,
  lessonId: 'lesson_1',
  lessonVersion: 3,
  snapshotDigest: DIGEST,
  status: 'pending',
  createdAt: '2026-10-06T01:00:00.000Z',
  expiresAt: '2026-10-08T01:00:00.000Z',
  updatedAt: '2026-10-06T01:00:00.000Z',
  ...over,
});

const member = (over: Partial<CollabRoomMemberDto> = {}): CollabRoomMemberDto => ({
  roomId: 'room_1',
  uid: SELF,
  role: 'owner',
  readiness: 'pending',
  joinedAt: '2026-10-06T01:00:00.000Z',
  updatedAt: '2026-10-06T01:00:00.000Z',
  ...over,
});

const room = (over: Partial<CollabRoomDto> = {}): CollabRoomDto => ({
  schemaVersion: 1,
  roomId: 'room_1',
  ownerUid: SELF,
  status: 'ready',
  revision: 1,
  currentSceneId: 'scene_1',
  course: { lessonId: 'lesson_1', lessonVersion: 3, snapshotDigest: DIGEST },
  createdAt: '2026-10-06T01:00:00.000Z',
  updatedAt: '2026-10-06T01:00:00.000Z',
  ...over,
});

const message = (over: Partial<CollabMessageDto> = {}): CollabMessageDto => ({
  messageId: 'msg_1',
  roomId: 'room_1',
  seq: 1,
  senderUid: SELF,
  senderType: 'human_learner',
  body: '这道题的条件我记下来了',
  dedupKey: 'req_1',
  createdAt: '2026-10-06T01:00:00.000Z',
  ...over,
});

describe('邀请的可点性判定', () => {
  it('发给自己的待决邀请才能表态，发起方不能替对方接受', () => {
    const view = collabInvitationView(invitation({ inviterUid: PEER, inviteeUid: SELF }), SELF);
    expect(view).toMatchObject({ direction: 'incoming', canDecide: true, canRevoke: false });
    expect(view.blockedReason).toBeNull();
  });
  it('本人发起的待决邀请只能撤销，不能自答', () => {
    const view = collabInvitationView(invitation(), SELF);
    expect(view).toMatchObject({ direction: 'outgoing', canDecide: false, canRevoke: true });
  });
  it('对方已接受后双方都不再能改判', () => {
    const view = collabInvitationView(invitation({ status: 'accepted' }), SELF);
    expect(view.canDecide).toBe(false);
    expect(view.canRevoke).toBe(false);
    expect(view.blockedReason).toContain('不能再改');
  });
  it('本地时间已过期而服务端仍记待决时只提示，不放行也不本地改判', () => {
    const view = collabInvitationView(invitation(), SELF, Date.parse('2026-10-09T00:00:00.000Z'));
    expect(view.expiryPending).toBe(true);
    expect(view.canRevoke).toBe(false);
    expect(view.canDecide).toBe(false);
    expect(view.stateLabel).toBe('待接受');
    expect(view.blockedReason).toContain('服务端');
  });
  it('服务端已折算为过期时按过期呈现', () => {
    const view = collabInvitationView(invitation({ status: 'expired' }), SELF);
    expect(view.stateLabel).toBe('已过期');
    expect(view.canDecide || view.canRevoke).toBe(false);
  });
});

describe('房间准备与开始的可点性判定', () => {
  it('界面不提供建房动作：房间由服务端在受邀接受时建立', () => {
    const actions = collabRoomActions({
      room: null,
      members: [],
      selfUid: SELF,
      invitationAccepted: false,
    });
    expect(Object.hasOwn(actions, 'canCreate')).toBe(false);
    expect(actions.blockedReason).toContain('接受');
  });
  it('房主且双方都 ready 才能开始', () => {
    const actions = collabRoomActions({
      room: room(),
      members: [
        member({ readiness: 'ready' }),
        member({ uid: PEER, role: 'participant', readiness: 'ready' }),
      ],
      selfUid: SELF,
      invitationAccepted: true,
    });
    expect(actions).toMatchObject({ canStart: true, canSetReadiness: true, canSend: false });
    expect(actions.blockedReason).toBeNull();
  });
  it('同学还未 ready 时房主的开始按钮保持不亮', () => {
    const actions = collabRoomActions({
      room: room(),
      members: [member({ readiness: 'ready' }), member({ uid: PEER, role: 'participant' })],
      selfUid: SELF,
      invitationAccepted: true,
    });
    expect(actions.canStart).toBe(false);
    expect(actions.blockedReason).toContain('准备');
  });
  it('受邀方不是房主，永远没有开始权', () => {
    const actions = collabRoomActions({
      room: room({ ownerUid: PEER }),
      members: [
        member({ uid: PEER, role: 'owner', readiness: 'ready' }),
        member({ uid: SELF, role: 'participant', readiness: 'ready' }),
      ],
      selfUid: SELF,
      invitationAccepted: true,
    });
    expect(actions.canStart).toBe(false);
    expect(actions.canSetReadiness).toBe(true);
    expect(actions.blockedReason).toContain('房主');
  });
  it('成员不足两人（第三方房间）不给开始权', () => {
    const actions = collabRoomActions({
      room: room(),
      members: [
        member({ readiness: 'ready' }),
        member({ uid: PEER, readiness: 'ready' }),
        member({ uid: STRANGER, readiness: 'ready' }),
      ],
      selfUid: SELF,
      invitationAccepted: true,
    });
    expect(actions.canStart).toBe(false);
  });
  it('课堂已开始只允许发言，准备状态不再变更', () => {
    const actions = collabRoomActions({
      room: room({ status: 'active' }),
      members: [member()],
      selfUid: SELF,
      invitationAccepted: true,
    });
    expect(actions).toMatchObject({ canSend: true, canSetReadiness: false, canStart: false });
  });
  it('课程已结束全部只读', () => {
    const actions = collabRoomActions({
      room: room({ status: 'ended' }),
      members: [member()],
      selfUid: SELF,
      invitationAccepted: true,
    });
    expect(actions.canSend || actions.canSetReadiness || actions.canStart).toBe(false);
  });
});

describe('游标读回与身份标注', () => {
  const event = (over: Partial<CollabEventDto> = {}): CollabEventDto => ({
    eventId: 'evt_1',
    roomId: 'room_1',
    seq: 1,
    kind: 'scene_changed',
    actorUid: SELF,
    summary: '进入场景 1',
    createdAt: '2026-10-06T01:00:00.000Z',
    ...over,
  });

  it('游标取已见最大 seq，空集合回 0', () => {
    expect(collabCursor([])).toBe(0);
    expect(collabCursor([message({ seq: 4 }), message({ seq: 9, messageId: 'msg_2' })])).toBe(9);
  });
  it('重试读回同一序号只留一条并按 seq 升序', () => {
    const current = [
      message({ seq: 2, messageId: 'msg_b' }),
      message({ seq: 1, messageId: 'msg_a' }),
    ];
    const incoming = [
      message({ seq: 1, messageId: 'msg_a' }),
      message({ seq: 3, messageId: 'msg_c' }),
    ];
    const merged = collabMergeBySeq(current, incoming);
    expect(merged.map((item) => item.seq)).toEqual([1, 2, 3]);
  });
  it('AI 同学与教师必须标明模拟身份，本人显示为我', () => {
    const names = { [PEER]: '小明', [STRANGER]: '小红' };
    expect(collabSenderLabel(message({ senderType: 'peer_ai' }), SELF, names)).toContain('AI 同学');
    expect(collabSenderLabel(message({ senderType: 'teacher_ai' }), SELF, names)).toContain('教师');
    expect(collabSenderLabel(message(), SELF, names)).toBe('我');
    expect(collabSenderLabel(message({ senderUid: STRANGER }), SELF, names)).toBe('小红');
  });
  it('昵称缺失时退回 UID 显示，不用空串掩盖发送者', () => {
    expect(collabSenderLabel(message({ senderUid: PEER }), SELF, {})).toBe(PEER);
  });
  it('事件摘要不携带私人答案字段', () => {
    expect(JSON.stringify(event())).not.toContain('answer');
  });
});

describe('面板静态渲染', () => {
  it('never exposes invite or active room actions for an outsider or a departed learner', () => {
    expect(collabInvitationView(invitation(), STRANGER).canRevoke).toBe(false);
    for (const members of [[], [member({ readiness: 'left' })]]) {
      const actions = collabRoomActions({
        room: room({ status: 'active' }),
        members,
        selfUid: SELF,
        invitationAccepted: true,
      });
      expect(actions.canSend || actions.canSetReadiness || actions.canStart).toBe(false);
    }
  });
  it('在线未连接时如实标注不能联网邀请，并显示本人 UID 与不可邀请原因', async () => {
    const { CollabClassroomPanel } = await import('../apps/learning/components/collab-classroom');
    const html = renderToStaticMarkup(
      createElement(CollabClassroomPanel, {
        scope: { projectId: 'proj_test', generation: 1 },
        selfUid: SELF,
        selfDisplayName: '本人',
        lessons: [
          { lessonId: 'lesson_1', lessonVersion: 3, title: '单调性', snapshotDigest: DIGEST },
        ],
      }),
    );
    // 服务端尚未读回在线状态时按「未配置」呈现：明确显示不能联网邀请，且不发邀请。
    expect(html).toContain('不能联网邀请');
    expect(html).toContain(SELF);
    expect(html).toContain('还没有邀请');
    // 未打开房间前不渲染讨论区，避免把「尚未建立第二条链路」演成已有同学在课内。
    expect(html).not.toContain('data-collab-send');
  });
});
