import { projectScopeSchema, StudyError } from '@sew/study-contracts';
import { z } from 'zod';
import {
  proSessionCommandSchema,
  proSessionResponseSchema,
  proSessionsViewSchema,
} from '../../../../../../packages/study-contracts/src/pro-session';
import { readBoundedJson } from '../../../../lib/server/bounded-json';
import { ok, parseQuery, route } from '../../../../lib/server/http';
import { commandProSession, readProSessions } from '../../../../lib/server/pro-session-service';

export const dynamic = 'force-dynamic';

export const GET = route((request: Request) => {
  const scope = parseQuery(
    request,
    projectScopeSchema.extend({ generation: z.coerce.number().int().nonnegative() }),
  );
  return ok(proSessionsViewSchema.parse(readProSessions(scope)), {
    headers: { 'cache-control': 'no-store' },
  });
});

export const POST = route(async (request: Request) => {
  const raw = await readBoundedJson(
    request,
    64 * 1024,
    () => new StudyError('INVALID_ARGUMENT', { reason: 'pro_request_body_invalid' }),
  );
  const parsed = proSessionCommandSchema.safeParse(raw);
  if (!parsed.success) throw new StudyError('INVALID_ARGUMENT', { reason: 'pro_command_invalid' });
  const command = parsed.data;
  return ok(proSessionResponseSchema.parse(await commandProSession(command, request.signal)), {
    headers: { 'cache-control': 'no-store' },
  });
});
