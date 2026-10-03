import { preferencesWriteSchema } from '@sew/study-contracts';
import { parseBody, route, ok } from '../../../../lib/server/http';
import { assertScope, requireSession } from '../../../../lib/server/service';
import {
  readPreferences,
  readTeachingPreference,
  writePreferences,
  writeTeachingPreference,
} from '../../../../lib/server/state';

export const dynamic = 'force-dynamic';

/** 外观与阅读属于全局；教学表达属于项目，两者分开保存。 */
export const GET = route(() => {
  const session = requireSession();
  return ok({
    appearance: readPreferences(session),
    teaching: readTeachingPreference(session),
  });
});

/**
 * 写入偏好。共享 schema 已校验：请求根必须是对象、至少提供 appearance/teaching 之一，
 * 且教学表达必须携带 scope。这里只负责范围校验与落库。
 */
export const PUT = route(async (request: Request) => {
  const session = requireSession();
  const body = await parseBody(request, preferencesWriteSchema);
  const result: Record<string, unknown> = {};

  if (body.appearance !== undefined) {
    // 外观是用户级全局偏好，写入用户级目录，不需要项目代次。
    result.appearance = writePreferences(session, body.appearance);
  }

  if (body.teaching !== undefined) {
    // 教学表达是项目级事实：显式绑定 projectId + generation，并由服务复验，
    // 过期代次不能写进重新打开的项目。
    const scoped = assertScope(body.scope!);
    result.teaching = writeTeachingPreference(scoped, body.teaching);
  }

  return ok(result);
});
