/**
 * 部署访问码的纯判定（OMA-083）。
 *
 * 只做判断：回答「这份访问码现在能不能用于这个 scope」。服务端只保存 SHA-256 哈希，
 * 认证时用哈希反查（等值匹配，不比较明文），因此明文永不落库/日志/导出。
 */

import { createHash } from 'node:crypto';
import { StudyError } from '@sew/study-contracts';
import type { DeploymentAccessScope } from '@sew/study-contracts';

/** 访问码明文的存储哈希：明文本身永不落库、不进日志/快照/导出。 */
export const deploymentAccessCodeHash = (secret: string): string =>
  createHash('sha256').update(secret, 'utf8').digest('hex');

export interface DeploymentAccessCodeFacts {
  codeId: string;
  projectId: string;
  scopes: readonly DeploymentAccessScope[];
  expiresAt: string;
  revokedAt: string | null;
}

/**
 * 断言访问码现在可用于某个 scope。
 *
 * 判定顺序：存在 → 未撤销 → 未过期 → 项目归属一致 → 具备所需 scope。
 * 任一不满足都以 `PROJECT_NOT_AUTHORIZED` 拒绝（对外统一为「未授权」，不泄漏内部细节）。
 */
export const assertDeploymentAccessUsable = (facts: {
  code: DeploymentAccessCodeFacts | null;
  projectId: string;
  requiredScope: DeploymentAccessScope;
  now: number;
}): void => {
  if (!facts.code) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'deployment_code_unknown' });
  }
  if (facts.code.revokedAt !== null) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'deployment_code_revoked' });
  }
  const expiresAt = Date.parse(facts.code.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= facts.now) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'deployment_code_expired' });
  }
  if (facts.code.projectId !== facts.projectId) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'deployment_project_mismatch' });
  }
  if (!facts.code.scopes.includes(facts.requiredScope)) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', {
      reason: 'deployment_scope_denied',
      required: facts.requiredScope,
    });
  }
};

/** 当前有效访问码允许的 scope 并集；私密项目默认不公开时返回空。 */
export const deploymentCapability = (facts: {
  projectId: string;
  codes: readonly DeploymentAccessCodeFacts[];
  now: number;
  privateByDefault?: boolean;
}): { projectId: string; open: boolean; scopes: DeploymentAccessScope[]; privateByDefault: boolean } => {
  const privateByDefault = facts.privateByDefault ?? true;
  const usable = facts.codes.filter(
    (code) =>
      code.revokedAt === null &&
      Number.isFinite(Date.parse(code.expiresAt)) &&
      Date.parse(code.expiresAt) > facts.now,
  );
  const scopes = privateByDefault
    ? []
    : [...new Set(usable.flatMap((code) => [...code.scopes]))].sort();
  return {
    projectId: facts.projectId,
    open: !privateByDefault && usable.length > 0,
    scopes,
    privateByDefault,
  };
};
