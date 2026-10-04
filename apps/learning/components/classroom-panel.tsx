'use client';

import { apiResponses } from '@sew/study-contracts';

/**
 * 课堂面板：外层 session 包住 Director 的有界调度（TEACH-01）。
 *
 * Director 只做一件事 —— 按场景顺序取下一张已审核卡片；等待本人时不再自动播报，
 * 交还本人这个动作会落库，重启后仍然是等待。预算按每轮与整节课两级显示。
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { ClassroomStateDto, ClassroomSessionStatus, ExplanationCardDto } from '@sew/study-contracts';
import { CLASSROOM_LESSON_MAX_CALLS, CLASSROOM_ROUND_LIMITS } from '@sew/study-contracts';
import { Empty, Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';

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

export const ClassroomPanel = ({
  projectId,
  generation,
  lessonId,
  sceneId,
}: {
  projectId: string;
  generation: number;
  lessonId: string;
  sceneId: string;
}): ReactNode => {
  const router = useRouter();
  const [state, setState] = useState<ClassroomStateDto | null>(null);
  const [lastCard, setLastCard] = useState<ExplanationCardDto | null>(null);
  const [reason, setReason] = useState('请本人完成这道题的作答');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    try {
      const result = await apiFetch('/api/study/classroom', apiResponses.classroomState);
      setState(result.state);
    } catch (caught) {
      setError(describeApiError(caught));
    }
  };

  useEffect(() => {
    void refresh();
    // 只在挂载时读取一次；后续状态由命令返回值与路由刷新驱动。
  }, []);

  const afterCommand = async (success: string): Promise<void> => {
    setMessage(success);
    await refresh();
    router.refresh();
  };

  const post = async (body: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (body.action === 'play-next') {
        const result = await apiFetch('/api/study/classroom', apiResponses.classroomPlay, {
          method: 'POST',
          body: JSON.stringify({ scope: { projectId, generation }, ...body }),
        });
        setLastCard(result.card);
        await afterCommand(result.deduplicated
          ? '这一步此前已执行，界面读回既有收据，没有重复播报。'
          : (result.card ? '已播放下一张讲解卡。' : '当前场景没有待播的已审核卡片。'));
      } else {
        const result = await apiFetch('/api/study/classroom', apiResponses.classroomSession, {
          method: 'POST',
          body: JSON.stringify({ scope: { projectId, generation }, ...body }),
        });
        await afterCommand(`${ACTION_LABEL[String(body.action)] ?? '课堂动作'}已完成（会话状态：${SESSION_LABEL[result.session.status]}）。`);
      }
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  const session = state?.session ?? null;
  const cardsForScene = state ? state.cards.filter((card) => card.sceneId === (session?.currentSceneId || sceneId)) : [];
  const queueLength = cardsForScene.filter((card) => card.status === 'approved' && !state?.playedIds.includes(card.explanationId)).length;

  return (
    <div className="card">
      <h2>课堂面板</h2>
      <p className="secondary">
        开课先复核「已发布 + 本版本已审核 + 来源仍准入」；调度只按场景顺序取下一张已审核卡片，
        等待本人时不再自动播报。每轮最多 {CLASSROOM_ROUND_LIMITS.maxCallsPerRound} 次模型调用、
        整节课最多 {CLASSROOM_LESSON_MAX_CALLS} 次。
      </p>
      {!session ? (
        <>
          <Empty>当前没有进行中的课堂会话。</Empty>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !lessonId}
            onClick={() => void post({ action: 'open', lessonId, stageId: null, sceneId })}
          >
            开始本课
          </button>
        </>
      ) : (
        <>
          <div className="row-inline">
            <span className="pill" data-tone={SESSION_TONE[session.status]}>{SESSION_LABEL[session.status]}</span>
            <span className="muted mono">
              场景 {session.currentSceneId || '未定位'} · 第 {session.roundIndex} 轮 ·
              本轮调用 {session.roundCalls}/{CLASSROOM_ROUND_LIMITS.maxCallsPerRound} ·
              整节课 {session.lessonCalls}/{CLASSROOM_LESSON_MAX_CALLS}
            </span>
          </div>
          {session.status === 'awaiting_learner' ? (
            <Notice tone="pending" style={{ marginTop: 'var(--sew-space-2)' }}>
              等待本人：{session.awaitingReason || '未填写原因'}。重启后仍保持等待，不会自行继续讲解。
            </Notice>
          ) : null}
          <p className="secondary" style={{ marginTop: 'var(--sew-space-2)' }}>
            待播已审核卡片：{queueLength} 张；待核卡片：{state?.pendingReview ?? 0} 张。
          </p>
          {lastCard ? (
            <Notice tone="verified">
              <strong>{lastCard.origin === 'model_generated' ? '模型产生（已补来源并审核）' : '教师手写'}</strong>
              <p className="secondary" style={{ whiteSpace: 'pre-wrap' }}>{lastCard.text}</p>
              <p className="hint mono">依据：{lastCard.statementIds.join('、')}</p>
            </Notice>
          ) : null}
          <div className="row-inline" style={{ marginTop: 'var(--sew-space-3)' }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || session.status !== 'in_class'}
              onClick={() => void post({ action: 'play-next', sessionId: session.sessionId })}
            >
              播放下一张讲解
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || session.status !== 'in_class'}
              onClick={() => void post({ action: 'handback', sessionId: session.sessionId, reason })}
            >
              交还本人
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || session.status !== 'awaiting_learner'}
              onClick={() => void post({ action: 'learner-answered', sessionId: session.sessionId })}
            >
              本人已作答，继续
            </button>
            {state?.nextSceneId ? (
              <button
                type="button"
                className="btn"
                disabled={busy || session.status !== 'in_class'}
                onClick={() => void post({ action: 'advance-scene', sessionId: session.sessionId, sceneId: state.nextSceneId })}
              >
                下一场景（{state.nextSceneId}）
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void post({ action: 'close', sessionId: session.sessionId, status: 'completed', reason: '本节结束' })}
            >
              结束本课
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void post({ action: 'close', sessionId: session.sessionId, status: 'cancelled', reason: '教师中断' })}
            >
              取消本课
            </button>
          </div>
          <div className="field" style={{ marginTop: 'var(--sew-space-2)' }}>
            <label htmlFor="handback-reason">交还本人的原因</label>
            <input id="handback-reason" value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} />
          </div>
        </>
      )}
      {cardsForScene.length > 0 ? (
        <ul className="check-list" style={{ marginTop: 'var(--sew-space-2)' }}>
          {cardsForScene.map((card) => (
            <li key={card.explanationId}>
              <span>
                #{card.position} {card.status === 'approved' ? '✓ 已审核' : card.status === 'draft' ? '○ 待核' : '✕ 已退回'} · {card.text.slice(0, 32)}
              </span>
              <span className="muted">{state?.playedIds.includes(card.explanationId) ? '已播放' : '未播放'}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {message ? <Notice tone="info" style={{ marginTop: 'var(--sew-space-2)' }}>{message}</Notice> : null}
      {error ? <Notice tone="error" style={{ marginTop: 'var(--sew-space-2)' }}>{error}</Notice> : null}
    </div>
  );
};
