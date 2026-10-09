import { z } from 'zod';
import { directorCommandSchema, StudyError } from '@sew/study-contracts';
import { ok, route } from '../../../../lib/server/http';
import { readBoundedJson } from '../../../../lib/server/bounded-json';
import { assertScope } from '../../../../lib/server/service';
import { commandDirector, readDirector } from '../../../../lib/server/director-service';

export const dynamic = 'force-dynamic';
export const GET = route((request: Request) => {
  const parsed = z
    .object({
      projectId: z.string().min(1).max(200),
      generation: z.coerce.number().int().positive(),
      sessionId: z.string().min(1).max(200),
    })
    .strict()
    .safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) throw new StudyError('INVALID_ARGUMENT');
  return ok(
    { director: readDirector(assertScope(parsed.data), parsed.data.sessionId) },
    { headers: { 'cache-control': 'no-store' } },
  );
});
export const POST = route(async (request: Request) => {
  const raw = await readBoundedJson(
    request,
    8 * 1024,
    () => new StudyError('INVALID_ARGUMENT', { reason: 'director_request_body_invalid' }),
  );
  const parsed = directorCommandSchema.safeParse(raw);
  if (!parsed.success)
    throw new StudyError('INVALID_ARGUMENT', { reason: 'director_command_invalid' });
  const input = parsed.data;
  return ok(
    {
      director: await commandDirector(assertScope(input.scope), input, { signal: request.signal }),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
});
