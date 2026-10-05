import type { ClassroomSessionDto } from '@sew/study-contracts';

/**
 * AI 同学面板的在途发言处理（PEER-01）。
 *
 * 作用域键含会话状态：别处推进课堂时，这里的在途结果必须被隔离。隔离只说明「界面不再采信
 * 这次结果」——abort 掉本地请求不会撤销服务端已经写入的发言，所以提示不能写成已撤销或未落库，
 * 而唯一可信的下一步是重读服务端权威状态。
 */

export const PEER_TURN_STALE_NOTICE =
  '课堂状态在这次发言等待期间发生了变化，这次结果已按旧作用域隔离，界面没有采用它。' +
  '中断停止的只是客户端等待：服务端写入不会因此撤销，这次发言可能已经记录。' +
  '同学发言与会话状态都以服务端重读的结果为准。';

/** 项目、代次、会话、轮次、场景与课堂状态任一变化都产生新作用域；状态变化不得留下旧结果。 */
export const peerCommandScope = (
  session: Pick<ClassroomSessionDto, 'sessionId' | 'status' | 'roundIndex' | 'currentSceneId'>,
  projectId: string,
  generation: number,
): string =>
  `${projectId}:${generation}:${session.sessionId}:${session.roundIndex}:` +
  `${session.currentSceneId}:${session.status}`;

export interface PeerStaleCommandInput {
  /** 面板是否仍然挂载；卸载后的迟到中断不再写界面状态，也不发起多余读取。 */
  mounted: { current: boolean };
  showNotice: (notice: string) => void;
  refreshAuthoritativeState: () => void;
}

/** 一次过期中断 = 一条可见提示 + 一次权威状态重读，二者都不允许省略。 */
export const createPeerStaleCommandHandler =
  ({ mounted, showNotice, refreshAuthoritativeState }: PeerStaleCommandInput) =>
  (): void => {
    if (!mounted.current) return;
    showNotice(PEER_TURN_STALE_NOTICE);
    refreshAuthoritativeState();
  };
