/**
 * 部署访问码仓储（OMA-083）。
 *
 * 只保存 SHA-256 哈希与公开元数据；`secret` 明文由服务层生成、签发时返回一次后即不再持有。
 * 撤销是软删除（写 `revoked_at`），历史保留以便审计。
 */

import { z } from 'zod';
import {
  StudyError,
  deploymentAccessCodeSchema,
  DEPLOYMENT_ACCESS_SCOPES,
  type DeploymentAccessCodeDto,
  type DeploymentAccessScope,
} from '@sew/study-contracts';
import type { SqlDatabase } from '../driver';
import { encodeJson } from '../json-codec';
import { readRequiredJsonColumn, nullableStr, str, type Row } from './types';

export interface CreateDeploymentAccessCodeInput {
  codeId: string;
  projectId: string;
  label: string;
  secretHash: string;
  scopes: DeploymentAccessScope[];
  createdAt: string;
  expiresAt: string;
}

const scopesSchema = z
  .array(z.enum(DEPLOYMENT_ACCESS_SCOPES))
  .min(1)
  .max(DEPLOYMENT_ACCESS_SCOPES.length);

const mapCode = (row: Row): DeploymentAccessCodeDto =>
  deploymentAccessCodeSchema.parse({
    codeId: str(row['code_id']),
    projectId: str(row['project_id']),
    label: str(row['label']),
    scopes: readRequiredJsonColumn(
      row['scopes_json'],
      scopesSchema,
      'deployment_access_codes.scopes_json',
      { reason: 'invalid_deployment_access_code' },
    ),
    createdAt: str(row['created_at']),
    expiresAt: str(row['expires_at']),
    revokedAt: nullableStr(row['revoked_at']),
    usedCount: Number(row['used_count']),
  });

const SELECT_COLUMNS =
  'code_id, project_id, label, scopes_json, created_at, expires_at, revoked_at, used_count';

export class DeploymentAccessCodeRepository {
  constructor(private readonly db: SqlDatabase) {}

  get(projectId: string, codeId: string): DeploymentAccessCodeDto | null {
    const row = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM deployment_access_codes WHERE project_id=? AND code_id=?`,
      )
      .get(projectId, codeId) as Row | undefined;
    return row ? mapCode(row) : null;
  }

  list(projectId: string): DeploymentAccessCodeDto[] {
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM deployment_access_codes WHERE project_id=? ORDER BY created_at DESC, code_id`,
      )
      .all(projectId) as Row[];
    return rows.map(mapCode);
  }

  /** 认证入口：按明文哈希反查；哈希唯一。 */
  findBySecretHash(
    secretHash: string,
  ): { code: DeploymentAccessCodeDto; secretHash: string } | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLUMNS}, secret_hash FROM deployment_access_codes WHERE secret_hash=?`)
      .get(secretHash) as Row | undefined;
    if (!row) return null;
    return { code: mapCode(row), secretHash: str(row['secret_hash']) };
  }

  create(input: CreateDeploymentAccessCodeInput): DeploymentAccessCodeDto {
    const code = deploymentAccessCodeSchema.parse({
      codeId: input.codeId,
      projectId: input.projectId,
      label: input.label,
      scopes: input.scopes,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      revokedAt: null,
      usedCount: 0,
    });
    this.db
      .prepare(
        'INSERT INTO deployment_access_codes (code_id, project_id, label, secret_hash, scopes_json, created_at, expires_at, revoked_at, used_count) VALUES (?,?,?,?,?,?,?,NULL,0)',
      )
      .run(
        code.codeId,
        input.projectId,
        code.label,
        input.secretHash,
        encodeJson(code.scopes),
        code.createdAt,
        code.expiresAt,
      );
    return code;
  }

  /** 撤销（软删除）：写 revoked_at；重复撤销保持首次时间。 */
  revoke(input: { projectId: string; codeId: string; revokedAt: string }): DeploymentAccessCodeDto {
    const current = this.get(input.projectId, input.codeId);
    if (!current) throw new StudyError('NOT_FOUND', { codeId: input.codeId });
    if (current.revokedAt === null) {
      this.db
        .prepare(
          'UPDATE deployment_access_codes SET revoked_at=? WHERE project_id=? AND code_id=?',
        )
        .run(input.revokedAt, input.projectId, input.codeId);
    }
    return this.get(input.projectId, input.codeId)!;
  }

  /** 兑换计数：成功兑换后 +1（用于审计与配额，不改变有效期）。 */
  noteUsed(projectId: string, codeId: string): void {
    this.db
      .prepare('UPDATE deployment_access_codes SET used_count=used_count+1 WHERE project_id=? AND code_id=?')
      .run(projectId, codeId);
  }

  /** 读取兑换收据：同 requestId 与意图重发读回既有结论，不重复计数。 */
  receipt(
    projectId: string,
    requestId: string,
    intent: string,
  ): { codeId: string; uid: string; scope: DeploymentAccessScope } | null {
    const row = this.db
      .prepare(
        'SELECT code_id, uid, scope, intent_json FROM deployment_access_receipts WHERE project_id=? AND request_id=?',
      )
      .get(projectId, requestId) as Row | undefined;
    if (!row) return null;
    if (str(row['intent_json']) !== intent) {
      throw new StudyError('VERSION_CONFLICT', { reason: 'deployment_redeem_nonce_reused' });
    }
    return {
      codeId: str(row['code_id']),
      uid: str(row['uid']),
      scope: str(row['scope']) as DeploymentAccessScope,
    };
  }

  saveReceipt(input: {
    projectId: string;
    requestId: string;
    codeId: string;
    uid: string;
    scope: DeploymentAccessScope;
    intent: string;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        'INSERT INTO deployment_access_receipts (project_id, request_id, code_id, uid, scope, intent_json, created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        input.projectId,
        input.requestId,
        input.codeId,
        input.uid,
        input.scope,
        input.intent,
        input.createdAt,
      );
  }
}

/** 供备份/迁移测试枚举：本仓库涉及的表名。 */
export const DEPLOYMENT_ACCESS_TABLES = [
  'deployment_access_codes',
  'deployment_access_receipts',
] as const;
