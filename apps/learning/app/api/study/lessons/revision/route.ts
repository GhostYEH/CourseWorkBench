import { statementRevisionProposeSchema } from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../../lib/server/http';
import { assertScope } from '../../../../../lib/server/service';
import { modelConnection } from '../../../../../lib/server/model-connection';
import { generateStatementRevision } from '../../../../../lib/server/lesson-revision-model';

export const dynamic = 'force-dynamic';

/**
 * 陈述正文改写候选生成（LESSON-02）。
 *
 * 复用与课程草案生成相同的 guard：来源、run、审核、预算与取消都先判完，不通过时
 * 不发出 provider 请求。返回的正文只是待核候选，须人工通过才会派生新草案版本。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, statementRevisionProposeSchema);
  const session = assertScope(body.scope);
  const result = await generateStatementRevision(
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
