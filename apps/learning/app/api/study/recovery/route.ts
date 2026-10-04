import { StudyError, recoveryCheckpointSchema, recoveryQuerySchema } from '@sew/study-contracts';
import { ok, route } from '../../../../lib/server/http';
import { assertScope } from '../../../../lib/server/service';
import { checkRecovery } from '../../../../lib/server/classroom-recovery';

export const dynamic = 'force-dynamic';

/**
 * 四层恢复核对（RESUME-01）。
 *
 * 只读：不发 provider 请求、不重放白板/消息/提交、不写任何权威事实。
 * 返回的 `resumable` 是界面能否继续这节课的唯一依据。
 */
export const GET = route((request: Request) => {
  const query = recoveryQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) throw new StudyError('INVALID_ARGUMENT');
  const session = assertScope(query.data);
  const checkpoint = checkRecovery(session, query.data.sessionId);
  return ok({ checkpoint: recoveryCheckpointSchema.parse(checkpoint) }, { headers: { 'cache-control': 'no-store' } });
});
