import { z } from 'zod';
import {
  roleCreateSchema,
  roleDeleteSchema,
  roleUpdateSchema,
} from '@sew/study-contracts';
import { parseBody, route, ok } from '../../../../lib/server/http';
import { assertScope, requireSession } from '../../../../lib/server/service';

export const dynamic = 'force-dynamic';

const writeSchema = z.discriminatedUnion('action', [
  roleCreateSchema.extend({ action: z.literal('create') }),
  roleUpdateSchema.extend({ action: z.literal('update') }),
  roleDeleteSchema.extend({ action: z.literal('delete') }),
]);

/**
 * 角色档案（STYLE-01）。
 *
 * 只配置表达方式：名称、人格提示与讲解方式。权限位由服务端按 kind 派生，
 * 写入 schema 是 strict 的，客户端提交 `permissions` 会被直接拒绝。
 */
export const GET = route(() => {
  const session = requireSession();
  return ok({
    profiles: session.store.listRoleProfiles(),
    configDigest: session.store.roleConfigDigest(),
  });
});

export const POST = route(async (request: Request) => {
  const body = await parseBody(request, writeSchema);
  const session = assertScope(body.scope);

  if (body.action === 'create') {
    const created = session.store.createRoleProfile(body.kind, {
      name: body.name,
      persona: body.persona,
      explanation: body.explanation,
    });
    return ok({ profile: created, profiles: session.store.listRoleProfiles() });
  }

  if (body.action === 'update') {
    const updated = session.store.updateRoleProfile(body.profileId, {
      name: body.name,
      persona: body.persona,
      explanation: body.explanation,
    });
    return ok({ profile: updated, profiles: session.store.listRoleProfiles() });
  }

  session.store.deleteRoleProfile(body.profileId);
  return ok({ profile: null, profiles: session.store.listRoleProfiles() });
});
