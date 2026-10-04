'use client';

/**
 * AI 同学面板（PEER-01）。
 *
 * 界面只做三件事：显示服务端判定的开关/参与度/上限、发命令、把结果显示出来。
 * 「同学能不能发言」永远由服务端判：这里没有本地推断的上限，也不会在等待本人
 * 或已结束时把按钮点亮——那样只会让人以为同学还能说话。
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { apiResponses, PEER_ENGAGEMENT_LABEL, type ClassroomPeerTurnDto, type ClassroomSessionDto, type PeerEngagement } from '@sew/study-contracts';
import { Empty, Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';

const PEER_KIND_LABEL: Record<'question' | 'discussion' | 'example', string> = {
  question: '提问',
  discussion: '讨论',
  example: '复述已审核示例',
};

export const ClassroomPeersPanel = ({
  projectId,
  generation,
  session,
  peers,
  peerTurns,
  onChange,
  disabled = false,
}: {
  projectId: string;
  generation: number;
  session: ClassroomSessionDto;
  peers: Array<{ profileId: string; name: string; engagement: PeerEngagement }>;
  peerTurns: ClassroomPeerTurnDto[];
  onChange: (session: ClassroomSessionDto, turn: ClassroomPeerTurnDto | null) => void;
  disabled?: boolean;
}): ReactNode => {
  const [engagement, setEngagement] = useState<PeerEngagement>(session.peersEngagement);
  // 有两位同学时要能选谁发言，不能写死第一位。
  const [speakerId, setSpeakerId] = useState(peers[0]?.profileId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const pendingTurns = useRef(new Map<string, string>());
  const scope = `${projectId}:${generation}:${session.sessionId}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const context = `${scope}:${session.roundIndex}:${session.currentSceneId}:${session.status}`;
  const currentContext = useRef(context);
  currentContext.current = context;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setEngagement(session.peersEngagement); }, [session.peersEngagement]);

  const post = async (body: Record<string, unknown>, success: string): Promise<void> => {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    const requestScope = scope;
    const requestContext = context;
    const turnKey = body.action === 'peer-turn'
      ? `${scope}:${session.roundIndex}:${session.currentSceneId}:${String(body.roleProfileId)}:${String(body.kind)}` : null;
    if (turnKey) {
      if (!pendingTurns.current.has(turnKey)) pendingTurns.current.set(turnKey, crypto.randomUUID().replaceAll('-', ''));
      body = { ...body, requestId: pendingTurns.current.get(turnKey) };
    }
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch('/api/study/classroom', apiResponses.classroomPeer, {
        method: 'POST',
        body: JSON.stringify({ scope: { projectId, generation }, ...body }),
      });
      if (!alive.current || currentScope.current !== requestScope) return;
      if (turnKey) pendingTurns.current.delete(turnKey);
      if (currentContext.current !== requestContext) return;
      onChange(result.session, result.turn);
      setMessage(success);
    } catch (caught) {
      if (!alive.current || currentScope.current !== requestScope || currentContext.current !== requestContext) return;
      setError(describeApiError(caught));
    } finally {
      inFlight.current = false;
      if (alive.current && currentScope.current === requestScope) setBusy(false);
    }
  };

  if (peers.length === 0) {
    return (
      <div className="card card-nested">
        <h3>AI 同学</h3>
        <Empty>本项目还没有配置 AI 同学档案。到「角色设置」登记后，才能在这里开关同学。</Empty>
      </div>
    );
  }

  const canSpeak = session.peersEnabled && session.status === 'in_class' && !disabled;

  return (
    <div className="card card-nested" data-classroom-peers>
      <h3>AI 同学</h3>
      <p className="secondary">
        同学只按已审核内容发言，始终标注为模拟；默认没有白板写权限，也不能替本人作答。
        等待本人作答或课堂结束时，同学不会插话。
      </p>
      <div className="row-inline">
        <span className="pill" data-tone={session.peersEnabled ? 'verified' : 'info'}>
          {session.peersEnabled ? '● 同学已开启' : '○ 同学已关闭'}
        </span>
        <span className="muted mono">
          本轮同学发言 {session.roundPeerTurns} 次
        </span>
      </div>
      <div className="field" style={{ marginTop: 'var(--sew-space-2)' }}>
        <label htmlFor="peer-engagement">参与度（只影响开口频率，不改变权限）</label>
        <select
          id="peer-engagement"
          value={engagement}
          disabled={busy || disabled}
          onChange={(event) => setEngagement(event.target.value as PeerEngagement)}
        >
          {(Object.keys(PEER_ENGAGEMENT_LABEL) as PeerEngagement[]).map((value) => (
            <option key={value} value={value}>{PEER_ENGAGEMENT_LABEL[value]}</option>
          ))}
        </select>
      </div>
      <div className="row-inline" style={{ marginTop: 'var(--sew-space-2)' }}>
        <button
          type="button"
          className="btn"
          disabled={busy || disabled}
          onClick={() => void post(
            { action: 'set-peers', sessionId: session.sessionId, enabled: !session.peersEnabled, engagement },
            session.peersEnabled ? '已关闭 AI 同学；教师课堂照常继续。' : '已开启 AI 同学。',
          )}
        >
          {session.peersEnabled ? '关闭 AI 同学' : '开启 AI 同学'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || disabled}
          onClick={() => void post(
            { action: 'set-peers', sessionId: session.sessionId, enabled: session.peersEnabled, engagement },
            '参与度已更新。',
          )}
        >
          应用参与度
        </button>
      </div>
      <ul className="check-list" style={{ marginTop: 'var(--sew-space-2)' }}>
        {peers.map((peer) => (
          <li key={peer.profileId}>
            <span>{peer.name} · {PEER_ENGAGEMENT_LABEL[peer.engagement]}</span>
            <span className="muted">AI 同学（模拟）</span>
          </li>
        ))}
      </ul>
      <div className="field" style={{ marginTop: 'var(--sew-space-2)' }}>
        <label htmlFor="peer-speaker">让哪位同学发言</label>
        <select
          id="peer-speaker"
          value={speakerId}
          disabled={busy || disabled}
          onChange={(event) => setSpeakerId(event.target.value)}
        >
          {peers.map((peer) => <option key={peer.profileId} value={peer.profileId}>{peer.name}</option>)}
        </select>
      </div>
      <div className="row-inline" style={{ marginTop: 'var(--sew-space-2)' }}>
        {(Object.keys(PEER_KIND_LABEL) as Array<keyof typeof PEER_KIND_LABEL>).map((kind) => {
          const speaker = peers.find((peer) => peer.profileId === speakerId) ?? peers[0]!;
          return (
            <button
              key={kind}
              type="button"
              className="btn"
              disabled={busy || !canSpeak}
              onClick={() => void post(
                { action: 'peer-turn', sessionId: session.sessionId, roleProfileId: speaker.profileId, kind },
                `已让 ${speaker.name} ${PEER_KIND_LABEL[kind]}。`,
              )}
            >
              {PEER_KIND_LABEL[kind]}
            </button>
          );
        })}
      </div>
      {peerTurns.length > 0 ? (
        <ul className="check-list" style={{ marginTop: 'var(--sew-space-2)' }}>
          {peerTurns.map((turn) => (
            <li key={turn.turnId}>
              <span>
                {turn.peerName}（{PEER_KIND_LABEL[turn.kind]}）：{turn.text}
              </span>
              <span className="muted mono">
                {turn.partition === 'simulation' ? '模拟' : turn.partition} · 依据 {turn.statementIds.length} 条陈述
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>本轮还没有同学发言。</Empty>
      )}
      {message ? <Notice tone="info" style={{ marginTop: 'var(--sew-space-2)' }}>{message}</Notice> : null}
      {error ? <Notice tone="error" style={{ marginTop: 'var(--sew-space-2)' }}>{error}</Notice> : null}
    </div>
  );
};
