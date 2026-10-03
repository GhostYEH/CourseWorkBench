import { NextResponse } from 'next/server';
import { z } from 'zod';
import { StudyError, projectScopeSchema } from '@sew/study-contracts';
import { parseBody, route } from '../../../lib/server/http';
import {
  authorizePaths,
  assertScope,
  closeProject,
  getSession,
  openProjectFromDisk,
} from '../../../lib/server/service';

export const dynamic = 'force-dynamic';

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open'), path: z.string().min(1) }),
  z.object({ action: z.literal('close') }),
  z.object({ action: z.literal('authorize'), scope: projectScopeSchema, paths: z.array(z.string()).max(50) }),
]);

/**
 * 主进程专用入口（外层 server.mjs 校验会话及控制凭据）：项目打开/关闭与原生路径授权。
 * 渲染层不直接调用它，只通过 preload 的白名单方法间接触发。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, bodySchema);

  if (body.action === 'authorize') {
    assertScope(body.scope);
    return NextResponse.json({ ok: true, data: { authorized: authorizePaths(body.paths) } });
  }

  if (body.action === 'close') {
    closeProject();
    return NextResponse.json({ ok: true, data: { session: null } });
  }

  const session = openProjectFromDisk(body.path);
  return NextResponse.json({
    ok: true,
    data: {
      session: {
        projectId: session.projectId,
        displayName: session.displayName,
        displayPath: session.displayPath,
        generation: session.generation,
      },
    },
  });
});

export const GET = route(() => {
  const session = getSession();
  if (!session) throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'no_open_project' });
  return NextResponse.json({
    ok: true,
    data: {
      projectId: session.projectId,
      displayName: session.displayName,
      displayPath: session.displayPath,
      generation: session.generation,
    },
  });
});
