/**
 * 独立协作服务的存储门面（ADR-0005）。
 *
 * 与本地学习服务的 `StudyStore` 分开：这里打开的是**协作服务自己的库**，
 * 只承载共享房间权威（邀请/成员/消息/事件/快照）与本人凭据；个人草稿/答案/
 * 判分/错题/掌握/材料库不在这里。
 *
 * 复用同一份迁移清单与领域判定（`@sew/study-domain` 的 `collaboration` /
 * `collaboration-auth`），本层不自行决定「能不能认证」「能不能推进场景」。
 * 凭据只存 `secret` 的 SHA-256 哈希；`secret` 本身永不落库、不进日志/快照/导出。
 */

import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import {
  StudyError,
  collabCredentialSchema,
  collabOnlineRegisterCommandSchema,
  collabOnlineRegistrationSchema,
  learnerUidSchema,
  type CollabCredentialDto,
  type CollabOnlineRegistrationDto,
  type CollabRegistrationDto,
} from '@sew/study-contracts';
import {
  assertCollabCredentialRevocable,
  assertCollabRegistrationCreatable,
  collabSecretHash,
  collabSecretMatches,
} from '@sew/study-domain';
import { createNodeSqliteDriver, type SqlDatabase, type SqliteDriver } from './driver';
import { applyMigrations } from './schema';
import { CollaborationRepository } from './repositories/collaboration';
import { decodeJson, encodeJson } from './json-codec';
import type { Row } from './repositories/types';

const id = z.string().min(1).max(200);
const revokeSchema = z.object({ credentialId: id, actorUid: id, requestId: id }).strict();

/** 凭据的完整存储记录：`secretHash` 只在本层使用，绝不对外暴露。 */
interface CredentialRecord {
  credentialId: string;
  uid: string;
  secretHash: string;
  status: 'active' | 'revoked';
  createdAt: string;
  revokedAt: string | null;
}

const toCredentialDto = (record: CredentialRecord): CollabCredentialDto =>
  collabCredentialSchema.parse({
    credentialId: record.credentialId,
    uid: record.uid,
    status: record.status,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
  });

export interface CollabServiceStoreOptions {
  file: string;
  driver?: SqliteDriver;
}

export class CollabServiceStore {
  private readonly db: SqlDatabase;
  /** 在线协作仓库：登记 authority 固定 `online`。 */
  readonly collaboration: CollaborationRepository;

  private constructor(
    db: SqlDatabase,
    readonly databaseFile: string,
  ) {
    this.db = db;
    this.collaboration = new CollaborationRepository(db, { authority: 'online' });
  }

  static open(options: CollabServiceStoreOptions): CollabServiceStore {
    const driver = options.driver ?? createNodeSqliteDriver();
    const db = driver.open(options.file);
    try {
      applyMigrations(db);
      return new CollabServiceStore(db, options.file);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  // ——————————————————————————— 凭据 ———————————————————————————

  private readCredential(credentialId: string): CredentialRecord | null {
    const row = this.db
      .prepare('SELECT * FROM collab_credentials WHERE credential_id=?')
      .get(credentialId) as Row | undefined;
    if (!row) return null;
    return {
      credentialId: String(row['credential_id']),
      uid: String(row['uid']),
      secretHash: String(row['secret_hash']),
      status: row['status'] === 'revoked' ? 'revoked' : 'active',
      createdAt: String(row['created_at']),
      revokedAt: row['revoked_at'] === null ? null : String(row['revoked_at']),
    };
  }

  /** 该 UID 是否已有凭据：决定首次登记还是追加/轮换。 */
  hasCredentials(uid: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS present FROM collab_credentials WHERE uid=? LIMIT 1')
      .get(uid) as Row | undefined;
    return row !== undefined;
  }

  /** 管理员离线签发一次性 UID 激活令牌；此能力不暴露在 HTTP 路由。 */
  issueRegistrationClaim(uid: string): string {
    const identity = validate(learnerUidSchema, uid);
    return this.db.transaction(() => {
      if (this.hasCredentials(identity)) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_uid_already_registered' });
      }
      const token = randomBytes(32).toString('hex');
      this.db
        .prepare(
          `INSERT INTO collab_registration_claims
        (uid, token_hash, consumed_credential_id, created_at) VALUES (?,?,NULL,?)
        ON CONFLICT(uid) DO UPDATE SET token_hash=excluded.token_hash,
        consumed_credential_id=NULL, created_at=excluded.created_at`,
        )
        .run(identity, collabSecretHash(token), new Date().toISOString());
      return token;
    });
  }

  /** `credentialId` 已被哪个 UID 占用；未被占用为 null。 */
  credentialOwner(credentialId: string): string | null {
    return this.readCredential(credentialId)?.uid ?? null;
  }

  /**
   * 验证凭据：只有「存在、归属匹配、仍是 active、秘密哈希一致」才返回记录。
   * 任一不满足返回 null（由调用方转成统一的认证失败语义，不泄露是哪一步失败）。
   */
  verifyCredential(credentialId: string, secret: string): CredentialRecord | null {
    const record = this.readCredential(credentialId);
    if (!record || record.status !== 'active') return null;
    if (!collabSecretMatches(secret, record.secretHash)) return null;
    return record;
  }

  listCredentials(uid: string): CollabCredentialDto[] {
    const rows = this.db
      .prepare('SELECT * FROM collab_credentials WHERE uid=? ORDER BY created_at, credential_id')
      .all(uid) as Row[];
    return rows.map((row) => {
      const record = this.readCredential(String(row['credential_id']));
      if (!record) throw new StudyError('INTERNAL', { reason: 'collab_credential_corrupt' });
      return toCredentialDto(record);
    });
  }

  /**
   * 在线登记：首次占用 UID，或带有效证明凭据追加/轮换。
   *
   * 幂等：同一 `credentialId` 重复提交返回既有结果，不重复占用；`requestId` 记入收据，
   * 同一 requestId 与意图重试读回既有回执。
   */
  registerOnline(raw: unknown): {
    registration: CollabOnlineRegistrationDto;
    credential: CollabCredentialDto;
    deduplicated: boolean;
  } {
    const input = validate(collabOnlineRegisterCommandSchema, raw);
    return this.db.transaction(() => {
      // 收据里保存的是脱敏 intent（不含 secret），读取比对也用同一份脱敏结果。
      const receiptIntent = redactSecrets(input);
      const prior = this.receipt(input.requestId, 'register-credential', input.uid, receiptIntent);
      if (prior) {
        const stored = prior as { credential: { credentialId: string } };
        const record = this.readCredential(stored.credential.credentialId);
        const registration = this.collaboration.getRegistration(input.uid);
        if (!record || !registration) {
          throw new StudyError('INTERNAL', { reason: 'collab_credential_receipt_missing' });
        }
        if (!collabSecretMatches(input.secret, record.secretHash)) {
          throw new StudyError('VERSION_CONFLICT', { reason: 'collab_credential_taken' });
        }
        return {
          registration: asOnline(registration, record.credentialId),
          credential: toCredentialDto(record),
          deduplicated: true,
        };
      }
      // 同一 credentialId 重复登记（换 requestId 重发也应幂等）：秘密一致即读回既有结果，
      // 不一致说明句柄被复用到了另一份秘密上，明确拒绝而不是覆盖。
      const existing = this.readCredential(input.credentialId);
      if (existing) {
        if (existing.uid !== input.uid || !collabSecretMatches(input.secret, existing.secretHash)) {
          throw new StudyError('VERSION_CONFLICT', { reason: 'collab_credential_taken' });
        }
        const registration = this.collaboration.getRegistration(input.uid);
        if (!registration)
          throw new StudyError('INTERNAL', { reason: 'collab_registration_missing' });
        return {
          registration: asOnline(registration, input.credentialId),
          credential: toCredentialDto(existing),
          deduplicated: true,
        };
      }
      // 新 credentialId：首次登记需 UID 激活令牌；追加/轮换必须带本人有效凭据。
      const proofRecord = input.proof ? this.readCredential(input.proof.credentialId) : null;
      const proofValid =
        input.proof !== null &&
        proofRecord !== null &&
        proofRecord.status === 'active' &&
        collabSecretMatches(input.proof.secret, proofRecord.secretHash);
      const claim = this.db
        .prepare('SELECT * FROM collab_registration_claims WHERE uid=?')
        .get(input.uid) as Row | undefined;
      const enrollmentValid =
        claim !== undefined &&
        claim['consumed_credential_id'] === null &&
        input.activationToken !== undefined &&
        collabSecretMatches(input.activationToken, String(claim['token_hash']));
      assertCollabRegistrationCreatable({
        uid: input.uid,
        uidHasCredentials: this.hasCredentials(input.uid),
        enrollmentValid,
        credentialIdOwnerUid: null,
        proof: input.proof === null ? null : { credential: proofValid ? proofRecord : null },
      });
      const now = new Date().toISOString();
      this.db
        .prepare(
          'INSERT INTO collab_credentials (credential_id, uid, secret_hash, status, created_at, revoked_at) VALUES (?,?,?,?,?,NULL)',
        )
        .run(input.credentialId, input.uid, collabSecretHash(input.secret), 'active', now);
      if (enrollmentValid) {
        this.db
          .prepare('UPDATE collab_registration_claims SET consumed_credential_id=? WHERE uid=?')
          .run(input.credentialId, input.uid);
      }
      // 登记记录（authority=online）。用派生的 requestId，避免与凭据收据抢占同一主键。
      const { registration } = this.collaboration.register({
        uid: input.uid,
        displayName: input.displayName,
        requestId: `cred:${input.requestId}`,
      });
      const record = this.readCredential(input.credentialId);
      if (!record) throw new StudyError('INTERNAL', { reason: 'collab_credential_missing' });
      const result = {
        registration: asOnline(registration, input.credentialId),
        credential: toCredentialDto(record),
      };
      this.writeReceipt(input.requestId, 'register-credential', input.uid, receiptIntent, result);
      return { ...result, deduplicated: false };
    });
  }

  /** 吊销凭据：只有本人能吊销自己的；吊销后一律不能认证。幂等。 */
  revokeCredential(raw: unknown): { credential: CollabCredentialDto; deduplicated: boolean } {
    const input = validate(revokeSchema, raw);
    return this.db.transaction(() => {
      const prior = this.receipt(input.requestId, 'revoke-credential', input.actorUid, input);
      if (prior) {
        const stored = prior as { credential: { credentialId: string } };
        const record = this.readCredential(stored.credential.credentialId);
        if (!record)
          throw new StudyError('INTERNAL', { reason: 'collab_credential_receipt_missing' });
        return { credential: toCredentialDto(record), deduplicated: true };
      }
      const record = this.readCredential(input.credentialId);
      assertCollabCredentialRevocable({
        credential: record
          ? {
              credentialId: record.credentialId,
              uid: record.uid,
              status: record.status,
              createdAt: record.createdAt,
              revokedAt: record.revokedAt,
            }
          : null,
        actorUid: input.actorUid,
      });
      const now = new Date().toISOString();
      if (record && record.status !== 'revoked') {
        this.db
          .prepare(
            "UPDATE collab_credentials SET status='revoked', revoked_at=? WHERE credential_id=?",
          )
          .run(now, input.credentialId);
      }
      const updated = this.readCredential(input.credentialId);
      if (!updated) throw new StudyError('INTERNAL', { reason: 'collab_credential_missing' });
      const result = { credential: toCredentialDto(updated) };
      this.writeReceipt(input.requestId, 'revoke-credential', input.actorUid, input, result);
      return { ...result, deduplicated: false };
    });
  }

  // ——————————————————————————— 收据 ———————————————————————————

  private receipt(
    requestId: string,
    action: string,
    actorUid: string,
    intent: unknown,
  ): unknown | null {
    if (!requestId.trim() || requestId.length > 200) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_request_id_invalid' });
    }
    const row = this.db
      .prepare('SELECT * FROM collab_command_receipts WHERE request_id=?')
      .get(requestId) as Row | undefined;
    if (!row) return null;
    if (
      row['action'] !== action ||
      row['actor_uid'] !== actorUid ||
      row['intent_json'] !== encodeJson(intent)
    ) {
      throw new StudyError('VERSION_CONFLICT', { reason: 'collab_request_reused' });
    }
    return decodeReceipt(row['result_json']);
  }

  private writeReceipt(
    requestId: string,
    action: string,
    actorUid: string,
    intent: unknown,
    result: unknown,
  ): void {
    this.db
      .prepare(
        'INSERT INTO collab_command_receipts (request_id, action, actor_uid, intent_json, result_json, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        requestId,
        action,
        actorUid,
        encodeJson(intent),
        encodeJson(result),
        new Date().toISOString(),
      );
  }
}

/** 收据结果以 JSON 文本存储；读取时集中解码（json-codec），损坏即拒绝。 */
const decodeReceipt = (value: unknown): unknown => {
  const decoded = decodeJson(value, z.unknown(), null, 'collab_command_receipts.result_json');
  if (!decoded.ok) throw new StudyError('INTERNAL', { reason: 'collab_receipt_invalid' });
  return decoded.value;
};

/**
 * 收据 intent 脱敏：登记命令携带 `secret`/`proof.secret`，凭据秘密**永不落库**。
 *
 * 收据只保存秘密哈希，重试仍绑定同一秘密，防止换了秘密却读回原登记。
 */
const redactSecrets = (input: {
  secret: string;
  activationToken?: string;
  proof: { secret: string } | null;
}): unknown => ({
  ...input,
  secret: collabSecretHash(input.secret),
  ...(input.activationToken ? { activationToken: collabSecretHash(input.activationToken) } : {}),
  proof:
    input.proof === null ? null : { ...input.proof, secret: collabSecretHash(input.proof.secret) },
});

const validate = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_input_invalid' });
  return parsed.data;
};

/** 登记记录里 `authority` 必须是 `online`，并补上公开句柄 `credentialId`。 */
const asOnline = (
  registration: CollabRegistrationDto,
  credentialId: string,
): CollabOnlineRegistrationDto => {
  if (registration.authority !== 'online') {
    throw new StudyError('INTERNAL', { reason: 'collab_registration_not_online' });
  }
  return collabOnlineRegistrationSchema.parse({ ...registration, credentialId });
};
