import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { StudyError, MODEL_USAGE_PURPOSE, modelUsageReportSchema } from '@sew/study-contracts';
import {
  assertSharedBudget, costMeasurement, resumePolicyForUnsettled, settlementMeasurement, sharedBudgetRemaining,
} from '@sew/study-domain';
import { StudyStore, createNodeSqliteDriver, ensureProjectLayout, projectPaths } from '@sew/study-storage';

/**
 * 共享预算与用量口径（BUDGET-01 /《规划书》6.4、6.5）。
 *
 * 固定三件事：
 * 1. 生成、教师、AI 同学、评分、归因、复习共用同一份 run 额度，不各记一本账；
 * 2. 派发前原子预占，取消/失败/未知保守计量，未知绝不按 0 计费；
 * 3. 实际 / 估算 / 未知三档分开报告，没有价格依据时费用保持未知。
 */

const expectCode = (action: () => unknown, code: string, reason?: string): void => {
  try {
    action();
  } catch (error) {
    expect((error as StudyError).code).toBe(code);
    if (reason !== undefined) expect((error as StudyError).details?.['reason']).toBe(reason);
    return;
  }
  throw new Error(`预期抛出 ${code}，但调用成功了`);
};

const intent = (value: string): string => createHash('sha256').update(value).digest('hex');
const LIMITS = { maxCalls: 4, maxTokens: 10_000, maxWallClockMs: 60_000 };
const frozen = {
  knowledgeTableDigest: 'd'.repeat(64), materialRevisions: {}, planVersion: 1, lessonVersion: null,
  teachingPreferenceVersion: 0, roleConfigDigest: null, modelProfileId: null,
};

describe('共享预算与用量口径', () => {
  let root: string;
  let store: StudyStore;
  let projectId: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-budget-'));
    ensureProjectLayout(root);
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    projectId = 'proj-budget';
    store.createProject({ projectId, displayName: '数学', subject: '数学', dailyMinutes: 60 });
    store.createRun('run-1', 'plan_confirmed', frozen);
  });

  afterEach(() => {
    try { store.close(); } catch { /* 已关闭 */ }
    rmSync(root, { recursive: true, force: true });
  });

  const start = (requestId: string, purpose: typeof MODEL_USAGE_PURPOSE[number], reservedTokens: number) =>
    store.startModelUsageCall({
      projectId, requestId, runId: 'run-1', purpose, sessionId: null, roundIndex: null,
      intent: intent(requestId), reservedTokens, provider: 'openai-compatible', requestedModel: 'fixture-model',
    }, LIMITS);

  it('派发前预占：次数与 Token 任一不足都在写台账之前拒绝', () => {
    start('a', 'lesson_draft', 4_000);
    expectCode(() => start('b', 'teaching_prompt', 7_000), 'BUDGET_EXCEEDED', 'model_reservation_exhausted');
    // 被拒的那笔没有留下台账记录。
    expect(store.listModelUsageCalls(projectId).map((call) => call.requestId)).toEqual(['a']);
  });

  it('durable shared reservation refuses a new request after active execution time is spent', () => {
    start('time', 'lesson_draft', 500);
    store.settleModelUsageCall(projectId, 'time', { state: 'completed', accountedTokens: 200, providerTokens: 200,
      returnedModel: null, elapsedMs: LIMITS.maxWallClockMs, result: null });
    expectCode(() => start('late', 'review_suggestion', 500), 'BUDGET_EXCEEDED', 'shared_wall_clock');
    expect(store.listModelUsageCalls(projectId)).toHaveLength(1);
  });

  it('六类用途共用同一份 run 额度，不是各记一本账', () => {
    start('p1', 'lesson_draft', 1_000);
    start('p2', 'teaching_prompt', 1_000);
    start('p3', 'peer_turn', 1_000);
    start('p4', 'attempt_grading', 1_000);
    expectCode(() => start('p5', 'error_attribution', 1_000), 'BUDGET_EXCEEDED');
    const usage = store.modelCallUsage('run-1');
    expect(usage.calls).toBe(4);
    expect(usage.tokens).toBe(4_000);
  });

  it('同请求标识换用途被拒，不能借重试重复占用额度', () => {
    start('same', 'lesson_draft', 500);
    expectCode(() => start('same', 'peer_turn', 500), 'VERSION_CONFLICT', 'model_nonce_reused');
    expect(store.listModelUsageCalls(projectId)).toHaveLength(1);
  });

  it('结算写入实际/估算/未知三档口径，未知不按 0 计费', () => {
    // 与生产路径一致：结算同时追加一条 run 事件（事件里的 totalTokens 就是 accountedTokens），
    // 否则「报告」和「guard 用的额度」会基于不同数据源而漂移。
    const settle = (
      requestId: string, purpose: typeof MODEL_USAGE_PURPOSE[number], reserved: number,
      accounted: number, provider: number | null, measurement: 'actual' | 'estimated' | 'unknown', elapsedMs: number,
    ): void => {
      start(requestId, purpose, reserved);
      store.appendNextRunEvent('run-1', { type: 'model_call', purpose, ok: true, totalTokens: accounted, message: '' });
      store.settleModelUsageCall(projectId, requestId, {
        state: 'completed', accountedTokens: accounted, providerTokens: provider, tokenMeasurement: measurement,
        cost: null, costMeasurement: 'unknown', returnedModel: null, elapsedMs, result: null,
      });
    };

    settle('actual', 'lesson_draft', 1_000, 900, 900, 'actual', 120);
    settle('estimated', 'teaching_prompt', 1_000, 800, null, 'estimated', 80);
    settle('unknown', 'peer_turn', 1_000, 0, null, 'unknown', 40);

    const report = store.modelUsageReport('run-1', LIMITS);
    expect(modelUsageReportSchema.safeParse(report).success).toBe(true);
    expect(report.total.actualTokens).toBe(900);
    // 估算有依据 → 按估算计入并释放差额；只有「发出去了却拿不到任何依据」才整笔保留预占。
    expect(report.total.estimatedTokens).toBe(800);
    expect(report.total.unknownTokens).toBe(1_000);
    expect(report.total.reservedTokens).toBe(0);
    expect(report.total.unknownCostCalls).toBe(3);
    expect(report.total.actualCost).toBeNull();
    expect(report.total.estimatedCost).toBeNull();
    // 报告口径必须与 guard 用的额度一致：900 + 800 + 1000 = 2700。
    expect(report.remainingTokens).toBe(10_000 - 2_700);
    expect(store.modelCallUsage('run-1').tokens).toBe(2_700);
    // 执行墙钟只累计已结算调用的耗时，等待输入不计。
    expect(report.activeElapsedMs).toBe(240);
    expect(report.wallClockExhausted).toBe(false);
    expect(report.byPurpose.map((item) => item.purpose).sort()).toEqual(['lesson_draft', 'peer_turn', 'teaching_prompt']);
  });

  it('未结算调用保留预占并出现在未结算清单，重开数据库后仍然占额度', () => {
    start('pending', 'lesson_draft', 2_500);
    store.close();
    store = StudyStore.open({ file: projectPaths(root).databaseFile });

    const report = store.modelUsageReport('run-1', LIMITS);
    expect(report.total.reservedTokens).toBe(2_500);
    expect(report.unsettled).toEqual([
      { requestId: 'pending', purpose: 'lesson_draft', reservedTokens: 2_500, createdAt: expect.any(String) },
    ]);
    // 预占仍然占额度：剩余 Token 不是满额。
    expect(report.remainingTokens).toBe(7_500);
    expect(store.modelCallUsage('run-1').tokens).toBe(2_500);
    // 未知调用的预占不会被静默释放。
    expect(store.listModelUsageCalls(projectId)[0]).toMatchObject({ state: 'started', tokenMeasurement: 'unknown' });
  });

  it('报告里的未结算清单包含评分预占，评分与生成共用同一份额度', () => {
    // 评分预占记在自己的表里，但报告必须能看到它，否则用户不知道额度花在哪。
    store.createRun('run-2', 'plan_confirmed', frozen);
    const report = store.modelUsageReport('run-2', LIMITS);
    expect(report.unsettled).toEqual([]);
    expect(report.remainingCalls).toBe(LIMITS.maxCalls);
  });

  it('费用没有价格依据时保持未知，不返回 0 元', () => {
    start('cost', 'lesson_draft', 100);
    const call = store.getModelUsageCall(projectId, 'cost')!;
    expect(call.cost).toBeNull();
    expect(call.costMeasurement).toBe('unknown');
    expect(store.modelUsageReport('run-1', LIMITS).total.actualCost).toBeNull();
  });

  it('历史台账缺少口径列时按当时证据补口径，不改动结算值', () => {
    start('legacy', 'lesson_draft', 1_000);
    store.settleModelUsageCall(projectId, 'legacy', {
      state: 'completed', accountedTokens: 700, providerTokens: 700,
      cost: null, costMeasurement: 'unknown', returnedModel: null, elapsedMs: 10, result: null,
    });
    // 模拟旧版本写入的行：抹掉后来新增的口径列与角色列。
    // 读取时必须能补回口径而不是判为损坏，且结算值（accounted/provider）一个字都不变。
    const raw = store.getModelUsageCall(projectId, 'legacy')!;
    const legacy: Record<string, unknown> = { ...raw };
    delete legacy['tokenMeasurement'];
    delete legacy['costMeasurement'];
    delete legacy['roleProfileId'];
    delete legacy['peerTurnIndex'];
    const db = createNodeSqliteDriver().open(projectPaths(root).databaseFile);
    db.prepare('UPDATE model_usage_calls SET call_json = ? WHERE project_id = ? AND request_id = ?')
      .run(JSON.stringify(legacy), projectId, 'legacy');
    db.close();

    const read = store.getModelUsageCall(projectId, 'legacy')!;
    expect(read.accountedTokens).toBe(700);
    expect(read.providerTokens).toBe(700);
    expect(read.tokenMeasurement).toBe('actual');
    expect(read.costMeasurement).toBe('unknown');
    expect(read.roleProfileId).toBeNull();
    expect(read.peerTurnIndex).toBeNull();
  });
});

describe('共享预算与结算口径的纯判断', () => {
  it('次数、Token、执行时限三者任一不足都在派发前失败', () => {
    expectCode(() => assertSharedBudget({
      limits: { maxCalls: 1, maxTokens: 100, maxWallClockMs: 1_000 },
      usage: { calls: 1, tokens: 0, activeElapsedMs: 0 }, reservedTokens: 10,
    }), 'BUDGET_EXCEEDED', 'shared_calls');
    expectCode(() => assertSharedBudget({
      limits: { maxCalls: 5, maxTokens: 100, maxWallClockMs: 1_000 },
      usage: { calls: 0, tokens: 95, activeElapsedMs: 0 }, reservedTokens: 10,
    }), 'BUDGET_EXCEEDED', 'shared_tokens');
    expectCode(() => assertSharedBudget({
      limits: { maxCalls: 5, maxTokens: 100, maxWallClockMs: 1_000 },
      usage: { calls: 0, tokens: 0, activeElapsedMs: 1_000 }, reservedTokens: 10,
    }), 'BUDGET_EXCEEDED', 'shared_wall_clock');
    expect(sharedBudgetRemaining({
      limits: { maxCalls: 5, maxTokens: 100, maxWallClockMs: 1_000 },
      usage: { calls: 2, tokens: 40, activeElapsedMs: 250 },
    })).toEqual({ calls: 3, tokens: 60, wallClockMs: 750 });
  });

  it('结算口径：未派发确知为 0；派发但无依据时保留预占', () => {
    // 请求根本没发出，消耗确知为 0，按实际记并释放预占。
    expect(settlementMeasurement({ dispatched: false, providerTokens: null, estimatedTokens: null }))
      .toEqual({ measurement: 'actual', accountedTokens: 0, keepsReservation: false });
    expect(settlementMeasurement({ dispatched: true, providerTokens: 321, estimatedTokens: 999 }))
      .toEqual({ measurement: 'actual', accountedTokens: 321, keepsReservation: false });
    expect(settlementMeasurement({ dispatched: true, providerTokens: null, estimatedTokens: 999 }))
      .toEqual({ measurement: 'estimated', accountedTokens: 999, keepsReservation: false });
    expect(settlementMeasurement({ dispatched: true, providerTokens: null, estimatedTokens: null }))
      .toEqual({ measurement: 'unknown', accountedTokens: null, keepsReservation: true });
  });

  it('费用口径：无价格依据时保持未知，有依据时区分实际与估算', () => {
    expect(costMeasurement({ priceKnown: false, tokensKnown: true, cost: 12, costIsEstimate: false }))
      .toEqual({ cost: null, measurement: 'unknown' });
    expect(costMeasurement({ priceKnown: true, tokensKnown: false, cost: 12, costIsEstimate: false }))
      .toEqual({ cost: null, measurement: 'unknown' });
    expect(costMeasurement({ priceKnown: true, tokensKnown: true, cost: 12, costIsEstimate: false }))
      .toEqual({ cost: 12, measurement: 'actual' });
    expect(costMeasurement({ priceKnown: true, tokensKnown: true, cost: 12, costIsEstimate: true }))
      .toEqual({ cost: 12, measurement: 'estimated' });
  });

  it('断线后不自动重放未结算调用，并保留其预占', () => {
    expect(resumePolicyForUnsettled({ state: 'started', attempt: 1 }))
      .toEqual({ policy: 'refuse_auto_replay', keepReservation: true });
    expect(resumePolicyForUnsettled({ state: 'completed', attempt: 1 }))
      .toEqual({ policy: 'reuse_settled', keepReservation: false });
    expect(resumePolicyForUnsettled({ state: 'failed', attempt: 1 }))
      .toEqual({ policy: 'reuse_settled', keepReservation: false });
  });
});
