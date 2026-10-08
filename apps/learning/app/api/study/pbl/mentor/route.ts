import { NextResponse } from 'next/server';
import { StudyError, pblMentorCommandSchema } from '@sew/study-contracts';
import { fail, ok } from '../../../../../lib/server/http';
import { modelConnection } from '../../../../../lib/server/model-connection';
import { generatePblMentor } from '../../../../../lib/server/pbl-model';
import {
  RuntimeHttpError,
  readBoundedRuntimeJson,
  revalidateRuntimeScope,
  runtimeRequestScope,
} from '../../../../../lib/server/runtime-storage';

export const dynamic = 'force-dynamic';
export const POST = async (request: Request): Promise<NextResponse> => {
  let response: NextResponse;
  try {
    const { scope } = runtimeRequestScope(request);
    const checked = pblMentorCommandSchema.safeParse(
      await readBoundedRuntimeJson(request, scope, 64 * 1024),
    );
    if (!checked.success) throw new StudyError('INVALID_ARGUMENT');
    const session = revalidateRuntimeScope(scope);
    if (
      checked.data.scope.projectId !== scope.projectId ||
      checked.data.scope.generation !== scope.generation
    )
      throw new StudyError('PROJECT_GENERATION_STALE');
    response = ok(
      await generatePblMentor(
        {
          session,
          store: session.store,
          projectId: session.projectId,
          learnerUid: session.learnerUid,
          connection: modelConnection,
          revalidateScope: () => {
            revalidateRuntimeScope(scope);
          },
        },
        checked.data,
        request.signal,
      ),
    );
  } catch (error) {
    response =
      error instanceof RuntimeHttpError
        ? NextResponse.json(
            { ok: false, error: { code: error.code, message: error.message, pending: false } },
            { status: error.status },
          )
        : fail(error);
  }
  response.headers.set('cache-control', 'no-store');
  return response;
};
