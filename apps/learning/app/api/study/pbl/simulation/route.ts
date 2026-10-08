import { NextResponse } from 'next/server';
import { z } from 'zod';
import { StudyError, pblBindingSchema, pblSimulationStepSchemaChecked } from '@sew/study-contracts';
import { fail, ok } from '../../../../../lib/server/http';
import { simulatePbl } from '../../../../../lib/server/pbl-service';
import {
  readBoundedRuntimeJson,
  revalidateRuntimeScope,
  runtimeRequestScope,
  RuntimeHttpError,
} from '../../../../../lib/server/runtime-storage';

export const dynamic = 'force-dynamic';
const bodySchema = z
  .object({
    scope: z
      .object({ projectId: z.string().min(1).max(200), generation: z.number().int().positive() })
      .strict(),
    binding: pblBindingSchema,
    steps: z.array(pblSimulationStepSchemaChecked).max(50),
    maxSteps: z.number().int().positive().max(50),
  })
  .strict();

export const POST = async (request: Request): Promise<NextResponse> => {
  try {
    const { scope } = runtimeRequestScope(request);
    const raw = await readBoundedRuntimeJson(request, scope, 256 * 1024);
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) throw new StudyError('INVALID_ARGUMENT');
    if (
      parsed.data.scope.projectId !== scope.projectId ||
      parsed.data.scope.generation !== scope.generation
    )
      throw new StudyError('PROJECT_GENERATION_STALE');
    const response = ok(simulatePbl(revalidateRuntimeScope(scope), parsed.data));
    response.headers.set('cache-control', 'no-store');
    return response;
  } catch (caught) {
    if (caught instanceof RuntimeHttpError) {
      return NextResponse.json(
        { ok: false, error: { code: caught.code, message: caught.message, pending: false } },
        {
          status: caught.status,
          headers: { 'cache-control': 'no-store' },
        },
      );
    }
    const response = fail(caught);
    response.headers.set('cache-control', 'no-store');
    return response;
  }
};
