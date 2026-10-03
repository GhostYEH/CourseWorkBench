/**
 * 作答记录（repository）。
 *
 * 真实与模拟分区存储；幂等键唯一，重复请求由调用方读取既有收据。
 * 掌握状态更新属于跨域协调，由调用方在同一事务内通过 knowledge repository 完成。
 */

import type { SqlDatabase } from '../driver';
import { mapAttempt, num, type AttemptRow, type Row } from './types';

export interface InsertAttemptInput {
  attemptId: string;
  questionId: string;
  kind: 'real' | 'simulation';
  /** 请求声明的 kind，用于幂等命中时拒绝「同键不同声明」。 */
  requestedKind: 'real' | 'simulation';
  actorType: string;
  answerText: string;
  processText: string;
  masteryAfter: AttemptRow['masteryAfter'];
  attributionStatus: AttemptRow['attributionStatus'];
  idempotencyKey: string;
  submittedAt: string;
}

export class AttemptsRepository {
  constructor(private readonly db: SqlDatabase) {}

  findByIdempotencyKey(idempotencyKey: string): AttemptRow | null {
    const row = this.db
      .prepare(`SELECT attempts.*, questions.record_scope AS record_scope
        FROM attempts JOIN questions USING (question_id) WHERE attempts.idempotency_key = ?`)
      .get(idempotencyKey) as Row | undefined;
    return row ? mapAttempt(row) : null;
  }

  /** Internal idempotency lookup spans formal and demo partitions. */
  getAnyByIdempotencyKey(idempotencyKey: string): AttemptRow | null {
    const row = this.db.prepare(`SELECT attempts.*, questions.record_scope AS record_scope
      FROM attempts JOIN questions USING (question_id) WHERE attempts.idempotency_key = ?`)
      .get(idempotencyKey) as Row | undefined;
    return row ? mapAttempt(row) : null;
  }

  insertAttempt(input: InsertAttemptInput): AttemptRow {
    this.db
      .prepare(
        `INSERT INTO attempts (attempt_id, question_id, kind, requested_kind, actor_type, answer_text, process_text, mastery_after, attribution_status, idempotency_key, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.attemptId,
        input.questionId,
        input.kind,
        input.requestedKind,
        input.actorType,
        input.answerText,
        input.processText,
        input.masteryAfter,
        input.attributionStatus,
        input.idempotencyKey,
        input.submittedAt,
      );
    const row = this.db.prepare(`SELECT attempts.*, questions.record_scope AS record_scope
      FROM attempts JOIN questions USING (question_id) WHERE attempts.attempt_id = ?`).get(input.attemptId) as Row;
    return mapAttempt(row);
  }

  listAttempts(kind?: 'real' | 'simulation', scope: 'formal' | 'demo' = 'formal'): AttemptRow[] {
    const rows = (
      kind
        ? this.db.prepare('SELECT attempts.*, questions.record_scope AS record_scope FROM attempts JOIN questions USING (question_id) WHERE attempts.kind = ? AND questions.record_scope = ? ORDER BY attempts.submitted_at DESC').all(kind, scope)
        : this.db.prepare('SELECT attempts.*, questions.record_scope AS record_scope FROM attempts JOIN questions USING (question_id) WHERE questions.record_scope = ? ORDER BY attempts.submitted_at DESC').all(scope)
    ) as Row[];
    return rows.map(mapAttempt);
  }

  countAttemptKinds(scope: 'formal' | 'demo' = 'formal'): { real: number; simulation: number } {
    // Match filtered list APIs: unknown stored kinds count in neither partition.
    const rows = this.db.prepare(
      "SELECT attempts.kind, COUNT(*) AS count FROM attempts JOIN questions USING (question_id) WHERE attempts.kind IN ('real', 'simulation') AND questions.record_scope = ? GROUP BY attempts.kind",
    ).all(scope) as Row[];
    const counts = { real: 0, simulation: 0 };
    for (const row of rows) {
      if (row['kind'] === 'real') counts.real = num(row['count']);
      else if (row['kind'] === 'simulation') counts.simulation = num(row['count']);
    }
    return counts;
  }
}
