import { NextResponse } from 'next/server';
import { z } from 'zod';
import { StudyError, pblCommandSchema } from '@sew/study-contracts';
import { fail, ok } from '../../../../lib/server/http';
import { commandPblProject, loadPblProject } from '../../../../lib/server/pbl-service';
import { readPblDefinition } from '../../../../lib/server/pbl-definition-store';
import {
  readBoundedRuntimeJson,
  revalidateRuntimeScope,
  runtimeRequestScope,
  RuntimeHttpError,
} from '../../../../lib/server/runtime-storage';

export const dynamic = 'force-dynamic';
const querySchema = z.union([
  z
    .object({
      lessonId: z.string().min(1).max(200),
      lessonVersion: z
        .string()
        .regex(/^[1-9]\d*$/)
        .transform(Number)
        .refine(Number.isSafeInteger),
    })
    .strict(),
  z
    .object({ stageId: z.string().min(1).max(200), definitionId: z.string().min(1).max(200) })
    .strict(),
]);

const handle =
  (handler: (request: Request) => Promise<NextResponse> | NextResponse) =>
  async (request: Request): Promise<NextResponse> => {
    let response: NextResponse;
    try {
      response = await handler(request);
    } catch (caught) {
      response =
        caught instanceof RuntimeHttpError
          ? NextResponse.json(
              { ok: false, error: { code: caught.code, message: caught.message, pending: false } },
              { status: caught.status },
            )
          : fail(caught);
    }
    response.headers.set('cache-control', 'no-store');
    return response;
  };

export const GET = handle((request) => {
  const { scope } = runtimeRequestScope(request);
  const url = new URL(request.url);
  const query = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success || [...url.searchParams.keys()].length !== 2)
    throw new StudyError('INVALID_ARGUMENT');
  const session = revalidateRuntimeScope(scope);
  return 'lessonId' in query.data
    ? ok(readPblDefinition(session, query.data.lessonId, query.data.lessonVersion))
    : ok(loadPblProject(session, query.data.stageId, query.data.definitionId));
});

export const POST = handle(async (request) => {
  const { scope } = runtimeRequestScope(request);
  const parsed = pblCommandSchema.safeParse(
    await readBoundedRuntimeJson(request, scope, 256 * 1024),
  );
  if (!parsed.success) throw new StudyError('INVALID_ARGUMENT');
  if (
    parsed.data.scope.projectId !== scope.projectId ||
    parsed.data.scope.generation !== scope.generation
  )
    throw new StudyError('PROJECT_GENERATION_STALE');
  return ok(commandPblProject(revalidateRuntimeScope(scope), parsed.data));
});
