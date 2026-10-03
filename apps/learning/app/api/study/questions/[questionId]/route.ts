import { StudyError, questionDetailQuerySchema } from '@sew/study-contracts';
import { parseQuery, route, ok } from '../../../../../lib/server/http';
import { requireSession } from '../../../../../lib/server/service';
import { toQuestionDetailDto, toQuestionListItemDto } from '../../../../../lib/server/dto';

export const dynamic = 'force-dynamic';

/**
 * 题目详情。默认只返回列表项字段；`includeAnswer=true` 才返回标准答案与解析，
 * 需要答案的入口必须显式声明。
 */
export const GET = route(
  async (request: Request, context: { params: Promise<{ questionId: string }> }) => {
    const session = requireSession();
    const { questionId } = await context.params;
    const query = parseQuery(request, questionDetailQuerySchema);

    const question = session.store.getQuestion(questionId);
    if (!question) throw new StudyError('NOT_FOUND', { questionId });

    return ok({
      question: query.includeAnswer ? toQuestionDetailDto(question) : toQuestionListItemDto(question),
    });
  },
);
