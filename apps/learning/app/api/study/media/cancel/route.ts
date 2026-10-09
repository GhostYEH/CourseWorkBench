import { mediaTaskCancelCommandSchema } from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../../lib/server/http';
import { assertScope } from '../../../../../lib/server/service';
import { cancelMediaTask } from '../../../../../lib/server/media-service';

export const dynamic = 'force-dynamic';
export const POST = route(async (request: Request) => {
  const input = await parseBody(request, mediaTaskCancelCommandSchema);
  return ok(
    { task: cancelMediaTask(assertScope(input.scope), input.taskId) },
    { headers: { 'cache-control': 'no-store' } },
  );
});
