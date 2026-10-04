/**
 * 运行、事件与步骤收据（repository）。
 *
 * 收据与事件都靠唯一键去重：重复写入被忽略，保证恢复不重放。
 * 三类 JSON 列（冻结快照、收据结果、事件载荷）都按共享合同的版本化形状读写：
 * 写入前校验，读取时按权威列校验——损坏的收据不能被恢复路径当作已提交事实。
 */

import {
  StudyError,
  type FrozenVersionsDto,
  type RunEventPayloadDto,
  type RunStartReceiptDto,
  type RunState,
} from '@sew/study-contracts';
import type { SqlDatabase } from '../driver';
import { encodeJson, frozenVersionsSchema, runEventPayloadSchema, runStartReceiptSchema } from '../json-codec';
import {
  defaultJsonPolicy,
  mapRun,
  num,
  readAuthoritativeJsonColumn,
  str,
  type Row,
  type RunRow,
} from './types';

export interface RunEventRow {
  seq: number;
  payload: RunEventPayloadDto;
  at: string;
}

export interface StepReceiptRow {
  stepKey: string;
  result: RunStartReceiptDto;
  createdAt: string;
}

export class RunsRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** 收据按 stepKey 去重：重复请求读回既有结果，不重放业务写入。 */
  getReceipt(stepKey: string): StepReceiptRow | null {
    const row = this.db.prepare('SELECT * FROM step_receipts WHERE step_key = ?').get(stepKey) as Row | undefined;
    if (!row) return null;
    return {
      stepKey: str(row['step_key']),
      result: readAuthoritativeJsonColumn(
        row['result_json'],
        runStartReceiptSchema,
        `step_receipts.result_json[${stepKey}]`,
        defaultJsonPolicy,
      ),
      createdAt: str(row['created_at']),
    };
  }

  saveReceipt(stepKey: string, result: RunStartReceiptDto, runId?: string, stepId?: string): void {
    const checked = runStartReceiptSchema.safeParse(result);
    if (!checked.success) {
      throw new StudyError('INTERNAL', {
        reason: 'invalid_receipt_result',
        issues: checked.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`),
      });
    }
    this.db
      .prepare(
        `INSERT INTO step_receipts (step_key, run_id, step_id, result_json, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(step_key) DO NOTHING`,
      )
      .run(stepKey, runId ?? null, stepId ?? null, encodeJson(checked.data), new Date().toISOString());
  }

  createRun(runId: string, state: RunState, frozen: FrozenVersionsDto): RunRow {
    const checked = frozenVersionsSchema.safeParse(frozen);
    if (!checked.success) {
      throw new StudyError('INTERNAL', {
        reason: 'invalid_frozen_versions',
        issues: checked.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`),
      });
    }
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO runs (run_id, state, frozen_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(runId, state, encodeJson(checked.data), now, now);
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as Row | undefined;
    if (!row) throw new StudyError('INTERNAL', { runId });
    return mapRun(row, defaultJsonPolicy);
  }

  updateRunState(runId: string, state: RunState, terminatedReason?: string): RunRow {
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

  /** 本项目最近一次 run；数据库按项目目录隔离，不需要项目列。 */
  getLatestRun(): RunRow | null {
    const row = this.db
      .prepare('SELECT * FROM runs ORDER BY created_at DESC, run_id DESC LIMIT 1')
      .get() as Row | undefined;
    return row ? mapRun(row, defaultJsonPolicy) : null;
  }

  /** 事件按 (run_id, seq) 唯一；重复写入同序号被忽略，保证恢复不重放。 */
  appendRunEvent(runId: string, seq: number, payload: RunEventPayloadDto): RunEventRow {
    const checked = runEventPayloadSchema.safeParse(payload);
    if (!checked.success) {
      throw new StudyError('INTERNAL', {
        reason: 'invalid_run_event',
        issues: checked.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`),
      });
    }
    const at = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO run_events (run_id, seq, type, payload_json, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, seq) DO NOTHING`,
      )
      .run(runId, seq, checked.data.type, encodeJson(checked.data), at);
    const row = this.db.prepare('SELECT * FROM run_events WHERE run_id = ? AND seq = ?').get(runId, seq) as Row | undefined;
    if (!row) throw new StudyError('INTERNAL', { runId, seq });
    return this.mapEvent(row);
  }

  /** 当前最大事件序号：追加前取一次，重复请求不会写出两个同内容事件。 */
  lastRunSeq(runId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS last_seq FROM run_events WHERE run_id = ?')
      .get(runId) as Row | undefined;
    return num(row?.['last_seq'] ?? 0);
  }

  listRunEvents(runId: string, afterSeq = 0): RunEventRow[] {
    const rows = this.db
      .prepare('SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC')
      .all(runId, afterSeq) as Row[];
    return rows.map((row) => this.mapEvent(row));
  }

  private mapEvent(row: Row): RunEventRow {
    const seq = num(row['seq']);
    return {
      seq,
      payload: readAuthoritativeJsonColumn(
        row['payload_json'],
        runEventPayloadSchema,
        `run_events.payload_json[${str(row['run_id'])}#${seq}]`,
        defaultJsonPolicy,
      ),
      at: str(row['at']),
    };
  }
}
