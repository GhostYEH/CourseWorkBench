'use client';

/**
 * 双人共同课堂的消费端面板（INVITE-01 / ROOM-01 / CHAT-01 / SYNC-01 的在线界面侧，ADR-0005）。
 *
 * 这一层只做三件事：把命令按既有合同发给**本地服务**（再由它作为受控客户端转发给独立
 * 协作服务）、按服务端结论渲染状态、用 `requestId` 让同一意图的重试不产生第二条记录。
 *
 * 在线边界：
 * - 只有真实连接与本人认证都成功（`online.authenticated`）才开放在线邀请/准备/讨论；
 *   离线、未配置或未认证时继续显示「不能联网邀请」并禁用在线动作。
 * - 凭据 secret 只在本地服务的受控边界，界面只看到公开句柄，永远拿不到 secret。
 * - 按钮可点性来自 `collab-panel-state` 的纯判定，服务端仍各自复验身份与成员资格。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { z } from 'zod';
import {
  apiResponses,
  collabOnlineCommandSchema,
  type CollabEventDto,
  type CollabMessageDto,
  type CollabOnlineViewDto,
  type CollabRoomMemberDto,
  type ProjectScope,
} from '@sew/study-contracts';
import { ApiError, apiFetch, describeApiError } from '../lib/client';
import {
  createCollabCommandTracker,
  type CollabCommandPayload,
} from '../lib/classroom/collab-command-state';
import {
  collabCursor,
  collabInvitationView,
  collabMergeBySeq,
  collabOnlineGate,
  collabRoomActions,
  collabSenderLabel,
} from '../lib/classroom/collab-panel-state';
import { Notice } from './ui';
import { CollabSharedScene } from './collab-shared-scene';

export interface CollabLessonOption {
  lessonId: string;
  lessonVersion: number;
  title: string;
  /** 已发布课程的冻结文档摘要；未装配课堂文档时为 null，此时不允许邀请。 */
  snapshotDigest: string | null;
}

interface CollabPanelProps {
  scope: ProjectScope;
  selfUid: string;
  selfDisplayName: string;
  lessons: CollabLessonOption[];
}

const UID_PATTERN = /^uid_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ONLINE_PATH = '/api/study/collab/online';

const emptyView = (): CollabOnlineViewDto => ({
  online: {
    configured: false,
    connected: false,
    authenticated: false,
    protocolVersion: null,
    registration: null,
    error: null,
  },
  invitations: [],
  room: null,
  members: [],
  messages: { messages: [], tailSeq: 0 },
  events: { events: [], tailSeq: 0 },
  snapshot: null,
});

export const CollabClassroomPanel = ({
  scope,
  selfUid,
  selfDisplayName,
  lessons,
}: CollabPanelProps): ReactNode => {
  const [view, setView] = useState<CollabOnlineViewDto>(emptyView);
  const [inviteeUid, setInviteeUid] = useState('');
  const [lessonKey, setLessonKey] = useState(
    () => lessons.find((item) => item.snapshotDigest)?.lessonId ?? '',
  );
  const [activeRoomId, setActiveRoomId] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recoveryWarning, setRecoveryWarning] = useState<string | null>(null);

  /**
   * 游标与已渲染集合放引用：把它们写进 `refresh` 的依赖会让每次读回都重建 `refresh`，
   * 进而重跑订阅效应形成轮询循环；状态更新器里也不写引用，避免 StrictMode 重复执行。
   */
  const messageCursor = useRef(0);
  const eventCursor = useRef(0);
  const messageSeen = useRef<CollabMessageDto[]>([]);
  const eventSeen = useRef<CollabEventDto[]>([]);
  const lock = useRef(false);
  const epoch = useRef(0);
  const commandStorageScope = JSON.stringify([scope.projectId, selfUid]);
  const executionScope = JSON.stringify([scope.projectId, scope.generation, selfUid]);
  const executionScopeRef = useRef(executionScope);
  executionScopeRef.current = executionScope;
  const commands = useRef<{
    scope: string;
    tracker: ReturnType<typeof createCollabCommandTracker>;
  } | null>(null);
  if (commands.current?.scope !== commandStorageScope) {
    let storage: Storage | undefined;
    if (typeof window !== 'undefined') {
      storage = {
        get length() {
          return window.localStorage.length;
        },
        clear: () => window.localStorage.clear(),
        getItem: (key) => window.localStorage.getItem(key),
        key: (index) => window.localStorage.key(index),
        removeItem: (key) => window.localStorage.removeItem(key),
        setItem: (key, value) => window.localStorage.setItem(key, value),
      };
    }
    commands.current = {
      scope: commandStorageScope,
      tracker: createCollabCommandTracker({
        ...(storage
          ? {
              persistence: {
                projectId: scope.projectId,
                uid: selfUid,
                storageKey: `sew:collab-command-pending:v1:${encodeURIComponent(scope.projectId)}:${encodeURIComponent(selfUid)}`,
                storage,
              },
            }
          : {}),
        validatePayload: (value): value is CollabCommandPayload =>
          collabOnlineCommandSchema.safeParse(value).success,
      }),
    };
  }
  const readVersion = useRef(0);
  const controllers = useRef(new Set<AbortController>());

  /** 读回在线视图：连接/认证状态、本人登记、邀请，以及当前房间与游标增量。 */
  const refresh = useCallback(
    async (signal: AbortSignal, turn: number, roomId: string): Promise<void> => {
      const version = ++readVersion.current;
      const isCurrent = () =>
        !signal.aborted && turn === epoch.current && version === readVersion.current;
      const headers = {
        'x-sew-project-id': scope.projectId,
        'x-sew-generation': String(scope.generation),
      };
      const params = new URLSearchParams();
      if (roomId) {
        params.set('roomId', roomId);
        params.set('messageAfterSeq', String(messageCursor.current));
        params.set('eventAfterSeq', String(eventCursor.current));
      }
      const result = await apiFetch(
        params.size > 0 ? `${ONLINE_PATH}?${params.toString()}` : ONLINE_PATH,
        apiResponses.collabOnlineView,
        { signal, headers },
      );
      if (!isCurrent()) return;
      const next = result.view;
      const clearRoomView = (): void => {
        messageSeen.current = [];
        eventSeen.current = [];
        messageCursor.current = 0;
        eventCursor.current = 0;
        setView(next);
      };
      if (!roomId || !next.room) {
        clearRoomView();
        return;
      }
      const mergedMessages = collabMergeBySeq(messageSeen.current, next.messages.messages);
      const mergedEvents = collabMergeBySeq(eventSeen.current, next.events.events);
      messageSeen.current = mergedMessages;
      eventSeen.current = mergedEvents;
      messageCursor.current = collabCursor(mergedMessages);
      eventCursor.current = collabCursor(mergedEvents);
      setView({
        ...next,
        messages: { messages: mergedMessages, tailSeq: next.messages.tailSeq },
        events: { events: mergedEvents, tailSeq: next.events.tailSeq },
      });
    },
    [scope.projectId, scope.generation],
  );

  useEffect(() => {
    const turn = ++epoch.current;
    const controller = new AbortController();
    const inflight = controllers.current;
    lock.current = false;
    setBusy(false);
    messageCursor.current = 0;
    eventCursor.current = 0;
    messageSeen.current = [];
    eventSeen.current = [];
    setView(emptyView());
    setBody('');
    setError(null);
    setRecoveryWarning(null);
    const fail = (caught: unknown) => {
      if (!controller.signal.aborted && turn === epoch.current) {
        setError(describeApiError(caught));
        if (
          caught instanceof ApiError &&
          ['ROLE_PERMISSION_DENIED', 'PROJECT_GENERATION_STALE', 'PROJECT_NOT_AUTHORIZED'].includes(
            caught.code,
          )
        ) {
          setView(emptyView());
          messageSeen.current = [];
          eventSeen.current = [];
          messageCursor.current = 0;
          eventCursor.current = 0;
        }
      }
    };
    let reading = false;
    const poll = async () => {
      if (reading || lock.current || controller.signal.aborted) return;
      reading = true;
      try {
        await refresh(controller.signal, turn, activeRoomId);
      } catch (caught) {
        fail(caught);
      } finally {
        reading = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      clearInterval(timer);
      controller.abort();
      epoch.current += 1;
      inflight.forEach((item) => item.abort());
    };
  }, [refresh, activeRoomId, selfUid]);

  /** 单入口命令发送：同一意图复用 requestId，避免重试产生第二条权威记录。 */
  const command = async <S extends z.ZodTypeAny>(
    schema: S,
    intent: Record<string, unknown>,
  ): Promise<boolean> => {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const turn = epoch.current;
    const commandScope = executionScope;
    const tracker = commands.current?.tracker;
    if (!tracker) return false;
    const controller = new AbortController();
    controllers.current.add(controller);
    let payload: CollabCommandPayload | undefined;
    const isCurrent = (): boolean =>
      turn === epoch.current &&
      commandScope === executionScopeRef.current &&
      !controller.signal.aborted;
    try {
      payload = tracker.prepare(ONLINE_PATH, intent, { tailSeq: eventCursor.current });
      if (!tracker.persistenceAvailable) {
        setRecoveryWarning('浏览器本地存储不可用；命令送达本机后会由本地服务保留，供重启后重试。');
      }
      const headers = {
        'x-sew-project-id': scope.projectId,
        'x-sew-generation': String(scope.generation),
      };
      const result = await apiFetch(ONLINE_PATH, schema, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!isCurrent()) return false;
      setNotice(result.notice);
      try {
        await apiFetch(`${ONLINE_PATH}/confirm`, apiResponses.collabOnlineConfirmation, {
          method: 'POST',
          headers,
          body: JSON.stringify({ requestId: result.commandRequestId }),
          signal: controller.signal,
        });
      } catch (caught) {
        if (isCurrent()) {
          setError(`命令已提交；确认回执失败，原请求仍保留以便重试：${describeApiError(caught)}`);
        }
        return false;
      }
      if (!isCurrent()) return false;
      tracker.confirm(ONLINE_PATH, payload);
      // 命令回执与状态刷新分别报告：读回失败不改写已确认的提交，也不丢失原重试语义。
      try {
        await refresh(controller.signal, turn, activeRoomId);
      } catch (caught) {
        if (isCurrent()) setError(`命令已确认；状态读回失败：${describeApiError(caught)}`);
      }
      return true;
    } catch (caught) {
      if (isCurrent()) setError(describeApiError(caught));
      if (
        isCurrent() &&
        payload &&
        caught instanceof ApiError &&
        caught.code === 'VERSION_CONFLICT' &&
        (caught.details?.['reason'] === 'collab_event_seq_mismatch' ||
          caught.details?.['reason'] === 'collab_room_revision_mismatch')
      ) {
        tracker.discard(ONLINE_PATH, payload);
        try {
          await refresh(controller.signal, turn, activeRoomId);
        } catch {
          /* 保留原冲突提示 */
        }
      }
      return false;
    } finally {
      controllers.current.delete(controller);
      if (isCurrent()) {
        lock.current = false;
        setBusy(false);
      }
    }
  };

  const gate = collabOnlineGate(view.online);
  const selectedLesson = lessons.find((item) => item.lessonId === lessonKey) ?? null;
  const acceptedInvitation =
    view.invitations.find((item) => item.status === 'accepted' && item.roomId === activeRoomId) ??
    null;
  const roomActions = collabRoomActions({
    room: view.room,
    members: view.members,
    selfUid,
    invitationAccepted: acceptedInvitation !== null,
  });
  const peerNames = Object.fromEntries(
    view.members
      .filter((member) => member.uid !== selfUid)
      .map((member) => [member.uid, member.uid]),
  );
  const sendDisabled = busy || !body.trim() || !roomActions.canSend || !gate.available;
  const onlineBlocked = busy || !gate.available;
  // 场景推进目标：按 order 排序后取当前场景的下一个（循环），而不是恒指向第一个。
  const orderedScenes = [...(view.snapshot?.snapshot?.scenes ?? [])].sort(
    (left, right) => left.order - right.order,
  );
  const currentSceneIndex = orderedScenes.findIndex(
    (scene) => scene.sceneId === view.room?.currentSceneId,
  );
  const nextScene =
    orderedScenes.length === 0
      ? null
      : (orderedScenes[currentSceneIndex + 1] ?? orderedScenes[0] ?? null);

  return (
    <section data-collab-panel className="card">
      <h3>双人共同课堂</h3>
      <div data-collab-online-status>
        {gate.available ? (
          <Notice tone="info">
            已连接在线协作服务（协议 v{view.online.protocolVersion ?? '?'}），本人认证通过。
            {view.online.registration
              ? `在线登记：${view.online.registration.displayName}（v${view.online.registration.revision}）`
              : '尚未完成在线登记。'}
          </Notice>
        ) : (
          <Notice tone="pending">
            <strong>不能联网邀请</strong>：{gate.reason}
          </Notice>
        )}
      </div>

      <div className="field" data-collab-self>
        <label htmlFor="collab-self-uid">本人 UID</label>
        <input id="collab-self-uid" className="mono" readOnly value={selfUid} />
        <p className="hint">昵称：{selfDisplayName || '（未填写）'}</p>
        <p className="hint">
          在线身份：
          {view.online.registration
            ? `已登记（句柄 ${view.online.registration.credentialId.slice(0, 12)}…）`
            : view.online.configured
              ? '尚未开通'
              : '未配置在线服务'}
        </p>
        <div>
          <button
            type="button"
            className="btn"
            data-collab-enable
            disabled={
              busy ||
              !view.online.configured ||
              view.online.authenticated ||
              !selfDisplayName.trim()
            }
            onClick={() => void command(apiResponses.collabOnlineWrite, { action: 'enable' })}
          >
            开通在线身份
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            data-collab-revoke-credential
            disabled={busy || !view.online.authenticated}
            onClick={() =>
              void command(apiResponses.collabOnlineWrite, { action: 'revoke-credential' })
            }
          >
            吊销在线凭据
          </button>
        </div>
      </div>

      <details open data-collab-invite>
        <summary>课前邀请</summary>
        <label>
          选择已发布课程
          <select
            data-collab-lesson
            value={lessonKey}
            disabled={busy}
            onChange={(event) => setLessonKey(event.target.value)}
          >
            {lessons.length === 0 ? <option value="">没有已发布课程</option> : null}
            {lessons.map((item) => (
              <option key={item.lessonId} value={item.lessonId}>
                {item.title} v{item.lessonVersion}
                {item.snapshotDigest ? '' : '（未装配课堂文档，不可邀请）'}
              </option>
            ))}
          </select>
        </label>
        <label>
          同学 UID
          <input
            data-collab-invitee
            className="mono"
            placeholder="uid_xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
            value={inviteeUid}
            maxLength={72}
            onChange={(event) => setInviteeUid(event.target.value.trim())}
          />
        </label>
        <button
          type="button"
          className="btn"
          data-collab-invite
          disabled={
            onlineBlocked ||
            !selectedLesson?.snapshotDigest ||
            !UID_PATTERN.test(inviteeUid) ||
            inviteeUid === selfUid
          }
          onClick={() =>
            void command(apiResponses.collabOnlineWrite, {
              action: 'invite',
              inviteeUid,
              lessonId: selectedLesson?.lessonId ?? '',
              lessonVersion: selectedLesson?.lessonVersion ?? 0,
              snapshotDigest: selectedLesson?.snapshotDigest ?? '',
            })
          }
        >
          发出在线邀请
        </button>
        {inviteeUid === selfUid ? <p className="hint">不能邀请自己。</p> : null}
        {selectedLesson && !selectedLesson.snapshotDigest ? (
          <p className="hint">该课程还没有可核对的冻结文档，先把课堂装配好再邀请。</p>
        ) : null}
      </details>

      <div data-collab-invitations>
        <p className="hint">与我相关的邀请（{view.invitations.length} 条）</p>
        {view.invitations.length === 0 ? <p className="muted">还没有邀请。</p> : null}
        <ul className="check-list">
          {view.invitations.map((invitation) => {
            const item = collabInvitationView(invitation, selfUid);
            return (
              <li key={invitation.invitationId} data-collab-invitation={invitation.invitationId}>
                <span className="mono">
                  {item.direction === 'incoming' ? '受邀' : '发起'} · {item.stateLabel} ·{' '}
                  {invitation.lessonId} v{invitation.lessonVersion}
                </span>
                {item.canDecide ? (
                  <>
                    <button
                      type="button"
                      className="btn"
                      data-collab-accept
                      disabled={onlineBlocked}
                      onClick={() =>
                        void command(apiResponses.collabOnlineWrite, {
                          action: 'decide',
                          invitationId: invitation.invitationId,
                          decision: 'accepted',
                        })
                      }
                    >
                      接受
                    </button>
                    <button
                      type="button"
                      className="btn"
                      data-collab-reject
                      disabled={onlineBlocked}
                      onClick={() =>
                        void command(apiResponses.collabOnlineWrite, {
                          action: 'decide',
                          invitationId: invitation.invitationId,
                          decision: 'rejected',
                        })
                      }
                    >
                      拒绝
                    </button>
                  </>
                ) : null}
                {item.canRevoke ? (
                  <button
                    type="button"
                    className="btn"
                    data-collab-revoke
                    disabled={onlineBlocked}
                    onClick={() =>
                      void command(apiResponses.collabOnlineWrite, {
                        action: 'revoke',
                        invitationId: invitation.invitationId,
                      })
                    }
                  >
                    撤销
                  </button>
                ) : null}
                {item.blockedReason ? <p className="hint">{item.blockedReason}</p> : null}
                <button
                  type="button"
                  className="btn btn-ghost"
                  data-collab-open-room={invitation.roomId}
                  onClick={() => setActiveRoomId(invitation.roomId)}
                >
                  打开该房间
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {activeRoomId ? (
        <div className="card card-nested" data-collab-room={activeRoomId}>
          <p className="hint mono">房间：{activeRoomId}</p>
          <p className="hint">
            状态：{view.room ? view.room.status : '尚未建立'} · 成员 {view.members.length} 人 ·
            课程版本 {view.room ? `v${view.room.course.lessonVersion}` : '—'}
          </p>

          {view.room?.status === 'ready' ? (
            <>
              <button
                type="button"
                className="btn"
                data-collab-ready
                disabled={
                  onlineBlocked ||
                  !roomActions.canSetReadiness ||
                  roomActions.selfReadiness === 'ready'
                }
                onClick={() =>
                  void command(apiResponses.collabOnlineWrite, {
                    action: 'readiness',
                    roomId: activeRoomId,
                    readiness: 'ready',
                  })
                }
              >
                我已准备
              </button>
              <button
                type="button"
                className="btn"
                data-collab-start
                disabled={onlineBlocked || !roomActions.canStart}
                onClick={() =>
                  void command(apiResponses.collabOnlineWrite, {
                    action: 'start',
                    roomId: activeRoomId,
                  })
                }
              >
                开始课堂（房主）
              </button>
            </>
          ) : null}
          {roomActions.blockedReason ? (
            <p className="hint" data-collab-blocked={roomActions.blockedReason}>
              {roomActions.blockedReason}
            </p>
          ) : null}

          <ul className="check-list" data-collab-members>
            {view.members.map((member: CollabRoomMemberDto) => (
              <li key={member.uid} className="mono">
                {member.uid === selfUid ? '本人' : '同学'} · {member.role} · {member.readiness}
              </li>
            ))}
          </ul>

          <div data-collab-discussion aria-live="polite">
            <p className="hint">课内讨论（{view.messages.messages.length} 条）</p>
            {view.messages.messages.map((item) => (
              <p key={item.messageId} data-collab-message={item.seq}>
                <span className="hint mono">
                  #{item.seq} {collabSenderLabel(item, selfUid, peerNames)}：
                </span>
                <span style={{ whiteSpace: 'pre-wrap' }}>{item.body}</span>
              </p>
            ))}
            {view.messages.messages.length === 0 ? <p className="muted">还没有消息。</p> : null}
          </div>

          {view.room?.status === 'active' ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const submittedBody = body;
                void command(apiResponses.collabOnlineWrite, {
                  action: 'message',
                  roomId: activeRoomId,
                  body: submittedBody,
                }).then((confirmed) => {
                  if (confirmed) setBody((current) => (current === submittedBody ? '' : current));
                });
              }}
            >
              <label>
                发言
                <textarea
                  data-collab-message-body
                  value={body}
                  maxLength={2000}
                  onChange={(event) => setBody(event.target.value)}
                />
              </label>
              <button type="submit" className="btn" data-collab-send disabled={sendDisabled}>
                发送
              </button>
            </form>
          ) : null}

          <CollabSharedScene
            snapshot={view.snapshot?.snapshot ?? null}
            sceneId={view.room?.currentSceneId ?? null}
          />
          <div data-collab-events>
            <p className="hint">房间事件（{view.events.events.length} 条）</p>
            {view.events.events.map((item) => (
              <p key={item.eventId} className="hint mono" data-collab-event={item.seq}>
                #{item.seq} {item.kind} · {item.summary}
              </p>
            ))}
            {view.room?.status === 'active' && view.room.ownerUid === selfUid ? (
              <button
                type="button"
                className="btn"
                data-collab-scene-event
                disabled={onlineBlocked || !roomActions.canSend || !nextScene}
                onClick={() =>
                  void command(apiResponses.collabOnlineWrite, {
                    action: 'scene',
                    roomId: activeRoomId,
                    sceneId: nextScene?.sceneId ?? '',
                    expectedRevision: view.room?.revision ?? 1,
                  })
                }
              >
                推进到下一场景（房主）
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="muted">选择一条邀请后打开对应房间，即可准备与开始共同课堂。</p>
      )}

      {notice ? <Notice tone="info">{notice}</Notice> : null}
      {recoveryWarning ? <Notice tone="info">{recoveryWarning}</Notice> : null}
      {error ? (
        <Notice tone="error" role="alert">
          {error}
        </Notice>
      ) : null}
    </section>
  );
};
