import { ok } from '../../../../lib/server/http';
import { modelConnection } from '../../../../lib/server/model-connection';
export const dynamic = 'force-dynamic';
/** Authenticated main-frame status only. No secret readback or inference commands. */
export const GET = () => ok(modelConnection.status(), { headers: { 'cache-control': 'no-store' } });
