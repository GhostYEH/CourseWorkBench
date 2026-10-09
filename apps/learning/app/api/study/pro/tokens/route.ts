import { proExternalTokenCommandSchema } from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../../lib/server/http';
import { commandProExternalToken } from '../../../../../lib/server/pro-external-service';

export const dynamic = 'force-dynamic';

/**
 * Pro 外部 token 管理（OMA-017）。
 *
 * 只在本机桌面 session 下可用（`server.mjs` 的 `x-sew-session` 已保护整个 `/api/` 前缀）；
 * 创建/轮换返回**一次性**明文 token，其余读取永不回显 secret 或哈希。
 */
export const POST = route(async (request: Request) =>
  ok(commandProExternalToken(await parseBody(request, proExternalTokenCommandSchema)), {
    headers: { 'cache-control': 'no-store' },
  }),
);
