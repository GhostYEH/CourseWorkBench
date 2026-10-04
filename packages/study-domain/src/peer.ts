/**
 * AI 同学的纯判断（《规划书》6.4 / 6.6，PEER-01）。
 *
 * 这一层回答三个问题，不碰数据库也不碰 HTTP：
 * 1. 这一轮该轮到同学开口了吗（用户优先、参与度只影响开口频率）？
 * 2. 这位同学能不能发这次言（权限按 kind 派生，不读客户端自报）？
 * 3. 同学的示范作答算不算本人的掌握（永远不算）？
 */

import {
  StudyError,
  CLASSROOM_ROUND_LIMITS,
  type ActorType,
  type PeerEngagement,
} from '@sew/study-contracts';

/**
 * 参与度到「本轮开口次数上限」的映射。
 *
 * 值是上限而不是配额：上限存在不等于一定会说满，`shouldPeerSpeak` 还要看用户优先规则。
 * 两者都不能超过《规划书》6.4 的硬上限（每轮最多 2 次同学发言）。
 */
const ENGAGEMENT_CEILING: Record<PeerEngagement, number> = {
  quiet: 1,
  balanced: 1,
  active: CLASSROOM_ROUND_LIMITS.maxPeerTurnsPerRound,
};

export const peerTurnCeiling = (engagement: PeerEngagement): number =>
  Math.min(ENGAGEMENT_CEILING[engagement], CLASSROOM_ROUND_LIMITS.maxPeerTurnsPerRound);

/**
 * 用户优先：同学是否还能在这一轮开口。
 *
 * 「用户优先」不是一句文案，它在这里落实为三条可判定的规则：
 * - 会话必须正在进行；
 * - 本人正在被等待作答、或会话已结束/取消时，同学一律不许插话；
 * - 同学发言次数不得超过参与度上限，也不得超过规划书的轮内硬上限。
 *
 * 达到上限返回 `false` 而不是抛错：调度器需要「这轮不说了」这个正常结论。
 */
export const shouldPeerSpeak = (facts: {
  sessionStatus: 'in_class' | 'awaiting_learner' | 'completed' | 'cancelled';
  peersEnabled: boolean;
  engagement: PeerEngagement;
  roundPeerTurns: number;
}): boolean => {
  if (!facts.peersEnabled) return false;
  if (facts.sessionStatus !== 'in_class') return false;
  return facts.roundPeerTurns < peerTurnCeiling(facts.engagement);
};

/**
 * 断言「这次同学发言被允许」。
 *
 * 与 `shouldPeerSpeak` 的分工：调度器用前者决定要不要说，命令处理器用后者
 * 保证任何人绕过界面直接 POST 也拿不到越权结果。两处共用同一份上限常量，
 * 不存在「界面限制了但接口没限制」的缺口。
 */
export const assertPeerTurnAllowed = (facts: {
  sessionStatus: 'in_class' | 'awaiting_learner' | 'completed' | 'cancelled';
  peersEnabled: boolean;
  engagement: PeerEngagement;
  roundPeerTurns: number;
  roleKind: 'teacher' | 'peer';
  actorType: ActorType;
  partition: 'real' | 'simulation';
}): void => {
  if (facts.roleKind !== 'peer' || facts.actorType !== 'peer_ai') {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'not_a_peer_role' });
  }
  if (facts.partition !== 'simulation') {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'peer_must_use_simulation_partition' });
  }
  if (facts.sessionStatus === 'awaiting_learner') {
    throw new StudyError('CLASSROOM_AWAITING_LEARNER', { reason: 'awaiting_learner' });
  }
  if (facts.sessionStatus !== 'in_class') {
    throw new StudyError('RUN_TERMINATED', { status: facts.sessionStatus });
  }
  if (!facts.peersEnabled) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'peers_disabled' });
  }
  const ceiling = peerTurnCeiling(facts.engagement);
  if (facts.roundPeerTurns >= ceiling) {
    throw new StudyError('BUDGET_EXCEEDED', {
      reason: 'round_peer_turns', used: facts.roundPeerTurns, limit: ceiling,
    });
  }
};

/**
 * 同学能做的事与不能做的事（《规划书》6.6 表格的机器可判版本）。
 *
 * 注意 `answerAsLearner` 是 `false` 字面量：这里没有布尔开关，
 * 「同学能不能替本人作答」不是一个可配置项。
 */
export const peerCapabilities = (): {
  whiteboardWrite: false;
  answerAsLearner: false;
  modifyKnowledge: false;
  approveContent: false;
  speak: true;
  aiIdentityVisible: true;
  partition: 'simulation';
} => ({
  whiteboardWrite: false,
  answerAsLearner: false,
  modifyKnowledge: false,
  approveContent: false,
  speak: true,
  aiIdentityVisible: true,
  partition: 'simulation',
});

/**
 * 同学的发言正文必须是「提问/讨论」或「审核过的示例」。
 *
 * 模型现场编出来的学科新事实不能当作示例——`example` 必须挂到已审核的
 * 教学示例上，否则只能降级为提问或讨论，或走候选审核路径。
 */
export const assertPeerTurnGrounded = (facts: {
  kind: 'question' | 'discussion' | 'example';
  statementIds: readonly string[];
  reviewedExampleId: string | null;
  knownStatementIds: ReadonlySet<string>;
}): void => {
  if (facts.kind !== 'example') {
    // 提问与讨论不声称来源，但如果引用了陈述，引用的必须真实存在于冻结证据包里。
    const unknown = facts.statementIds.filter((statementId) => !facts.knownStatementIds.has(statementId));
    if (unknown.length > 0) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'peer_statement_outside_bundle', unknown });
    }
    return;
  }
  if (!facts.reviewedExampleId) {
    throw new StudyError('SOURCE_MISSING', { reason: 'peer_example_not_reviewed' });
  }
  if (facts.statementIds.length === 0) {
    throw new StudyError('SOURCE_MISSING', { reason: 'peer_example_has_no_statements' });
  }
  const unknown = facts.statementIds.filter((statementId) => !facts.knownStatementIds.has(statementId));
  if (unknown.length > 0) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'peer_statement_outside_bundle', unknown });
  }
};

/**
 * 同学的提交永远不更新本人掌握。
 *
 * 这里返回「应当写入的分区」，而不是布尔值：调用方只能照它写，
 * 没有「同学答对了所以算本人掌握」这条分支可供选择。
 */
export const peerAttemptPartition = (): 'simulation' => 'simulation';
