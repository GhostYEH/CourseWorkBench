import { describe, expect, it } from 'vitest';
import { StudyError } from '@sew/study-contracts';
import {
  collabEventAppendSchema,
  collabInvitationCreateSchema,
  collabInvitationDecisionSchema,
  collabInvitationRevokeSchema,
  collabMessageAppendSchema,
  collabMessageSchema,
} from '@sew/study-contracts';
import {
  assertCollabAdmission,
  assertCollabEventAppendable,
  assertCollabInvitationCreatable,
  assertCollabInvitationDecidable,
  assertCollabInvitationRevocable,
  assertCollabMessageWritable,
  assertCollabResyncCursor,
  assertCollabRoomStartable,
  assertCollabSnapshotMatch,
  assertCollabTeacherEventAllowed,
} from '@sew/study-domain';

const UID_A = 'uid_10000000-0000-4000-8000-000000000001';
const UID_B = 'uid_10000000-0000-4000-8000-000000000002';
const UID_C = 'uid_10000000-0000-4000-8000-000000000003';
const DIGEST = 'a'.repeat(64);

const invitation = (
  status: 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired' = 'pending',
) => ({
  invitationId: 'inv_1',
  roomId: 'room_1',
  inviterUid: UID_A,
  inviteeUid: UID_B,
  lessonId: 'lesson_1',
  lessonVersion: 1,
  snapshotDigest: DIGEST,
  status,
  createdAt: '2026-10-06T00:00:00.000Z',
  expiresAt: '2026-10-08T00:00:00.000Z',
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

describe('INVITE-01 邀请发起与表态', () => {
  it('拒绝自邀、未登记发起人与不完整的课程绑定', () => {
    expectCode(
      () =>
        assertCollabInvitationCreatable({
          inviterUid: UID_A,
          inviteeUid: UID_A,
          lessonId: 'lesson_1',
          lessonVersion: 1,
          snapshotDigest: DIGEST,
          inviterRegistered: true,
        }),
      'INVALID_ARGUMENT',
      'cannot_invite_self',
    );
    expectCode(
      () =>
        assertCollabInvitationCreatable({
          inviterUid: UID_A,
          inviteeUid: UID_B,
          lessonId: 'lesson_1',
          lessonVersion: 1,
          snapshotDigest: DIGEST,
          inviterRegistered: false,
        }),
      'PROJECT_NOT_AUTHORIZED',
      'inviter_not_registered',
    );
    expectCode(
      () =>
        assertCollabInvitationCreatable({
          inviterUid: UID_A,
          inviteeUid: UID_B,
          lessonId: '',
          lessonVersion: 1,
          snapshotDigest: DIGEST,
          inviterRegistered: true,
        }),
      'INVALID_ARGUMENT',
      'invitation_course_incomplete',
    );
  });

  it('只有受邀本人在有效期内能表态，已决/过期不能二次表态', () => {
    assertCollabInvitationDecidable({
      invitation: invitation(),
      actorUid: UID_B,
      decision: 'accepted',
      now: '2026-10-06T01:00:00.000Z',
    });
    expectCode(
      () =>
        assertCollabInvitationDecidable({
          invitation: invitation(),
          actorUid: UID_A,
          decision: 'accepted',
          now: '2026-10-06T01:00:00.000Z',
        }),
      'ROLE_PERMISSION_DENIED',
      'only_invitee_decides',
    );
    expectCode(
      () =>
        assertCollabInvitationDecidable({
          invitation: invitation('accepted'),
          actorUid: UID_B,
          decision: 'accepted',
          now: '2026-10-06T01:00:00.000Z',
        }),
      'VERSION_CONFLICT',
      'invitation_already_decided',
    );
    expectCode(
      () =>
        assertCollabInvitationDecidable({
          invitation: invitation(),
          actorUid: UID_B,
          decision: 'accepted',
          now: '2026-10-09T00:00:00.000Z',
        }),
      'VERSION_CONFLICT',
      'invitation_expired',
    );
  });

  it('只有发起人在表态前能撤销，受邀人走表态不走撤销', () => {
    assertCollabInvitationRevocable({ invitation: invitation(), actorUid: UID_A });
    expectCode(
      () => assertCollabInvitationRevocable({ invitation: invitation(), actorUid: UID_B }),
      'ROLE_PERMISSION_DENIED',
      'only_inviter_revokes',
    );
    expectCode(
      () =>
        assertCollabInvitationRevocable({ invitation: invitation('accepted'), actorUid: UID_A }),
      'VERSION_CONFLICT',
      'invitation_already_decided',
    );
  });

  it('命令 schema 拒绝自报越权字段与非法 UID', () => {
    expect(
      collabInvitationCreateSchema.safeParse({
        roomId: 'room_1',
        inviterUid: UID_A,
        inviteeUid: UID_A,
        lessonId: 'lesson_1',
        lessonVersion: 1,
        snapshotDigest: DIGEST,
        requestId: 'req_1',
      }).success,
    ).toBe(true);
    expect(
      collabInvitationDecisionSchema.safeParse({
        invitationId: 'inv_1',
        actorUid: 'forged',
        decision: 'accepted',
        requestId: 'req_1',
      }).success,
    ).toBe(false);
    expect(
      collabInvitationRevokeSchema.safeParse({
        invitationId: 'inv_1',
        actorUid: UID_B,
        requestId: 'req_1',
        status: 'pending',
      }).success,
    ).toBe(false);
  });
});

describe('CHAT-01 课内消息归属与去重形状', () => {
  it('只有成员真人能写，房间结束后与伪造身份一律拒绝', () => {
    assertCollabMessageWritable({
      roomId: 'room_1',
      senderUid: UID_A,
      senderType: 'human_learner',
      body: '这一步我算出来是增函数。',
      memberUids: [UID_A, UID_B],
      roomEnded: false,
    });
    expectCode(
      () =>
        assertCollabMessageWritable({
          roomId: 'room_1',
          senderUid: UID_C,
          senderType: 'human_learner',
          body: '我是路过的。',
          memberUids: [UID_A, UID_B],
          roomEnded: false,
        }),
      'ROLE_PERMISSION_DENIED',
      'not_room_member',
    );
    expectCode(
      () =>
        assertCollabMessageWritable({
          roomId: 'room_1',
          senderUid: UID_A,
          senderType: 'peer_ai',
          body: '我是同学。',
          memberUids: [UID_A, UID_B],
          roomEnded: false,
        }),
      'ROLE_PERMISSION_DENIED',
      'chat_only_human',
    );
    expectCode(
      () =>
        assertCollabMessageWritable({
          roomId: 'room_1',
          senderUid: UID_A,
          senderType: 'human_learner',
          body: '结束了还发。',
          memberUids: [UID_A, UID_B],
          roomEnded: true,
        }),
      'RUN_TERMINATED',
      'room_ended',
    );
  });

  it('消息形状拒绝空正文、超长正文、本地路径与AI伪造', () => {
    expect(
      collabMessageAppendSchema.safeParse({
        roomId: 'room_1',
        senderUid: UID_A,
        senderType: 'human_learner',
        body: '   ',
        requestId: 'req_1',
      }).success,
    ).toBe(false);
    expect(
      collabMessageSchema.safeParse({
        messageId: 'msg_1',
        roomId: 'room_1',
        seq: 1,
        senderUid: UID_A,
        senderType: 'peer_ai',
        body: 'AI 不能经聊天入口写',
        dedupKey: 'req_1',
        createdAt: '2026-10-06T00:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      collabMessageAppendSchema.safeParse({
        roomId: 'room_1',
        senderUid: UID_A,
        senderType: 'human_learner',
        body: '看 C:/private/answer.txt',
        requestId: 'req_1',
      }).success,
    ).toBe(false);
    expect(
      collabMessageAppendSchema.safeParse({
        roomId: 'room_1',
        senderUid: UID_A,
        senderType: 'peer_ai',
        body: '伪造同学发言',
        requestId: 'req_1',
      }).success,
    ).toBe(false);
  });
});

describe('SYNC-01 事件序号与重连游标', () => {
  it('追加序号必须恰好是尾序号+1，非成员与未知种类拒绝', () => {
    assertCollabEventAppendable({
      kind: 'scene_changed',
      expectedSeq: 4,
      tailSeq: 3,
      roomEnded: false,
      actorIsMember: true,
    });
    expectCode(
      () =>
        assertCollabEventAppendable({
          kind: 'scene_changed',
          expectedSeq: 5,
          tailSeq: 3,
          roomEnded: false,
          actorIsMember: true,
        }),
      'VERSION_CONFLICT',
      'collab_event_seq_mismatch',
    );
    expectCode(
      () =>
        assertCollabEventAppendable({
          kind: 'scene_changed',
          expectedSeq: 4,
          tailSeq: 3,
          roomEnded: false,
          actorIsMember: false,
        }),
      'ROLE_PERMISSION_DENIED',
      'not_room_member',
    );
    expectCode(
      () =>
        assertCollabEventAppendable({
          kind: 'scene_changed',
          expectedSeq: 4,
          tailSeq: 3,
          roomEnded: true,
          actorIsMember: true,
        }),
      'RUN_TERMINATED',
      'room_ended',
    );
  });

  it('房间结束后只允许成员离开事件，其余公共输出一律拒绝', () => {
    assertCollabEventAppendable({
      kind: 'member_left',
      expectedSeq: 4,
      tailSeq: 3,
      roomEnded: true,
      actorIsMember: true,
    });
    expectCode(
      () =>
        assertCollabEventAppendable({
          kind: 'teacher_output',
          expectedSeq: 4,
          tailSeq: 3,
          roomEnded: true,
          actorIsMember: true,
        }),
      'RUN_TERMINATED',
      'room_ended',
    );
  });

  it('重连游标不能为负、不能超前，合法区间放行', () => {
    assertCollabResyncCursor({ afterSeq: 0, tailSeq: 3 });
    assertCollabResyncCursor({ afterSeq: 3, tailSeq: 3 });
    expectCode(
      () => assertCollabResyncCursor({ afterSeq: -1, tailSeq: 3 }),
      'INVALID_ARGUMENT',
      'collab_cursor_invalid',
    );
    expectCode(
      () => assertCollabResyncCursor({ afterSeq: 4, tailSeq: 3 }),
      'VERSION_CONFLICT',
      'collab_cursor_ahead',
    );
    expect(
      collabEventAppendSchema.safeParse({
        roomId: 'room_1',
        eventId: 'evt_1',
        kind: 'scene_changed',
        actorUid: UID_A,
        summary: '进入场景 2',
        expectedSeq: 4,
        requestId: 'req_1',
      }).success,
    ).toBe(true);
    expect(
      collabEventAppendSchema.safeParse({
        roomId: 'room_1',
        eventId: 'evt_blank',
        kind: 'scene_changed',
        actorUid: UID_A,
        summary: '   ',
        expectedSeq: 4,
        requestId: 'req_blank',
      }).success,
    ).toBe(false);
  });
});

describe('准备页与入场核验', () => {
  const course = { lessonId: 'lesson_1', lessonVersion: 1, snapshotDigest: DIGEST };
  const readyMembers = [
    { uid: UID_A, readiness: 'ready' as const },
    { uid: UID_B, readiness: 'ready' as const },
  ];

  it('两人就绪且课程一致时只有发起人能开始', () => {
    assertCollabRoomStartable({
      inviterUid: UID_A,
      inviteeUid: UID_B,
      lessonId: 'lesson_1',
      lessonVersion: 1,
      snapshotDigest: DIGEST,
      actorUid: UID_A,
      members: readyMembers,
      course,
    });
    expectCode(
      () =>
        assertCollabRoomStartable({
          inviterUid: UID_A,
          inviteeUid: UID_B,
          lessonId: 'lesson_1',
          lessonVersion: 1,
          snapshotDigest: DIGEST,
          actorUid: UID_B,
          members: readyMembers,
          course,
        }),
      'ROLE_PERMISSION_DENIED',
      'only_inviter_starts',
    );
  });

  it('成员缺席/换人/未就绪一律不能开始', () => {
    expectCode(
      () =>
        assertCollabRoomStartable({
          inviterUid: UID_A,
          inviteeUid: UID_B,
          lessonId: 'lesson_1',
          lessonVersion: 1,
          snapshotDigest: DIGEST,
          actorUid: UID_A,
          members: [{ uid: UID_A, readiness: 'ready' as const }],
          course,
        }),
      'VERSION_CONFLICT',
      'collab_members_mismatch',
    );
    expectCode(
      () =>
        assertCollabRoomStartable({
          inviterUid: UID_A,
          inviteeUid: UID_B,
          lessonId: 'lesson_1',
          lessonVersion: 1,
          snapshotDigest: DIGEST,
          actorUid: UID_A,
          members: [
            { uid: UID_A, readiness: 'ready' as const },
            { uid: UID_C, readiness: 'ready' as const },
          ],
          course,
        }),
      'VERSION_CONFLICT',
      'collab_members_mismatch',
    );
    expectCode(
      () =>
        assertCollabRoomStartable({
          inviterUid: UID_A,
          inviteeUid: UID_B,
          lessonId: 'lesson_1',
          lessonVersion: 1,
          snapshotDigest: DIGEST,
          actorUid: UID_A,
          members: [
            { uid: UID_A, readiness: 'ready' as const },
            { uid: UID_B, readiness: 'pending' as const },
          ],
          course,
        }),
      'VERSION_CONFLICT',
      'collab_members_not_ready',
    );
  });

  it('邀请后课程变化不能按旧邀请开课，只能重新邀请', () => {
    expectCode(
      () =>
        assertCollabRoomStartable({
          inviterUid: UID_A,
          inviteeUid: UID_B,
          lessonId: 'lesson_1',
          lessonVersion: 1,
          snapshotDigest: DIGEST,
          actorUid: UID_A,
          members: readyMembers,
          course: { ...course, lessonVersion: 2 },
        }),
      'VERSION_CONFLICT',
      'collab_course_changed',
    );
  });

  it('入场核验课程版本、自报身份与成员资格，房间结束后拒绝', () => {
    assertCollabAdmission({
      roomCourse: course,
      presentedCourse: course,
      claimedUid: UID_B,
      sessionUid: UID_B,
      memberUids: [UID_A, UID_B],
      roomEnded: false,
    });
    expectCode(
      () =>
        assertCollabAdmission({
          roomCourse: course,
          presentedCourse: course,
          claimedUid: UID_A,
          sessionUid: UID_B,
          memberUids: [UID_A, UID_B],
          roomEnded: false,
        }),
      'PROJECT_NOT_AUTHORIZED',
      'collab_identity_mismatch',
    );
    expectCode(
      () =>
        assertCollabAdmission({
          roomCourse: course,
          presentedCourse: course,
          claimedUid: UID_C,
          sessionUid: UID_C,
          memberUids: [UID_A, UID_B],
          roomEnded: false,
        }),
      'ROLE_PERMISSION_DENIED',
      'not_room_member',
    );
    expectCode(
      () =>
        assertCollabAdmission({
          roomCourse: course,
          presentedCourse: { ...course, snapshotDigest: 'b'.repeat(64) },
          claimedUid: UID_B,
          sessionUid: UID_B,
          memberUids: [UID_A, UID_B],
          roomEnded: false,
        }),
      'VERSION_CONFLICT',
      'collab_course_changed',
    );
    expectCode(
      () =>
        assertCollabAdmission({
          roomCourse: course,
          presentedCourse: course,
          claimedUid: UID_B,
          sessionUid: UID_B,
          memberUids: [UID_A, UID_B],
          roomEnded: true,
        }),
      'RUN_TERMINATED',
      'room_ended',
    );
  });
});

describe('双端快照一致与唯一教师执行权', () => {
  const snapshot = {
    lessonId: 'lesson_1',
    lessonVersion: 1,
    documentDigest: DIGEST,
    bundleDigest: 'b'.repeat(64),
  };

  it('四项摘要完全一致才算同一节课，任一项不同即拒绝', () => {
    assertCollabSnapshotMatch({ local: snapshot, remote: { ...snapshot } });
    expectCode(
      () =>
        assertCollabSnapshotMatch({ local: snapshot, remote: { ...snapshot, lessonVersion: 2 } }),
      'VERSION_CONFLICT',
      'collab_snapshot_mismatch',
    );
    expectCode(
      () =>
        assertCollabSnapshotMatch({
          local: snapshot,
          remote: { ...snapshot, bundleDigest: DIGEST },
        }),
      'VERSION_CONFLICT',
      'collab_snapshot_mismatch',
    );
  });

  it('教师公共输出与场景切换只允许房主，白板动作允许成员', () => {
    assertCollabTeacherEventAllowed({
      kind: 'teacher_output',
      actorUid: UID_A,
      ownerUid: UID_A,
      memberUids: [UID_A, UID_B],
    });
    assertCollabTeacherEventAllowed({
      kind: 'board_action',
      actorUid: UID_B,
      ownerUid: UID_A,
      memberUids: [UID_A, UID_B],
    });
    expectCode(
      () =>
        assertCollabTeacherEventAllowed({
          kind: 'teacher_output',
          actorUid: UID_B,
          ownerUid: UID_A,
          memberUids: [UID_A, UID_B],
        }),
      'ROLE_PERMISSION_DENIED',
      'only_owner_teaches',
    );
    expectCode(
      () =>
        assertCollabTeacherEventAllowed({
          kind: 'scene_changed',
          actorUid: UID_B,
          ownerUid: UID_A,
          memberUids: [UID_A, UID_B],
        }),
      'ROLE_PERMISSION_DENIED',
      'only_owner_advances',
    );
    expectCode(
      () =>
        assertCollabTeacherEventAllowed({
          kind: 'board_action',
          actorUid: UID_C,
          ownerUid: UID_A,
          memberUids: [UID_A, UID_B],
        }),
      'ROLE_PERMISSION_DENIED',
      'not_room_member',
    );
  });
});
