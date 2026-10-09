/**
 * 受限 AI 场景计划补丁候选（LESSON-02 / OMA-023，repository）。
 *
 * 与完整课件候选（`lesson-scene-plan.ts`）同风格：候选先落 `pending`，不写入计划、不进入教学；
 * 人工逐项审核通过后才按 `save-scene-plan` 的乐观并发写入。回执与业务写入在同一事务内落库，
 * 四种结果（completed/failed/cancelled/unknown）都可查询、可重放。
 */

import { z } from 'zod';
import {
  StudyError,
  scenePlanPatchCandidateSchema,
  type ScenePlanPatchCandidateDto,
  type ScenePlanPatchCandidateStatus,
} from '@sew/study-contracts';
import type { SqlDatabase } from '../driver';
import { decodeJson, encodeJson } from '../json-codec';
import { readRequiredJsonColumn, nullableStr, str, type Row } from './types';

export interface CreateScenePlanPatchCandidateInput {
  candidateId: string;
  projectId: string;
  lessonId: string;
  baseVersion: number;
  ops: ScenePlanPatchCandidateDto['ops'];
  instruction: string;
  basePlanRevision?: number;
  basePlanDigest?: string | null;
}

export interface ScenePlanPatchReceipt {
  action: string;
  intent: string;
  state: 'completed' | 'failed' | 'cancelled' | 'unknown';
  result: unknown;
  message: string;
  errorCode: string | null;
  errorReason: string | null;
}

const STATUS_OF: Record<string, ScenePlanPatchCandidateStatus> = {
  pending: 'pending',
  applied: 'applied',
  rejected: 'rejected',
};

const mapCandidate = (row: Row): ScenePlanPatchCandidateDto => {
  const candidate = readRequiredJsonColumn(
    row['candidate_json'],
    scenePlanPatchCandidateSchema,
    'lesson_scene_patch_candidates.candidate_json',
    { reason: 'invalid_scene_plan_patch_candidate' },
  );
  if (
    candidate.projectId !== row['project_id'] ||
    candidate.candidateId !== row['candidate_id'] ||
    candidate.lessonId !== row['lesson_id'] ||
    candidate.baseVersion !== row['base_version'] ||
    candidate.status !== row['status'] ||
    candidate.basePlanRevision !== row['base_plan_revision'] ||
    candidate.basePlanDigest !== row['base_plan_digest']
  ) {
    throw new StudyError('INTERNAL', { reason: 'invalid_scene_plan_patch_candidate' });
  }
  return candidate;
};

export class ScenePlanPatchRepository {
  constructor(private readonly db: SqlDatabase) {}

  getCandidate(projectId: string, candidateId: string): ScenePlanPatchCandidateDto | null {
    const row = this.db
      .prepare(
        'SELECT * FROM lesson_scene_patch_candidates WHERE project_id=? AND candidate_id=?',
      )
      .get(projectId, candidateId) as Row | undefined;
    if (!row) return null;
    return mapCandidate(row);
  }

  /** 项目内全部补丁候选：页面一次读全，按课程版本在前端分组。 */
  listForProject(projectId: string): ScenePlanPatchCandidateDto[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM lesson_scene_patch_candidates WHERE project_id=? ORDER BY created_at, candidate_id',
      )
      .all(projectId) as Row[];
    return rows.map(mapCandidate);
  }

  createCandidate(input: CreateScenePlanPatchCandidateInput): ScenePlanPatchCandidateDto {
    const now = new Date().toISOString();
    const candidate = scenePlanPatchCandidateSchema.parse({
      candidateId: input.candidateId,
      projectId: input.projectId,
      lessonId: input.lessonId,
      baseVersion: input.baseVersion,
      basePlanRevision: input.basePlanRevision ?? 0,
      basePlanDigest: input.basePlanDigest ?? null,
      origin: 'model_generated',
      status: 'pending',
      instruction: input.instruction,
      ops: input.ops,
      note: '',
      reviewedBy: null,
      createdAt: now,
      updatedAt: now,
    });
    this.db
      .prepare(
        'INSERT INTO lesson_scene_patch_candidates (candidate_id, project_id, lesson_id, base_version, base_plan_revision, base_plan_digest, status, candidate_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        candidate.candidateId,
        input.projectId,
        input.lessonId,
        input.baseVersion,
        candidate.basePlanRevision,
        candidate.basePlanDigest,
        candidate.status,
        encodeJson(candidate),
        now,
        now,
      );
    return candidate;
  }

  /** 人工处置候选：pending 改为 applied/rejected，写入审核人身份与备注。 */
  decideCandidate(input: {
    projectId: string;
    candidateId: string;
    decision: 'approved' | 'rejected';
    note: string;
    reviewedBy: string;
  }): ScenePlanPatchCandidateDto {
    const current = this.getCandidate(input.projectId, input.candidateId);
    if (!current) throw new StudyError('NOT_FOUND', { candidateId: input.candidateId });
    if (current.status !== 'pending') {
      throw new StudyError('STEP_ALREADY_COMMITTED', {
        status: current.status,
        reason: 'scene_plan_patch_already_decided',
      });
    }
    const status: ScenePlanPatchCandidateStatus =
      input.decision === 'approved' ? 'applied' : 'rejected';
    const next = scenePlanPatchCandidateSchema.parse({
      ...current,
      status,
      note: input.note,
      reviewedBy: input.reviewedBy,
      updatedAt: new Date().toISOString(),
    });
    this.db
      .prepare(
        'UPDATE lesson_scene_patch_candidates SET status=?, candidate_json=?, updated_at=? WHERE project_id=? AND candidate_id=?',
      )
      .run(status, encodeJson(next), next.updatedAt, input.projectId, input.candidateId);
    return next;
  }

  /** 读取补丁命令回执；命中时校验 action 与 intent，换用途或换意图按 nonce 复用拒绝。 */
  receipt(
    projectId: string,
    requestId: string,
    action: string,
    intent: string,
  ): ScenePlanPatchReceipt | null {
    const row = this.db
      .prepare(
        'SELECT action, intent_json, state, result_json, message, error_code, error_reason FROM lesson_scene_patch_receipts WHERE project_id=? AND request_id=?',
      )
      .get(projectId, requestId) as Row | undefined;
    if (!row) return null;
    if (str(row['action']) !== action || str(row['intent_json']) !== intent) {
      throw new StudyError('VERSION_CONFLICT', { reason: 'scene_plan_patch_nonce_reused' });
    }
    let result: unknown = null;
    const rawResult = row['result_json'];
    if (rawResult !== null && rawResult !== undefined) {
      const decoded = decodeJson<unknown>(
        rawResult,
        z.unknown(),
        null,
        'lesson_scene_patch_receipts.result_json',
      );
      if (!decoded.ok) throw new StudyError('INTERNAL', { reason: 'invalid_scene_plan_patch_receipt' });
      result = decoded.value;
    }
    return {
      action,
      intent,
      state: str(row['state']) as ScenePlanPatchReceipt['state'],
      result,
      message: str(row['message']),
      errorCode: nullableStr(row['error_code']),
      errorReason: nullableStr(row['error_reason']),
    };
  }

  saveReceipt(input: {
    projectId: string;
    requestId: string;
    action: 'propose' | 'apply';
    intent: string;
    state: 'completed' | 'failed' | 'cancelled' | 'unknown';
    result: unknown;
    message: string;
    errorCode?: string | null;
    errorReason?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO lesson_scene_patch_receipts
         (project_id, request_id, action, intent_json, state, result_json, message, error_code, error_reason, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.projectId,
        input.requestId,
        input.action,
        input.intent,
        input.state,
        input.state === 'completed' ? encodeJson(input.result) : null,
        input.message,
        input.errorCode ?? null,
        input.errorReason ?? null,
        new Date().toISOString(),
      );
  }

  static statusOf(value: string): ScenePlanPatchCandidateStatus {
    const status = STATUS_OF[value];
    if (!status)
      throw new StudyError('INTERNAL', { reason: 'invalid_scene_plan_patch_status', value });
    return status;
  }
}
