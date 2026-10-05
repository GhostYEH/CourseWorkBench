import {
  StudyError,
  measurementOf,
  modelUsageCallSchema,
  modelUsageReportSchema,
  type ModelCostMeasurement,
  type ModelUsageCallDto,
  type ModelUsageReportDto,
} from '@sew/study-contracts';
import { consumptionOf, summarizeModelUsage } from '@sew/study-domain';
import type { SqlDatabase } from '../driver';
import { decodeJson, encodeJson } from '../json-codec';

export type StartModelUsageCallInput = Pick<
  ModelUsageCallDto,
  | 'projectId'
  | 'requestId'
  | 'runId'
  | 'purpose'
  | 'sessionId'
  | 'roundIndex'
  | 'intent'
  | 'reservedTokens'
  | 'provider'
  | 'requestedModel'
> &
  Partial<Pick<ModelUsageCallDto, 'roleProfileId' | 'peerTurnIndex'>>;
export type SettleModelUsageCallInput = Pick<
  ModelUsageCallDto,
  'state' | 'accountedTokens' | 'providerTokens' | 'returnedModel' | 'elapsedMs' | 'result'
> &
  Partial<Pick<ModelUsageCallDto, 'tokenMeasurement' | 'cost' | 'costMeasurement'>>;

/** 共享预算上限：次数、Token、执行墙钟三项，课堂与生成共用同一份。 */
export interface ModelUsageLimits {
  maxCalls: number;
  maxTokens: number;
  maxWallClockMs: number;
}

interface ModelUsageRow {
  call_json: unknown;
  project_id: string;
  request_id: string;
  run_id: string;
}

/**
 * 读取时把 v23 以前的记录补成当前形状。
 *
 * 历史记录缺新列是正常情况，不是损坏：按当时能推断出的口径如实标注
 * （有 provider 计数→实际，有 accounted→估算，否则未知），绝不重算金额，
 * 也不改动任何既有结算值。
 */
const normalizeLegacy = (raw: unknown): unknown => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>;
  const hasCost = typeof value['cost'] === 'number';
  return {
    roleProfileId: null,
    peerTurnIndex: null,
    ...value,
    tokenMeasurement:
      value['tokenMeasurement'] ??
      measurementOf({
        state: value['state'] as ModelUsageCallDto['state'],
        accountedTokens: (value['accountedTokens'] ?? null) as number | null,
        providerTokens: (value['providerTokens'] ?? null) as number | null,
      }),
    costMeasurement: value['costMeasurement'] ?? (hasCost ? 'estimated' : 'unknown'),
  };
};

export class ModelUsageRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * 读一行并做「先补形状、再严格校验」。
   *
   * 顺序很关键：先补旧列再交给 strict schema，历史记录才不会被误判为损坏；
   * 补完仍然不合法的（例如被外部改写）则按内部错误拒绝，不降级放行。
   */
  private parseCall(row: ModelUsageRow): ModelUsageCallDto {
    const decoded = decodeJson(
      row.call_json,
      modelUsageCallSchema.nullable(),
      null,
      'model_usage_calls',
      normalizeLegacy,
    );
    const call = decoded.value;
    if (
      !decoded.ok ||
      !call ||
      call.projectId !== row.project_id ||
      call.requestId !== row.request_id ||
      call.runId !== row.run_id
    ) {
      throw new StudyError('INTERNAL', { reason: 'invalid_model_usage' });
    }
    return call;
  }

  get(projectId: string, requestId: string, intent?: string): ModelUsageCallDto | null {
    const row = this.db
      .prepare('SELECT * FROM model_usage_calls WHERE project_id=? AND request_id=?')
      .get(projectId, requestId) as ModelUsageRow | undefined;
    if (!row) return null;
    const call = this.parseCall(row);
    if (intent !== undefined && call.intent !== intent)
      throw new StudyError('VERSION_CONFLICT', { reason: 'model_nonce_reused' });
    return call;
  }

  list(projectId: string): ModelUsageCallDto[] {
    const rows = this.db
      .prepare('SELECT * FROM model_usage_calls WHERE project_id=? ORDER BY rowid DESC')
      .all(projectId) as ModelUsageRow[];
    return rows.map((row) => this.parseCall(row));
  }

  /** 某个 run 的全部调用；报告与结算共用它，避免两处各写一遍筛选条件。 */
  listForRun(runId: string): ModelUsageCallDto[] {
    const rows = this.db
      .prepare('SELECT * FROM model_usage_calls WHERE run_id=? ORDER BY rowid')
      .all(runId) as ModelUsageRow[];
    return rows.map((row) => this.parseCall(row));
  }

  start(
    input: StartModelUsageCallInput,
    usage: { calls: number; tokens: number; activeElapsedMs?: number },
    limits: ModelUsageLimits,
  ): ModelUsageCallDto {
    return this.db.transaction(() => {
      if (!input.requestId.trim() || this.get(input.projectId, input.requestId))
        throw new StudyError('VERSION_CONFLICT', { reason: 'model_nonce_reused' });
      if (
        usage.calls + 1 > limits.maxCalls ||
        usage.tokens + input.reservedTokens > limits.maxTokens
      )
        throw new StudyError('BUDGET_EXCEEDED', { reason: 'model_reservation_exhausted' });
      if ((usage.activeElapsedMs ?? 0) >= limits.maxWallClockMs)
        throw new StudyError('BUDGET_EXCEEDED', { reason: 'shared_wall_clock' });
      const at = new Date().toISOString();
      const call = modelUsageCallSchema.parse({
        ...input,
        roleProfileId: input.roleProfileId ?? null,
        peerTurnIndex: input.peerTurnIndex ?? null,
        state: 'started',
        accountedTokens: null,
        providerTokens: null,
        returnedModel: null,
        elapsedMs: null,
        tokenMeasurement: 'unknown',
        cost: null,
        costMeasurement: 'unknown',
        createdAt: at,
        updatedAt: at,
        result: null,
      });
      this.db
        .prepare(
          'INSERT INTO model_usage_calls(project_id,request_id,run_id,call_json) VALUES(?,?,?,?)',
        )
        .run(input.projectId, input.requestId, input.runId, encodeJson(call));
      return call;
    });
  }

  settle(
    projectId: string,
    requestId: string,
    input: SettleModelUsageCallInput,
  ): ModelUsageCallDto {
    const old = this.get(projectId, requestId);
    if (old?.state !== 'started' || input.state === 'started')
      throw new StudyError('VERSION_CONFLICT', { reason: 'model_call_already_settled' });
    // 口径随结算一起定下：调用方不显式给出时，按当时能拿到的证据推导。
    const tokenMeasurement =
      input.tokenMeasurement ??
      measurementOf({
        state: input.state,
        accountedTokens: input.accountedTokens,
        providerTokens: input.providerTokens,
      });
    const call = modelUsageCallSchema.parse({
      ...old,
      ...input,
      tokenMeasurement,
      cost: input.cost ?? null,
      costMeasurement:
        input.costMeasurement ??
        (input.cost === null || input.cost === undefined ? 'unknown' : 'estimated'),
      updatedAt: new Date().toISOString(),
    });
    this.db
      .prepare('UPDATE model_usage_calls SET call_json=? WHERE project_id=? AND request_id=?')
      .run(encodeJson(call), projectId, requestId);
    return call;
  }

  saveResult(projectId: string, requestId: string, result: ModelUsageCallDto['result']): void {
    const old = this.get(projectId, requestId);
    if (!old || old.state === 'started' || old.result !== null)
      throw new StudyError('VERSION_CONFLICT', { reason: 'model_result_already_settled' });
    const call = modelUsageCallSchema.parse({ ...old, result });
    this.db
      .prepare('UPDATE model_usage_calls SET call_json=? WHERE project_id=? AND request_id=?')
      .run(encodeJson(call), projectId, requestId);
  }

  /**
   * 未结算与「用量未知」调用对预算的占用。
   *
   * 判定按 `tokenMeasurement` 走，和 `consumptionOf` 同源：
   * 只有 `unknown` 与仍在 `started` 的调用继续占额度。
   * 「未知」的调用必须继续占额度：钱可能已经花了，把它算成 0 会让界面显示
   * 一个不存在的大额剩余。
   */
  pendingUsage(runId: string, ownRequestId?: string): { calls: number; tokens: number } {
    const rows = this.db
      .prepare('SELECT * FROM model_usage_calls WHERE run_id=? AND request_id<>?')
      .all(runId, ownRequestId ?? '') as ModelUsageRow[];
    return rows.reduce(
      (sum, row) => {
        const call = this.parseCall(row);
        const bucket = consumptionOf(call);
        // 未结算的调用在 run 事件里还没有对应记录，所以 calls 也要在这里补上；
        // 已结算的调用已由 run 事件计数，这里只补它保留的额度。
        if (call.accountedTokens === null) sum.calls += 1;
        sum.tokens += bucket.reserved + bucket.unknown;
        return sum;
      },
      { calls: 0, tokens: 0 },
    );
  }

  /**
   * 共享预算报告（BUDGET-01）。
   *
   * 生成、教师、AI 同学、评分、归因、复习全部落在同一个 run 里，所以这里
   * 一次算清：总额度、按用途的明细、实际/估算/未知三档用量、执行墙钟与未结算清单。
   * 界面不需要自己加总，也就不会出现「两个页面显示不同剩余额度」。
   */
  report(
    runId: string,
    limits: ModelUsageLimits,
    calls = this.listForRun(runId),
  ): ModelUsageReportDto {
    const { total, byPurpose, unsettled, activeElapsedMs, consumedTokens } =
      summarizeModelUsage(calls);
    return modelUsageReportSchema.parse({
      runId,
      limits,
      total,
      remainingCalls: Math.max(0, limits.maxCalls - total.calls),
      remainingTokens: Math.max(0, limits.maxTokens - consumedTokens),
      activeElapsedMs,
      maxWallClockMs: limits.maxWallClockMs,
      wallClockExhausted: activeElapsedMs >= limits.maxWallClockMs,
      byPurpose,
      unsettled,
    });
  }
}

/** 费用口径辅助：没有价格依据时保持未知，不返回 0 元。 */
export const unknownCost = (): { cost: null; costMeasurement: ModelCostMeasurement } => ({
  cost: null,
  costMeasurement: 'unknown',
});
