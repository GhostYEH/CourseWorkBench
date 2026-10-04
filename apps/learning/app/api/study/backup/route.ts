import { z } from 'zod';
import { StudyError, projectScopeSchema } from '@sew/study-contracts';
import { parseBody, route, ok } from '../../../../lib/server/http';
import { assertScope } from '../../../../lib/server/service';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  scope: projectScopeSchema,
  targetPath: z.string().min(1),
});

/**
 * 一致性备份：启用 WAL 时不能只复制运行中的 .db 文件，交给驱动做快照。
 * 当前只生成数据库快照（含项目 UID 绑定），尚未打包 manifest 或材料文件。
 * 用户级身份文件和短期应用会话凭据不在该数据库快照中。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  const session = assertScope(body.scope);
  if (!/\.db$/i.test(body.targetPath)) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'backup_target_must_be_db' });
  }
  session.store.backupTo(body.targetPath);
  return ok({ targetPath: body.targetPath });
});
