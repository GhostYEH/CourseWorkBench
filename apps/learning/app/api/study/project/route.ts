import { projectSettingsPatchSchema } from '@sew/study-contracts';
import { parseBody, route, ok } from '../../../../lib/server/http';
import { requireSession, updateProjectSettings } from '../../../../lib/server/service';
import { buildWorkbenchState } from '../../../../lib/server/state';

export const dynamic = 'force-dynamic';

/** 科目设置：目标、时间与学习模式属于项目配置。 */
export const PATCH = route(async (request: Request) => {
  const { scope, ...patch } = await parseBody(request, projectSettingsPatchSchema);
  updateProjectSettings(scope, patch);
  return ok(buildWorkbenchState(requireSession()));
});
