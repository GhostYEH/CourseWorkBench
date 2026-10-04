import { z } from 'zod';
import { feedbackReviewCommandSchema } from '@sew/study-contracts';
import { ok, parseBody, parseQuery, route } from '../../../../lib/server/http';
import { assertScope } from '../../../../lib/server/service';

export const dynamic = 'force-dynamic';
const querySchema = z.object({ projectId: z.string().min(1), generation: z.coerce.number().int().nonnegative(), attemptId: z.string().min(1).optional() }).strict();
const uncached = { headers: { 'cache-control': 'no-store' } };
export const GET = route((request: Request) => {
  const query = parseQuery(request, querySchema);
  const session = assertScope(query);
  return ok(query.attemptId ? session.store.getFeedbackContext(session.projectId, session.learnerUid, query.attemptId)
    : session.store.listReviewTasks(session.projectId, session.learnerUid), uncached);
});
export const POST = route(async (request: Request) => {
  const command = await parseBody(request, feedbackReviewCommandSchema);
  const session = assertScope(command.scope);
  return ok(session.store.feedbackCommand(session.projectId, session.learnerUid, command), uncached);
});
