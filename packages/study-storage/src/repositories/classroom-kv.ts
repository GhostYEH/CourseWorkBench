/** Account KV values for the local service; device values stay in browser storage. */
import type { SqlDatabase } from '../driver';
import { arbitrarySchema, decodeJson, encodeJson } from '../json-codec';
import { defaultJsonPolicy, str, type Row } from './types';

export class ClassroomKVRepository {
  constructor(private readonly db: SqlDatabase) {}

  get<T>(projectId: string, learnerKey: string, key: string): T | null {
    const row = this.db.prepare(`SELECT value_json FROM classroom_kv
      WHERE project_id = ? AND learner_key = ? AND kv_key = ?`).get(projectId, learnerKey, key) as Row | undefined;
    if (!row) return null;
    const decoded = decodeJson<unknown>(row['value_json'], arbitrarySchema, null, `classroom_kv.value_json[${key}]`);
    if (!decoded.ok && decoded.error) defaultJsonPolicy.warn(decoded.error);
    if (!decoded.ok) throw new Error(decoded.error ?? 'invalid persisted KV value');
    return decoded.value as T;
  }

  set(projectId: string, learnerKey: string, key: string, value: unknown): void {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('KV values must be JSON-serializable');
    this.db.prepare(`INSERT INTO classroom_kv (project_id, learner_key, kv_key, value_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, learner_key, kv_key) DO UPDATE SET
        value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(projectId, learnerKey, key, encodeJson(value), new Date().toISOString());
  }

  remove(projectId: string, learnerKey: string, key: string): void {
    this.db.prepare(`DELETE FROM classroom_kv
      WHERE project_id = ? AND learner_key = ? AND kv_key = ?`).run(projectId, learnerKey, key);
  }

  keys(projectId: string, learnerKey: string, prefix = ''): string[] {
    const rows = this.db.prepare(`SELECT kv_key FROM classroom_kv
      WHERE project_id = ? AND learner_key = ? ORDER BY kv_key ASC`).all(projectId, learnerKey) as Row[];
    return rows.map((row) => str(row['kv_key'])).filter((key) => key.startsWith(prefix));
  }
}
