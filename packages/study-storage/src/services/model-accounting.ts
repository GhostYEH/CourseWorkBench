import type { ModelUsageCallDto } from '@sew/study-contracts';
import type { AttemptGradingRepository } from '../repositories/attempt-grading';
import type { RunEventRow } from '../repositories/runs';

interface AccountingFacts {
  calls: readonly ModelUsageCallDto[];
  grading: ReturnType<AttemptGradingRepository['generationAccounting']>['rows'];
  events: readonly RunEventRow[];
  projectId: string;
}

/** Historical compatibility is read-only. Typed request/source identifiers take precedence over legacy time-window matching. */
export const normalizeSharedModelCalls = (facts: AccountingFacts, runId: string,
  ownGradingRequestId?: string, ownModelRequestId?: string): ModelUsageCallDto[] => {
    const calls = [...facts.calls];
    const grading = facts.grading;
    const events = facts.events.filter(event => event.payload.type === 'model_call');
    const consumed = new Set<number>();
    const takeEvent = (purpose: ModelUsageCallDto['purpose'], tokens: number | null, requestId: string, createdAt: string, updatedAt: string, source: 'model' | 'grading') => {
      // Newer ledgers correspond to newer events; pre-ledger historical events stay unmatched.
      let index = events.findLastIndex((event, i) => !consumed.has(i) && event.payload.type === 'model_call' && event.payload.requestId === requestId && event.payload.purpose === purpose
        && (event.payload.usageSource === source || (event.payload.usageSource === undefined && event.at >= createdAt && event.at <= updatedAt
          && (tokens === null || event.payload.totalTokens === tokens))));
      if (index < 0) index = events.findLastIndex((event, i) => !consumed.has(i) && event.payload.type === 'model_call'
        && event.payload.requestId === undefined && (event.payload.usageSource === undefined || event.payload.usageSource === source) && event.at >= createdAt && event.at <= updatedAt && event.payload.purpose === purpose && (tokens === null || event.payload.totalTokens === tokens));
      if (index < 0) return null;
      consumed.add(index);
      const payload = events[index]!.payload;
      return payload.type === 'model_call' ? payload : null;
    };
    const omitted = new Set<ModelUsageCallDto>();
    for (const call of calls) if (call.requestId === ownModelRequestId) omitted.add(call);
    for (const call of [...calls].reverse()) {
      if (call.state === 'started') continue;
      const event = takeEvent(call.purpose, call.accountedTokens, call.requestId, call.createdAt, call.updatedAt, 'model');
      if (!event && call.tokenMeasurement === 'actual' && call.accountedTokens === 0 && call.providerTokens === 0) omitted.add(call);
    }
    const projectId = facts.projectId;
    for (const row of [...grading].reverse()) {
      const event = row.state !== 'started'
        ? takeEvent('attempt_grading', row.accountedTokens, row.requestId, row.createdAt, row.updatedAt, 'grading') : null;
      if (row.requestId === ownGradingRequestId) continue;
      if (!event && row.state !== 'started' && row.tokenMeasurement === 'actual' && row.accountedTokens === 0) continue;
      const legacyTokens = row.tokenMeasurement === null && event && event.totalTokens > 0 ? event.totalTokens : null;
      calls.push({ projectId: row.projectId, requestId: row.requestId, runId, purpose: 'attempt_grading', sessionId: null, roundIndex: null,
        roleProfileId: null, peerTurnIndex: null, state: row.state, intent: '0'.repeat(64), reservedTokens: Math.max(1, row.reservedTokens),
        accountedTokens: row.state === 'started' ? null : row.accountedTokens ?? legacyTokens ?? 0,
        tokenMeasurement: (row.tokenMeasurement ?? (legacyTokens !== null ? 'estimated' : 'unknown')) as ModelUsageCallDto['tokenMeasurement'],
        providerTokens: row.tokenMeasurement === 'actual' ? row.accountedTokens : null, provider: null, requestedModel: null, returnedModel: null,
        elapsedMs: row.elapsedMs, cost: null, costMeasurement: 'unknown', createdAt: row.createdAt, updatedAt: row.updatedAt, result: null });
    }
    events.forEach((event, index) => {
      if (consumed.has(index) || event.payload.type !== 'model_call') return;
      calls.push({ projectId, requestId: `historical-event-${runId}-${event.seq}`, runId, purpose: event.payload.purpose,
        sessionId: null, roundIndex: null, roleProfileId: null, peerTurnIndex: null, state: event.payload.ok ? 'completed' : 'failed',
        intent: '0'.repeat(64), reservedTokens: Math.max(1, event.payload.totalTokens), accountedTokens: event.payload.totalTokens,
        tokenMeasurement: event.payload.totalTokens > 0 ? 'estimated' : 'unknown', providerTokens: null, provider: null,
        requestedModel: null, returnedModel: null, elapsedMs: null, cost: null, costMeasurement: 'unknown',
        createdAt: event.at, updatedAt: event.at, result: null });
    });
    return calls.filter(call => !omitted.has(call));

};
