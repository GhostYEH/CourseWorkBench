import { createHash, randomBytes } from 'node:crypto';
import { StudyError, newId } from '@sew/study-contracts';
import {
  PRO_EXTERNAL_ACTION_SCOPE,
  PRO_EXTERNAL_TOKEN_PREFIX,
  type ProExternalCommand,
  type ProExternalTokenCommand,
  type ProExternalTokenDto,
  type ProExternalTokenIssuedDto,
} from '../../../../packages/study-contracts/src/pro-external';
import { assertProExternalTokenUsable, proExternalTokenHash } from '@sew/study-domain';
import { assertScope, requireSession, type Session } from './service';
import { commandProSession, readProSessions } from './pro-session-service';

/**
 * Pro 外部 token 管理（OMA-017）。
 *
 * 管理入口（create/rotate/revoke/list）**只**接受本机认证的桌面 session：token 是项目凭据，
 * 不能用一个外部 token 去签发另一个。secret 明文只在创建/轮换时返回一次。
 */
const nowIso = (): string => new Date().toISOString();
const tokenId = (): string => newId('protok');
const secret = (): string => `${PRO_EXTERNAL_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
const expiry = (ttlDays: number): string =>
  new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

const issued = (token: ProExternalTokenDto, plaintext: string): ProExternalTokenIssuedDto => ({
  token,
  secret: plaintext,
});

/** 管理命令：只在本机认证 session 下调用（路由层已用 x-sew-session 保护）。 */
export const commandProExternalToken = (raw: ProExternalTokenCommand) => {
  const session = assertScope(raw.scope);
  const { store, projectId, learnerUid } = session;
  if (raw.action === 'list') {
    return {
      tokens: store.proExternalTokens.list(projectId, learnerUid),
      issued: null,
      deduplicated: false,
    };
  }
  // 管理命令幂等：同 requestId 与意图重发读回既有结论，不重复创建/轮换/撤销。
  // 明文 secret 只在首次创建/轮换时返回一次；重放只回公开元数据（secret 已不可恢复）。
  const intent = JSON.stringify(raw);
  const previous = store.proExternalTokens.receipt(projectId, raw.requestId, raw.action, intent);
  if (previous) {
    const token = store.proExternalTokens.get(projectId, learnerUid, previous.tokenId);
    if (!token) throw new StudyError('INTERNAL', { reason: 'pro_external_token_receipt_missing' });
    return { tokens: [token], issued: null, deduplicated: true };
  }
  if (raw.action === 'create') {
    const plaintext = secret();
    const created = store.transaction(() => {
      const token = store.proExternalTokens.create({
        tokenId: tokenId(),
        projectId,
        ownerUid: learnerUid,
        label: raw.label,
        secretHash: proExternalTokenHash(plaintext),
        scopes: raw.scopes,
        createdAt: nowIso(),
        expiresAt: expiry(raw.ttlDays),
      });
      store.proExternalTokens.saveReceipt({
        projectId,
        requestId: raw.requestId,
        action: 'create',
        intent,
        tokenId: token.tokenId,
      });
      return token;
    });
    return { tokens: [created], issued: issued(created, plaintext), deduplicated: false };
  }
  if (raw.action === 'rotate') {
    const plaintext = secret();
    const rotated = store.transaction(() => {
      const token = store.proExternalTokens.rotate({
        projectId,
        ownerUid: learnerUid,
        tokenId: raw.tokenId,
        secretHash: proExternalTokenHash(plaintext),
        expiresAt: expiry(raw.ttlDays),
      });
      store.proExternalTokens.saveReceipt({
        projectId,
        requestId: raw.requestId,
        action: 'rotate',
        intent,
        tokenId: token.tokenId,
      });
      return token;
    });
    return { tokens: [rotated], issued: issued(rotated, plaintext), deduplicated: false };
  }
  // revoke
  const revoked = store.transaction(() => {
    const token = store.proExternalTokens.revoke({
      projectId,
      ownerUid: learnerUid,
      tokenId: raw.tokenId,
      revokedAt: nowIso(),
    });
    store.proExternalTokens.saveReceipt({
      projectId,
      requestId: raw.requestId,
      action: 'revoke',
      intent,
      tokenId: token.tokenId,
    });
    return token;
  });
  return { tokens: [revoked], issued: null, deduplicated: false };
};

/**
 * 从 Authorization: Bearer 解析并认证外部 token。
 *
 * 只接受 `Bearer sewpro_...`：解析出的哈希反查元数据，再按纯判定校验撤销/过期/项目归属/scope。
 * 返回的 `session` 是**当前打开项目**的会话（外部命令不带 scope）；token 的 projectId 必须与
 * 当前打开项目一致，否则拒绝——项目 ID 不是凭据，token 才是。
 */
export const authenticateProExternal = (
  authorization: string | null,
  requiredScope: ProExternalCommand['action'],
): { session: Session; token: ProExternalTokenDto; secretHash: string } => {
  const header = authorization ?? '';
  if (!header.startsWith('Bearer ')) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'pro_external_bearer_required' });
  }
  const provided = header.slice('Bearer '.length).trim();
  if (!provided.startsWith(PRO_EXTERNAL_TOKEN_PREFIX)) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'pro_external_token_malformed' });
  }
  const secretHash = proExternalTokenHash(provided);
  const record = requireSession().store.proExternalTokens.findBySecretHash(secretHash);
  const session = requireSession();
  const scope = PRO_EXTERNAL_ACTION_SCOPE[requiredScope];
  assertProExternalTokenUsable({
    token: record?.token ?? null,
    projectId: session.projectId,
    requiredScope: scope,
    now: Date.now(),
  });
  // 归属：token 的 owner 必须与当前打开项目的本人身份一致。
  if (record!.token.ownerUid !== session.learnerUid) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'pro_external_owner_mismatch' });
  }
  return { session, token: record!.token, secretHash };
};

/**
 * 原凭据的**实时**授权复验（OMA-017）。
 *
 * 长调用期间凭据可能被撤销、轮换、到期，或项目被切换/重开。派发前、等待后与最终提交事务内都必须
 * 用**实时状态**重新判定，而不能只按不变的 tokenId 判断，也不能缓存首次认证的 DTO。判定内容：
 * - 当前打开项目仍是认证时的项目与代次（`assertScope`，项目切换/重开使旧凭据失效）；
 * - 用**原始 secret 哈希**在实时库中反查：撤销写 `revoked_at`、轮换改 `secret_hash`（旧哈希查不到）、
 *   到期由 `assertProExternalTokenUsable` 判定，scope 也重新核对；
 * - token 身份（tokenId）与 owner 必须仍是同一个，防替换与归属漂移。
 */
const assertProExternalAuthorization = (input: {
  scope: { projectId: string; generation: number };
  secretHash: string;
  tokenId: string;
  action: ProExternalCommand['action'];
}): void => {
  const session = assertScope(input.scope);
  const record = session.store.proExternalTokens.findBySecretHash(input.secretHash);
  assertProExternalTokenUsable({
    token: record?.token ?? null,
    projectId: session.projectId,
    requiredScope: PRO_EXTERNAL_ACTION_SCOPE[input.action],
    now: Date.now(),
  });
  if (record!.token.tokenId !== input.tokenId) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', {
      reason: 'pro_external_token_identity_changed',
    });
  }
  if (record!.token.ownerUid !== session.learnerUid) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'pro_external_owner_mismatch' });
  }
};

/**
 * 外部 requestId 的稳定映射（OMA-017）。
 *
 * 合同允许最多 200 字符的 requestId。旧实现直接 `pro-ext-${tokenId}-${requestId}` 再 `.slice(0,200)`：
 * 拼接后的前缀会把 nonce 尾部挤出上限，于是「只在末尾不同」的两个合法 nonce 映射成同一个键，
 * 造成付费请求被误判为复用（`pro_request_reused`）或错误重放。
 *
 * 这里：能完整放下时保持原键不变（既有已执行回执继续命中，不会把旧付费请求再执行一遍）；
 * 超长时改用带清晰域分隔的稳定摘要——同 token+同请求稳定、不同合法 nonce（含只在尾部不同的）
 * 不碰撞、不同 token 隔离。摘要固定 64 位十六进制，长度远低于上限，不再截断。
 */
const externalRequestId = (tokenId: string, requestId: string): string => {
  const legacy = `pro-ext-${tokenId}-${requestId}`;
  if (legacy.length <= 200) return legacy;
  return `pro-ext-${createHash('sha256')
    .update(JSON.stringify(['sew-pro-external-request', tokenId, requestId]))
    .digest('hex')}`;
};

/**
 * 外部命令：认证后把动作转译成既有 Pro 命令，复用同一份 owner-private 会话仓库与 guard。
 *
 * 外部命令**不携带 scope**：项目身份与 owner 都来自 token。动作被收口到 read/create/send，
 * 工具执行、审核、接管、控制等不在合同里——外部调用者无从表达，也就无从越权。
 *
 * 长调用（send）在派发前、等待后与最终提交事务内都用**原凭据的实时状态**复验：挂起期间被撤销/
 * 轮换/到期或项目切换时，迟到的业务结果不得提交（已派发的用量仍真实结算）。
 */
export const commandProExternal = async (
  command: ProExternalCommand,
  authorization: string | null,
  signal?: AbortSignal,
) => {
  const { session, token, secretHash } = authenticateProExternal(authorization, command.action);
  const scope = { projectId: session.projectId, generation: session.generation };
  const requestId = externalRequestId(token.tokenId, command.requestId);
  const legacyRequestId = `pro-ext-${token.tokenId}-${command.requestId}`.slice(0, 200);
  if (requestId !== legacyRequestId) {
    const legacyExists =
      command.action === 'create'
        ? session.store.proSessions.hasRequest(
            session.projectId,
            session.learnerUid,
            legacyRequestId,
          )
        : command.action === 'send' &&
          Boolean(
            session.store.proSessions
              .get(session.projectId, session.learnerUid, command.sessionId)
              ?.events.some((event) => event.requestId === legacyRequestId),
          );
    if (legacyExists)
      throw new StudyError(
        'VERSION_CONFLICT',
        { reason: 'pro_external_legacy_request_requires_review' },
        '此长请求编号已有旧版截断回执，请先核对原会话；不会按新编号再次执行。',
      );
  }
  const verifyAuthorization = (): void =>
    assertProExternalAuthorization({
      scope,
      secretHash,
      tokenId: token.tokenId,
      action: command.action,
    });
  if (command.action === 'list') {
    const view = readProSessions(scope);
    return { detail: null, sessions: view.sessions, replayed: false };
  }
  if (command.action === 'get') {
    const result = await commandProSession(
      { scope, requestId, action: 'get', sessionId: command.sessionId },
      signal,
      verifyAuthorization,
    );
    return { detail: result.detail, sessions: [], replayed: result.replayed };
  }
  if (command.action === 'create') {
    const result = await commandProSession(
      { scope, requestId, action: 'create', title: command.title },
      signal,
      verifyAuthorization,
    );
    return { detail: result.detail, sessions: [], replayed: result.replayed };
  }
  // send
  const result = await commandProSession(
    {
      scope,
      requestId,
      action: 'send',
      sessionId: command.sessionId,
      expectedRevision: command.expectedRevision,
      content: command.content,
      bundleId: command.bundleId,
      bundleDigest: command.bundleDigest,
      skillIds: command.skillIds,
    },
    signal,
    verifyAuthorization,
  );
  return { detail: result.detail, sessions: [], replayed: result.replayed };
};
