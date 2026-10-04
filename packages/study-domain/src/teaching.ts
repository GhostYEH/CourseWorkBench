/**
 * 课堂教师侧的纯判断（《规划书》6.2 / 6.4，TEACH-01）。
 *
 * 这一层不知道数据库也不不知道 HTTP：它只回答三件事 —— 这张卡能不能播、
 * 现在该播哪一张、这一轮还能不能再发模型调用。等待本人时不再自动播报，
 * 停止后的会话不接受新的动作，模型产生的新内容没有经过语义审核就不能出声。
 */

import {
  StudyError,
  CLASSROOM_LESSON_MAX_CALLS,
  CLASSROOM_ROUND_LIMITS,
  type ClassroomSessionStatus,
  type EvidenceBundleDto,
  type ExplanationCardDto,
} from '@sew/study-contracts';

/** 卡片引用的陈述必须都在冻结的证据包里，并且指向同一个知识点集合。 */
export const assertCardGrounded = (
  statementIds: readonly string[],
  bundle: EvidenceBundleDto,
): string[] => {
  if (statementIds.length === 0) {
    throw new StudyError('SOURCE_MISSING', { reason: 'card_has_no_statements' });
  }
  const byId = new Map(bundle.statements.map((statement) => [statement.statementId, statement]));
  const unknown = statementIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'statement_outside_bundle', unknown });
  }
  return [...new Set(statementIds.map((id) => byId.get(id)!.knowledgeId))];
};

/** 批准讲解卡：引用的知识点必须仍通过准入。 */
export const assertCardApprovable = (
  facts: { status: ExplanationCardDto['status']; knowledgeIds: readonly string[] },
  admittedKnowledgeIds: ReadonlySet<string>,
): void => {
  const blocked = facts.knowledgeIds.filter((knowledgeId) => !admittedKnowledgeIds.has(knowledgeId));
  if (blocked.length > 0) throw new StudyError('KNOWLEDGE_INVALIDATED', { knowledgeIds: blocked });
};

/**
 * 播放前复核：卡片已审核、会话仍在进行、来源仍准入。
 *
 * 三条都不满足时报不同的原因，界面才能给出「等谁来处理」而不是笼统的失败。
 */
export const assertCardPlayable = (
  facts: {
    cardStatus: ExplanationCardDto['status'];
    sessionStatus: ClassroomSessionStatus;
    knowledgeIds: readonly string[];
  },
  admittedKnowledgeIds: ReadonlySet<string>,
): void => {
  if (facts.sessionStatus === 'awaiting_learner') {
    throw new StudyError('CLASSROOM_AWAITING_LEARNER', { reason: 'awaiting_learner' });
  }
  if (facts.sessionStatus !== 'in_class') {
    throw new StudyError('RUN_TERMINATED', { status: facts.sessionStatus });
  }
  if (facts.cardStatus !== 'approved') {
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'card_not_approved' });
  }
  const blocked = facts.knowledgeIds.filter((knowledgeId) => !admittedKnowledgeIds.has(knowledgeId));
  if (blocked.length > 0) throw new StudyError('KNOWLEDGE_INVALIDATED', { knowledgeIds: blocked });
};

/**
 * 下一张该讲的卡：只看当前场景、已审核、未播放，按位置与写入顺序取第一张。
 *
 * 队列是确定性的，Director 不做自由调度，也不产生「角色自己接着讲」的递归。
 */
export const nextPlayableCard = (
  cards: readonly ExplanationCardDto[],
  playedIds: ReadonlySet<string>,
  sceneId: string,
): ExplanationCardDto | null => {
  const queue = cards
    .filter((card) => card.sceneId === sceneId && card.status === 'approved' && !playedIds.has(card.explanationId))
    .sort((left, right) => left.position - right.position
      || left.createdAt.localeCompare(right.createdAt)
      || left.explanationId.localeCompare(right.explanationId));
  return queue[0] ?? null;
};

/** 会话是否已停止：停止后任何动作都拒绝，恢复也不补执行。 */
export const assertSessionActive = (status: ClassroomSessionStatus): void => {
  if (status === 'completed' || status === 'cancelled') {
    throw new StudyError('RUN_TERMINATED', { status });
  }
};

export type ClassroomBudgetUse = 'model_call' | 'peer_turn';

/**
 * 每轮与整节课上限（《规划书》6.4）。等待本人不计入执行时限，因此没有墙钟项；
 * 达到上限只报「交还用户决定」，不静默丢弃动作。
 */
export const assertClassroomBudget = (
  facts: {
    roundCalls: number;
    roundPeerTurns: number;
    lessonCalls: number;
    peersEnabled: boolean;
    maxCallsPerRound?: number;
    maxPeerTurnsPerRound?: number;
    maxLessonCalls?: number;
  },
  use: ClassroomBudgetUse,
): void => {
  const maxCallsPerRound = facts.maxCallsPerRound ?? CLASSROOM_ROUND_LIMITS.maxCallsPerRound;
  const maxPeerTurns = facts.maxPeerTurnsPerRound ?? CLASSROOM_ROUND_LIMITS.maxPeerTurnsPerRound;
  const maxLessonCalls = facts.maxLessonCalls ?? CLASSROOM_LESSON_MAX_CALLS;
  if (facts.lessonCalls >= maxLessonCalls) {
    throw new StudyError('BUDGET_EXCEEDED', { reason: 'lesson_calls', used: facts.lessonCalls, limit: maxLessonCalls });
  }
  if (use === 'model_call' && facts.roundCalls >= maxCallsPerRound) {
    throw new StudyError('BUDGET_EXCEEDED', {
      reason: 'round_calls', used: facts.roundCalls, limit: maxCallsPerRound,
    });
  }
  if (use === 'peer_turn') {
    if (!facts.peersEnabled) throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'peers_disabled' });
    if (facts.roundPeerTurns >= maxPeerTurns) {
      throw new StudyError('BUDGET_EXCEEDED', {
        reason: 'round_peer_turns', used: facts.roundPeerTurns, limit: maxPeerTurns,
      });
    }
  }
};

/** 新一轮从切场景或本人作答归来开始；轮次只增不减，收据才能区分重复动作。 */
export const nextRoundIndex = (roundIndex: number): number => roundIndex + 1;
