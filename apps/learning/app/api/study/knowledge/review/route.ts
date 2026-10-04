import { reviewApplySchema } from '@sew/study-contracts';
import { parseBody, route, ok } from '../../../../../lib/server/http';
import { assertScope } from '../../../../../lib/server/service';
import { toKnowledgePointDto, toProposalDto } from '../../../../../lib/server/dto';

export const dynamic = 'force-dynamic';

/**
 * 人工审核入口。只通过经验证的界面操作进入，不注册进备考或课堂 agent 工具列表。
 * 提交时重新复验机械检查与版本，人工按钮不能绕过缺失来源。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, reviewApplySchema);
  const session = assertScope(body.scope);

  const outcome = session.store.applyReview({
    proposalId: body.proposalId,
    decision: body.decision,
    expectedRevision: body.expectedRevision,
    semanticReviewed: body.semanticReviewed,
    note: body.note,
    // 考纲映射由人工在审核时确认；条目或要素不存在时整笔审核被拒绝，不写部分结果。
    syllabus: body.syllabus,
  });

  // 审核结果同样经 DTO 边界输出：不暴露 KnowledgeRow 的 originProposalId 等内部字段。
  return ok({
    proposal: toProposalDto(outcome.proposal),
    knowledgePoint: outcome.knowledgePoint ? toKnowledgePointDto(outcome.knowledgePoint) : null,
    requiresSemanticReview: outcome.requiresSemanticReview,
  });
});
