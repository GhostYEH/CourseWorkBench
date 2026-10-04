/**
 * 角色档案（repository）。
 *
 * 只保存表达方式配置（名称、人格提示、讲解方式）与版本号；权限位不落库，
 * 由 `permissionsOf` 按 kind 派生，所以「改偏好」不可能「改权限」。
 * 同学上限属于领域规则（PEER-01：零至两名），在写入前检查。
 */

import { createHash } from 'node:crypto';
import {
  MAX_PEER_PROFILES,
  StudyError,
  newId,
  type RecordScope,
  type RoleExplanation,
  type RoleKind,
  type RolePermissionsDto,
} from '@sew/study-contracts';
import type { SqlDatabase } from '../driver';
import { num, recordScope, str, type RoleProfileRow, type Row } from './types';

export interface RoleWriteInput {
  name: string;
  persona: string;
  explanation: RoleExplanation;
}

/** 权限按 kind 派生：同学没有白板写权限，也永远不能代表本人作答。 */
export const permissionsOf = (kind: RoleKind): RolePermissionsDto => ({
  whiteboardWrite: kind === 'teacher',
  answerAsLearner: false,
  speak: true,
  aiIdentityVisible: true,
});

const mapRole = (row: Row): RoleProfileRow => ({
  profileId: str(row['profile_id']),
  kind: str(row['kind']) === 'peer' ? 'peer' : 'teacher',
  name: str(row['name']),
  persona: str(row['persona']),
  explanation: str(row['explanation']) as RoleExplanation,
  configVersion: num(row['config_version']),
  recordScope: recordScope(row['record_scope']),
  permissions: permissionsOf(str(row['kind']) === 'peer' ? 'peer' : 'teacher'),
  createdAt: str(row['created_at']),
  updatedAt: str(row['updated_at']),
});

export class RoleRepository {
  constructor(private readonly db: SqlDatabase) {}

  list(scope: RecordScope): RoleProfileRow[] {
    const rows = this.db
      .prepare('SELECT * FROM role_profiles WHERE record_scope = ? ORDER BY kind DESC, created_at, profile_id')
      .all(scope) as Row[];
    return rows.map(mapRole);
  }

  get(profileId: string, scope: RecordScope): RoleProfileRow | null {
    const row = this.db
      .prepare('SELECT * FROM role_profiles WHERE profile_id = ? AND record_scope = ?')
      .get(profileId, scope) as Row | undefined;
    return row ? mapRole(row) : null;
  }

  create(kind: RoleKind, input: RoleWriteInput, scope: RecordScope): RoleProfileRow {
    if (kind === 'teacher' && this.countOf('teacher', scope) >= 1) {
      throw new StudyError('ROLE_TEACHER_EXISTS');
    }
    if (kind === 'peer' && this.countOf('peer', scope) >= MAX_PEER_PROFILES) {
      throw new StudyError('ROLE_LIMIT_REACHED', { limit: MAX_PEER_PROFILES });
    }
    const profileId = newId<'role'>('role');
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO role_profiles (profile_id, kind, name, persona, explanation, config_version, record_scope, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(profileId, kind, input.name, input.persona, input.explanation, scope, now, now);
    const created = this.get(profileId, scope);
    if (!created) throw new StudyError('INTERNAL', { profileId });
    return created;
  }

  /** 每次有效修改自增版本号：run 冻结的是摘要，改过角色就能被识别出来。 */
  update(profileId: string, input: RoleWriteInput, scope: RecordScope): RoleProfileRow {
    const current = this.get(profileId, scope);
    if (!current) throw new StudyError('NOT_FOUND', { profileId });
    const changed =
      current.name !== input.name || current.persona !== input.persona || current.explanation !== input.explanation;
    if (changed) {
      this.db
        .prepare('UPDATE role_profiles SET name = ?, persona = ?, explanation = ?, config_version = config_version + 1, updated_at = ? WHERE profile_id = ? AND record_scope = ?')
        .run(input.name, input.persona, input.explanation, new Date().toISOString(), profileId, scope);
    }
    const updated = this.get(profileId, scope);
    if (!updated) throw new StudyError('INTERNAL', { profileId });
    return updated;
  }

  delete(profileId: string, scope: RecordScope): void {
    const current = this.get(profileId, scope);
    if (!current) throw new StudyError('NOT_FOUND', { profileId });
    this.db
      .prepare('DELETE FROM role_profiles WHERE profile_id = ? AND record_scope = ?')
      .run(profileId, scope);
  }

  /** 角色集合摘要；没有配置任何角色时返回 null，让 run 如实记录「未配置」。 */
  configDigest(scope: RecordScope): string | null {
    const rows = this.list(scope);
    if (rows.length === 0) return null;
    const material = rows
      .map((row) => `${row.profileId}:${row.kind}:${row.configVersion}:${row.explanation}`)
      .sort()
      .join('|');
    return createHash('sha256').update(material, 'utf8').digest('hex');
  }

  private countOf(kind: RoleKind, scope: RecordScope): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS total FROM role_profiles WHERE record_scope = ? AND kind = ?')
      .get(scope, kind) as Row | undefined;
    return num(row?.['total'] ?? 0);
  }
}

export type { RoleProfileRow };
