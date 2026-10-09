import {
  mp4StartSchema,
  mp4ActionSchema,
  projectScopeSchema,
  StudyError,
} from '@sew/study-contracts';
import { ok, route } from '../../../../../lib/server/http';
import { readBoundedJson } from '../../../../../lib/server/bounded-json';
import { assertScope } from '../../../../../lib/server/service';
import {
  readMp4Tasks,
  startMp4Task,
  actionMp4Task,
} from '../../../../../lib/server/mp4-export-service';

export const dynamic = 'force-dynamic';
export const GET = route((request: Request) => {
  const url = new URL(request.url);
  const generation = url.searchParams.get('generation');
  if (generation === null || !/^\d+$/.test(generation)) throw new StudyError('INVALID_ARGUMENT');
  const scope = projectScopeSchema.parse({
    projectId: url.searchParams.get('projectId'),
    generation: Number(generation),
  });
  return ok(
    { tasks: readMp4Tasks(assertScope(scope)) },
    { headers: { 'cache-control': 'no-store' } },
  );
});
export const POST = route(async (request: Request) => {
  const raw = await readBoundedJson(request, 8192, () => new StudyError('INVALID_ARGUMENT'));
  const start = mp4StartSchema.safeParse(raw);
  const task = start.success
    ? await startMp4Task(assertScope(start.data.scope), start.data)
    : await (() => {
        const action = mp4ActionSchema.parse(raw);
        return actionMp4Task(assertScope(action.scope), action);
      })();
  return ok({ task }, { headers: { 'cache-control': 'no-store' } });
});
