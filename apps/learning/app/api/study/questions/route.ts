import { questionCreateSchema } from '@sew/study-contracts';
import { parseBody, route, ok } from '../../../../lib/server/http';
import { assertScope, requireSession } from '../../../../lib/server/service';
import { toQuestionDetailDto, toQuestionListItemDto } from '../../../../lib/server/dto';

export const dynamic = 'force-dynamic';

/**
 * 题目列表：按使用场景最小化字段，**不返回**标准答案与解析。
 * 需要答案的流程走 `/api/study/questions/[questionId]?includeAnswer=true`。
 */
export const GET = route(() => {
  const session = requireSession();
  return ok({ questions: session.store.listQuestions().map(toQuestionListItemDto) });
});

/**
 * 创建题目。请求方声明的身份只是请求，服务端按可信创建/导入记录裁定：
 * AI 新编题自称真题时被降级并计入伪装统计，但合法的新编身份仍然可用。
 * 创建是授权写入路径，响应可携带完整题目详情。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, questionCreateSchema);
  const session = assertScope(body.scope);

  const result = session.store.createQuestion({
    stem: body.stem,
    answer: body.answer,
    solution: body.solution,
    knowledgeIds: body.knowledgeIds,
    requestedOrigin: body.requestedOrigin,
    originRecord: body.originRecord,
  });

  return ok({ ...result, question: toQuestionDetailDto(result.question) });
});
