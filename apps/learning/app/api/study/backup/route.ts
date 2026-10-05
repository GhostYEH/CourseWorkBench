import { z } from 'zod';
import { projectScopeSchema } from '@sew/study-contracts';
import { parseBody, route, ok } from '../../../../lib/server/http';
import {
  backupOpenedProject,
  restoreBackupProject,
} from '../../../../lib/server/project-backup-service';

export const dynamic = 'force-dynamic';

const bodySchema = z.union([
  z
    .object({
      action: z.literal('backup').default('backup'),
      scope: projectScopeSchema,
      targetPath: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal('restore'),
      scope: projectScopeSchema.nullable(),
      backupPath: z.string().min(1),
      targetPath: z.string().min(1),
    })
    .strict(),
]);

/**
 * 主进程专用控制入口：路径只能来自原生选择器，渲染层不能授权任意读写。
 * 备份用一致性数据库快照；恢复先校验暂存副本，只发布到不存在的新目录。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  return ok(
    body.action === 'restore'
      ? await restoreBackupProject(body.scope, body.backupPath, body.targetPath)
      : await backupOpenedProject(body.scope, body.targetPath),
  );
});
