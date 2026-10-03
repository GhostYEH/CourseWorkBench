import { knowledgeProposeSchema } from '@sew/study-contracts';
import { parseBody, route, ok } from '../../../../../lib/server/http';
import { assertScope } from '../../../../../lib/server/service';
import { toProposalDto } from '../../../../../lib/server/dto';

export const dynamic = 'force-dynamic';

/**
 * 提交知识点候选。AI 与用户共用该入口，但都只能写候选。
 * 机械检查结果随候选一起返回；不通过时仍保存候选并显示具体缺口。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, knowledgeProposeSchema);
  const session = assertScope(body.scope);

  const proposal = session.store.createProposal({
    projectId: session.projectId,
    name: body.name,
    concept: body.concept,
    conditions: body.conditions,
    scopeStatus: body.scopeStatus,
    prerequisites: body.prerequisites,
    evidence: body.evidence,
    acceptance: body.acceptance,
    priority: body.priority,
    proposedBy: body.proposedBy,
  });

  return ok({ proposal: toProposalDto(proposal) });
});
