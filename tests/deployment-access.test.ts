import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeSqliteDriver } from '@sew/study-storage';
import {
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';
import { POST as codesPost } from '../apps/learning/app/api/study/deployment/access-codes/route';
import { POST as redeemPost } from '../apps/learning/app/api/study/deployment/redeem/route';
import {
  commandDeploymentAccessCode,
  readDeploymentCapability,
  redeemDeploymentAccess,
} from '../apps/learning/lib/server/deployment-access-service';
import { deploymentAccessCodeViewSchema, deploymentRedeemResultSchema } from '@sew/study-contracts';

/**
 * 共享部署访问码（OMA-083）。
 *
 * 固定：① 签发返回一次性明文，列表/读取永不回显 secret 或哈希；② 撤销/过期后立即失效；
 * ③ 私密项目默认不公开，无有效访问码时不开放接入；④ 兑换按 requestId 幂等，不重复计数；
 * ⑤ 项目不一致 / scope 不足被拒。
 */
describe('OMA-083 共享部署访问码', () => {
  let session: Session | null = null;
  let root: string | null = null;
  afterEach(() => {
    if (session) closeProject();
    session = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  const open = (): Session => {
    root = mkdtempSync(join(tmpdir(), 'sew-deployment-'));
    session = openProjectFromDisk(root);
    return session;
  };

  const codesRoute = (body: Record<string, unknown>) =>
    codesPost(
      new Request('http://127.0.0.1/api/study/deployment/access-codes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  const redeemRoute = (body: Record<string, unknown>) =>
    redeemPost(
      new Request('http://127.0.0.1/api/study/deployment/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  it('签发返回一次性明文，列表永不回显 secret 或哈希', async () => {
    const s = open();
    const issued = commandDeploymentAccessCode(s, {
      action: 'issue',
      requestId: 'issue-1',
      label: '外部成员',
      scopes: ['join'],
      ttlDays: 7,
    });
    expect(deploymentAccessCodeViewSchema.safeParse(issued).success).toBe(true);
    const secret = issued.issued!.secret;
    expect(secret).toMatch(/^sewac_[a-f0-9]{64}$/);
    const list = commandDeploymentAccessCode(s, { action: 'list' });
    expect(list.issued).toBeNull();
    expect(JSON.stringify(list)).not.toContain(secret);
    expect(JSON.stringify(list)).not.toContain('secret_hash');
    // 数据库里只有哈希，可反查证明明文未落库。
    const row = s.store.deploymentAccess.findBySecretHash(
      (await import('node:crypto')).createHash('sha256').update(secret).digest('hex'),
    );
    expect(row).not.toBeNull();
    expect(JSON.stringify(row!.code)).not.toContain(secret);
  });

  it('撤销后立即失效；私密项目默认不公开', async () => {
    const s = open();
    const issued = commandDeploymentAccessCode(s, {
      action: 'issue',
      requestId: 'issue-2',
      label: '外部成员',
      scopes: ['join'],
      ttlDays: 7,
    });
    const secret = issued.issued!.secret;
    const codeId = issued.issued!.code.codeId;
    // 私密项目默认不公开：即便有有效访问码，capability 也不开放。
    expect(readDeploymentCapability(s)).toMatchObject({ open: false, privateByDefault: true });
    const first = redeemDeploymentAccess(s, {
      codeId: null,
      secret,
      uid: s.learnerUid,
      scope: 'join',
      requestId: 'redeem-1',
    });
    expect(first.result.codeId).toBe(codeId);
    commandDeploymentAccessCode(s, { action: 'revoke', requestId: 'revoke-1', codeId });
    expect(() =>
      redeemDeploymentAccess(s, {
        codeId: null,
        secret,
        uid: s.learnerUid,
        scope: 'join',
        requestId: 'redeem-1',
      }),
    ).toThrowError(expect.objectContaining({ code: 'PROJECT_NOT_AUTHORIZED' }));
    expect(() =>
      redeemDeploymentAccess(s, {
        codeId: null,
        secret,
        uid: s.learnerUid,
        scope: 'join',
        requestId: 'redeem-2',
      }),
    ).toThrowError(expect.objectContaining({ code: 'PROJECT_NOT_AUTHORIZED' }));
  });

  it('过期后立即失效（独立连接改到期时间）', () => {
    const s = open();
    const issued = commandDeploymentAccessCode(s, {
      action: 'issue',
      requestId: 'issue-3',
      label: '外部成员',
      scopes: ['guest'],
      ttlDays: 7,
    });
    const secret = issued.issued!.secret;
    const db = createNodeSqliteDriver().open(s.store.databaseFile);
    try {
      db.prepare('UPDATE deployment_access_codes SET expires_at=?').run(
        new Date(Date.now() - 1000).toISOString(),
      );
    } finally {
      db.close();
    }
    expect(() =>
      redeemDeploymentAccess(s, {
        codeId: null,
        secret,
        uid: s.learnerUid,
        scope: 'guest',
        requestId: 'redeem-expired',
      }),
    ).toThrowError(expect.objectContaining({ code: 'PROJECT_NOT_AUTHORIZED' }));
  });

  it('scope 不足被拒：guest 访问码不能用于 join', () => {
    const s = open();
    const issued = commandDeploymentAccessCode(s, {
      action: 'issue',
      requestId: 'issue-4',
      label: '只读访客',
      scopes: ['guest'],
      ttlDays: 7,
    });
    expect(() =>
      redeemDeploymentAccess(s, {
        codeId: null,
        secret: issued.issued!.secret,
        uid: s.learnerUid,
        scope: 'join',
        requestId: 'redeem-scope',
      }),
    ).toThrowError(expect.objectContaining({ code: 'PROJECT_NOT_AUTHORIZED' }));
  });

  it('兑换按 requestId 幂等：同请求重发不重复计数，改意图拒绝', () => {
    const s = open();
    const issued = commandDeploymentAccessCode(s, {
      action: 'issue',
      requestId: 'issue-5',
      label: '外部成员',
      scopes: ['join'],
      ttlDays: 7,
    });
    const secret = issued.issued!.secret;
    const command = {
      codeId: null,
      secret,
      uid: s.learnerUid,
      scope: 'join' as const,
      requestId: 'redeem-idem',
    };
    const first = redeemDeploymentAccess(s, command);
    expect(first.deduplicated).toBe(false);
    const second = redeemDeploymentAccess(s, command);
    expect(second.deduplicated).toBe(true);
    const code = s.store.deploymentAccess.get(s.projectId, issued.issued!.code.codeId)!;
    expect(code.usedCount).toBe(1);
    expect(() => redeemDeploymentAccess(s, { ...command, codeId: 'different-code' })).toThrowError(
      expect.objectContaining({ code: 'PROJECT_NOT_AUTHORIZED' }),
    );
    // 同 requestId 改 scope（意图变化）按 nonce 复用拒绝。
    expect(() => redeemDeploymentAccess(s, { ...command, scope: 'guest' })).toThrowError(
      expect.objectContaining({ code: 'VERSION_CONFLICT' }),
    );
  });

  it('HTTP 边界：管理入口需本机 session，兑换路由返回合同形状', async () => {
    const s = open();
    const issued = await codesRoute({
      action: 'issue',
      requestId: 'http-issue',
      label: '外部成员',
      scopes: ['join'],
      ttlDays: 7,
    });
    expect(issued.status).toBe(200);
    const issuedData = (await issued.json()).data;
    expect(deploymentAccessCodeViewSchema.safeParse(issuedData).success).toBe(true);
    const secret = issuedData.issued.secret as string;
    const redeemed = await redeemRoute({
      codeId: null,
      secret,
      uid: s.learnerUid,
      scope: 'join',
      requestId: 'http-redeem',
    });
    expect(redeemed.status).toBe(200);
    expect(deploymentRedeemResultSchema.safeParse((await redeemed.json()).data).success).toBe(true);
    // 无 secret 的兑换被拒。
    const denied = await redeemRoute({
      codeId: null,
      secret: 'sewac_' + 'a'.repeat(64),
      uid: s.learnerUid,
      scope: 'join',
      requestId: 'http-denied',
    });
    expect(denied.status).toBe(403);
  });
});
