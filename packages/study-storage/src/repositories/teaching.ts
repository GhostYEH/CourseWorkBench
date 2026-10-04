/**
 * 讲解卡、课堂会话与动作收据（repository，TEACH-01）。
 *
 * 三张表放在一起是因为它们共同回答同一个问题：这节课现在能讲什么、讲到哪、刚才那一步
 * 是否已经执行过。收据插入与状态变更在同一个事务里，断连重试读到既有收据而不是二次执行。
 */

import { StudyError, newId,
  CLASSROOM_ACTION_KINDS,
  CLASSROOM_SESSION_STATUS,
  EXPLANATION_KIND,
  EXPLANATION_ORIGIN,
  EXPLANATION_STATUS,
  type ClassroomActionPayloadDto,
  type ClassroomActionKind,
  type ExplanationKind,
  type ExplanationOrigin,
  type ExplanationStatus,
} from '@sew/study-contracts';
import type { SqlDatabase } from '../driver';
import { classroomActionPayloadSchema, encodeJson, knowledgeIdsSchema } from '../json-codec';
import {
  defaultJsonPolicy,
  num,
  readAuthoritativeJsonColumn,
  str,
  type ClassroomActionRow,
  type ExplanationRow,
  type ClassroomSessionRow,
  type Row,
} from './types';

/** 状态列的取值清单与共享合同同源；库里出现未知值说明数据被外部改写，按内部错误拒绝。 */
function oneOf<T extends string>(allowed: readonly T[], value: string, reason: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new StudyError('INTERNAL', { reason, value, expected: allowed });
}

const mapActionKind = (row: Row): ClassroomActionKind => {
  const payloadKind = mapActionPayload(row).kind;
  const column = str(row['kind']);
  if (column !== payloadKind) {
    throw new StudyError('INTERNAL', { reason: 'classroom_action_kind_mismatch', column, payloadKind });
  }
  return oneOf(CLASSROOM_ACTION_KINDS, column, 'invalid_classroom_action_kind');
};

const mapCard = (row: Row): ExplanationRow => {
  const explanationId = str(row['explanation_id']);
  return {
    explanationId,
    projectId: str(row['project_id']),
    lessonId: str(row['lesson_id']),
    lessonVersion: num(row['lesson_version']),
    sceneId: str(row['scene_id']),
    position: num(row['position']),
    kind: oneOf(EXPLANATION_KIND, str(row['kind']), 'invalid_explanation_kind') as ExplanationKind,
    origin: oneOf(EXPLANATION_ORIGIN, str(row['origin']), 'invalid_explanation_origin') as ExplanationOrigin,
    status: oneOf(EXPLANATION_STATUS, str(row['status']), 'invalid_explanation_status') as ExplanationStatus,
    text: str(row['text']),
    statementIds: readAuthoritativeJsonColumn(
      row['statement_ids_json'],
      knowledgeIdsSchema,
      `lesson_explanations.statement_ids_json[${explanationId}]`,
      defaultJsonPolicy,
    ),
    reviewNote: str(row['review_note']),
    createdAt: str(row['created_at']),
    updatedAt: str(row['updated_at']),
  };
};

const mapSession = (row: Row): ClassroomSessionRow => ({
  sessionId: str(row['session_id']),
  projectId: str(row['project_id']),
  runId: str(row['run_id']) || null,
  lessonId: str(row['lesson_id']),
  lessonVersion: num(row['lesson_version']),
  bundleId: str(row['bundle_id']),
  stageId: str(row['stage_id']) || null,
  learnerKey: str(row['learner_key']),
  status: oneOf(CLASSROOM_SESSION_STATUS, str(row['status']), 'invalid_session_status'),
  awaitingReason: str(row['awaiting_reason']),
  currentSceneId: str(row['current_scene_id']),
  roundIndex: num(row['round_index']),
  roundCalls: num(row['round_calls']),
  roundPeerTurns: num(row['round_peer_turns']),
  lessonCalls: num(row['lesson_calls']),
  peersEnabled: num(row['peers_enabled']) > 0,
  createdAt: str(row['created_at']),
  updatedAt: str(row['updated_at']),
});

const mapActionPayload = (row: Row): ClassroomActionPayloadDto => readAuthoritativeJsonColumn(
  row['payload_json'],
  classroomActionPayloadSchema,
  `classroom_action_receipts.payload_json[${str(row['step_key'])}]`,
  defaultJsonPolicy,
);

const mapAction = (row: Row): ClassroomActionRow => ({
  stepKey: str(row['step_key']),
  sessionId: str(row['session_id']),
  projectId: str(row['project_id']),
  kind: mapActionKind(row),
  sceneId: str(row['scene_id']),
  payload: mapActionPayload(row),
  at: str(row['at']),
});

export interface CreateExplanationInput {
  projectId: string;
  lessonId: string;
  lessonVersion: number;
  sceneId: string;
  kind: ExplanationKind;
  origin: ExplanationOrigin;
  text: string;
  statementIds: string[];
}

export interface CreateSessionInput {
  projectId: string;
  runId: string | null;
  lessonId: string;
  lessonVersion: number;
  bundleId: string;
  stageId: string | null;
  learnerKey: string;
  currentSceneId: string;
}

export class TeachingRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** 场景内位置由服务端追加，客户端不能插队改变既定顺序。 */
  createCard(input: CreateExplanationInput): ExplanationRow {
    const maxPosition = this.db
      .prepare(
        `SELECT COALESCE(MAX(position), -1) AS max_position FROM lesson_explanations
          WHERE project_id = ? AND lesson_id = ? AND lesson_version = ? AND scene_id = ?`,
      )
      .get(input.projectId, input.lessonId, input.lessonVersion, input.sceneId) as Row | undefined;
    const position = num(maxPosition?.['max_position']) + 1;
    const explanationId = newId<string>('exp');
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO lesson_explanations (explanation_id, project_id, lesson_id, lesson_version, scene_id, position, kind, origin, status, text, statement_ids_json, review_note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, '', ?, ?)`,
      )
      .run(
        explanationId,
        input.projectId,
        input.lessonId,
        input.lessonVersion,
        input.sceneId,
        position,
        input.kind,
        input.origin,
        input.text,
        encodeJson([...new Set(input.statementIds)]),
        now,
        now,
      );
    const created = this.getCard(explanationId, input.projectId);
    if (!created) throw new StudyError('INTERNAL', { explanationId });
    return created;
  }

  getCard(explanationId: string, projectId: string): ExplanationRow | null {
    const row = this.db
      .prepare('SELECT * FROM lesson_explanations WHERE explanation_id = ? AND project_id = ?')
      .get(explanationId, projectId) as Row | undefined;
    return row ? mapCard(row) : null;
  }

  listCards(lessonId: string, lessonVersion: number, projectId: string): ExplanationRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM lesson_explanations
          WHERE project_id = ? AND lesson_id = ? AND lesson_version = ?
          ORDER BY scene_id, position, created_at, explanation_id`,
      )
      .all(projectId, lessonId, lessonVersion) as Row[];
    return rows.map(mapCard);
  }

  /** 只允许改草案卡片：已审核的卡片内容与结论必须一致，不再原地改写。 */
  updateCard(
    explanationId: string,
    projectId: string,
    patch: { text?: string; statementIds?: string[] },
  ): ExplanationRow {
    const sets: string[] = ['updated_at = ?'];
    const values: Array<string | number> = [new Date().toISOString()];
    if (patch.text !== undefined) {
      sets.push('text = ?');
      values.push(patch.text);
    }
    if (patch.statementIds !== undefined) {
      sets.push('statement_ids_json = ?');
      values.push(encodeJson([...new Set(patch.statementIds)]));
    }
    const result = this.db
      .prepare(`UPDATE lesson_explanations SET ${sets.join(', ')} WHERE explanation_id = ? AND project_id = ? AND status = 'draft'`)
      .run(...values, explanationId, projectId);
    if (result.changes !== 1) throw new StudyError('STEP_ALREADY_COMMITTED', { reason: 'card_not_draft' });
    const updated = this.getCard(explanationId, projectId);
    if (!updated) throw new StudyError('INTERNAL', { explanationId });
    return updated;
  }

  /** 只有草案卡片可审核：改判会留下两条结论相互矛盾的历史。 */
  reviewCard(explanationId: string, projectId: string, status: ExplanationStatus, note: string): ExplanationRow {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE lesson_explanations SET status = ?, review_note = ?, updated_at = ? WHERE explanation_id = ? AND project_id = ? AND status = 'draft'")
      .run(status, note, now, explanationId, projectId);
    if (result.changes !== 1) throw new StudyError('STEP_ALREADY_COMMITTED', { reason: 'card_not_draft' });
    const updated = this.getCard(explanationId, projectId);
    if (!updated) throw new StudyError('INTERNAL', { explanationId });
    return updated;
  }

  createSession(input: CreateSessionInput): ClassroomSessionRow {
    const sessionId = newId<string>('cls');
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO classroom_sessions (session_id, project_id, run_id, lesson_id, lesson_version, bundle_id, stage_id, learner_key, status, awaiting_reason, current_scene_id, round_index, round_calls, round_peer_turns, lesson_calls, peers_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_class', '', ?, 1, 0, 0, 0, 0, ?, ?)`,
      )
      .run(
        sessionId,
        input.projectId,
        input.runId,
        input.lessonId,
        input.lessonVersion,
        input.bundleId,
        input.stageId,
        input.learnerKey,
        input.currentSceneId,
        now,
        now,
      );
    const created = this.getSession(sessionId, input.projectId);
    if (!created) throw new StudyError('INTERNAL', { sessionId });
    return created;
  }

  getSession(sessionId: string, projectId: string): ClassroomSessionRow | null {
    const row = this.db
      .prepare('SELECT * FROM classroom_sessions WHERE session_id = ? AND project_id = ?')
      .get(sessionId, projectId) as Row | undefined;
    return row ? mapSession(row) : null;
  }

  /** 本项目仍在进行或正在等待本人的会话；一个课堂同时只允许一个活动会话。 */
  getOpenSession(projectId: string): ClassroomSessionRow | null {
    const row = this.db
      .prepare("SELECT * FROM classroom_sessions WHERE project_id = ? AND status IN ('in_class', 'awaiting_learner') ORDER BY created_at DESC, session_id LIMIT 1")
      .get(projectId) as Row | undefined;
    return row ? mapSession(row) : null;
  }

  listSessions(projectId: string): ClassroomSessionRow[] {
    const rows = this.db
      .prepare('SELECT * FROM classroom_sessions WHERE project_id = ? ORDER BY created_at DESC, session_id')
      .all(projectId) as Row[];
    return rows.map(mapSession);
  }

  updateSession(
    sessionId: string,
    projectId: string,
    patch: Partial<Pick<ClassroomSessionRow, 'status' | 'awaitingReason' | 'currentSceneId' | 'roundIndex' | 'roundCalls' | 'roundPeerTurns' | 'lessonCalls' | 'peersEnabled'>>,
  ): ClassroomSessionRow {
    const sets: string[] = ['updated_at = ?'];
    const values: Array<string | number> = [new Date().toISOString()];
    if (patch.status !== undefined) {
      if (!CLASSROOM_SESSION_STATUS.includes(patch.status)) throw new StudyError('INTERNAL', { reason: 'invalid_session_status' });
      sets.push('status = ?');
      values.push(patch.status);
    }
    if (patch.awaitingReason !== undefined) {
      sets.push('awaiting_reason = ?');
      values.push(patch.awaitingReason);
    }
    if (patch.currentSceneId !== undefined) {
      sets.push('current_scene_id = ?');
      values.push(patch.currentSceneId);
    }
    if (patch.roundIndex !== undefined) {
      sets.push('round_index = ?');
      values.push(patch.roundIndex);
    }
    if (patch.roundCalls !== undefined) {
      sets.push('round_calls = ?');
      values.push(patch.roundCalls);
    }
    if (patch.roundPeerTurns !== undefined) {
      sets.push('round_peer_turns = ?');
      values.push(patch.roundPeerTurns);
    }
    if (patch.lessonCalls !== undefined) {
      sets.push('lesson_calls = ?');
      values.push(patch.lessonCalls);
    }
    if (patch.peersEnabled !== undefined) {
      sets.push('peers_enabled = ?');
      values.push(patch.peersEnabled ? 1 : 0);
    }
    this.db
      .prepare(`UPDATE classroom_sessions SET ${sets.join(', ')} WHERE session_id = ? AND project_id = ?`)
      .run(...values, sessionId, projectId);
    const updated = this.getSession(sessionId, projectId);
    if (!updated) throw new StudyError('INTERNAL', { sessionId });
    return updated;
  }

  getReceipt(stepKey: string): ClassroomActionRow | null {
    const row = this.db
      .prepare('SELECT * FROM classroom_action_receipts WHERE step_key = ?')
      .get(stepKey) as Row | undefined;
    return row ? mapAction(row) : null;
  }

  listActions(sessionId: string, projectId: string): ClassroomActionRow[] {
    const rows = this.db
      .prepare('SELECT * FROM classroom_action_receipts WHERE session_id = ? AND project_id = ? ORDER BY at, step_key')
      .all(sessionId, projectId) as Row[];
    return rows.map(mapAction);
  }

  /**
   * 幂等执行一步课堂动作：收据命中就返回既有结果，否则在同一事务里执行业务写入并落收据。
   *
   * `commit` 不得再开启事务，否则会破坏「业务写入与收据原子保存」这条承诺。
   */
  recordAction(input: {
    stepKey: string;
    sessionId: string;
    projectId: string;
    sceneId: string;
    payload: ClassroomActionPayloadDto;
  }, commit: () => void): { deduplicated: boolean; receipt: ClassroomActionRow } {
    const checked = classroomActionPayloadSchema.safeParse(input.payload);
    if (!checked.success) {
      throw new StudyError('INTERNAL', {
        reason: 'invalid_classroom_action',
        issues: checked.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`),
      });
    }
    const existing = this.getReceipt(input.stepKey);
    if (existing) return { deduplicated: true, receipt: existing };

    const at = new Date().toISOString();
    const receipt = this.db.transaction((): ClassroomActionRow => {
      commit();
      this.db
        .prepare('INSERT INTO classroom_action_receipts (step_key, session_id, project_id, kind, scene_id, payload_json, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(input.stepKey, input.sessionId, input.projectId, checked.data.kind, input.sceneId, encodeJson(checked.data), at);
      const saved = this.getReceipt(input.stepKey);
      if (!saved) throw new StudyError('INTERNAL', { stepKey: input.stepKey });
      return saved;
    });
    return { deduplicated: false, receipt };
  }

  /** 已播放卡片编号：从收据派生，不另存一份可能漂移的进度列。 */
  playedCardIds(sessionId: string, projectId: string): string[] {
    return this.listActions(sessionId, projectId)
      .filter((action) => action.payload.kind === 'card_played')
      .map((action) => (action.payload.kind === 'card_played' ? action.payload.explanationId : ''))
      .filter((id) => id.length > 0);
  }

  setPeersEnabled(sessionId: string, projectId: string, enabled: boolean): ClassroomSessionRow {
    return this.updateSession(sessionId, projectId, { peersEnabled: enabled });
  }
}
