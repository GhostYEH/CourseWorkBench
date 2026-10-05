'use client';

/**
 * AI 同学面板（PEER-01）。
 *
 * 界面只做三件事：显示服务端判定的开关/参与度/上限、发命令、把结果显示出来。
 * 「同学能不能发言」永远由服务端判：这里没有本地推断的上限，也不会在等待本人
 * 或已结束时把按钮点亮——那样只会让人以为同学还能说话。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  apiResponses,
  PEER_ENGAGEMENT_LABEL,
  type ClassroomPeerTurnDto,
  type ClassroomSessionDto,
  type PeerEngagement,
} from '@sew/study-contracts';
import { Empty, Notice } from './ui';
import { apiFetch } from '../lib/client';
import {
  createPeerStaleCommandHandler,
  peerCommandScope,
} from '../lib/classroom/peer-command-lifecycle';
import { useCommand } from '../lib/use-command';

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
  onStateRefresh = null,
  disabled = false,
}: {
  projectId: string;
  generation: number;
  session: ClassroomSessionDto;
  peers: Array<{ profileId: string; name: string; engagement: PeerEngagement }>;
  peerTurns: ClassroomPeerTurnDto[];
  onChange: (session: ClassroomSessionDto, turn: ClassroomPeerTurnDto | null) => void;
  /** 服务端权威状态的重读入口；中断后以它为准，而不是沿用面板里已隔离的结果。 */
  onStateRefresh?: (() => void | Promise<void>) | null;
  disabled?: boolean;
}): ReactNode => {
  const [engagement, setEngagement] = useState<PeerEngagement>(session.peersEngagement);
  // 有两位同学时要能选谁发言，不能写死第一位。
  const [speakerId, setSpeakerId] = useState(peers[0]?.profileId ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
  const pendingTurns = useRef(new Map<string, string>());
  const mounted = useRef(true);
  // 面板在课堂状态变化时不重挂载（key 不含 status），因此中断提示要能留在新作用域上显示。
  // 卸载标记与 useCommand 的 gate 失效同在 layout 相位收尾，迟到的中断回调才不会对着已卸载的面板写入。
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const scope = `${projectId}:${generation}:${session.sessionId}`;
  // 轮次、场景与状态都进入作用域键：别处推进课堂时，这里的在途结果必须被隔离。
  const context = peerCommandScope(session, projectId, generation);
  const { busy, error, run } = useCommand(context);
  useEffect(() => {
    setEngagement(session.peersEngagement);
  }, [session.peersEngagement]);

  const post = async (body: Record<string, unknown>, success: string): Promise<void> => {
    if (disabled) return;
    await run(
      async (command) => {
        const turnKey =
          body.action === 'peer-turn'
            ? `${scope}:${session.roundIndex}:${session.currentSceneId}:${String(body.roleProfileId)}:${String(body.kind)}`
            : null;
        if (turnKey) {
          if (!pendingTurns.current.has(turnKey))
            pendingTurns.current.set(turnKey, crypto.randomUUID().replaceAll('-', ''));
          body = { ...body, requestId: pendingTurns.current.get(turnKey) };
        }
        const result = await apiFetch('/api/study/classroom', apiResponses.classroomPeer, {
          method: 'POST',
          signal: command.signal,
          body: JSON.stringify({ scope: { projectId, generation }, ...body }),
        });
        if (!command.isCurrent()) return;
        if (turnKey) pendingTurns.current.delete(turnKey);
        onChange(result.session, result.turn);
        setMessage(success);
      },
      {
        onStart: () => {
          setMessage(null);
          setStaleNotice(null);
        },
        onStale: createPeerStaleCommandHandler({
          mounted,
          showNotice: setStaleNotice,
          refreshAuthoritativeState: () => void onStateRefresh?.(),
        }),
      },
    );
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
        <span className="muted mono">本轮同学发言 {session.roundPeerTurns} 次</span>
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
            <option key={value} value={value}>
              {PEER_ENGAGEMENT_LABEL[value]}
            </option>
          ))}
        </select>
      </div>
      <div className="row-inline" style={{ marginTop: 'var(--sew-space-2)' }}>
        <button
          type="button"
          className="btn"
          disabled={busy || disabled}
          onClick={() =>
            void post(
              {
                action: 'set-peers',
                sessionId: session.sessionId,
                enabled: !session.peersEnabled,
                engagement,
              },
              session.peersEnabled ? '已关闭 AI 同学；教师课堂照常继续。' : '已开启 AI 同学。',
            )
          }
        >
          {session.peersEnabled ? '关闭 AI 同学' : '开启 AI 同学'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || disabled}
          onClick={() =>
            void post(
              {
                action: 'set-peers',
                sessionId: session.sessionId,
                enabled: session.peersEnabled,
                engagement,
              },
              '参与度已更新。',
            )
          }
        >
          应用参与度
        </button>
      </div>
      <ul className="check-list" style={{ marginTop: 'var(--sew-space-2)' }}>
        {peers.map((peer) => (
          <li key={peer.profileId}>
            <span>
              {peer.name} · {PEER_ENGAGEMENT_LABEL[peer.engagement]}
            </span>
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
          {peers.map((peer) => (
            <option key={peer.profileId} value={peer.profileId}>
              {peer.name}
            </option>
          ))}
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
              onClick={() =>
                void post(
                  {
                    action: 'peer-turn',
                    sessionId: session.sessionId,
                    roleProfileId: speaker.profileId,
                    kind,
                  },
                  `已让 ${speaker.name} ${PEER_KIND_LABEL[kind]}。`,
                )
              }
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
                {turn.partition === 'simulation' ? '模拟' : turn.partition} · 依据{' '}
                {turn.statementIds.length} 条陈述
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>本轮还没有同学发言。</Empty>
      )}
      {message ? (
        <Notice tone="info" style={{ marginTop: 'var(--sew-space-2)' }}>
          {message}
        </Notice>
      ) : null}
      {staleNotice ? (
        <Notice tone="pending" role="alert" style={{ marginTop: 'var(--sew-space-2)' }}>
          {staleNotice}
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
