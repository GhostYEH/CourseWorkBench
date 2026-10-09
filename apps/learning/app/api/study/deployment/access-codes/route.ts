import { deploymentAccessCodeCommandSchema } from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../../lib/server/http';
import { requireSession } from '../../../../../lib/server/service';
import { commandDeploymentAccessCode } from '../../../../../lib/server/deployment-access-service';

export const dynamic = 'force-dynamic';

/**
 * 共享部署访问码管理（OMA-083）。
 *
 * 只在本机桌面 session 下可用（`server.mjs` 的 `x-sew-session` 已保护整个 `/api/` 前缀）；
 * 签发返回**一次性**明文访问码，其余读取永不回显 secret 或哈希。
 */
export const POST = route(async (request: Request) =>
  ok(commandDeploymentAccessCode(requireSession(), await parseBody(request, deploymentAccessCodeCommandSchema)), {
    headers: { 'cache-control': 'no-store' },
  }),
);
