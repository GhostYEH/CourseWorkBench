import { modelGenerationInputSchema } from '@sew/study-contracts';
import { parseBody, route, ok } from '../../../../lib/server/http';
import { assertScope } from '../../../../lib/server/service';
import { modelConnection } from '../../../../lib/server/model-connection';
import { generateGuarded } from '../../../../lib/server/model-call';

export const dynamic = 'force-dynamic';

/**
 * 受 guard 约束的模型草案生成（M2-A）。
 *
 * 请求只能给出用途与已冻结的证据包编号：陈述文本、来源与准入结论都由服务端读取，
 * 提示词不接受渲染层拼接。返回的正文只是草案，写入 run 事件供展示，不进入权威记录。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, modelGenerationInputSchema);
  const session = assertScope(body.scope);
  const result = await generateGuarded(
    { store: session.store, projectId: session.projectId, connection: modelConnection },
    body,
    request.signal,
  );
  return ok(result, { headers: { 'cache-control': 'no-store' } });
});
