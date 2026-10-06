import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiResponses } from '@sew/study-contracts';
import { createNodeSqliteDriver, projectPaths } from '@sew/study-storage';
import {
  GET as registrationGet,
  POST as registrationPost,
} from '../apps/learning/app/api/study/collab/registration/route';
import {
  GET as invitationsGet,
  POST as invitationsPost,
} from '../apps/learning/app/api/study/collab/invitations/route';
import {
  GET as roomsGet,
  POST as roomsPost,
} from '../apps/learning/app/api/study/collab/rooms/route';
import {
  GET as messagesGet,
  POST as messagesPost,
} from '../apps/learning/app/api/study/collab/messages/route';
import {
  GET as eventsGet,
  POST as eventsPost,
} from '../apps/learning/app/api/study/collab/events/route';
import {
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';

/**
 * 协作命令的 HTTP 边界（INVITE-01 / SYNC-01 / CHAT-01 的本地链路，ADR-0004）。
 *
 * 固定四件事：① 身份由**服务端会话**绑定，请求体自报他人 UID 一律拒绝；
 * ② 邀请生命周期、房间成员、消息、事件的权威序号在 HTTP 层可读回，且响应通过运行时合同校验；
 * ③ **读取侧**同样要求是房间成员（房间存在时「知道 roomId」不足以读）；
 * ④ 教师/场景事件只允许房主、白板动作允许成员、游标越界明确失败。
 *
 * 这里覆盖的是**本机链路**；双设备在线联调仍属 COLLAB-EVAL-01，未执行。
 */

const OTHER_UID = 'uid_20000000-0000-4000-8000-000000000002';
const OUTSIDER_A = 'uid_20000000-0000-4000-8000-000000000003';
const OUTSIDER_B = 'uid_20000000-0000-4000-8000-000000000004';
const DIGEST = 'a'.repeat(64);
const ROOM = 'room_http_1';

describe('协作命令 HTTP 边界', () => {
  let root: string;
  let session: Session;
  let selfUid = '';
  const url = (path: string): string => `http://127.0.0.1${path}`;
  const headers = () => ({
    'content-type': 'application/json',
    'x-sew-project-id': session.projectId,
    'x-sew-generation': String(session.generation),
  });
  const post = (path: string, body: Record<string, unknown>) =>
    new Request(url(path), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
  const get = (path: string) => new Request(url(path), { method: 'GET', headers: headers() });
  /** 一次读取响应体，返回 { data } / { error }；同一响应不能读两次。 */
  const jsonOf = async (
    response: Response,
  ): Promise<{
    data?: Record<string, unknown>;
    error?: { code: string; details?: Record<string, unknown> };
  }> => (await response.json()) as never;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-collab-http-'));
    session = openProjectFromDisk(root);
    selfUid = session.learnerUid;
    // 本机链路要求双方都已登记；本会话是「乙」，另一台设备是「甲」。
    session.store.registerCollaborationUid({
      uid: selfUid,
      displayName: '乙',
      requestId: 'reg-self',
    });
    session.store.registerCollaborationUid({
      uid: OTHER_UID,
      displayName: '甲',
      requestId: 'reg-other',
    });
  });

  afterEach(() => {
    closeProject();
    rmSync(root, { recursive: true, force: true });
  });

  it('requires a project scope and rejects stale reads and writes after project reopen', async () => {
    expect((await registrationGet(new Request(url('/api/study/collab/registration')))).status).toBe(
      400,
    );
    const staleRead = get('/api/study/collab/registration');
    const staleWrite = post('/api/study/collab/registration', {
      uid: selfUid,
      displayName: '旧页面',
      requestId: 'stale-write',
    });
    session = openProjectFromDisk(root);
    expect((await registrationGet(staleRead)).status).toBe(409);
    expect((await registrationPost(staleWrite)).status).toBe(409);
    expect(session.store.getCollaborationRegistration(selfUid)!.displayName).toBe('乙');
  });

  /** 由「甲」（另一台设备）发起给本会话「乙」的邀请。 */
  const inviteFromOther = (requestId = 'inv-other-1') =>
    session.store.inviteCollaborator({
      roomId: ROOM,
      inviterUid: OTHER_UID,
      inviteeUid: selfUid,
      lessonId: 'lesson_1',
      lessonVersion: 1,
      snapshotDigest: DIGEST,
      requestId,
    });

  const acceptAsSelf = async (invitationId: string, requestId = 'http-accept-1') =>
    invitationsPost(
      post('/api/study/collab/invitations', {
        action: 'decide',
        invitationId,
        actorUid: selfUid,
        decision: 'accepted',
        requestId,
      }),
    );

  const collaborationRows = () => {
    const db = createNodeSqliteDriver().open(projectPaths(root).databaseFile);
    try {
      return {
        invitations: db.prepare('SELECT * FROM collab_invitations ORDER BY invitation_id').all(),
        rooms: db.prepare('SELECT * FROM collab_rooms ORDER BY room_id').all(),
        members: db.prepare('SELECT * FROM collab_room_members ORDER BY room_id, uid').all(),
        receipts: db.prepare('SELECT * FROM collab_command_receipts ORDER BY request_id').all(),
        messages: db.prepare('SELECT * FROM collab_room_messages ORDER BY room_id, seq').all(),
        events: db.prepare('SELECT * FROM collab_room_events ORDER BY room_id, seq').all(),
      };
    } finally {
      db.close();
    }
  };

  it('登记：GET 读回本机链路登记（过合同），请求体自报他人 UID 被拒', async () => {
    const read = await registrationGet(get('/api/study/collab/registration'));
    expect(read.status).toBe(200);
    const { data } = await jsonOf(read);
    expect(apiResponses.collabRegistration.safeParse(data).success).toBe(true);
    expect(data!.registration).toMatchObject({ uid: selfUid, authority: 'local_link' });

    const forged = await registrationPost(
      post('/api/study/collab/registration', {
        uid: OTHER_UID,
        displayName: '冒充',
        requestId: 'reg-forged',
      }),
    );
    expect(forged.status).toBe(403);
    expect((await jsonOf(forged)).error?.details?.['reason']).toBe('collab_identity_mismatch');
  });

  it('登记：displayName 含本地路径被拒（避免把一端文件布局显示给另一端）', async () => {
    const rejected = await registrationPost(
      post('/api/study/collab/registration', {
        uid: selfUid,
        displayName: 'C:\\Users\\yao\\secret.txt',
        requestId: 'reg-path',
      }),
    );
    expect(rejected.status).toBe(400);
    expect((await jsonOf(rejected)).error?.code).toBe('INVALID_ARGUMENT');
  });

  it('邀请：发起、列出、表态（接受建成员）、撤销，全部经 HTTP 可读回且过合同', async () => {
    const invited = await invitationsPost(
      post('/api/study/collab/invitations', {
        action: 'invite',
        roomId: ROOM,
        inviterUid: selfUid,
        inviteeUid: OTHER_UID,
        lessonId: 'lesson_1',
        lessonVersion: 1,
        snapshotDigest: DIGEST,
        requestId: 'http-inv-1',
      }),
    );
    expect(invited.status).toBe(200);
    const invitedData = await jsonOf(invited);
    expect(apiResponses.collabInvitationWrite.safeParse(invitedData.data).success).toBe(true);
    const invitation = invitedData.data!.invitation as Record<string, unknown>;
    expect(invitation).toMatchObject({
      status: 'pending',
      inviterUid: selfUid,
      inviteeUid: OTHER_UID,
    });

    const listed = await invitationsGet(get('/api/study/collab/invitations'));
    expect(listed.status).toBe(200);
    const listedData = await jsonOf(listed);
    expect(apiResponses.collabInvitations.safeParse(listedData.data).success).toBe(true);
    expect(listedData.data!.invitations as unknown[]).toHaveLength(1);

    // 本会话是发起人，不能替受邀人表态。
    const forgedDecide = await invitationsPost(
      post('/api/study/collab/invitations', {
        action: 'decide',
        invitationId: invitation['invitationId'],
        actorUid: OTHER_UID,
        decision: 'accepted',
        requestId: 'http-decide-forged',
      }),
    );
    expect(forgedDecide.status).toBe(403);

    const revoked = await invitationsPost(
      post('/api/study/collab/invitations', {
        action: 'revoke',
        invitationId: invitation['invitationId'],
        actorUid: selfUid,
        requestId: 'http-revoke-1',
      }),
    );
    expect(revoked.status).toBe(200);
    const revokedData = await jsonOf(revoked);
    expect(apiResponses.collabInvitationWrite.safeParse(revokedData.data).success).toBe(true);
    expect((revokedData.data!.invitation as Record<string, unknown>)['status']).toBe('revoked');
  });

  it('房间：房主可显式建房并成为 owner（过合同），非房主建房被拒', async () => {
    const created = await roomsPost(
      post('/api/study/collab/rooms', {
        action: 'create',
        roomId: ROOM,
        ownerUid: selfUid,
        lessonId: 'lesson_1',
        lessonVersion: 1,
        snapshotDigest: DIGEST,
        currentSceneId: 'scene_1',
        requestId: 'http-room-create',
      }),
    );
    expect(created.status).toBe(200);
    const createdData = await jsonOf(created);
    expect(apiResponses.collabRoom.safeParse(createdData.data).success).toBe(true);
    expect(createdData.data!.room).toMatchObject({ roomId: ROOM, ownerUid: selfUid });
    expect(session.store.listCollaborationMembers(ROOM)).toMatchObject([
      { uid: selfUid, role: 'owner', readiness: 'pending' },
    ]);

    const forged = await roomsPost(
      post('/api/study/collab/rooms', {
        action: 'create',
        roomId: 'room_http_forged',
        ownerUid: OTHER_UID,
        lessonId: 'lesson_1',
        lessonVersion: 1,
        snapshotDigest: DIGEST,
        currentSceneId: 'scene_1',
        requestId: 'http-room-forged',
      }),
    );
    expect(forged.status).toBe(403);
    expect((await jsonOf(forged)).error?.details?.['reason']).toBe('collab_identity_mismatch');
  });

  it('房间：受邀方接受后成为成员，可改本人准备状态；非成员不能改', async () => {
    const created = inviteFromOther();
    const accepted = await acceptAsSelf(created.invitation.invitationId);
    expect(accepted.status).toBe(200);
    const acceptedData = await jsonOf(accepted);
    expect(apiResponses.collabInvitationWrite.safeParse(acceptedData.data).success).toBe(true);
    expect(acceptedData.data!.member).toMatchObject({ uid: selfUid, role: 'participant' });

    const ready = await roomsPost(
      post('/api/study/collab/rooms', {
        action: 'readiness',
        roomId: ROOM,
        uid: selfUid,
        readiness: 'ready',
        requestId: 'http-ready-1',
      }),
    );
    expect(ready.status).toBe(200);
    expect(apiResponses.collabMemberWrite.safeParse((await jsonOf(ready)).data).success).toBe(true);

    // 非成员改准备状态被拒（身份自报也不通过）。
    const forged = await roomsPost(
      post('/api/study/collab/rooms', {
        action: 'readiness',
        roomId: ROOM,
        uid: OTHER_UID,
        readiness: 'ready',
        requestId: 'http-ready-forged',
      }),
    );
    expect(forged.status).toBe(403);

    const room = await roomsGet(get(`/api/study/collab/rooms?roomId=${ROOM}`));
    expect(room.status).toBe(200);
    const roomData = await jsonOf(room);
    expect(apiResponses.collabRoomView.safeParse(roomData.data).success).toBe(true);
    expect(roomData.data!.room).toMatchObject({ roomId: ROOM, ownerUid: OTHER_UID });
  });

  it('开始共同课堂：未就绪被拒，双方就绪后房主可开始（房间置 active）', async () => {
    // 本会话作为房主邀请「甲」，甲接受后成为 participant。
    const invited = await invitationsPost(
      post('/api/study/collab/invitations', {
        action: 'invite',
        roomId: ROOM,
        inviterUid: selfUid,
        inviteeUid: OTHER_UID,
        lessonId: 'lesson_1',
        lessonVersion: 1,
        snapshotDigest: DIGEST,
        requestId: 'http-start-invite',
      }),
    );
    const invitedInvitation = (await jsonOf(invited)).data!.invitation as Record<string, unknown>;
    session.store.decideCollaborationInvitation({
      invitationId: invitedInvitation['invitationId'] as string,
      actorUid: OTHER_UID,
      decision: 'accepted',
      requestId: 'start-accept',
    });

    const startBody = (requestId: string) => ({
      action: 'start',
      roomId: ROOM,
      actorUid: selfUid,
      requestId,
    });
    // 双方尚未就绪：开始被拒，且房间状态不变。
    const early = await roomsPost(post('/api/study/collab/rooms', startBody('http-start-early')));
    expect(early.status).toBe(409);
    expect((await jsonOf(early)).error?.details?.['reason']).toBe('collab_members_not_ready');

    session.store.setCollaborationMemberReadiness({
      roomId: ROOM,
      uid: selfUid,
      readiness: 'ready',
      requestId: 'ready-owner',
    });
    session.store.setCollaborationMemberReadiness({
      roomId: ROOM,
      uid: OTHER_UID,
      readiness: 'ready',
      requestId: 'ready-peer',
    });

    const started = await roomsPost(post('/api/study/collab/rooms', startBody('http-start-ok')));
    expect(started.status).toBe(200);
    const startedData = await jsonOf(started);
    expect(apiResponses.collabRoom.safeParse(startedData.data).success).toBe(true);
    expect((startedData.data!.room as Record<string, unknown>)['status']).toBe('active');
  });

  it('读取访问控制：房间存在时非成员不能读房间、消息与事件', async () => {
    // 「甲」建的房间：本会话不是成员。
    session.store.createCollaborationRoom({
      roomId: ROOM,
      ownerUid: OTHER_UID,
      lessonId: 'lesson_1',
      lessonVersion: 1,
      snapshotDigest: DIGEST,
      currentSceneId: 'scene_1',
      requestId: 'other-room',
    });
    const responses = [
      await roomsGet(get(`/api/study/collab/rooms?roomId=${ROOM}`)),
      await messagesGet(get(`/api/study/collab/messages?roomId=${ROOM}&afterSeq=0`)),
      await eventsGet(get(`/api/study/collab/events?roomId=${ROOM}&afterSeq=0`)),
    ];
    for (const response of responses) {
      expect(response.status).toBe(403);
      expect((await jsonOf(response)).error?.details?.['reason']).toBe('not_room_member');
    }
  });

  it('第三方不能借已有 roomId 邀请或接受旧恶意邀请，失败不改双方内容和历史', async () => {
    for (const uid of [OUTSIDER_A, OUTSIDER_B])
      session.store.registerCollaborationUid({
        uid,
        displayName: '已有房间成员',
        requestId: `reg-${uid}`,
      });
    const legitimate = session.store.inviteCollaborator({
      roomId: ROOM,
      inviterUid: OUTSIDER_A,
      inviteeUid: OUTSIDER_B,
      lessonId: 'lesson_1',
      lessonVersion: 1,
      snapshotDigest: DIGEST,
      requestId: 'legitimate-pair',
    }).invitation;
    session.store.decideCollaborationInvitation({
      invitationId: legitimate.invitationId,
      actorUid: OUTSIDER_B,
      decision: 'accepted',
      requestId: 'legitimate-accept',
    });
    session.store.appendCollaborationMessage({
      roomId: ROOM,
      senderUid: OUTSIDER_A,
      body: '已有双方的私有讨论',
      requestId: 'existing-history-message',
    });
    session.store.appendCollaborationEvent({
      roomId: ROOM,
      actorUid: OUTSIDER_A,
      kind: 'board_action',
      eventId: 'existing-history-event',
      summary: '已有双方的事件',
      expectedSeq: 1,
      requestId: 'existing-history-event-command',
    });
    const malicious = session.store.inviteCollaborator({
      roomId: 'room_old_malicious',
      inviterUid: OTHER_UID,
      inviteeUid: selfUid,
      lessonId: 'lesson_1',
      lessonVersion: 1,
      snapshotDigest: DIGEST,
      requestId: 'old-malicious-invite',
    }).invitation;
    const db = createNodeSqliteDriver().open(projectPaths(root).databaseFile);
    try {
      db.prepare('UPDATE collab_invitations SET room_id=? WHERE invitation_id=?').run(
        ROOM,
        malicious.invitationId,
      );
    } finally {
      db.close();
    }
    const before = collaborationRows();
    const inviteAttempt = await invitationsPost(
      post('/api/study/collab/invitations', {
        action: 'invite',
        roomId: ROOM,
        inviterUid: selfUid,
        inviteeUid: OTHER_UID,
        lessonId: 'lesson_1',
        lessonVersion: 1,
        snapshotDigest: DIGEST,
        requestId: 'http-room-hijack',
      }),
    );
    expect(inviteAttempt.status).toBe(403);
    const accepted = await acceptAsSelf(malicious.invitationId, 'http-malicious-accept');
    expect(accepted.status).toBe(403);
    expect((await jsonOf(accepted)).error?.details?.['reason']).toBe('collab_room_owner_mismatch');
    for (const response of [
      await roomsGet(get(`/api/study/collab/rooms?roomId=${ROOM}`)),
      await messagesGet(get(`/api/study/collab/messages?roomId=${ROOM}&afterSeq=0`)),
      await eventsGet(get(`/api/study/collab/events?roomId=${ROOM}&afterSeq=0`)),
    ])
      expect(response.status).toBe(403);
    expect(collaborationRows()).toEqual(before);
  });

  it('成员退出后房间、消息、事件读取及新写入/旧收据重放都拒绝，不能改 ready 重入', async () => {
    const created = inviteFromOther();
    await acceptAsSelf(created.invitation.invitationId, 'http-accept-before-left');
    const ready = {
      action: 'readiness',
      roomId: ROOM,
      uid: selfUid,
      readiness: 'ready',
      requestId: 'http-ready-before-left',
    };
    const message = {
      roomId: ROOM,
      senderUid: selfUid,
      senderType: 'human_learner',
      body: '退出前消息',
      requestId: 'http-message-before-left',
    };
    const event = {
      roomId: ROOM,
      eventId: 'evt-before-left',
      kind: 'board_action',
      actorUid: selfUid,
      summary: '退出前事件',
      expectedSeq: 1,
      requestId: 'http-event-before-left',
    };
    expect((await roomsPost(post('/api/study/collab/rooms', ready))).status).toBe(200);
    expect((await messagesPost(post('/api/study/collab/messages', message))).status).toBe(200);
    expect((await eventsPost(post('/api/study/collab/events', event))).status).toBe(200);
    const leave = {
      action: 'readiness',
      roomId: ROOM,
      uid: selfUid,
      readiness: 'left',
      requestId: 'http-member-left',
    };
    expect((await roomsPost(post('/api/study/collab/rooms', leave))).status).toBe(200);
    expect((await roomsPost(post('/api/study/collab/rooms', leave))).status).toBe(200);
    session.store.appendCollaborationMessage({
      roomId: ROOM,
      senderUid: OTHER_UID,
      body: '退出后不能读取的消息',
      requestId: 'message-after-left',
    });
    session.store.appendCollaborationEvent({
      roomId: ROOM,
      actorUid: OTHER_UID,
      kind: 'board_action',
      eventId: 'evt-after-left',
      summary: '退出后不能读取的事件',
      expectedSeq: 2,
      requestId: 'event-after-left',
    });
    const before = collaborationRows();
    const responses = [
      await roomsGet(get(`/api/study/collab/rooms?roomId=${ROOM}`)),
      await messagesGet(get(`/api/study/collab/messages?roomId=${ROOM}&afterSeq=0`)),
      await eventsGet(get(`/api/study/collab/events?roomId=${ROOM}&afterSeq=0`)),
      await roomsPost(post('/api/study/collab/rooms', ready)),
      await roomsPost(post('/api/study/collab/rooms', { ...ready, requestId: 'http-rejoin' })),
      await messagesPost(post('/api/study/collab/messages', message)),
      await messagesPost(
        post('/api/study/collab/messages', {
          ...message,
          requestId: 'http-new-message-after-left',
        }),
      ),
      await eventsPost(post('/api/study/collab/events', event)),
      await eventsPost(
        post('/api/study/collab/events', {
          ...event,
          eventId: 'evt-new-after-left',
          expectedSeq: 3,
          requestId: 'http-new-event-after-left',
        }),
      ),
      await acceptAsSelf(created.invitation.invitationId, 'http-accept-before-left'),
    ];
    for (const response of responses) {
      expect(response.status).toBe(403);
      const result = await jsonOf(response);
      expect(result.data).toBeUndefined();
      expect(result.error?.details?.['reason']).toBe('not_room_member');
    }
    expect(collaborationRows()).toEqual(before);
    expect(
      session.store.listCollaborationMembers(ROOM).find((member) => member.uid === selfUid)
        ?.readiness,
    ).toBe('left');
  });

  it('房主退出 HTTP 链路同步结束房间并撤销读取权限', async () => {
    const created = await roomsPost(
      post('/api/study/collab/rooms', {
        action: 'create',
        roomId: ROOM,
        ownerUid: selfUid,
        lessonId: 'lesson_1',
        lessonVersion: 1,
        snapshotDigest: DIGEST,
        currentSceneId: 'scene_1',
        requestId: 'http-owner-room',
      }),
    );
    expect(created.status).toBe(200);
    const leave = await roomsPost(
      post('/api/study/collab/rooms', {
        action: 'readiness',
        roomId: ROOM,
        uid: selfUid,
        readiness: 'left',
        requestId: 'http-owner-left',
      }),
    );
    expect(leave.status).toBe(200);
    expect(session.store.getCollaborationRoom(ROOM)?.status).toBe('ended');
    expect((await roomsGet(get(`/api/study/collab/rooms?roomId=${ROOM}`))).status).toBe(403);
  });

  it('消息：本人追加可按游标读回（过合同），自报他人发送者被拒，游标越界明确失败', async () => {
    const created = inviteFromOther();
    await acceptAsSelf(created.invitation.invitationId, 'http-accept-2');

    const sent = await messagesPost(
      post('/api/study/collab/messages', {
        roomId: ROOM,
        senderUid: selfUid,
        senderType: 'human_learner',
        body: '这一步我算出来是增函数。',
        requestId: 'http-msg-1',
      }),
    );
    expect(sent.status).toBe(200);
    const sentData = await jsonOf(sent);
    expect(apiResponses.collabMessageWrite.safeParse(sentData.data).success).toBe(true);
    expect((sentData.data!.message as Record<string, unknown>)['seq']).toBe(1);

    const delta = await messagesGet(get(`/api/study/collab/messages?roomId=${ROOM}&afterSeq=0`));
    expect(delta.status).toBe(200);
    const deltaData = await jsonOf(delta);
    expect(apiResponses.collabMessages.safeParse(deltaData.data).success).toBe(true);
    expect(deltaData.data!.messages as unknown[]).toHaveLength(1);

    // 游标越界：客户端认知超前，明确失败而不是静默返回空。
    const ahead = await messagesGet(get(`/api/study/collab/messages?roomId=${ROOM}&afterSeq=5`));
    expect(ahead.status).toBe(409);
    expect((await jsonOf(ahead)).error?.details?.['reason']).toBe('collab_cursor_ahead');

    const forged = await messagesPost(
      post('/api/study/collab/messages', {
        roomId: ROOM,
        senderUid: OTHER_UID,
        senderType: 'human_learner',
        body: '我是路过的。',
        requestId: 'http-msg-forged',
      }),
    );
    expect(forged.status).toBe(403);
    expect((await jsonOf(forged)).error?.details?.['reason']).toBe('collab_identity_mismatch');
  });

  it('事件：成员可发白板动作、房主专属事件被拒，序号与游标可读回（过合同）', async () => {
    const created = inviteFromOther();
    await acceptAsSelf(created.invitation.invitationId, 'http-accept-3');

    const board = await eventsPost(
      post('/api/study/collab/events', {
        roomId: ROOM,
        eventId: 'evt-board',
        kind: 'board_action',
        actorUid: selfUid,
        summary: '高亮增函数条件',
        expectedSeq: 1,
        requestId: 'http-evt-1',
      }),
    );
    expect(board.status).toBe(200);
    expect(apiResponses.collabEventWrite.safeParse((await jsonOf(board)).data).success).toBe(true);

    const forbidden = await eventsPost(
      post('/api/study/collab/events', {
        roomId: ROOM,
        eventId: 'evt-scene',
        kind: 'scene_changed',
        actorUid: selfUid,
        summary: '我来切场景',
        expectedSeq: 2,
        requestId: 'http-evt-2',
      }),
    );
    expect(forbidden.status).toBe(403);
    expect((await jsonOf(forbidden)).error?.details?.['reason']).toBe('only_owner_advances');

    const delta = await eventsGet(get(`/api/study/collab/events?roomId=${ROOM}&afterSeq=0`));
    expect(delta.status).toBe(200);
    const deltaData = await jsonOf(delta);
    expect(apiResponses.collabEvents.safeParse(deltaData.data).success).toBe(true);
    expect(deltaData.data!.events as unknown[]).toHaveLength(1);
  });
});
