import { courseCompletionQuerySchema } from '@sew/study-contracts';
import { ok, parseQuery, route } from '../../../../../lib/server/http';
import { assertScope, requireSession } from '../../../../../lib/server/service';
import { readCourseCompletion } from '../../../../../lib/server/course-completion-service';

export const dynamic = 'force-dynamic';

/**
 * 课程完成页数据（OMA-033）：只读。
 *
 * 完成状态只依据本人真实提交：未作答不自动标完成，AI/模拟分区不计入。查询参数携带 scope，
 * 由 `assertScope` 复验打开代次，避免旧页面读到重新打开的项目。
 */
export const GET = route((request: Request) => {
  const session = requireSession();
  const query = parseQuery(request, courseCompletionQuerySchema);
  assertScope({ projectId: query.projectId, generation: query.generation });
  return ok(
    readCourseCompletion(session, { lessonId: query.lessonId, version: query.version }),
    { headers: { 'cache-control': 'no-store' } },
  );
});
