import { NextResponse } from 'next/server';
import { z } from 'zod';
import { StudyError, interactionSubmitSchema } from '@sew/study-contracts';
import { fail, ok } from '../../../../lib/server/http';
import { loadInteraction, submitInteraction } from '../../../../lib/server/interaction-service';
import { RuntimeHttpError, readBoundedRuntimeJson, revalidateRuntimeScope, runtimeRequestScope } from '../../../../lib/server/runtime-storage';

export const dynamic = 'force-dynamic';
const querySchema = z.object({ stageId: z.string().min(1).max(200), sceneId: z.string().min(1).max(200) }).strict();
const handle = (handler: (request: Request) => Promise<NextResponse> | NextResponse) => async (request: Request): Promise<NextResponse> => {
  let response: NextResponse;
  try { response = await handler(request); } catch (caught) {
    response = caught instanceof RuntimeHttpError
      ? NextResponse.json({ ok: false, error: { code: caught.code, message: caught.message, pending: false } }, { status: caught.status })
      : fail(caught);
  }
  response.headers.set('cache-control', 'no-store');
  return response;
};
export const GET = handle((request) => {
  const { scope } = runtimeRequestScope(request);
  const url = new URL(request.url);
  const query = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success || [...url.searchParams.keys()].length !== 2) throw new StudyError('INVALID_ARGUMENT');
  return ok(loadInteraction(revalidateRuntimeScope(scope), query.data.stageId, query.data.sceneId));
});
export const POST = handle(async (request) => {
  const { scope } = runtimeRequestScope(request);
  const input = interactionSubmitSchema.safeParse(await readBoundedRuntimeJson(request, scope, 16 * 1024));
  if (!input.success) throw new StudyError('INVALID_ARGUMENT');
  if (input.data.scope.projectId !== scope.projectId || input.data.scope.generation !== scope.generation) throw new StudyError('PROJECT_GENERATION_STALE');
  return ok(submitInteraction(revalidateRuntimeScope(scope), input.data));
});
