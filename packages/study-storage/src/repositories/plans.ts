/**
 * 备考计划版本（repository）。
 *
 * 只有 confirmed 版本可以进入课程生成；payload 按 JSON 列解析校验，
 * 损坏时回退 null 并记录诊断（计划缺失会让上层停在「未确认」，不会放行）。
 */

import type { SqlDatabase } from '../driver';
import { arbitrarySchema, decodeJson, encodeJson } from '../json-codec';
import { defaultJsonPolicy, num, str, type Row } from './types';

const decodePayload = <T>(value: unknown, context: string): T | null => {
  const decoded = decodeJson<unknown>(value, arbitrarySchema, null, context);
  if (!decoded.ok && decoded.error) defaultJsonPolicy.warn(decoded.error);
  return decoded.ok ? (decoded.value as T) : null;
};

export class PlansRepository {
  constructor(private readonly db: SqlDatabase) {}

  savePlanVersion(
    projectId: string,
    version: number,
    status: 'draft' | 'confirmed',
    payload: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO plan_versions (project_id, version, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, version) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json`,
      )
      .run(projectId, version, status, encodeJson(payload), new Date().toISOString());
  }

  getConfirmedPlan<T>(projectId: string): { version: number; payload: T } | null {
    const row = this.db
      .prepare(
        `SELECT * FROM plan_versions WHERE project_id = ? AND status = 'confirmed' ORDER BY version DESC LIMIT 1`,
      )
      .get(projectId) as Row | undefined;
    if (!row) return null;
    const version = num(row['version']);
    const payload = decodePayload<T>(row['payload_json'], `plan_versions.payload_json[${projectId}#${version}]`);
    if (payload === null) return null;
    return { version, payload };
  }

  /** 最近一版计划（草案或已确认），用于界面展示与调整预览。 */
  getLatestPlan<T>(
    projectId: string,
  ): { version: number; status: 'draft' | 'confirmed'; payload: T } | null {
    const row = this.db
      .prepare('SELECT * FROM plan_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1')
      .get(projectId) as Row | undefined;
    if (!row) return null;
    const version = num(row['version']);
    const payload = decodePayload<T>(row['payload_json'], `plan_versions.payload_json[${projectId}#${version}]`);
    if (payload === null) return null;
    return {
      version,
      status: str(row['status']) === 'confirmed' ? 'confirmed' : 'draft',
      payload,
    };
  }
}
