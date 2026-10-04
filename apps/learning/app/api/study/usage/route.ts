import { z } from 'zod';
import { StudyError, modelUsageReportSchema } from '@sew/study-contracts';
import { ok, route } from '../../../../lib/server/http';
import { assertScope } from '../../../../lib/server/service';
import { DEFAULT_MODEL_CALL_LIMITS } from '../../../../lib/server/model-call';

export const dynamic = 'force-dynamic';
const querySchema = z.object({ projectId: z.string().min(1), generation: z.coerce.number().int().positive() }).strict();

/**
 * 共享预算报告（BUDGET-01）。
 *
 * 生成、课堂教师、AI 同学、模型评分、错因归因与复习共用同一个 run 的额度，
 * 所以这里一次返回：总额度、按用途明细、实际/估算/未知三档用量、执行墙钟
 * 与尚未结算的调用清单。费用没有价格依据时保持未知，不显示为 0 元。
 */
export const GET = route((request: Request) => {
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) throw new StudyError('INVALID_ARGUMENT');
  const session = assertScope(query.data);
  const run = session.store.getLatestRun();
  const limits = DEFAULT_MODEL_CALL_LIMITS;
  return ok({
    calls: run ? session.store.sharedModelUsageCalls(run.runId) : session.store.listModelUsageCalls(session.projectId),
    // 无 run 时同样给出 activeElapsedMs，界面不必对两种形状分别兜底。
    usage: run ? session.store.modelCallUsage(run.runId) : { calls: 0, tokens: 0, activeElapsedMs: 0 },
    report: run ? modelUsageReportSchema.parse(session.store.modelUsageReport(run.runId, limits)) : null,
    limits,
    // 费用口径：本项目未维护价目表，因此一律未知，界面必须照实显示。
    costBasis: 'unknown' as const,
    // 旧字段保留：既有界面与回归依赖它，含义不变（无价格依据时为 null）。
    estimatedCost: null,
  }, { headers: { 'cache-control': 'no-store' } });
});
