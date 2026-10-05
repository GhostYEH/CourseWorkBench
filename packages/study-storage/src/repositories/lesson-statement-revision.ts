/**
 * 陈述正文改写候选与幂等收据（LESSON-02，repository）。
 *
 * 候选只落待核区：`pending` 的正文是模型草案，不写入任何课程版本，也不改写原陈述。
 * 通过（`applied`）才由调用方在同一事务内派生新草案版本；拒绝（`rejected`）只留档。
 * 候选生成与人工处置都用 `requestId` 幂等：相同 requestId 与意图重试返回既有结果。
 */

import { z } from 'zod';
import {
  StudyError,
  statementRevisionCandidateSchema,
  type StatementRevisionCandidateDto,
  type StatementRevisionStatus,
} from '@sew/study-contracts';
import type { SqlDatabase } from '../driver';
import { decodeJson, encodeJson } from '../json-codec';
import { readRequiredJsonColumn, type Row } from './types';

export interface CreateStatementRevisionInput {
  candidateId: string;
  projectId: string;
  lessonId: string;
  baseVersion: number;
  statementId: string;
  knowledgeId: string;
  proposedText: string;
  proposedConditions: string;
  evidence: StatementRevisionCandidateDto['evidence'];
  instruction: string;
}

/** 幂等收据：`intent` 是调用方给出的意图指纹，重试时必须完全一致。 */
export interface RevisionReceipt {
  action: string;
  intent: string;
  result: unknown;
}

const STATUS_OF: Record<string, StatementRevisionStatus> = {
  pending: 'pending',
  applied: 'applied',
  rejected: 'rejected',
};

export class LessonStatementRevisionRepository {
  constructor(private readonly db: SqlDatabase) {}

  private parse(value: unknown, context: string): StatementRevisionCandidateDto {
    return readRequiredJsonColumn(value, statementRevisionCandidateSchema, context, {
      reason: 'invalid_statement_revision',
    });
  }

  get(projectId: string, candidateId: string): StatementRevisionCandidateDto | null {
    const row = this.db
      .prepare(
        'SELECT candidate_json FROM lesson_statement_revisions WHERE project_id=? AND candidate_id=?',
      )
      .get(projectId, candidateId) as Row | undefined;
    return row
      ? this.parse(row['candidate_json'], `lesson_statement_revisions[${candidateId}]`)
      : null;
  }

  list(projectId: string, lessonId: string, baseVersion: number): StatementRevisionCandidateDto[] {
    const rows = this.db
      .prepare(
        'SELECT candidate_json FROM lesson_statement_revisions WHERE project_id=? AND lesson_id=? AND base_version=? ORDER BY created_at, candidate_id',
      )
      .all(projectId, lessonId, baseVersion) as Row[];
    return rows.map((row) => this.parse(row['candidate_json'], 'lesson_statement_revisions'));
  }

  /** 项目内全部候选：页面一次读全，按课程版本在前端分组，避免每版本一次查询。 */
  listForProject(projectId: string): StatementRevisionCandidateDto[] {
    const rows = this.db
      .prepare(
        'SELECT candidate_json FROM lesson_statement_revisions WHERE project_id=? ORDER BY created_at, candidate_id',
      )
      .all(projectId) as Row[];
    return rows.map((row) => this.parse(row['candidate_json'], 'lesson_statement_revisions'));
  }

  /** 生成候选：只在没有同 requestId 收据时插入；调用方负责先查收据。 */
  create(input: CreateStatementRevisionInput): StatementRevisionCandidateDto {
    const now = new Date().toISOString();
    const candidate = statementRevisionCandidateSchema.parse({
      candidateId: input.candidateId,
      projectId: input.projectId,
      lessonId: input.lessonId,
      baseVersion: input.baseVersion,
      statementId: input.statementId,
      knowledgeId: input.knowledgeId,
      origin: 'model_generated',
      status: 'pending',
      proposedText: input.proposedText,
      proposedConditions: input.proposedConditions,
      evidence: input.evidence,
      instruction: input.instruction,
      note: '',
      reviewedBy: null,
      createdAt: now,
      updatedAt: now,
    });
    this.db
      .prepare(
        'INSERT INTO lesson_statement_revisions (candidate_id, project_id, lesson_id, base_version, statement_id, status, candidate_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        candidate.candidateId,
        input.projectId,
        input.lessonId,
        input.baseVersion,
        input.statementId,
        candidate.status,
        encodeJson(candidate),
        now,
        now,
      );
    return candidate;
  }

  /** 人工处置：把候选从 pending 改为 applied/rejected，并写入审核人身份与备注。 */
  decide(input: {
    projectId: string;
    candidateId: string;
    decision: 'approved' | 'rejected';
    note: string;
    reviewedBy: string;
  }): StatementRevisionCandidateDto {
    const current = this.get(input.projectId, input.candidateId);
    if (!current) throw new StudyError('NOT_FOUND', { candidateId: input.candidateId });
    if (current.status !== 'pending') {
      throw new StudyError('STEP_ALREADY_COMMITTED', {
        status: current.status,
        reason: 'revision_already_decided',
      });
    }
    const status: StatementRevisionStatus = input.decision === 'approved' ? 'applied' : 'rejected';
    const next = statementRevisionCandidateSchema.parse({
      ...current,
      status,
      note: input.note,
      reviewedBy: input.reviewedBy,
      updatedAt: new Date().toISOString(),
    });
    this.db
      .prepare(
        'UPDATE lesson_statement_revisions SET status=?, candidate_json=?, updated_at=? WHERE project_id=? AND candidate_id=?',
      )
      .run(status, encodeJson(next), next.updatedAt, input.projectId, input.candidateId);
    return next;
  }

  /** 读取某 requestId 的收据；意图不一致时按 nonce 复用拒绝，不静默返回旧结果。 */
  receipt(
    projectId: string,
    requestId: string,
    action: string,
    intent: string,
  ): RevisionReceipt | null {
    const row = this.db
      .prepare(
        'SELECT action, intent_json, result_json FROM lesson_statement_revision_receipts WHERE project_id=? AND request_id=?',
      )
      .get(projectId, requestId) as Row | undefined;
    if (!row) return null;
    if (row['action'] !== action || row['intent_json'] !== intent) {
      throw new StudyError('VERSION_CONFLICT', { reason: 'revision_nonce_reused' });
    }
    const decoded = decodeJson<unknown>(
      row['result_json'],
      z.unknown(),
      null,
      'lesson_statement_revision_receipts.result_json',
    );
    if (!decoded.ok) throw new StudyError('INTERNAL', { reason: 'invalid_revision_receipt' });
    return { action, intent, result: decoded.value };
  }

  saveReceipt(
    projectId: string,
    requestId: string,
    action: string,
    intent: string,
    result: unknown,
  ): void {
    this.db
      .prepare(
        'INSERT INTO lesson_statement_revision_receipts (project_id, request_id, action, intent_json, result_json) VALUES (?,?,?,?,?)',
      )
      .run(projectId, requestId, action, intent, encodeJson(result));
  }

  /** 课程草案派生的幂等收据：命中时返回既有 (lessonId, version)。 */
  draftReceipt(
    projectId: string,
    requestId: string,
    intent: string,
  ): { lessonId: string; version: number } | null {
    const row = this.db
      .prepare(
        'SELECT intent_json, lesson_id, version FROM lesson_draft_receipts WHERE project_id=? AND request_id=?',
      )
      .get(projectId, requestId) as Row | undefined;
    if (!row) return null;
    if (row['intent_json'] !== intent) {
      throw new StudyError('VERSION_CONFLICT', { reason: 'draft_nonce_reused' });
    }
    return { lessonId: String(row['lesson_id']), version: Number(row['version']) };
  }

  saveDraftReceipt(
    projectId: string,
    requestId: string,
    intent: string,
    lessonId: string,
    version: number,
  ): void {
    this.db
      .prepare(
        'INSERT INTO lesson_draft_receipts (project_id, request_id, intent_json, lesson_id, version) VALUES (?,?,?,?,?)',
      )
      .run(projectId, requestId, intent, lessonId, version);
  }

  static statusOf(value: string): StatementRevisionStatus {
    const status = STATUS_OF[value];
    if (!status) throw new StudyError('INTERNAL', { reason: 'invalid_revision_status', value });
    return status;
  }
}
