import { materialExamVerificationSchema } from '@sew/study-contracts';
import { parseBody, route, ok } from '../../../../../../lib/server/http';
import { assertScope } from '../../../../../../lib/server/service';

export const dynamic = 'force-dynamic';

/**
 * 人工核实「该材料版本可作为考试真题来源」。
 *
 * 这是服务端权威事实，只经界面人工审核动作写入，不注册进任何 agent 工具列表；
 * 题目身份由服务端按 (materialId, revision) 从该记录派生，请求方不能自报。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, materialExamVerificationSchema);
  const session = assertScope(body.scope);

  const result = session.store.verifyMaterialAsExam({
    materialId: body.materialId,
    revision: body.revision,
    note: body.note,
  });

  return ok(result);
});
