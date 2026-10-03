import { route, ok } from '../../../../lib/server/http';
import { requireSession } from '../../../../lib/server/service';
import { buildWorkbenchState } from '../../../../lib/server/state';

export const dynamic = 'force-dynamic';

/** 工作台总览：项目信息、材料与知识计数、计划状态、准入摘要。 */
export const GET = route(() => {
  const session = requireSession();
  return ok(buildWorkbenchState(session));
});
