/**
 * 运行、事件与步骤收据（repository）。
 *
 * 收据与事件都靠唯一键去重：重复写入被忽略，保证恢复不重放。
 * 收据结果、事件载荷、运行冻结快照都按 JSON 列做解析校验。
 */

import { StudyError } from '@sew/study-contracts';
import type { SqlDatabase } from '../driver';
import { arbitrarySchema, decodeJson, encodeJson } from '../json-codec';
import {
  defaultJsonPolicy,
  mapRun,
  num,
  str,
  type Row,
  type RunRow,
} from './types';

export interface RunEventRow {
  seq: number;
  type: string;
  payload: unknown;
  at: string;
}

export class RunsRepository {
  constructor(private readonly db: SqlDatabase) {}

  getReceipt(stepKey: string): { stepKey: string; result: unknown; createdAt: string } | null {
    const row = this.db.prepare('SELECT * FROM step_receipts WHERE step_key = ?').get(stepKey) as
      | Row
      | undefined;
    if (!row) return null;
    return {
      stepKey: str(row['step_key']),
      result: decodeUnknown(row['result_json'], 'step_receipts.result_json'),
      createdAt: str(row['created_at']),
    };
  }

  saveReceipt(stepKey: string, result: unknown, runId?: string, stepId?: string): void {
    this.db
      .prepare(
        `INSERT INTO step_receipts (step_key, run_id, step_id, result_json, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(step_key) DO NOTHING`,
      )
      .run(stepKey, runId ?? null, stepId ?? null, encodeJson(result), new Date().toISOString());
  }

  createRun(runId: string, state: string, frozen: Record<string, unknown>): RunRow {
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO runs (run_id, state, frozen_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(runId, state, encodeJson(frozen), now, now);
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as Row;
    return mapRun(row, defaultJsonPolicy);
  }

  updateRunState(runId: string, state: string, terminatedReason?: string): RunRow {
    this.db
      .prepare('UPDATE runs SET state = ?, terminated_reason = ?, updated_at = ? WHERE run_id = ?')
      .run(state, terminatedReason ?? null, new Date().toISOString(), runId);
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as Row | undefined;
    if (!row) throw new StudyError('NOT_FOUND', { runId });
    return mapRun(row, defaultJsonPolicy);
  }

  getRun(runId: string): RunRow | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as Row | undefined;
    return row ? mapRun(row, defaultJsonPolicy) : null;
  }

  /** 事件按 (run_id, seq) 唯一；重复写入同序号被忽略，保证恢复不重放。 */
  appendRunEvent(runId: string, seq: number, type: string, payload: unknown): void {
    this.db
      .prepare(
        `INSERT INTO run_events (run_id, seq, type, payload_json, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, seq) DO NOTHING`,
      )
      .run(runId, seq, type, encodeJson(payload), new Date().toISOString());
  }

  listRunEvents(runId: string, afterSeq = 0): RunEventRow[] {
    const rows = this.db
      .prepare('SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC')
      .all(runId, afterSeq) as Row[];
    return rows.map((row) => ({
      seq: num(row['seq']),
      type: str(row['type']),
      payload: decodeUnknown(row['payload_json'], 'run_events.payload_json'),
      at: str(row['at']),
    }));
  }
}

/** 任意载荷列：解析失败时记录诊断并回退 null，不影响服务可用。 */
const decodeUnknown = (value: unknown, context: string): unknown => {
  const decoded = decodeJson<unknown>(value, arbitrarySchema, null, context);
  if (!decoded.ok && decoded.error) defaultJsonPolicy.warn(decoded.error);
  return decoded.value;
};
