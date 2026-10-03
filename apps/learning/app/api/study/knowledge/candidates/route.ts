import { z } from 'zod';
import { REVIEW_DECISION } from '@sew/study-contracts';
import { parseQuery, route, ok } from '../../../../../lib/server/http';
import { requireSession } from '../../../../../lib/server/service';
import { toProposalDto } from '../../../../../lib/server/dto';

export const dynamic = 'force-dynamic';

const querySchema = z.object({ status: z.enum(REVIEW_DECISION).or(z.enum(['pending'])).optional() });

/** 待审核候选列表。候选计数不算知识覆盖数。 */
export const GET = route((request: Request) => {
  const session = requireSession();
  const query = parseQuery(request, querySchema);
  const allProposals = session.store.listProposals();
  const proposals = (query.status
    ? allProposals.filter((proposal) => proposal.status === query.status)
    : allProposals).map(toProposalDto);
  return ok({
    proposals,
    pendingCount: allProposals.filter((p) => p.status === 'pending' || p.status === 'needs_material').length,
  });
});
