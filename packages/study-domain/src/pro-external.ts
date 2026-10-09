/**
 * Pro 外部 token 的纯判定（OMA-017）。
 *
 * 只做判断，不碰数据库/网络：回答「这份 token 现在能不能用于这个动作」。
 * 服务端只保存 token 的 SHA-256 哈希；认证时用哈希在唯一列上反查（等值匹配，不比较明文），
 * 因此 secret 明文永不落库、不进日志/快照/导出。
 */

import { createHash } from 'node:crypto';
import { StudyError } from '@sew/study-contracts';
import type { ProExternalScope } from '@sew/study-contracts';

/** token 秘密的存储哈希：secret 本身永不落库、不进日志/快照/导出。 */
export const proExternalTokenHash = (secret: string): string =>
  createHash('sha256').update(secret, 'utf8').digest('hex');

export interface ProExternalTokenFacts {
  tokenId: string;
  projectId: string;
  ownerUid: string;
  scopes: readonly ProExternalScope[];
  expiresAt: string;
  revokedAt: string | null;
}

/**
 * 断言 token 现在可用于某个动作。
 *
 * 判定顺序：存在 → 未撤销 → 未过期 → 项目归属与当前打开项目一致 → 具备所需 scope。
 * 任一不满足都以 `PROJECT_NOT_AUTHORIZED` 拒绝（对外部调用者统一为「未授权」，不泄漏内部细节）。
 */
export const assertProExternalTokenUsable = (facts: {
  token: ProExternalTokenFacts | null;
  projectId: string;
  requiredScope: ProExternalScope;
  now: number;
}): void => {
  if (!facts.token) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'pro_external_token_unknown' });
  }
  if (facts.token.revokedAt !== null) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'pro_external_token_revoked' });
  }
  const expiresAt = Date.parse(facts.token.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= facts.now) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'pro_external_token_expired' });
  }
  if (facts.token.projectId !== facts.projectId) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'pro_external_project_mismatch' });
  }
  if (!facts.token.scopes.includes(facts.requiredScope)) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', {
      reason: 'pro_external_scope_denied',
      required: facts.requiredScope,
    });
  }
};
