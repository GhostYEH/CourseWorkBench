import { modelDiscoveryResultSchema } from '@sew/study-contracts';
import { ok, route } from '../../../../../lib/server/http';
import { requireSession } from '../../../../../lib/server/service';
import { modelConnection } from '../../../../../lib/server/model-connection';

export const dynamic = 'force-dynamic';

/** User-triggered provider model discovery; no credentials are accepted from the renderer. */
export const POST = route(async (request: Request) => {
  requireSession();
  const result = modelDiscoveryResultSchema.parse(
    await modelConnection.discoverModels(request.signal),
  );
  return ok(result, { headers: { 'cache-control': 'no-store' } });
});
