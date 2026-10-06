import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ClassroomSessionDto } from '@sew/study-contracts';
import { ClassroomPeersPanel } from '../apps/learning/components/classroom-peers';
import {
  PEER_TURN_STALE_NOTICE,
  createPeerStaleCommandHandler,
  peerCommandScope,
} from '../apps/learning/lib/classroom/peer-command-lifecycle';

/**
 * 同学面板的过期结果处理（PEER-01）。
 *
 * 固定三件事：作用域键仍包含课堂状态（别处推进课堂必须隔离这里的在途发言）；
 * 中断提示只承认「客户端不再等待」，不声称服务端写入被撤销；中断必然伴随权威状态重读。
 */

const require = createRequire(new URL('../apps/learning/package.json', import.meta.url));
const { createElement } = require('react') as {
  createElement: (type: unknown, props: unknown) => unknown;
};
const { renderToStaticMarkup } = require('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

const session = (overrides: Partial<ClassroomSessionDto> = {}): ClassroomSessionDto => ({
  sessionId: 'session-1',
  projectId: 'project-1',
  runId: null,
  lessonId: 'lesson-1',
  lessonVersion: 1,
  bundleId: 'bundle-1',
  stageId: 'stage-1',
  learnerKey: 'learner-1',
  status: 'in_class',
  awaitingReason: '',
  currentSceneId: 'scene-1',
  roundIndex: 1,
  roundCalls: 0,
  roundPeerTurns: 0,
  lessonCalls: 0,
  peersEnabled: true,
  peersEngagement: 'balanced',
  createdAt: '2026-10-05T00:00:00.000Z',
  updatedAt: '2026-10-05T00:00:00.000Z',
  ...overrides,
});

const renderPanel = (
  current: ClassroomSessionDto,
  schedule: {
    canSpeak: boolean;
    reason: string | null;
    turnCeiling: number;
    turnsThisRound: number;
  } = { canSpeak: true, reason: null, turnCeiling: 1, turnsThisRound: 0 },
): string =>
  renderToStaticMarkup(
    createElement(ClassroomPeersPanel, {
      projectId: current.projectId,
      generation: 3,
      session: current,
      peers: [{ profileId: 'role-peer-1', name: '小李', engagement: 'active' }],
      peerTurns: [],
      schedule,
      onChange: () => undefined,
      onStateRefresh: () => undefined,
    }),
  );

describe('AI 同学面板的过期结果隔离', () => {
  it('把课堂状态计入命令作用域，任何一类课堂推进都会隔离在途发言', () => {
    const base = session();
    const key = (overrides: Partial<ClassroomSessionDto>) =>
      peerCommandScope({ ...base, ...overrides }, 'project-1', 3);
    expect(key({ status: 'awaiting_learner' })).not.toBe(key({}));
    expect(key({ status: 'completed' })).not.toBe(key({}));
    expect(key({ roundIndex: 2 })).not.toBe(key({}));
    expect(key({ currentSceneId: 'scene-2' })).not.toBe(key({}));
    expect(key({ sessionId: 'session-2' })).not.toBe(key({}));
    expect(peerCommandScope(base, 'project-2', 3)).not.toBe(key({}));
    expect(peerCommandScope(base, 'project-1', 4)).not.toBe(key({}));
    // 同一课堂状态的重复读取必须得到同一个键，否则每次渲染都会换掉锁。
    expect(key({})).toBe(peerCommandScope(base, 'project-1', 3));
  });

  it('面板按服务端会话渲染，且把过期中断接到可见提示与权威重读上', () => {
    const html = renderPanel(session({ status: 'awaiting_learner' }));
    expect(html).toContain('data-classroom-peers');
    expect(html).toContain('让哪位同学发言');
    const source = readFileSync(
      new URL('../apps/learning/components/classroom-peers.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain('onStale: createPeerStaleCommandHandler');
    expect(source).toContain('const context = peerCommandScope(session, projectId, generation)');
  });

  it('consumes the server schedule verdict instead of recomputing user priority', () => {
    // 服务端说不能发言（等待本人）时，即便会话开关是开的，界面也必须按服务端结论禁用。
    const awaiting = renderPanel(session({ status: 'awaiting_learner', peersEnabled: true }), {
      canSpeak: false,
      reason: 'awaiting_learner',
      turnCeiling: 1,
      turnsThisRound: 0,
    });
    expect(awaiting).toContain('data-peer-schedule-note="awaiting_learner"');
    expect(awaiting).toContain('正在等待本人作答');
    // 服务端说已达轮内上限时，界面显示实际上限而不是自己算的数字。
    const capped = renderPanel(session({ peersEnabled: true, roundPeerTurns: 2 }), {
      canSpeak: false,
      reason: 'round_ceiling',
      turnCeiling: 2,
      turnsThisRound: 2,
    });
    expect(capped).toContain('data-peer-schedule-note="round_ceiling"');
    expect(capped).toContain('本轮同学发言 2/2 次');
    // 源码不得再自行拼装用户优先规则。
    const source = readFileSync(
      new URL('../apps/learning/components/classroom-peers.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain('const canSpeak = schedule.canSpeak && !disabled;');
    expect(source).not.toContain("session.peersEnabled && session.status === 'in_class'");
  });

  it('shows the interruption and rereads authoritative state only while the panel is mounted', () => {
    const mounted = { current: true };
    const shown: string[] = [];
    const refresh = vi.fn();
    createPeerStaleCommandHandler({
      mounted,
      showNotice: (notice) => shown.push(notice),
      refreshAuthoritativeState: refresh,
    })();
    expect(shown).toEqual([PEER_TURN_STALE_NOTICE]);
    expect(refresh).toHaveBeenCalledTimes(1);

    const unmounted = { current: false };
    const lateShown: string[] = [];
    const lateRefresh = vi.fn();
    createPeerStaleCommandHandler({
      mounted: unmounted,
      showNotice: (notice) => lateShown.push(notice),
      refreshAuthoritativeState: lateRefresh,
    })();
    expect(lateShown).toEqual([]);
    expect(lateRefresh).not.toHaveBeenCalled();
  });

  it('states the abort as a client-side wait that cannot claim the server write was revoked', () => {
    expect(PEER_TURN_STALE_NOTICE).toContain('已按旧作用域隔离');
    expect(PEER_TURN_STALE_NOTICE).toContain('这次发言可能已经记录');
    expect(PEER_TURN_STALE_NOTICE).toContain('服务端重读');
    // 不能出现的说法：写入被撤销、确认未落库、结果被回滚。
    expect(PEER_TURN_STALE_NOTICE).not.toMatch(/已撤销|已回滚|未写入|没有写入|不会被记录/);
  });
});
