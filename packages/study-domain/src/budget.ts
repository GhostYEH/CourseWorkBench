/**
 * 共享预算的纯判断（《规划书》6.4 / 6.5，BUDGET-01）。
 *
 * 生成任务与课堂不是两套限额：Director、教师、AI 同学、模型评分、错因归因、
 * 复习建议全部落在同一个 `run` 的调用/Token 总额度里。这一层回答
 * 「现在这一笔还能不能发」，以及「已经花掉的部分该记成实际、估算还是未知」。
 *
 * 等待本人输入的时间不计执行时限，所以墙钟项只累计真正在跑的外部调用。
 */

import { StudyError, type ModelCostMeasurement, type ModelUsageMeasurement } from '@sew/study-contracts';

/** 共享预算上限。本地保守限额，不等于服务商配额。 */
export interface SharedBudgetLimits {
  maxCalls: number;
  maxTokens: number;
  maxWallClockMs: number;
}

export interface SharedBudgetUsage {
  calls: number;
  tokens: number;
  /** 已发出且已结算的调用耗时之和；等待输入不属于执行时间。 */
  activeElapsedMs: number;
}

/**
 * 派发前判定。
 *
 * 三件事必须同时成立：次数、Token、执行时限都还有余量。任一不足都在
 * provider 请求发出之前失败，因此不会出现「先花钱再报额度不足」。
 */
export const assertSharedBudget = (
  facts: { limits: SharedBudgetLimits; usage: SharedBudgetUsage; reservedTokens: number },
): void => {
  const { limits, usage, reservedTokens } = facts;
  if (usage.calls + 1 > limits.maxCalls) {
    throw new StudyError('BUDGET_EXCEEDED', {
      reason: 'shared_calls', used: usage.calls, limit: limits.maxCalls,
    });
  }
  if (usage.tokens + reservedTokens > limits.maxTokens) {
    throw new StudyError('BUDGET_EXCEEDED', {
      reason: 'shared_tokens', used: usage.tokens, reserved: reservedTokens, limit: limits.maxTokens,
    });
  }
  if (usage.activeElapsedMs >= limits.maxWallClockMs) {
    throw new StudyError('BUDGET_EXCEEDED', {
      reason: 'shared_wall_clock', used: usage.activeElapsedMs, limit: limits.maxWallClockMs,
    });
  }
};

/** 剩余额度，用于界面显示与服务端二次复验。 */
export const sharedBudgetRemaining = (
  facts: { limits: SharedBudgetLimits; usage: SharedBudgetUsage },
): { calls: number; tokens: number; wallClockMs: number } => ({
  calls: Math.max(0, facts.limits.maxCalls - facts.usage.calls),
  tokens: Math.max(0, facts.limits.maxTokens - facts.usage.tokens),
  wallClockMs: Math.max(0, facts.limits.maxWallClockMs - facts.usage.activeElapsedMs),
});

/**
 * 结算口径判定（《规划书》6.4「失败/未知保守计量」）。
 *
 * 关键约束：请求发出去了就必须留下痕迹。
 * - 请求根本没发出 → 消耗**确知为 0**，按 `actual` 记并释放预占；
 * - provider 明确给了计数 → `actual`，按实际计入；
 * - provider 没给计数但有本地估算依据 → `estimated`，差额由调用方保守保留；
 * - provider 没给计数且没有估算依据 → `unknown`，保留预占不释放。
 *
 * 刻意不提供「把未知按 0 计费」的选项：未知就是未知，把钱算成 0 是最危险的做法。
 * 这是全仓唯一的结算口径实现，生产路径与测试都调用它，避免两处各写一遍而漂移。
 */
export const settlementMeasurement = (facts: {
  dispatched: boolean;
  providerTokens: number | null;
  estimatedTokens: number | null;
}): { measurement: ModelUsageMeasurement; accountedTokens: number | null; keepsReservation: boolean } => {
  if (!facts.dispatched) return { measurement: 'actual', accountedTokens: 0, keepsReservation: false };
  if (facts.providerTokens !== null) return { measurement: 'actual', accountedTokens: facts.providerTokens, keepsReservation: false };
  if (facts.estimatedTokens !== null) return { measurement: 'estimated', accountedTokens: facts.estimatedTokens, keepsReservation: false };
  return { measurement: 'unknown', accountedTokens: null, keepsReservation: true };
};

/**
 * 费用口径。
 *
 * 没有价格表时只能是 `unknown`——本项目不发付费请求，也没有维护价目表，
 * 所以「费用」这一栏的正确行为是明确说不知道，而不是给一个看起来专业的数字。
 * 将来接入价目表时，也要由价目表来源决定是 actual 还是 estimated。
 */
export const costMeasurement = (facts: {
  priceKnown: boolean;
  tokensKnown: boolean;
  cost: number | null;
  costIsEstimate: boolean;
}): { cost: number | null; measurement: ModelCostMeasurement } => {
  if (!facts.priceKnown || facts.cost === null) return { cost: null, measurement: 'unknown' };
  if (!facts.tokensKnown) return { cost: null, measurement: 'unknown' };
  return { cost: facts.cost, measurement: facts.costIsEstimate ? 'estimated' : 'actual' };
};

/**
 * 断线/重开后的判定：不允许自动重放。
 *
 * 一个 `started` 但没有结算记录的调用，说明「钱可能花了，结果不知道」。
 * 这种情况下服务端只能拒绝自动重发，把决定权交回用户；默认保留预占。
 */
export const resumePolicyForUnsettled = (facts: {
  state: 'started' | 'failed' | 'completed';
  attempt: number;
}): { policy: 'refuse_auto_replay' | 'reuse_settled'; keepReservation: boolean } => {
  if (facts.state === 'started') return { policy: 'refuse_auto_replay', keepReservation: true };
  return { policy: 'reuse_settled', keepReservation: false };
};

/** Reserve prompt bytes conservatively; output receives only the remaining allowance. */
export const reserveSharedModelTokens = (messages: ReadonlyArray<{ content: string }>, remainingTokens: number, outputLimit = 2000) => {
  const inputTokens = messages.reduce((sum, message) => sum + new TextEncoder().encode(message.content).length + 16, 0) + 32;
  const maxTokens = Math.min(outputLimit, remainingTokens - inputTokens);
  if (maxTokens < 1) throw new StudyError('BUDGET_EXCEEDED', { reason: 'shared_tokens', reserved: inputTokens, remainingTokens });
  return { reservedTokens: inputTokens + maxTokens, maxTokens };
};

export const sharedModelDeadlineMs = (limits: SharedBudgetLimits, usage: SharedBudgetUsage, singleCallMs = 120_000): number => {
  const remaining = limits.maxWallClockMs - (usage.activeElapsedMs ?? 0);
  if (remaining <= 0) throw new StudyError('BUDGET_EXCEEDED', { reason: 'shared_wall_clock' });
  return Math.min(remaining, singleCallMs);
};

/** Validate the complete dispatched consumption before accepting any candidate. */
export const assertSharedModelSettlement = (limits: SharedBudgetLimits, usage: SharedBudgetUsage, tokens: number, elapsedMs: number): void => {
  if (usage.tokens + tokens > limits.maxTokens) throw new StudyError('BUDGET_EXCEEDED', { reason: 'shared_tokens' });
  if ((usage.activeElapsedMs ?? 0) + elapsedMs > limits.maxWallClockMs) throw new StudyError('BUDGET_EXCEEDED', { reason: 'shared_wall_clock' });
};
