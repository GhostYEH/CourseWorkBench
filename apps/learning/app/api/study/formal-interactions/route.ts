import { NextResponse } from 'next/server';
import { z } from 'zod';
import { StudyError, formalInteractionCommandSchema } from '@sew/study-contracts';
import { fail, ok } from '../../../../lib/server/http';
import { commandFormalInteraction, loadFormalInteraction } from '../../../../lib/server/formal-interaction-service';
import { readFormalInteractionDefinitions } from '../../../../lib/server/formal-interaction-definition-store';
import { RuntimeHttpError, readBoundedRuntimeJson, revalidateRuntimeScope, runtimeRequestScope } from '../../../../lib/server/runtime-storage';

export const dynamic = 'force-dynamic';
const querySchema = z.union([
  z.object({ stageId: z.string().min(1).max(200), sceneId: z.string().min(1).max(200) }).strict(),
  z.object({ lessonId: z.string().min(1).max(200), lessonVersion: z.string().regex(/^[1-9]\d*$/).transform(Number).refine(Number.isSafeInteger) }).strict(),
]);
const handle = (handler: (request: Request) => Promise<NextResponse> | NextResponse) => async (request: Request): Promise<NextResponse> => {
  let response: NextResponse;
  try { response = await handler(request); } catch (caught) {
    response = caught instanceof RuntimeHttpError ? NextResponse.json({ ok: false, error: { code: caught.code, message: caught.message, pending: false } }, { status: caught.status }) : fail(caught);
  }
  response.headers.set('cache-control', 'no-store'); return response;
};
export const GET = handle((request) => {
  const { scope } = runtimeRequestScope(request);
  const url = new URL(request.url);
  const query = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success || [...url.searchParams.keys()].length !== 2) throw new StudyError('INVALID_ARGUMENT');
  const session = revalidateRuntimeScope(scope);
  return 'lessonId' in query.data
    ? ok(readFormalInteractionDefinitions(session, query.data.lessonId, query.data.lessonVersion))
    : ok(loadFormalInteraction(session, query.data.stageId, query.data.sceneId));
});
export const POST = handle(async (request) => {
  const { scope } = runtimeRequestScope(request);
  const parsed = formalInteractionCommandSchema.safeParse(await readBoundedRuntimeJson(request, scope, 32 * 1024));
  if (!parsed.success) throw new StudyError('INVALID_ARGUMENT');
  if (parsed.data.scope.projectId !== scope.projectId || parsed.data.scope.generation !== scope.generation) throw new StudyError('PROJECT_GENERATION_STALE');
  return ok(commandFormalInteraction(revalidateRuntimeScope(scope), parsed.data));
});
