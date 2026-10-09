import { localMediaConfigurationInputSchema, StudyError } from '@sew/study-contracts';
import { ok, route } from '../../../../../lib/server/http';
import { readBoundedJson } from '../../../../../lib/server/bounded-json';
import { requireSession } from '../../../../../lib/server/service';
import { modelConnection } from '../../../../../lib/server/model-connection';

export const dynamic = 'force-dynamic';

export const GET = route(() => {
  requireSession();
  return ok(modelConnection.localMediaStatus(), { headers: { 'cache-control': 'no-store' } });
});

export const POST = route(async (request: Request) => {
  requireSession();
  const raw = await readBoundedJson(
    request,
    20 * 1024,
    () => new StudyError('INVALID_ARGUMENT', { reason: 'local_media_config_invalid' }),
  );
  const parsed = localMediaConfigurationInputSchema.safeParse(raw);
  if (!parsed.success)
    throw new StudyError('INVALID_ARGUMENT', { reason: 'local_media_config_invalid' });
  const status = modelConnection.configureLocalMedia(parsed.data);
  return ok(status, { headers: { 'cache-control': 'no-store' } });
});
