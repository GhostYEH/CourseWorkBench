/**
 * 备考计划版本（repository）。
 *
 * 只有 confirmed 版本可以进入课程生成。载荷按 `planPayloadSchema` 读写：
 * 写入前校验，读取时按权威列校验——损坏或版本不符的计划不能被当作「没有计划」静默降级，
 * 也不能被 run 消费。
 */

import type { PlanPayloadDto } from '@sew/study-contracts';
import { StudyError } from '@sew/study-contracts';
import type { SqlDatabase } from '../driver';
import { encodeJson, planPayloadSchema } from '../json-codec';
import {
  defaultJsonPolicy,
  mapPlanStatus,
  num,
  readAuthoritativeJsonColumn,
  str,
  type PlanVersionRow,
  type Row,
} from './types';

export type { PlanVersionRow };

const contextOf = (projectId: string, version: number): string =>
  `plan_versions.payload_json[${projectId}#${version}]`;

export class PlansRepository {
  constructor(private readonly db: SqlDatabase) {}

  savePlanVersion(
    projectId: string,
    version: number,
    status: PlanVersionRow['status'],
    payload: PlanPayloadDto,
  ): PlanVersionRow {
    const checked = planPayloadSchema.safeParse(payload);
    if (!checked.success) {
      throw new StudyError('INTERNAL', {
        reason: 'invalid_plan_payload',
        issues: checked.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`),
      });
    }
    this.db
      .prepare(
        `INSERT INTO plan_versions (project_id, version, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, version) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json`,
      )
      .run(projectId, version, status, encodeJson(checked.data), new Date().toISOString());
    const saved = this.getPlanVersion(projectId, version);
    if (!saved) throw new StudyError('INTERNAL', { projectId, version });
    return saved;
  }

  getPlanVersion(projectId: string, version: number): PlanVersionRow | null {
    const row = this.db
      .prepare('SELECT * FROM plan_versions WHERE project_id = ? AND version = ?')
      .get(projectId, version) as Row | undefined;
    return row ? this.mapVersion(row) : null;
  }

  getConfirmedPlan(projectId: string): PlanVersionRow | null {
    const row = this.db
      .prepare(`SELECT * FROM plan_versions WHERE project_id = ? AND status = 'confirmed' ORDER BY version DESC LIMIT 1`)
      .get(projectId) as Row | undefined;
    return row ? this.mapVersion(row) : null;
  }

  /** 最近一版计划（草案或已确认），用于界面展示与调整预览。 */
  getLatestPlan(projectId: string): PlanVersionRow | null {
    const row = this.db
      .prepare('SELECT * FROM plan_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1')
      .get(projectId) as Row | undefined;
    return row ? this.mapVersion(row) : null;
  }

  listPlanVersions(projectId: string): PlanVersionRow[] {
    const rows = this.db
      .prepare('SELECT * FROM plan_versions WHERE project_id = ? ORDER BY version DESC')
      .all(projectId) as Row[];
    return rows.map((row) => this.mapVersion(row));
  }

  private mapVersion(row: Row): PlanVersionRow {
    const version = num(row['version']);
    return {
      version,
      status: mapPlanStatus(str(row['status'])),
      createdAt: str(row['created_at']),
      payload: readAuthoritativeJsonColumn(
        row['payload_json'],
        planPayloadSchema,
        contextOf(str(row['project_id']), version),
        defaultJsonPolicy,
      ),
    };
  }
}
