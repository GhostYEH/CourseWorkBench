import { z } from 'zod';
import { projectScopeSchema } from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../lib/server/http';
import { assertScope } from '../../../../lib/server/service';
import { ensureFixedLesson } from '../../../../lib/server/classroom-service';

export const dynamic = 'force-dynamic';

const demoImportSchema = z.object({
  scope: projectScopeSchema,
  confirmDemoImport: z.literal(true),
});

/** Explicit consent to import an author-reviewed demo, not an application-user review. */
export const POST = route(async (request: Request) => {
  const input = await parseBody(request, demoImportSchema);
  const session = assertScope(input.scope);
  const lesson = ensureFixedLesson(session);
  return ok({ stageId: lesson.stageId, lessonId: lesson.lessonId });
});
