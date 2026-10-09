import { StudyError } from '@sew/study-contracts';
import { proExternalCommandSchema, proSessionResponseSchema } from '@sew/study-contracts';
import { readBoundedJson } from '../../../../lib/server/bounded-json';
import { ok, route } from '../../../../lib/server/http';
import { commandProExternal } from '../../../../lib/server/pro-external-service';

export const dynamic = 'force-dynamic';

/**
 * Pro 外部任务 API（OMA-017）。
 *
 * 这是**独立 exact-path 入口**：`server.mjs` 只对精确路径 `/api/pro/external` 放行、
 * 用 bearer token 认证，而**不**放宽其余 `/api`、Host 或桌面 control 路由。
 *
 * 认证：`Authorization: Bearer sewpro_...`。token 绑定 owner/project，带有效期与最小 scope
 * （read/create/send），数据库只存哈希。命令**不携带 scope**，项目身份从 token 解析后与当前
 * 打开项目核对；工具执行/审核/接管不在合同里。
 */
export const POST = route(async (request: Request) => {
  const raw = await readBoundedJson(
    request,
    64 * 1024,
    () => new StudyError('INVALID_ARGUMENT', { reason: 'pro_external_body_invalid' }),
  );
  const parsed = proExternalCommandSchema.safeParse(raw);
  if (!parsed.success)
    throw new StudyError('INVALID_ARGUMENT', { reason: 'pro_external_command_invalid' });
  const result = await commandProExternal(
    parsed.data,
    request.headers.get('authorization'),
    request.signal,
  );
  return ok(proSessionResponseSchema.parse(result), {
    headers: { 'cache-control': 'no-store' },
  });
});
