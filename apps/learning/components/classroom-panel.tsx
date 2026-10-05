'use client';

import { apiResponses } from '@sew/study-contracts';

/**
 * 课堂面板：外层 session 包住 Director 的有界调度（TEACH-01）。
 *
 * Director 只做一件事 —— 按场景顺序取下一张已审核卡片；等待本人时不再自动播报，
 * 交还本人这个动作会落库，重启后仍然是等待。预算按每轮与整节课两级显示。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type {
  ClassroomStateDto,
  ClassroomBoardEffectDto,
  ClassroomSessionStatus,
  ExplanationCardDto,
  RecoveryCheckpointDto,
} from '@sew/study-contracts';
import { CLASSROOM_LESSON_MAX_CALLS, CLASSROOM_ROUND_LIMITS } from '@sew/study-contracts';
import { Empty, Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';
import { ClassroomBoardPanel } from './classroom-board-panel';
import { ClassroomPeersPanel } from './classroom-peers';
import { ClassroomRecoveryPanel } from './classroom-recovery-panel';

const SESSION_LABEL: Record<ClassroomSessionStatus, string> = {
  in_class: '● 上课中',
  awaiting_learner: '✎ 等待本人作答',
  completed: '✓ 本次完成',
  cancelled: '✕ 已取消',
};

const SESSION_TONE: Record<ClassroomSessionStatus, 'verified' | 'pending' | 'info' | 'error'> = {
  in_class: 'verified',
  awaiting_learner: 'pending',
  completed: 'info',
  cancelled: 'error',
};

const ACTION_LABEL: Record<string, string> = {
  open: '课堂会话已开始',
  handback: '已交还本人',
  'learner-answered': '本人作答已记录',
  'advance-scene': '已切换场景',
  close: '课堂已结束',
};

/** 停止类动作带回被中止的在途请求数量；没有在途请求时不重复播报。 */
const stopNote = (count: number): string => (count > 0 ? `；已中止 ${count} 个在途模型请求` : '');

const ClassroomPanelContent = ({
  projectId,
  generation,
  lessonId,
  lessonVersion,
  stageId,
  sceneId,
  compact = false,
  onSceneChange = null,
  onBoardEffects = null,
  roomId,
}: {
  projectId: string;
  generation: number;
  lessonId: string;
  lessonVersion?: number;
  stageId?: string | null;
  sceneId: string;
  compact?: boolean;
  roomId?: string;
  /** 教师切换场景时同步课堂视图；没有回调时只更新服务状态。 */
  onSceneChange?: ((sceneId: string) => void) | null;
  /** 白板效果上报给画布，教师聚焦才能作用在冻结场景的真实元素上。 */
  onBoardEffects?: ((effects: ClassroomBoardEffectDto[]) => void) | null;
}): ReactNode => {
  const router = useRouter();
  const [state, setState] = useState<ClassroomStateDto | null>(null);
  const [lastCard, setLastCard] = useState<ExplanationCardDto | null>(null);
  const [reason, setReason] = useState('请本人完成这道题的作答');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkpoint, setCheckpoint] = useState<RecoveryCheckpointDto | null>(null);
  const active = useRef(true);
  const locked = useRef(false);
  const requests = useRef(new Set<AbortController>());
  const readVersion = useRef(0);
  const pendingPlay = useRef<{ sessionId: string; requestId: string } | null>(null);
  const pendingScene = useRef<{ sessionId: string; sceneId: string; requestId: string } | null>(
    null,
  );

  const refresh = useCallback(async (): Promise<void> => {
    const version = ++readVersion.current;
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      const result = await apiFetch(
        `/api/study/classroom?projectId=${encodeURIComponent(projectId)}&generation=${generation}&lessonId=${encodeURIComponent(lessonId)}${roomId ? `&roomId=${encodeURIComponent(roomId)}` : ''}`,
        apiResponses.classroomState,
        { signal: controller.signal },
      );
      if (!active.current || controller.signal.aborted || version !== readVersion.current) return;
      setState(result.state);
    } catch (caught) {
      if (active.current && version === readVersion.current && !controller.signal.aborted)
        setError(describeApiError(caught));
    } finally {
      requests.current.delete(controller);
    }
  }, [projectId, generation, lessonId, roomId]);

  useEffect(() => {
    active.current = true;
    locked.current = false;
    setBusy(false);
    const controllers = requests.current;
    void refresh();
    return () => {
      active.current = false;
      readVersion.current += 1;
      controllers.forEach((controller) => controller.abort());
    };
  }, [refresh]);

  const afterCommand = async (success: string, isCurrent: () => boolean): Promise<void> => {
    if (!isCurrent()) return;
    setMessage(success);
    await refresh();
    if (isCurrent()) router.refresh();
  };

  const post = async (body: Record<string, unknown>): Promise<void> => {
    if (locked.current || !active.current) return;
    const action = String(body.action);
    if (!['open', 'close', 'handback'].includes(action)) {
      const current = state?.session;
      const validCheckpoint =
        current &&
        (!current.stageId ||
          (checkpoint?.sessionId === current.sessionId &&
            checkpoint.sessionStatus === current.status &&
            checkpoint.position.sceneId === current.currentSceneId));
      const allowed =
        current &&
        validCheckpoint &&
        (action === 'learner-answered'
          ? current.stageId
            ? checkpoint?.continuation === 'waiting'
            : current.status === 'awaiting_learner'
          : current.stageId
            ? checkpoint?.continuation === 'continue'
            : current.status === 'in_class');
      if (!allowed) {
        setError('请先完成恢复核对；等待本人或被阻断时不能执行教师动作。');
        return;
      }
    }
    locked.current = true;
    const controller = new AbortController();
    requests.current.add(controller);
    const isCurrent = () => active.current && !controller.signal.aborted;
    setBusy(true);
    setError(null);
    try {
      const command = {
        scope: { projectId, generation },
        ...body,
        ...(body.action === 'open' && roomId ? { roomId } : {}),
      };
      if (body.action === 'play-next') {
        const sessionId = String(body.sessionId);
        if (pendingPlay.current?.sessionId !== sessionId) {
          pendingPlay.current = { sessionId, requestId: crypto.randomUUID().replaceAll('-', '') };
        }
        const result = await apiFetch('/api/study/classroom', apiResponses.classroomPlay, {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({ ...command, requestId: pendingPlay.current.requestId }),
        });
        if (!isCurrent()) return;
        pendingPlay.current = null;
        setLastCard(result.card);
        await afterCommand(
          result.deduplicated
            ? '这一步此前已执行，界面读回既有收据，没有重复播报。'
            : result.card
              ? '已播放下一张讲解卡。'
              : '当前场景没有待播的已审核卡片。',
          isCurrent,
        );
      } else if (body.action === 'advance-scene') {
        const sessionId = String(body.sessionId);
        const target = String(body.sceneId);
        if (
          pendingScene.current?.sessionId !== sessionId ||
          pendingScene.current.sceneId !== target
        ) {
          pendingScene.current = {
            sessionId,
            sceneId: target,
            requestId: crypto.randomUUID().replaceAll('-', ''),
          };
        }
        const result = await apiFetch('/api/study/classroom', apiResponses.classroomAdvance, {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({ ...command, requestId: pendingScene.current.requestId }),
        });
        if (!isCurrent()) return;
        setCheckpoint(null);
        pendingScene.current = null;
        setLastCard(null);
        onSceneChange?.(result.session.currentSceneId);
        await afterCommand(
          `${
            result.deduplicated
              ? '该切换此前已执行，没有重复开启新轮。'
              : `已切换到场景 ${result.session.currentSceneId}。`
          }${stopNote(result.abortedCalls)}`,
          isCurrent,
        );
      } else {
        const result = await apiFetch('/api/study/classroom', apiResponses.classroomSession, {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify(command),
        });
        if (!isCurrent()) return;
        setCheckpoint(null);
        await afterCommand(
          `${ACTION_LABEL[String(body.action)] ?? '课堂动作'}已完成（会话状态：${SESSION_LABEL[result.session.status]}）` +
            `${stopNote(result.abortedCalls)}`,
          isCurrent,
        );
      }
    } catch (caught) {
      if (isCurrent()) setError(describeApiError(caught));
    } finally {
      requests.current.delete(controller);
      if (isCurrent()) {
        locked.current = false;
        setBusy(false);
      }
    }
  };

  const session = state?.session ?? null;
  const checkpointCurrent =
    !session?.stageId ||
    (checkpoint?.sessionId === session?.sessionId &&
      checkpoint?.sessionStatus === session?.status &&
      checkpoint?.position.sceneId === session?.currentSceneId);
  const teachingDisabled =
    busy ||
    session?.status !== 'in_class' ||
    !checkpointCurrent ||
    Boolean(session?.stageId && checkpoint?.continuation !== 'continue');
  const cardsForScene = state
    ? state.cards.filter((card) => card.sceneId === (session?.currentSceneId ?? sceneId))
    : [];
  const queueLength = cardsForScene.filter(
    (card) => card.status === 'approved' && !state?.playedIds.includes(card.explanationId),
  ).length;

  return (
    <div className={compact ? 'card card-nested' : 'card'}>
      {compact ? null : <h2>课堂面板</h2>}
      <p className="secondary">
        开课先复核「已发布 + 本版本已审核 + 来源仍准入」；调度只按场景顺序取下一张已审核卡片，
        等待本人时不再自动播报。交还本人或结束课堂会同时中止本节在途的模型请求。 每轮最多{' '}
        {CLASSROOM_ROUND_LIMITS.maxCallsPerRound} 次模型调用、 整节课最多{' '}
        {CLASSROOM_LESSON_MAX_CALLS} 次。
      </p>
      {!session ? (
        <>
          <Empty>当前没有进行中的课堂会话。</Empty>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !lessonId || !sceneId.trim()}
            onClick={() =>
              void post({ action: 'open', lessonId, stageId: stageId ?? null, sceneId })
            }
          >
            开始本课
          </button>
        </>
      ) : (
        <>
          <div className="row-inline">
            <span className="pill" data-tone={SESSION_TONE[session.status]}>
              {SESSION_LABEL[session.status]}
            </span>
            <span className="muted mono">
              场景 {session.currentSceneId} · 第 {session.roundIndex} 轮 · 本轮调用{' '}
              {session.roundCalls}/{CLASSROOM_ROUND_LIMITS.maxCallsPerRound} · 整节课{' '}
              {session.lessonCalls}/{CLASSROOM_LESSON_MAX_CALLS}
            </span>
          </div>
          {session.status === 'awaiting_learner' ? (
            <Notice tone="pending" style={{ marginTop: 'var(--sew-space-2)' }}>
              等待本人：{session.awaitingReason || '未填写原因'}
              。重启后仍保持等待，不会自行继续讲解。
            </Notice>
          ) : null}
          {lessonVersion && session.lessonVersion !== lessonVersion ? (
            <Notice tone="error" role="alert" style={{ marginTop: 'var(--sew-space-2)' }}>
              会话冻结在 v{session.lessonVersion}，本页读取的是 v{lessonVersion}。
              新版本发布后旧会话不会继续播放，请结束本课后按新版本重新开课。
            </Notice>
          ) : null}
          <p className="secondary" style={{ marginTop: 'var(--sew-space-2)' }}>
            待播已审核卡片：{queueLength} 张；待核卡片：{state?.pendingReview ?? 0} 张。
          </p>
          {lastCard ? (
            <Notice tone="verified">
              <strong>
                {lastCard.origin === 'model_generated' ? '模型产生（已补来源并审核）' : '教师手写'}
              </strong>
              <p className="secondary" style={{ whiteSpace: 'pre-wrap' }}>
                {lastCard.text}
              </p>
              <p className="hint mono">依据：{lastCard.statementIds.join('、')}</p>
            </Notice>
          ) : null}
          <div className="row-inline" style={{ marginTop: 'var(--sew-space-3)' }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={teachingDisabled}
              onClick={() => void post({ action: 'play-next', sessionId: session.sessionId })}
            >
              播放下一张讲解
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || session.status !== 'in_class'}
              onClick={() =>
                void post({ action: 'handback', sessionId: session.sessionId, reason })
              }
            >
              交还本人
            </button>
            <button
              type="button"
              className="btn"
              disabled={
                busy ||
                session.status !== 'awaiting_learner' ||
                !checkpointCurrent ||
                Boolean(session.stageId && checkpoint?.continuation !== 'waiting')
              }
              onClick={() =>
                void post({ action: 'learner-answered', sessionId: session.sessionId })
              }
            >
              本人已作答，继续
            </button>
            {sceneId.trim() && sceneId !== session.currentSceneId ? (
              <button
                type="button"
                className="btn"
                disabled={teachingDisabled}
                onClick={() =>
                  void post({ action: 'advance-scene', sessionId: session.sessionId, sceneId })
                }
              >
                切换到场景（{sceneId}）
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void post({
                  action: 'close',
                  sessionId: session.sessionId,
                  status: 'completed',
                  reason: '本节结束',
                })
              }
            >
              结束本课
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void post({
                  action: 'close',
                  sessionId: session.sessionId,
                  status: 'cancelled',
                  reason: '教师中断',
                })
              }
            >
              取消本课
            </button>
          </div>
          <div className="field" style={{ marginTop: 'var(--sew-space-2)' }}>
            <label htmlFor="handback-reason">交还本人的原因</label>
            <input
              id="handback-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={busy}
            />
          </div>
        </>
      )}
      {cardsForScene.length > 0 ? (
        <ul className="check-list" style={{ marginTop: 'var(--sew-space-2)' }}>
          {cardsForScene.map((card) => (
            <li key={card.explanationId}>
              <span>
                #{card.position}{' '}
                {card.status === 'approved'
                  ? '✓ 已审核'
                  : card.status === 'draft'
                    ? '○ 待核'
                    : '✕ 已退回'}{' '}
                · {card.text.slice(0, 32)}
              </span>
              <span className="muted">
                {state?.playedIds.includes(card.explanationId) ? '已播放' : '未播放'}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {session ? (
        <ClassroomBoardPanel
          key={`${projectId}-${generation}-${session.sessionId}`}
          projectId={projectId}
          generation={generation}
          session={session}
          playbackDisabled={teachingDisabled}
          onEffectsChange={onBoardEffects}
        />
      ) : null}
      {session && state ? (
        <ClassroomPeersPanel
          key={`peers-${projectId}-${generation}-${session.sessionId}`}
          projectId={projectId}
          generation={generation}
          session={session}
          peers={state.peers}
          peerTurns={state.peerTurns}
          disabled={teachingDisabled}
          onChange={(updated, turn) =>
            setState((current) => {
              if (!current || current.session?.sessionId !== updated.sessionId) return current;
              if (
                current.session.roundIndex !== updated.roundIndex ||
                current.session.currentSceneId !== updated.currentSceneId
              )
                return current;
              return {
                ...current,
                session: updated,
                peers: current.peers.map((peer) => ({
                  ...peer,
                  engagement: updated.peersEngagement,
                })),
                peerTurns:
                  turn && !current.peerTurns.some((item) => item.turnId === turn.turnId)
                    ? [...current.peerTurns, turn]
                    : current.peerTurns,
              };
            })
          }
        />
      ) : null}
      {session?.stageId ? (
        <ClassroomRecoveryPanel
          key={`${projectId}-${generation}-${session.sessionId}-${session.status}-${session.currentSceneId}`}
          projectId={projectId}
          generation={generation}
          sessionId={session.sessionId}
          onCheckpoint={(result) => {
            if (active.current) setCheckpoint(result);
          }}
        />
      ) : null}
      {message ? (
        <Notice tone="info" style={{ marginTop: 'var(--sew-space-2)' }}>
          {message}
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="error" style={{ marginTop: 'var(--sew-space-2)' }}>
          {error}
        </Notice>
      ) : null}
    </div>
  );
};

/** Each scope and selected scene owns its component and outstanding commands. */
export const ClassroomPanel = (props: Parameters<typeof ClassroomPanelContent>[0]): ReactNode => (
  <ClassroomPanelContent
    key={JSON.stringify([
      props.projectId,
      props.generation,
      props.lessonId,
      props.lessonVersion,
      props.roomId,
      props.stageId,
      props.sceneId,
    ])}
    {...props}
  />
);
