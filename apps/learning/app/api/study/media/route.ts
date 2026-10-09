import { mediaGenerationCommandSchema, projectScopeSchema, StudyError } from '@sew/study-contracts';
import { ok, route } from '../../../../lib/server/http';
import { readBoundedJson } from '../../../../lib/server/bounded-json';
import { assertScope } from '../../../../lib/server/service';
import { generateMediaTask, readMediaTasks } from '../../../../lib/server/media-service';

export const dynamic = 'force-dynamic';

export const GET = route((request: Request) => {
  const url = new URL(request.url);
  const generation = url.searchParams.get('generation');
  if (generation === null || !/^\d+$/.test(generation)) throw new StudyError('INVALID_ARGUMENT');
  const scope = projectScopeSchema.safeParse({
    projectId: url.searchParams.get('projectId'),
    generation: Number(generation),
  });
  if (!scope.success) throw new StudyError('INVALID_ARGUMENT');
  return ok(readMediaTasks(assertScope(scope.data)), { headers: { 'cache-control': 'no-store' } });
});

export const POST = route(async (request: Request) => {
  const raw = await readBoundedJson(
    request,
    64 * 1024,
    () => new StudyError('INVALID_ARGUMENT', { reason: 'media_request_body_invalid' }),
  );
  const parsed = mediaGenerationCommandSchema.safeParse(raw);
  if (!parsed.success)
    throw new StudyError('INVALID_ARGUMENT', { reason: 'media_command_invalid' });
  const command = parsed.data;
  const task = await generateMediaTask(assertScope(command.scope), command, {
    signal: request.signal,
  });
  return ok({ task }, { headers: { 'cache-control': 'no-store' } });
});
