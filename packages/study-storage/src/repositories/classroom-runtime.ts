/** Project-local persistence for the OpenMAIC RuntimeStore contract. */
import type { SqlDatabase } from '../driver';
import { arbitrarySchema, encodeJson } from '../json-codec';
import { defaultJsonPolicy, readAuthoritativeJsonColumn, str, type Row } from './types';

export type RuntimeStatus = 'active' | 'completed' | 'archived';

export interface RuntimeSessionRow {
  id: string;
  runtimeDslVersion: string;
  kind: string;
  stageId: string;
  learnerKey: string;
  status: RuntimeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeRecordRow {
  id: string;
  sessionId: string;
  seq: number;
  sceneId?: string;
  actionIndex?: number;
  subAnchor?: string;
  createdAt: string;
  payload: unknown;
}

export interface RuntimeRecordInput {
  id: string;
  sessionId: string;
  sceneId?: string;
  actionIndex?: number;
  subAnchor?: string;
  createdAt: string;
  payload: unknown;
}

export interface RuntimeAppendOptions {
  expectedLastSeq?: number | null;
  sessionTransition?: { status: RuntimeStatus; updatedAt: string };
}

export interface RuntimeQuizReceiptRow {
  idempotencyKey: string;
  sessionId: string;
  questionId: string;
  recordId: string;
  createdAt: string;
}

export class RuntimeAppendConflict extends Error {
  constructor(
    readonly sessionId: string,
    readonly expectedLastSeq: number | null,
    readonly actualLastSeq: number | null,
  ) {
    super(`runtime tail changed for session ${JSON.stringify(sessionId)}`);
    this.name = 'RuntimeAppendConflict';
  }
}

export class RuntimeSessionExists extends Error {
  readonly code = 'SESSION_ALREADY_EXISTS';
  constructor(readonly sessionId: string) {
    super(`runtime session already exists: ${JSON.stringify(sessionId)}`);
    this.name = 'RuntimeSessionExists';
  }
}

const mapSession = (row: Row): RuntimeSessionRow => ({
  id: str(row['session_id']),
  runtimeDslVersion: str(row['runtime_dsl_version']),
  kind: str(row['kind']),
  stageId: str(row['stage_id']),
  learnerKey: str(row['learner_key']),
  status: str(row['status']) as RuntimeStatus,
  createdAt: str(row['created_at']),
  updatedAt: str(row['updated_at']),
});

const mapRecord = (row: Row, context: string): RuntimeRecordRow => ({
  id: str(row['record_id']),
  sessionId: str(row['session_id']),
  seq: Number(row['seq']),
  ...(typeof row['scene_id'] === 'string' ? { sceneId: row['scene_id'] } : {}),
  ...(typeof row['action_index'] === 'number' ? { actionIndex: row['action_index'] } : {}),
  ...(typeof row['sub_anchor'] === 'string' ? { subAnchor: row['sub_anchor'] } : {}),
  createdAt: str(row['created_at']),
  payload: readAuthoritativeJsonColumn(
    row['payload_json'], arbitrarySchema, `classroom_runtime_records.payload_json[${context}]`, defaultJsonPolicy,
  ),
});

export class ClassroomRuntimeRepository {
  constructor(private readonly db: SqlDatabase) {}

  createSession(projectId: string, session: RuntimeSessionRow): RuntimeSessionRow {
    try {
      this.db.prepare(`INSERT INTO classroom_runtime_sessions
        (project_id, session_id, learner_key, stage_id, kind, runtime_dsl_version, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(projectId, session.id, session.learnerKey, session.stageId, session.kind,
          session.runtimeDslVersion, session.status, session.createdAt, session.updatedAt);
    } catch (error) {
      const existing = this.getSession(projectId, session.id);
      if (existing) throw new RuntimeSessionExists(session.id);
      throw error;
    }
    return session;
  }

  getSession(projectId: string, sessionId: string): RuntimeSessionRow | undefined {
    const row = this.db.prepare(`SELECT * FROM classroom_runtime_sessions
      WHERE project_id = ? AND session_id = ?`).get(projectId, sessionId) as Row | undefined;
    return row ? mapSession(row) : undefined;
  }

  listSessions(projectId: string, stageId: string, learnerKey: string): RuntimeSessionRow[] {
    return (this.db.prepare(`SELECT * FROM classroom_runtime_sessions
      WHERE project_id = ? AND stage_id = ? AND learner_key = ?
      ORDER BY created_at ASC, session_id ASC`).all(projectId, stageId, learnerKey) as Row[])
      .map(mapSession);
  }

  setSessionStatus(
    projectId: string,
    sessionId: string,
    status: RuntimeStatus,
    updatedAt: string,
    expectedLastSeq?: number | null,
  ): void {
    this.db.transaction(() => {
      const session = this.getSession(projectId, sessionId);
      if (!session) throw new Error(`runtime session not found: ${JSON.stringify(sessionId)}`);
      const actualLastSeq = this.getLastSeq(projectId, sessionId);
      if (expectedLastSeq !== undefined && expectedLastSeq !== actualLastSeq) {
        throw new RuntimeAppendConflict(sessionId, expectedLastSeq, actualLastSeq);
      }
      this.db.prepare(`UPDATE classroom_runtime_sessions SET status = ?, updated_at = ?
        WHERE project_id = ? AND session_id = ?`).run(status, updatedAt, projectId, sessionId);
    });
  }

  deleteSession(projectId: string, sessionId: string): void {
    this.db.prepare(`DELETE FROM classroom_runtime_sessions WHERE project_id = ? AND session_id = ?`)
      .run(projectId, sessionId);
  }

  deleteLearnerRuntime(projectId: string, stageId: string, learnerKey: string): void {
    this.db.prepare(`DELETE FROM classroom_runtime_sessions
      WHERE project_id = ? AND stage_id = ? AND learner_key = ?`).run(projectId, stageId, learnerKey);
  }

  deleteStageRuntime(projectId: string, stageId: string): void {
    this.db.prepare(`DELETE FROM classroom_runtime_sessions
      WHERE project_id = ? AND stage_id = ?`).run(projectId, stageId);
  }

  deleteAllRuntime(projectId: string): void {
    this.db.prepare(`DELETE FROM classroom_runtime_sessions WHERE project_id = ?`).run(projectId);
  }

  appendRecord(projectId: string, input: RuntimeRecordInput, options: RuntimeAppendOptions = {}): RuntimeRecordRow {
    return this.db.transaction(() => {
      const session = this.getSession(projectId, input.sessionId);
      if (!session) throw new Error(`runtime session not found: ${JSON.stringify(input.sessionId)}`);
      const existingRow = this.db.prepare(`SELECT * FROM classroom_runtime_records
        WHERE project_id = ? AND session_id = ? AND record_id = ?`)
        .get(projectId, input.sessionId, input.id) as Row | undefined;
      if (existingRow) {
        const existing = mapRecord(existingRow, `${input.sessionId}/${input.id}`);
        const samePayload = encodeJson(existing.payload) === encodeJson(input.payload);
        const sameAnchors = existing.sceneId === input.sceneId &&
          existing.actionIndex === input.actionIndex && existing.subAnchor === input.subAnchor &&
          existing.createdAt === input.createdAt;
        const transitionMatches = !options.sessionTransition ||
          (session.status === options.sessionTransition.status && session.updatedAt === options.sessionTransition.updatedAt);
        if (!samePayload || !sameAnchors || !transitionMatches) {
          throw new Error(`runtime record id reused with different content: ${JSON.stringify(input.id)}`);
        }
        return existing;
      }
      if (session.status !== 'active') {
        throw new Error(`cannot append to runtime session with status ${JSON.stringify(session.status)}`);
      }
      const actualLastSeq = this.getLastSeq(projectId, input.sessionId);
      if (options.expectedLastSeq !== undefined && options.expectedLastSeq !== actualLastSeq) {
        throw new RuntimeAppendConflict(input.sessionId, options.expectedLastSeq, actualLastSeq);
      }
      const record: RuntimeRecordRow = {
        ...input,
        seq: actualLastSeq === null ? 0 : actualLastSeq + 1,
      };
      this.db.prepare(`INSERT INTO classroom_runtime_records
        (project_id, session_id, seq, record_id, scene_id, action_index, sub_anchor, created_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(projectId, input.sessionId, record.seq, input.id, input.sceneId ?? null,
          input.actionIndex ?? null, input.subAnchor ?? null, input.createdAt, encodeJson(input.payload));
      if (options.sessionTransition) {
        this.db.prepare(`UPDATE classroom_runtime_sessions SET status = ?, updated_at = ?
          WHERE project_id = ? AND session_id = ?`)
          .run(options.sessionTransition.status, options.sessionTransition.updatedAt, projectId, input.sessionId);
      }
      return record;
    });
  }

  listRecords(projectId: string, sessionId: string, sceneId?: string): RuntimeRecordRow[] {
    const rows = (sceneId === undefined
      ? this.db.prepare(`SELECT * FROM classroom_runtime_records WHERE project_id = ? AND session_id = ? ORDER BY seq ASC`)
        .all(projectId, sessionId)
      : this.db.prepare(`SELECT * FROM classroom_runtime_records
        WHERE project_id = ? AND session_id = ? AND scene_id = ? ORDER BY seq ASC`)
        .all(projectId, sessionId, sceneId)) as Row[];
    return rows.map((row) => mapRecord(row, `${sessionId}/${String(row['seq'])}`));
  }

  getRecord(projectId: string, sessionId: string, recordId: string): RuntimeRecordRow | undefined {
    const row = this.db.prepare(`SELECT * FROM classroom_runtime_records
      WHERE project_id = ? AND session_id = ? AND record_id = ?`).get(projectId, sessionId, recordId) as Row | undefined;
    return row ? mapRecord(row, `${sessionId}/${recordId}`) : undefined;
  }

  getQuizReceipt(projectId: string, idempotencyKey: string): RuntimeQuizReceiptRow | undefined {
    const row = this.db.prepare(`SELECT * FROM classroom_quiz_receipts
      WHERE project_id = ? AND idempotency_key = ?`).get(projectId, idempotencyKey) as Row | undefined;
    if (!row) return undefined;
    return {
      idempotencyKey: str(row['idempotency_key']),
      sessionId: str(row['session_id']),
      questionId: str(row['question_id']),
      recordId: str(row['record_id']),
      createdAt: str(row['created_at']),
    };
  }

  saveQuizReceipt(projectId: string, receipt: RuntimeQuizReceiptRow): void {
    this.db.prepare(`INSERT INTO classroom_quiz_receipts
      (project_id, idempotency_key, session_id, question_id, record_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(projectId, receipt.idempotencyKey, receipt.sessionId, receipt.questionId, receipt.recordId, receipt.createdAt);
  }

  private getLastSeq(projectId: string, sessionId: string): number | null {
    const row = this.db.prepare(`SELECT seq FROM classroom_runtime_records
      WHERE project_id = ? AND session_id = ? ORDER BY seq DESC LIMIT 1`).get(projectId, sessionId) as Row | undefined;
    return row ? Number(row['seq']) : null;
  }
}
