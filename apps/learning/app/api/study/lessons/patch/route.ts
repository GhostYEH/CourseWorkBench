import { scenePlanPatchProposeSchema } from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../../lib/server/http';
import { assertScope } from '../../../../../lib/server/service';
import { modelConnection } from '../../../../../lib/server/model-connection';
import { generateScenePlanPatch } from '../../../../../lib/server/scene-plan-patch-model';

export const dynamic = 'force-dynamic';

/**
 * 受限 AI 场景计划补丁候选生成（LESSON-02 / OMA-023）。
 *
 * 复用与课程草案、陈述改写、完整课件相同的 guard：来源、run、审核、预算与取消都先判完，
 * 不通过时不发出 provider 请求。返回的补丁只是待核候选，须逐项人工审核后才会写进场景计划。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, scenePlanPatchProposeSchema);
  const session = assertScope(body.scope);
  const result = await generateScenePlanPatch(
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
