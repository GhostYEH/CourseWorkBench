import { mediaTaskReviewCommandSchema } from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../../lib/server/http';
import { assertScope } from '../../../../../lib/server/service';
import { reviewMediaTask } from '../../../../../lib/server/media-service';

export const dynamic = 'force-dynamic';
export const POST = route(async (request: Request) => {
  const input = await parseBody(request, mediaTaskReviewCommandSchema);
  return ok(
    { task: reviewMediaTask(assertScope(input.scope), input) },
    { headers: { 'cache-control': 'no-store' } },
  );
});
