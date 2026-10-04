import { feedbackModelInputSchema } from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../../lib/server/http';
import { assertScope } from '../../../../../lib/server/service';
import { modelConnection } from '../../../../../lib/server/model-connection';
import { generateFeedbackCandidate } from '../../../../../lib/server/feedback-model';

export const dynamic = 'force-dynamic';
export const POST = route(async (request: Request) => {
  const input = await parseBody(request, feedbackModelInputSchema);
  const session = assertScope(input.scope);
  const result = await generateFeedbackCandidate({ store: session.store, projectId: session.projectId,
    learnerUid: session.learnerUid, connection: modelConnection, revalidateScope: () => { assertScope(input.scope); } }, input, request.signal);
  return ok(result, { headers: { 'cache-control': 'no-store' } });
});
