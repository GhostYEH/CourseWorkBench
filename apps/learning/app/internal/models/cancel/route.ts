import { ok } from '../../../../lib/server/http';
import { modelConnection } from '../../../../lib/server/model-connection';
export const dynamic = 'force-dynamic';
/** Parent-only cancellation is the sole model route accepted while stopping. */
export const POST = () => { modelConnection.cancel(); return ok({ cancelled: true }); };
