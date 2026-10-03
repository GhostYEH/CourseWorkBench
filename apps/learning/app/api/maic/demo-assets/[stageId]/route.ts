import { StudyError } from '@sew/study-contracts';
import { ok, route } from '../../../../../lib/server/http';
import { assertScope, requireSession } from '../../../../../lib/server/service';
import { getVerifiedDemoAssetBindings } from '../../../../../lib/server/classroom-demo-assets';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: Request, context: { params: Promise<{ stageId: string }> }) => {
  const projectId = request.headers.get('x-sew-project-id');
  const generationValue = request.headers.get('x-sew-generation');
  const generation = generationValue === null ? Number.NaN : Number(generationValue);
  if (!projectId || !Number.isSafeInteger(generation) || generation < 1) {
    requireSession();
    throw new StudyError('INVALID_ARGUMENT', {
      reason: 'missing_classroom_project_scope',
      requiredHeaders: ['x-sew-project-id', 'x-sew-generation'],
    });
  }
  assertScope({ projectId, generation });
  const { stageId } = await context.params;
  const session = assertScope({ projectId, generation });
  const assets = getVerifiedDemoAssetBindings(session, stageId);
  return ok({ stageId, assets });
});
