import { z } from 'zod';
import { modelConnectionInputSchema, StudyError } from '@sew/study-contracts';
import { ok, route } from '../../../lib/server/http';
import { modelConnection, readModelJson } from '../../../lib/server/model-connection';
export const dynamic = 'force-dynamic';
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('configure'), config: modelConnectionInputSchema, persisted: z.boolean() }).strict(),
  z.object({ action: z.literal('test') }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
]);
/** Outer server.mjs requires the parent-only control credential. */
export const POST = route(async (request: Request) => {
  let raw: unknown;
  try { raw = await readModelJson(request, 16_384); } catch { throw new StudyError('INVALID_ARGUMENT'); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new StudyError('INVALID_ARGUMENT');
  const body = parsed.data;
  const headers = { 'cache-control': 'no-store' };
  if (body.action === 'configure') return ok(modelConnection.configure(body.config, body.persisted), { headers });
  if (body.action === 'cancel') { modelConnection.cancel(); return ok({ cancelled: true }, { headers }); }
  return ok(await modelConnection.test(request.signal), { headers });
});
