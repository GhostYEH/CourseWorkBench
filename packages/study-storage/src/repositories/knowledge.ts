/**
 * 权威知识点表（repository）。
 *
 * `knowledge_points` 是唯一权威事实表；候选与派生 Markdown 都不是第二套权威。
 * 准入判断委托给领域层 `checkAdmission`，本层只负责装配当前表与最新材料版本。
 */

import { StudyError, type AdmissionResultDto, type MasteryStatus, type RecordScope, type ReviewProvenance } from '@sew/study-contracts';
import { checkAdmission, type KnowledgeRecord } from '@sew/study-domain';
import type { SqlDatabase } from '../driver';
import { encodeJson } from '../json-codec';
import {
  defaultJsonPolicy,
  mapKnowledge,
  type EvidenceStored,
  type KnowledgeRow,
  type Row,
} from './types';

export interface InsertKnowledgePointInput {
  knowledgeId: string;
  name: string;
  concept: string;
  conditions: string;
  scopeStatus: KnowledgeRow['scopeStatus'];
  /** 人工审核时确认的考纲条目映射；未映射为 null。 */
  syllabusItemId: string | null;
  syllabusRequirementKey: string | null;
  prerequisites: string[];
  evidence: EvidenceStored[];
  acceptance: string;
  priority: KnowledgeRow['priority'];
  originProposalId: string;
  now: string;
  recordScope: RecordScope;
  reviewProvenance: ReviewProvenance;
}

export class KnowledgeRepository {
  constructor(private readonly db: SqlDatabase) {}

  listKnowledge(scope: RecordScope = 'formal'): KnowledgeRow[] {
    return (this.db.prepare('SELECT * FROM knowledge_points WHERE record_scope = ? ORDER BY created_at ASC').all(scope) as Row[]).map(
      (row) => mapKnowledge(row, defaultJsonPolicy),
    );
  }

  getKnowledge(knowledgeId: string, scope?: RecordScope): KnowledgeRow | null {
    const row = this.db
      .prepare(`SELECT * FROM knowledge_points WHERE knowledge_id = ?${scope ? ' AND record_scope = ?' : ''}`)
      .get(...(scope ? [knowledgeId, scope] : [knowledgeId])) as Row | undefined;
    return row ? mapKnowledge(row, defaultJsonPolicy) : null;
  }

  setMastery(knowledgeId: string, mastery: MasteryStatus, scope: RecordScope = 'formal'): KnowledgeRow {
    const current = this.getKnowledge(knowledgeId, scope);
    if (!current) throw new StudyError('NOT_FOUND', { knowledgeId });
    this.db
      .prepare('UPDATE knowledge_points SET mastery_status = ?, updated_at = ? WHERE knowledge_id = ? AND record_scope = ?')
      .run(mastery, new Date().toISOString(), knowledgeId, scope);
    const updated = this.getKnowledge(knowledgeId, scope);
    if (!updated) throw new StudyError('NOT_FOUND', { knowledgeId });
    return updated;
  }

  /** 材料更新后把受影响知识点转为已失效（保留历史，不静默改写）。 */
  invalidateKnowledgePoints(knowledgeIds: string[], now: string, scope: RecordScope = 'formal'): void {
    const statement = this.db.prepare(
      `UPDATE knowledge_points SET source_status = 'invalidated', updated_at = ?, revision = revision + 1 WHERE knowledge_id = ? AND record_scope = ?`,
    );
    for (const knowledgeId of knowledgeIds) statement.run(now, knowledgeId, scope);
  }

  /** 仅在知识点当前仍为已核实时更新掌握状态（模拟作答与失效来源不写）。 */
  updateMasteryIfVerified(knowledgeIds: string[], mastery: MasteryStatus, now: string, scope: RecordScope = 'formal'): void {
    for (const knowledgeId of knowledgeIds) {
      const current = this.getKnowledge(knowledgeId, scope);
      if (!current || current.sourceStatus !== 'verified') continue;
      this.db.prepare(`UPDATE knowledge_points SET mastery_status = ?, updated_at = ? WHERE knowledge_id = ? AND record_scope = ?`).run(mastery, now, knowledgeId, scope);
    }
  }

  insertKnowledgePoint(input: InsertKnowledgePointInput): KnowledgeRow {
    this.db
      .prepare(
        `INSERT INTO knowledge_points (knowledge_id, name, concept, conditions, source_status, scope_status, mastery_status, syllabus_item_id, syllabus_requirement_key, prerequisites_json, evidence_json, acceptance, priority, origin_proposal_id, revision, created_at, updated_at, record_scope, review_provenance)
         VALUES (?, ?, ?, ?, 'verified', ?, 'untested', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        input.knowledgeId,
        input.name,
        input.concept,
        input.conditions,
        input.scopeStatus,
        input.syllabusItemId,
        input.syllabusRequirementKey,
        encodeJson(input.prerequisites),
        encodeJson(input.evidence),
        input.acceptance,
        input.priority,
        input.originProposalId,
        input.now,
        input.now,
        input.recordScope,
        input.reviewProvenance,
      );
    const created = this.getKnowledge(input.knowledgeId);
    if (!created) throw new StudyError('INTERNAL', { knowledgeId: input.knowledgeId });
    return created;
  }

  /** 当前权威表的准入视图（含待核实项，用于解释阻断原因）。 */
  admissionTable(scope: RecordScope = 'formal'): Map<string, KnowledgeRecord> {
    return new Map<string, KnowledgeRecord>(
      this.listKnowledge(scope).map((k) => [
        k.knowledgeId,
        {
          knowledgeId: k.knowledgeId,
          name: k.name,
          sourceStatus: k.sourceStatus,
          scopeStatus: k.scopeStatus,
          prerequisites: k.prerequisites,
          evidence: k.evidence.map((e) => ({ materialId: e.materialId, revision: e.revision })),
        },
      ]),
    );
  }

  /** 生成准入预检：所有入口共用同一实现，不存在「课堂生成特权」。 */
  checkAdmission(knowledgeIds: string[], currentRevisions: Record<string, number>, scope: RecordScope = 'formal'): AdmissionResultDto {
    return checkAdmission({ knowledgeIds, table: this.admissionTable(scope), currentRevisions });
  }
}
