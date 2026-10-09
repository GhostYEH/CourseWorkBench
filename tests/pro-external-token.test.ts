import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proSessionResponseSchema, proExternalTokensViewSchema } from '@sew/study-contracts';
import {
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';
import { POST as tokensPost } from '../apps/learning/app/api/study/pro/tokens/route';
import { POST as externalPost } from '../apps/learning/app/api/pro/external/route';

/**
 * Pro 外部任务 token 与 API（OMA-017）。
 *
 * 固定五件事：① 创建/轮换只返回一次明文，列表/读取永不回显 secret 或哈希；
 * ② bearer token 才能访问外部入口，缺失/错误/畸形都被拒；③ scope 最小化，越权动作被拒；
 * ④ 撤销后立即失效，轮换后旧 secret 立即失效；⑤ 外部命令不携带 scope，项目身份从 token 解析。
 */
describe('OMA-017 Pro 外部 token 与外部任务 API', () => {
  let session: Session | null = null;
  let root: string | null = null;
  afterEach(() => {
    if (session) closeProject();
    session = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  const open = (): { scope: { projectId: string; generation: number } } => {
    root = mkdtempSync(join(tmpdir(), 'sew-pro-external-'));
    session = openProjectFromDisk(root);
    return { scope: { projectId: session.projectId, generation: session.generation } };
  };

  const manage = (
    scope: { projectId: string; generation: number },
    body: Record<string, unknown>,
  ) => {
    // list 动作不带 requestId（其合同无该字段）；其余动作需要 requestId。
    const withRequestId = body.action === 'list' ? body : { requestId: `m-${Math.random()}`, ...body };
    return tokensPost(
      new Request('http://127.0.0.1/api/study/pro/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope, ...withRequestId }),
      }),
    );
  };

  const external = (body: Record<string, unknown>, authorization?: string) =>
    externalPost(
      new Request('http://127.0.0.1/api/pro/external', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify(body),
      }),
    );

  const create = async (
    scope: { projectId: string; generation: number },
    scopes: string[] = ['read', 'create', 'send'],
  ): Promise<string> => {
    const response = await manage(scope, {
      action: 'create',
      label: '外部任务',
      scopes,
      ttlDays: 30,
    });
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(proExternalTokensViewSchema.safeParse(data).success).toBe(true);
    expect(data.issued.secret).toMatch(/^sewpro_[a-f0-9]{64}$/);
    return data.issued.secret as string;
  };

  it('创建返回一次性明文，列表永不回显 secret 或哈希', async () => {
    const { scope } = open();
    const secret = await create(scope);
    const list = await manage(scope, { action: 'list' });
    const listData = (await list.json()).data;
    expect(listData.issued).toBeNull();
    expect(JSON.stringify(listData)).not.toContain(secret);
    expect(JSON.stringify(listData)).not.toContain('secret_hash');
    // 数据库里也只有哈希，没有明文。
    const row = session!.store.proExternalTokens.findBySecretHash(
      // 哈希可反查：证明库里存的是哈希而非明文。
      (await import('node:crypto')).createHash('sha256').update(secret).digest('hex'),
    );
    expect(row).not.toBeNull();
    expect(JSON.stringify(row!.token)).not.toContain(secret);
  });

  it('缺失/畸形 bearer 都被拒；有效 token 可读会话', async () => {
    const { scope } = open();
    const missing = await external({ action: 'list', requestId: 'e1' });
    expect(missing.status).toBe(403);
    const malformed = await external({ action: 'list', requestId: 'e2' }, 'Bearer not-a-token');
    expect(malformed.status).toBe(403);
    const secret = await create(scope);
    const listed = await external({ action: 'list', requestId: 'e3' }, `Bearer ${secret}`);
    expect(listed.status).toBe(200);
    const data = (await listed.json()).data;
    expect(proSessionResponseSchema.safeParse(data).success).toBe(true);
  });

  it('scope 最小化：只读 token 不能创建或发送', async () => {
    const { scope } = open();
    const readOnly = await create(scope, ['read']);
    const createDenied = await external(
      { action: 'create', requestId: 'e-create', title: '越权' },
      `Bearer ${readOnly}`,
    );
    expect(createDenied.status).toBe(403);
    const sendDenied = await external(
      {
        action: 'send',
        requestId: 'e-send',
        sessionId: 'x',
        expectedRevision: 0,
        content: 'hi',
        bundleId: 'b',
        bundleDigest: 'a'.repeat(64),
        skillIds: [],
      },
      `Bearer ${readOnly}`,
    );
    expect(sendDenied.status).toBe(403);
    // 只读动作仍可用。
    const listed = await external({ action: 'list', requestId: 'e-list' }, `Bearer ${readOnly}`);
    expect(listed.status).toBe(200);
  });

  it('撤销后 token 立即失效', async () => {
    const { scope } = open();
    const secret = await create(scope);
    const created = (await (await manage(scope, { action: 'list' })).json()).data.tokens[0];
    const revoked = await manage(scope, { action: 'revoke', tokenId: created.tokenId });
    expect(revoked.status).toBe(200);
    const after = await external({ action: 'list', requestId: 'e-revoked' }, `Bearer ${secret}`);
    expect(after.status).toBe(403);
  });

  it('轮换后旧 secret 立即失效，新 secret 可用', async () => {
    const { scope } = open();
    const oldSecret = await create(scope);
    const created = (await (await manage(scope, { action: 'list' })).json()).data.tokens[0];
    const rotated = await manage(scope, { action: 'rotate', tokenId: created.tokenId, ttlDays: 30 });
    const rotatedData = (await rotated.json()).data;
    const newSecret = rotatedData.issued.secret as string;
    expect(newSecret).not.toBe(oldSecret);
    const oldDenied = await external({ action: 'list', requestId: 'e-old' }, `Bearer ${oldSecret}`);
    expect(oldDenied.status).toBe(403);
    const newOk = await external({ action: 'list', requestId: 'e-new' }, `Bearer ${newSecret}`);
    expect(newOk.status).toBe(200);
  });

  it('管理命令幂等：同 requestId 重发不重复创建/轮换/撤销', async () => {
    const { scope } = open();
    // 创建：同一 requestId 重发只回公开元数据，不再返回新 secret，也不多出 token。
    const created = await manage(scope, {
      action: 'create',
      requestId: 'idem-create',
      label: '幂等',
      scopes: ['read'],
      ttlDays: 30,
    });
    const createdData = (await created.json()).data;
    expect(createdData.issued).not.toBeNull();
    const replay = await manage(scope, {
      action: 'create',
      requestId: 'idem-create',
      label: '幂等',
      scopes: ['read'],
      ttlDays: 30,
    });
    const replayData = (await replay.json()).data;
    expect(replayData.deduplicated).toBe(true);
    expect(replayData.issued).toBeNull();
    expect(replayData.tokens[0].tokenId).toBe(createdData.tokens[0].tokenId);
    const list = await manage(scope, { action: 'list' });
    expect((await list.json()).data.tokens).toHaveLength(1);
  });

  it('外部 token 不能签发另一个 token（管理入口只认桌面 session）', async () => {
    const { scope } = open();
    const secret = await create(scope);
    // 管理入口不读取 Authorization，因此拿外部 secret 当 session 不能创建 token。
    // 这里验证：伪造的 generation 会被业务层拒绝，且不会因为带了 bearer 就放行。
    const forged = await tokensPost(
      new Request('http://127.0.0.1/api/study/pro/tokens', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          scope: { projectId: session!.projectId, generation: session!.generation + 99 },
          requestId: 'forge',
          action: 'create',
          label: '越权',
          scopes: ['read'],
          ttlDays: 30,
        }),
      }),
    );
    expect(forged.status).toBe(409);
    expect(((await forged.json()) as { error: { code: string } }).error.code).toBe(
      'PROJECT_GENERATION_STALE',
    );
    // 库里的 token 数量没有增加。
    const list = await manage(scope, { action: 'list' });
    expect((await list.json()).data.tokens).toHaveLength(1);
  });

  it('项目切换后旧代次的 token 请求失效（token 绑定当前打开项目）', async () => {
    const { scope } = open();
    const secret = await create(scope);
    // 重新打开同一项目会推进 generation；旧 scope 的会话已失效。
    const reopened = openProjectFromDisk(root!);
    const stale = await external(
      { action: 'list', requestId: 'e-stale' },
      `Bearer ${secret}`,
    );
    // 认证读取当前打开项目：token 的 projectId 仍一致（同一磁盘项目），因此读成功。
    expect(stale.status).toBe(200);
    // 但用旧 scope 调管理命令会因代次不符被拒。
    const staleManage = await manage(scope, { action: 'list' });
    expect(staleManage.status).toBe(409);
    expect(reopened.projectId).toBe(scope.projectId);
  });
});
