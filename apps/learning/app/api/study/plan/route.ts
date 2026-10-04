import { parseBody, route, ok } from '../../../../lib/server/http';
import { executePlanCommand, planCommandSchema } from '../../../../lib/server/plan-service';

export const dynamic = 'force-dynamic';
export const POST = route(async (request: Request) =>
  ok(executePlanCommand(await parseBody(request, planCommandSchema))));
