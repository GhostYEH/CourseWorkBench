import {
  MODEL_USAGE_PURPOSE, type ModelUsageBreakdownDto, type ModelUsageCallDto, type ModelUsagePurpose,
  type ModelUsageReportDto, type ModelUsageSummaryDto,
} from '@sew/study-contracts';

const emptySummary = (): ModelUsageSummaryDto => ({
  calls: 0, actualTokens: 0, estimatedTokens: 0, unknownTokens: 0, reservedTokens: 0,
  elapsedMs: 0, actualCost: null, estimatedCost: null, unknownCostCalls: 0,
});

/**
 * 一笔调用该记进哪个 token 桶。
 *
 * 这是整个预算口径的唯一权威实现，必须与 `pendingUsage` 和 `StudyStore.modelCallUsage`
 * 给出同一个总数，否则「界面显示的剩余额度」会和 guard 实际判定的额度不一致。
 * 三个桶的规则（按 `tokenMeasurement` 判，不看 `providerTokens` 是否为空）：
 * - `actual`    provider 报了计数 → 记实际，预占全额释放；
 * - `estimated` 只有本地计数 → 记估算，**差额释放**（我们确实有依据，不该按未知扣着）；
 * - `unknown`   发出去了但拿不到任何依据 → 整笔预占记未知，绝不按 0 计；
 * - 仍未结算（`accountedTokens === null`）→ 整笔记预占。
 */
export const consumptionOf = (call: ModelUsageCallDto): { actual: number; estimated: number; unknown: number; reserved: number } => {
  if (call.accountedTokens === null) {
    return { actual: 0, estimated: 0, unknown: 0, reserved: call.reservedTokens };
  }
  if (call.tokenMeasurement === 'actual') {
    return { actual: call.accountedTokens, estimated: 0, unknown: 0, reserved: 0 };
  }
  if (call.tokenMeasurement === 'estimated') {
    return { actual: 0, estimated: call.accountedTokens, unknown: 0, reserved: 0 };
  }
  return { actual: 0, estimated: 0, unknown: call.reservedTokens, reserved: 0 };
};


/** Reporting and admission use exactly the same pure accounting summary. */
export const summarizeModelUsage = (calls: readonly ModelUsageCallDto[]) => {
    const total = emptySummary();
    const byPurpose = new Map<ModelUsagePurpose, ModelUsageSummaryDto>();
    const unsettled: ModelUsageReportDto['unsettled'] = [];
    let activeElapsedMs = 0;

    for (const call of calls) {
      const purposeSummary = byPurpose.get(call.purpose) ?? emptySummary();
      const bucket = consumptionOf(call);
      for (const summary of [total, purposeSummary]) {
        summary.calls += 1;
        summary.actualTokens += bucket.actual;
        summary.estimatedTokens += bucket.estimated;
        // 服务商没给计数又无法估算时，整笔预占都记进「未知」——
        // 这样未知既不会被算成 0，也不会从剩余额度里消失。
        summary.unknownTokens += bucket.unknown;
        summary.reservedTokens += bucket.reserved;
        summary.elapsedMs += call.elapsedMs ?? 0;
        if (call.costMeasurement === 'unknown') summary.unknownCostCalls += 1;
        else if (call.costMeasurement === 'actual' && call.cost !== null) summary.actualCost = (summary.actualCost ?? 0) + call.cost;
        else if (call.costMeasurement === 'estimated' && call.cost !== null) summary.estimatedCost = (summary.estimatedCost ?? 0) + call.cost;
      }
      activeElapsedMs += call.elapsedMs ?? 0;
      if (call.state === 'started') unsettled.push({
        requestId: call.requestId, purpose: call.purpose, reservedTokens: call.reservedTokens, createdAt: call.createdAt,
      });
      byPurpose.set(call.purpose, purposeSummary);
    }

    // 消耗口径与 `store.modelCallUsage` 逐项对齐（含 providerTokens 为空时保留的差额预占），
    // 否则界面显示的剩余额度会和 guard 实际用的额度不一致。
    const consumedTokens = total.actualTokens + total.estimatedTokens + total.unknownTokens + total.reservedTokens;
    const byPurposeList: ModelUsageBreakdownDto[] = MODEL_USAGE_PURPOSE
      .filter((purpose) => byPurpose.has(purpose))
      .map((purpose) => ({ purpose, summary: byPurpose.get(purpose)! }));


  return { total, byPurpose: byPurposeList, unsettled, activeElapsedMs, consumedTokens };
};
