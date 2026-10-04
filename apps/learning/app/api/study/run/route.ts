import { z } from 'zod';
import { projectScopeSchema, type RunSnapshotDto } from '@sew/study-contracts';
import { parseBody, route, ok } from '../../../../lib/server/http';
import { assertScope, requireSession } from '../../../../lib/server/service';

export const dynamic = 'force-dynamic';

const startSchema = z.object({ scope: projectScopeSchema, action: z.literal('start') });

/** 组装当前 run 的可见快照；事件按已提交序号读取。 */
const snapshotOf = (runId: string): RunSnapshotDto | null => {
  const session = requireSession();
  const run = session.store.getRun(runId);
  if (!run) return null;
  const events = session.store.listRunEvents(runId);
  return {
    runId: run.runId,
    state: run.state,
    frozen: run.frozen,
    lastSeq: events.length > 0 ? (events[events.length - 1]?.seq ?? 0) : 0,
  };
};

/**
 * 备考 run（PLAN-01 基础）。
 *
 * GET 读取最近一次 run 与已提交事件序号；POST 从已确认计划启动。
 * 启动按「项目 + 计划版本」去重：重复请求读回既有 run，不产生第二个 run。
 */
export const GET = route(() => {
  const session = requireSession();
  const latest = session.store.getLatestRun();
  return ok({ snapshot: latest ? snapshotOf(latest.runId) : null });
});

export const POST = route(async (request: Request) => {
  const body = await parseBody(request, startSchema);
  const session = assertScope(body.scope);
  const started = session.store.startPlanRun(session.projectId);
  return ok({
    snapshot: snapshotOf(started.run.runId),
    deduplicated: started.deduplicated,
  });
});
