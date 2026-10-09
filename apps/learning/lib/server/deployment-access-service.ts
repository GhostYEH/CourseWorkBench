/**
 * 共享部署访问码服务（OMA-083）。
 *
 * 管理入口（issue/revoke/list）**只**接受本机认证的桌面 session：访问码是部署凭据，不能用一个
 * 访问码去签发另一个。明文只在签发时返回一次；数据库只保存哈希。
 *
 * 兑换入口（redeem）用访问码 + 本人 UID 换取「部署接入授权」：访问码只授予 join/guest，
 * 不代替本人凭据认证；私密项目默认不公开（无有效访问码时不开放）。
 */

import { randomBytes } from 'node:crypto';
import { StudyError, newId } from '@sew/study-contracts';
import {
  DEPLOYMENT_ACCESS_CODE_PREFIX,
  DEPLOYMENT_ACCESS_DEFAULT_TTL_DAYS,
  type DeploymentAccessCodeCommand,
  type DeploymentAccessCodeDto,
  type DeploymentAccessCodeViewDto,
  type DeploymentCapabilityDto,
  type DeploymentRedeemInput,
  type DeploymentRedeemResultDto,
} from '../../../../packages/study-contracts/src/deployment-access';
import {
  assertDeploymentAccessUsable,
  deploymentAccessCodeHash,
  deploymentCapability,
} from '@sew/study-domain';
import type { Session } from './service';

const nowIso = (): string => new Date().toISOString();
const codeId = (): string => newId('depcode');
const secret = (): string => `${DEPLOYMENT_ACCESS_CODE_PREFIX}${randomBytes(32).toString('hex')}`;
const expiry = (ttlDays: number): string =>
  new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

/** 管理命令：只在本机认证 session 下调用（路由层已用 x-sew-session 保护）。 */
export const commandDeploymentAccessCode = (
  session: Session,
  raw: DeploymentAccessCodeCommand,
): DeploymentAccessCodeViewDto => {
  const { store, projectId } = session;
  if (raw.action === 'list') {
    return { codes: store.deploymentAccess.list(projectId), issued: null, deduplicated: false };
  }
  if (raw.action === 'revoke') {
    const revoked = store.transaction(() =>
      store.deploymentAccess.revoke({ projectId, codeId: raw.codeId, revokedAt: nowIso() }),
    );
    return { codes: [revoked], issued: null, deduplicated: false };
  }
  // issue
  const plaintext = secret();
  const created = store.transaction(() =>
    store.deploymentAccess.create({
      codeId: codeId(),
      projectId,
      label: raw.label,
      secretHash: deploymentAccessCodeHash(plaintext),
      scopes: raw.scopes,
      createdAt: nowIso(),
      expiresAt: expiry(raw.ttlDays ?? DEPLOYMENT_ACCESS_DEFAULT_TTL_DAYS),
    }),
  );
  return { codes: [created], issued: { code: created, secret: plaintext }, deduplicated: false };
};

/** 部署能力：供宿主扩展点查询本部署是否开放接入、开放了哪些 scope。 */
export const readDeploymentCapability = (session: Session): DeploymentCapabilityDto =>
  deploymentCapability({
    projectId: session.projectId,
    codes: session.store.deploymentAccess.list(session.projectId),
    now: Date.now(),
    privateByDefault: true,
  });

/**
 * 兑换访问码：访问码 + 本人 UID → 部署接入授权。
 *
 * 判定顺序：哈希反查 → 未撤销/未过期/项目一致/scope 具备（领域纯函数）→ 记录兑换收据。
 * 同 requestId 与意图重发读回既有授权，不重复计数。
 */
export const redeemDeploymentAccess = (
  session: Session,
  raw: DeploymentRedeemInput,
): { result: DeploymentRedeemResultDto; deduplicated: boolean } => {
  const { store, projectId } = session;
  const secretHash = deploymentAccessCodeHash(raw.secret);
  const found = store.deploymentAccess.findBySecretHash(secretHash);
  const intent = JSON.stringify({
    codeId: found?.code.codeId ?? null,
    uid: raw.uid,
    scope: raw.scope,
  });
  const previous = store.deploymentAccess.receipt(projectId, raw.requestId, intent);
  assertDeploymentAccessUsable({
    code: found?.code ?? null,
    projectId,
    requiredScope: raw.scope,
    now: Date.now(),
  });
  if (raw.codeId !== null && raw.codeId !== found!.code.codeId) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'deployment_code_id_mismatch' });
  }
  if (previous) {
    return {
      result: {
        codeId: previous.codeId,
        projectId,
        uid: previous.uid,
        scope: previous.scope,
        redeemedAt: nowIso(),
      },
      deduplicated: true,
    };
  }
  const redeemedAt = nowIso();
  return store.transaction(() => {
    store.deploymentAccess.noteUsed(projectId, found!.code.codeId);
    store.deploymentAccess.saveReceipt({
      projectId,
      requestId: raw.requestId,
      codeId: found!.code.codeId,
      uid: raw.uid,
      scope: raw.scope,
      intent,
      createdAt: redeemedAt,
    });
    return {
      result: {
        codeId: found!.code.codeId,
        projectId,
        uid: raw.uid,
        scope: raw.scope,
        redeemedAt,
      },
      deduplicated: false,
    };
  });
};

export type { DeploymentAccessCodeDto };
