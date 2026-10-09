import { generationPipelineCommandSchema } from '../../../../../../../packages/study-contracts/src/generation-pipeline';
import { ok, parseBody, route } from '../../../../../lib/server/http';
import { assertScope } from '../../../../../lib/server/service';
import { modelConnection } from '../../../../../lib/server/model-connection';
import { runLessonGenerationPipelineCommand } from '../../../../../lib/server/lesson-generation-pipeline';

export const dynamic = 'force-dynamic';

/** One persisted stage per explicit command; reads never trigger a model call. */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, generationPipelineCommandSchema);
  const session = assertScope(body.scope);
  const result = await runLessonGenerationPipelineCommand(
    {
      store: session.store,
      projectId: session.projectId,
      learnerUid: session.learnerUid,
      connection: modelConnection,
      revalidateScope: () => {
        assertScope(body.scope);
      },
    },
    body,
    request.signal,
  );
  return ok(result, { headers: { 'cache-control': 'no-store' } });
});
