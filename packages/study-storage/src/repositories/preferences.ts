/**
 * 偏好（repository）。
 *
 * 全局偏好（外观/阅读）与项目级教学表达分开存储；两者都按 JSON 列解析校验。
 * 偏好不改变事实、不改变权限，因此损坏时回退 null 并记录诊断即可。
 */

import type { SqlDatabase } from '../driver';
import { arbitrarySchema, decodeJson, encodeJson } from '../json-codec';
import { defaultJsonPolicy, num, type Row } from './types';

export interface StoredPreference<T> {
  value: T | null;
  version: number;
}

const decodeValue = <T>(value: unknown, context: string): T | null => {
  const decoded = decodeJson<unknown>(value, arbitrarySchema, null, context);
  if (!decoded.ok && decoded.error) defaultJsonPolicy.warn(decoded.error);
  return decoded.ok ? (decoded.value as T) : null;
};

export class PreferencesRepository {
  constructor(private readonly db: SqlDatabase) {}

  readPreference<T>(key: string): StoredPreference<T> {
    const row = this.db.prepare('SELECT * FROM preferences WHERE key = ?').get(key) as Row | undefined;
    if (!row) return { value: null, version: 0 };
    return { value: decodeValue<T>(row['value_json'], `preferences.value_json[${key}]`), version: num(row['version']) };
  }

  writePreference(key: string, value: unknown): number {
    const existing = this.readPreference(key);
    const version = existing.version + 1;
    this.db
      .prepare(
        `INSERT INTO preferences (key, value_json, version, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, version = excluded.version, updated_at = excluded.updated_at`,
      )
      .run(key, encodeJson(value), version, new Date().toISOString());
    return version;
  }

  readTeachingPreference<T>(projectId: string): StoredPreference<T> {
    const row = this.db
      .prepare('SELECT * FROM teaching_preferences WHERE project_id = ?')
      .get(projectId) as Row | undefined;
    if (!row) return { value: null, version: 0 };
    return {
      value: decodeValue<T>(row['value_json'], `teaching_preferences.value_json[${projectId}]`),
      version: num(row['version']),
    };
  }

  writeTeachingPreference(projectId: string, value: unknown): number {
    const existing = this.readTeachingPreference(projectId);
    const version = existing.version + 1;
    this.db
      .prepare(
        `INSERT INTO teaching_preferences (project_id, value_json, version, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET value_json = excluded.value_json, version = excluded.version, updated_at = excluded.updated_at`,
      )
      .run(projectId, encodeJson(value), version, new Date().toISOString());
    return version;
  }
}
