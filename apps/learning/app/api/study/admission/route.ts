import { admissionCheckSchema } from '@sew/study-contracts';
import { parseBody, route, ok } from '../../../../lib/server/http';
import { assertScope } from '../../../../lib/server/service';

export const dynamic = 'force-dynamic';

/**
 * 生成准入预检：所有入口（备考生成、教师发言、白板、互动、导入）共用同一实现。
 * 无来源或未核实的知识点在这里被阻断，任务不会调用模型。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, admissionCheckSchema);
  const session = assertScope(body.scope);
  const result = session.store.checkAdmission(body.knowledgeIds);
  return ok(result);
});
