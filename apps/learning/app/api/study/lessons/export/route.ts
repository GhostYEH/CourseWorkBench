import { lessonExportSchema } from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../../lib/server/http';
import { assertScope } from '../../../../../lib/server/service';
import { exportLesson } from '../../../../../lib/server/lesson-export-service';

export const dynamic = 'force-dynamic';

/**
 * 课件自包含导出（OMA-068/069/070/072）。
 *
 * 只导出当前已审核发布、且通过上课入口统一复核的课程版本；产物写入项目内 `exports/`，
 * 返回包内条目摘要、整包 sha256 与未内联资源缺口。未发布/未审核/来源失效/审核后计划已改
 * 一律整节阻断，不产出任何文件。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, lessonExportSchema);
  const session = assertScope(body.scope);
  return ok(
    { export: exportLesson(session, body.lessonId, body.version) },
    { headers: { 'cache-control': 'no-store' } },
  );
});
