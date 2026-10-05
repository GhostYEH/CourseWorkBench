import { coursewareProposeSchema } from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../../lib/server/http';
import { assertScope } from '../../../../../lib/server/service';
import { modelConnection } from '../../../../../lib/server/model-connection';
import { generateCourseware } from '../../../../../lib/server/lesson-courseware-model';

export const dynamic = 'force-dynamic';

/**
 * 完整课件计划候选生成（LESSON-02 / OMA-006）。
 *
 * 复用与课程草案、陈述改写相同的 guard：来源、run、审核、预算与取消都先判完，不通过时
 * 不发出 provider 请求。返回的场景只是待核候选，须人工通过才会写成该草案版本的场景计划。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, coursewareProposeSchema);
  const session = assertScope(body.scope);
  const result = await generateCourseware(
    {
      store: session.store,
      projectId: session.projectId,
      learnerUid: session.learnerUid,
      connection: modelConnection,
      revalidateScope: () => {
        assertScope(body.scope);
      },
    },
    body,
    request.signal,
  );
  return ok(result, { headers: { 'cache-control': 'no-store' } });
});
