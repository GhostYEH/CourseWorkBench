import { parseBody, route, ok } from '../../../../lib/server/http';
import { requireSession } from '../../../../lib/server/service';
import {
  executeLessonCommand,
  lessonCommandSchema,
  readLessonCatalog,
} from '../../../../lib/server/lesson-service';

export const dynamic = 'force-dynamic';
export const GET = route(() => ok(readLessonCatalog(requireSession())));
export const POST = route(async (request: Request) =>
  ok(executeLessonCommand(await parseBody(request, lessonCommandSchema), request.signal)),
);
