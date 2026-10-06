import { z } from 'zod';
import { ok, parseBody, route } from '../../../../../../lib/server/http';
import { requireCollabSession } from '../../../../../../lib/server/collaboration-access';
import { confirmOnlineCommand } from '../../../../../../lib/server/collab-command-outbox';

export const dynamic = 'force-dynamic';
export const POST = route(async (request: Request) => {
  const input = await parseBody(
    request,
    z.object({ requestId: z.string().min(1).max(200) }).strict(),
  );
  const session = requireCollabSession(request);
  confirmOnlineCommand(session, input.requestId);
  return ok({ confirmed: true });
});
