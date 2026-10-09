/**
 * Pro 外部 token 仓储（OMA-017）。
 *
 * 只保存 SHA-256 哈希与公开元数据；`secret` 明文由服务层生成、创建时返回一次后即不再持有。
 * 读取/列表永不返回哈希或明文。撤销是软删除（写 revoked_at），历史保留以便审计。
 */

import { z } from 'zod';
import {
  StudyError,
  proExternalTokenSchema,
  PRO_EXTERNAL_SCOPES,
  type ProExternalScope,
  type ProExternalTokenDto,
} from '@sew/study-contracts';
import type { SqlDatabase } from '../driver';
import { encodeJson } from '../json-codec';
import { readRequiredJsonColumn, nullableStr, str, type Row } from './types';

export interface CreateProExternalTokenInput {
  tokenId: string;
  projectId: string;
  ownerUid: string;
  label: string;
  secretHash: string;
  scopes: ProExternalScope[];
  createdAt: string;
  expiresAt: string;
}

const scopesSchema = z.array(z.enum(PRO_EXTERNAL_SCOPES)).min(1).max(PRO_EXTERNAL_SCOPES.length);

const mapToken = (row: Row): ProExternalTokenDto => {
  const token = proExternalTokenSchema.parse({
    tokenId: str(row['token_id']),
    label: str(row['label']),
    projectId: str(row['project_id']),
    ownerUid: str(row['owner_uid']),
    scopes: readRequiredJsonColumn(
      row['scopes_json'],
      scopesSchema,
      'pro_external_tokens.scopes_json',
      { reason: 'invalid_pro_external_token' },
    ),
    createdAt: str(row['created_at']),
    expiresAt: str(row['expires_at']),
    revokedAt: nullableStr(row['revoked_at']),
  });
  if (token.tokenId !== str(row['token_id'])) {
    throw new StudyError('INTERNAL', { reason: 'invalid_pro_external_token' });
  }
  return token;
};

export class ProExternalTokensRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** 按公开 tokenId 取元数据（不含哈希）。 */
  get(projectId: string, ownerUid: string, tokenId: string): ProExternalTokenDto | null {
    const row = this.db
      .prepare(
        'SELECT token_id, project_id, owner_uid, label, scopes_json, created_at, expires_at, revoked_at FROM pro_external_tokens WHERE project_id=? AND owner_uid=? AND token_id=?',
      )
      .get(projectId, ownerUid, tokenId) as Row | undefined;
    return row ? mapToken(row) : null;
  }

  list(projectId: string, ownerUid: string): ProExternalTokenDto[] {
    const rows = this.db
      .prepare(
        'SELECT token_id, project_id, owner_uid, label, scopes_json, created_at, expires_at, revoked_at FROM pro_external_tokens WHERE project_id=? AND owner_uid=? ORDER BY created_at DESC, token_id',
      )
      .all(projectId, ownerUid) as Row[];
    return rows.map(mapToken);
  }

  /** 认证入口：按 secret 哈希反查 token 元数据；哈希唯一。 */
  findBySecretHash(secretHash: string): { token: ProExternalTokenDto; secretHash: string } | null {
    const row = this.db
      .prepare(
        'SELECT token_id, project_id, owner_uid, label, scopes_json, created_at, expires_at, revoked_at, secret_hash FROM pro_external_tokens WHERE secret_hash=?',
      )
      .get(secretHash) as Row | undefined;
    if (!row) return null;
    return { token: mapToken(row), secretHash: str(row['secret_hash']) };
  }

  create(input: CreateProExternalTokenInput): ProExternalTokenDto {
    const now = input.createdAt;
    const token = proExternalTokenSchema.parse({
      tokenId: input.tokenId,
      label: input.label,
      projectId: input.projectId,
      ownerUid: input.ownerUid,
      scopes: input.scopes,
      createdAt: now,
      expiresAt: input.expiresAt,
      revokedAt: null,
    });
    this.db
      .prepare(
        'INSERT INTO pro_external_tokens (token_id, project_id, owner_uid, label, secret_hash, scopes_json, created_at, expires_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,NULL)',
      )
      .run(
        token.tokenId,
        input.projectId,
        input.ownerUid,
        token.label,
        input.secretHash,
        encodeJson(token.scopes),
        now,
        token.expiresAt,
      );
    return token;
  }

  /** 轮换：用新哈希替换旧哈希并重置有效期；tokenId 与 scopes 不变，历史 secret 立即失效。 */
  rotate(input: {
    projectId: string;
    ownerUid: string;
    tokenId: string;
    secretHash: string;
    expiresAt: string;
  }): ProExternalTokenDto {
    const current = this.get(input.projectId, input.ownerUid, input.tokenId);
    if (!current) throw new StudyError('NOT_FOUND', { tokenId: input.tokenId });
    if (current.revokedAt !== null)
      throw new StudyError('VERSION_CONFLICT', { reason: 'pro_external_token_revoked' });
    this.db
      .prepare(
        'UPDATE pro_external_tokens SET secret_hash=?, expires_at=?, revoked_at=NULL WHERE project_id=? AND owner_uid=? AND token_id=?',
      )
      .run(input.secretHash, input.expiresAt, input.projectId, input.ownerUid, input.tokenId);
    return this.get(input.projectId, input.ownerUid, input.tokenId)!;
  }

  /** 撤销（软删除）：写 revoked_at；重复撤销保持首次时间。 */
  revoke(input: {
    projectId: string;
    ownerUid: string;
    tokenId: string;
    revokedAt: string;
  }): ProExternalTokenDto {
    const current = this.get(input.projectId, input.ownerUid, input.tokenId);
    if (!current) throw new StudyError('NOT_FOUND', { tokenId: input.tokenId });
    if (current.revokedAt === null) {
      this.db
        .prepare(
          'UPDATE pro_external_tokens SET revoked_at=? WHERE project_id=? AND owner_uid=? AND token_id=?',
        )
        .run(input.revokedAt, input.projectId, input.ownerUid, input.tokenId);
    }
    return this.get(input.projectId, input.ownerUid, input.tokenId)!;
  }

  /** 读取管理命令回执：同 requestId 与意图重发读回既有 tokenId，不重复创建/轮换/撤销。 */
  receipt(
    projectId: string,
    requestId: string,
    action: string,
    intent: string,
  ): { action: string; tokenId: string } | null {
    const row = this.db
      .prepare(
        'SELECT action, intent_json, token_id FROM pro_external_token_receipts WHERE project_id=? AND request_id=?',
      )
      .get(projectId, requestId) as Row | undefined;
    if (!row) return null;
    if (str(row['action']) !== action || str(row['intent_json']) !== intent) {
      throw new StudyError('VERSION_CONFLICT', { reason: 'pro_external_token_nonce_reused' });
    }
    return { action, tokenId: str(row['token_id']) };
  }

  saveReceipt(input: {
    projectId: string;
    requestId: string;
    action: 'create' | 'rotate' | 'revoke';
    intent: string;
    tokenId: string;
  }): void {
    this.db
      .prepare(
        'INSERT INTO pro_external_token_receipts (project_id, request_id, action, intent_json, token_id, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        input.projectId,
        input.requestId,
        input.action,
        input.intent,
        input.tokenId,
        new Date().toISOString(),
      );
  }
}
