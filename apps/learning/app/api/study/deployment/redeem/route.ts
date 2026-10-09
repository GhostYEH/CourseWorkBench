import { deploymentRedeemSchema, deploymentRedeemResultSchema } from '@sew/study-contracts';
import { ok, parseBody, route } from '../../../../../lib/server/http';
import { requireSession } from '../../../../../lib/server/service';
import { redeemDeploymentAccess } from '../../../../../lib/server/deployment-access-service';

export const dynamic = 'force-dynamic';

/**
 * 兑换共享部署访问码（OMA-083）。
 *
 * 访问码 + 本人 UID → 部署接入授权（join/guest）。访问码只授予接入能力，不代替本人凭据认证；
 * 私密项目默认不公开。同 requestId 与意图重发读回既有授权，不重复计数。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, deploymentRedeemSchema);
  const { result } = redeemDeploymentAccess(requireSession(), body);
  return ok(deploymentRedeemResultSchema.parse(result), {
    headers: { 'cache-control': 'no-store' },
  });
});
