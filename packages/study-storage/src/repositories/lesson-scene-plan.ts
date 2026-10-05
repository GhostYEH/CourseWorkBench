/**
 * 场景计划与完整课件生成候选（LESSON-02 / OMA-006、OMA-021、OMA-022，repository）。
 *
 * - 场景计划按 `(project_id, lesson_id, lesson_version)` 一对一保存：计划只挂在草案版本上，
 *   已发布版本的计划不再改写（发布即冻结历史）。
 * - 计划整份覆盖写，`revision` 每次推进一格；客户端基于读到的 revision 提交，服务端已推进即拒绝。
 * - 完整课件生成候选先落 `pending`：不写入计划、不进入教学；人工通过才把候选场景写成计划。
 */

import { z } from 'zod';
import {
  StudyError,
  scenePlanSchema,
  coursewareCandidateSchema,
  type CoursewareCandidateDto,
  type CoursewareCandidateStatus,
  type ScenePlanDto,
} from '@sew/study-contracts';
import type { SqlDatabase } from '../driver';
import { decodeJson, encodeJson } from '../json-codec';
import { readRequiredJsonColumn, str, type Row } from './types';

export interface SaveScenePlanInput {
  projectId: string;
  lessonId: string;
  lessonVersion: number;
  bundleId: string;
  scenes: ScenePlanDto['scenes'];
  origin: ScenePlanDto['origin'];
  /** 客户端据以编辑的 revision；与实际存储不一致时返回 VERSION_CONFLICT。 */
  baseRevision: number;
}

export interface CreateCoursewareCandidateInput {
  candidateId: string;
  projectId: string;
  lessonId: string;
  baseVersion: number;
  scenes: CoursewareCandidateDto['scenes'];
  instruction: string;
}

export interface CoursewareReceipt {
  action: string;
  intent: string;
  result: unknown;
}

const STATUS_OF: Record<string, CoursewareCandidateStatus> = {
  pending: 'pending',
  applied: 'applied',
  rejected: 'rejected',
};

export class LessonScenePlanRepository {
  constructor(private readonly db: SqlDatabase) {}

  getPlan(projectId: string, lessonId: string, lessonVersion: number): ScenePlanDto | null {
    const row = this.db
      .prepare(
        'SELECT plan_json FROM lesson_scene_plans WHERE project_id=? AND lesson_id=? AND lesson_version=?',
      )
      .get(projectId, lessonId, lessonVersion) as Row | undefined;
    if (!row) return null;
    return readRequiredJsonColumn(
      row['plan_json'],
      scenePlanSchema,
      'lesson_scene_plans.plan_json',
      {
        reason: 'invalid_scene_plan',
      },
    );
  }

  /** 项目内全部计划：页面一次读全，按课程版本在前端取用。 */
  listPlansForProject(projectId: string): ScenePlanDto[] {
    const rows = this.db
      .prepare(
        'SELECT plan_json FROM lesson_scene_plans WHERE project_id=? ORDER BY updated_at DESC, lesson_id, lesson_version',
      )
      .all(projectId) as Row[];
    return rows.map((row) =>
      readRequiredJsonColumn(row['plan_json'], scenePlanSchema, 'lesson_scene_plans.plan_json', {
        reason: 'invalid_scene_plan',
      }),
    );
  }

  /** 保存计划：整份覆盖写并推进 revision；revision 已被别处推进时拒绝，不静默覆盖。 */
  savePlan(input: SaveScenePlanInput): ScenePlanDto {
    const current = this.getPlan(input.projectId, input.lessonId, input.lessonVersion);
    const currentRevision = current?.revision ?? 0;
    if (input.baseRevision !== currentRevision) {
      throw new StudyError('VERSION_CONFLICT', {
        reason: 'plan_revision_stale',
        expected: currentRevision,
        received: input.baseRevision,
      });
    }
    const now = new Date().toISOString();
    const plan = scenePlanSchema.parse({
      planVersion: 1,
      projectId: input.projectId,
      lessonId: input.lessonId,
      lessonVersion: input.lessonVersion,
      bundleId: input.bundleId,
      scenes: input.scenes,
      revision: currentRevision + 1,
      origin: input.origin,
      updatedAt: now,
    });
    this.db
      .prepare(
        `INSERT INTO lesson_scene_plans (project_id, lesson_id, lesson_version, bundle_id, plan_json, revision, origin, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(project_id, lesson_id, lesson_version) DO UPDATE SET
           bundle_id = excluded.bundle_id, plan_json = excluded.plan_json,
           revision = excluded.revision, origin = excluded.origin, updated_at = excluded.updated_at`,
      )
      .run(
        input.projectId,
        input.lessonId,
        input.lessonVersion,
        input.bundleId,
        encodeJson(plan),
        plan.revision,
        plan.origin,
        now,
        now,
      );
    const saved = this.getPlan(input.projectId, input.lessonId, input.lessonVersion);
    if (!saved) throw new StudyError('INTERNAL', { reason: 'scene_plan_missing_after_write' });
    return saved;
  }

  getCandidate(projectId: string, candidateId: string): CoursewareCandidateDto | null {
    const row = this.db
      .prepare(
        'SELECT candidate_json FROM lesson_courseware_candidates WHERE project_id=? AND candidate_id=?',
      )
      .get(projectId, candidateId) as Row | undefined;
    if (!row) return null;
    return readRequiredJsonColumn(
      row['candidate_json'],
      coursewareCandidateSchema,
      `lesson_courseware_candidates[${candidateId}]`,
      { reason: 'invalid_courseware_candidate' },
    );
  }

  /** 项目内全部候选：页面一次读全，按课程版本在前端分组。 */
  listForProject(projectId: string): CoursewareCandidateDto[] {
    const rows = this.db
      .prepare(
        'SELECT candidate_json FROM lesson_courseware_candidates WHERE project_id=? ORDER BY created_at, candidate_id',
      )
      .all(projectId) as Row[];
    return rows.map((row) =>
      readRequiredJsonColumn(
        row['candidate_json'],
        coursewareCandidateSchema,
        'lesson_courseware_candidates',
        { reason: 'invalid_courseware_candidate' },
      ),
    );
  }

  createCandidate(input: CreateCoursewareCandidateInput): CoursewareCandidateDto {
    const now = new Date().toISOString();
    const candidate = coursewareCandidateSchema.parse({
      candidateId: input.candidateId,
      projectId: input.projectId,
      lessonId: input.lessonId,
      baseVersion: input.baseVersion,
      origin: 'model_generated',
      status: 'pending',
      scenes: input.scenes,
      instruction: input.instruction,
      note: '',
      reviewedBy: null,
      createdAt: now,
      updatedAt: now,
    });
    this.db
      .prepare(
        'INSERT INTO lesson_courseware_candidates (candidate_id, project_id, lesson_id, base_version, status, candidate_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        candidate.candidateId,
        input.projectId,
        input.lessonId,
        input.baseVersion,
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
  }): CoursewareCandidateDto {
    const current = this.getCandidate(input.projectId, input.candidateId);
    if (!current) throw new StudyError('NOT_FOUND', { candidateId: input.candidateId });
    if (current.status !== 'pending') {
      throw new StudyError('STEP_ALREADY_COMMITTED', {
        status: current.status,
        reason: 'courseware_already_decided',
      });
    }
    const status: CoursewareCandidateStatus =
      input.decision === 'approved' ? 'applied' : 'rejected';
    const next = coursewareCandidateSchema.parse({
      ...current,
      status,
      note: input.note,
      reviewedBy: input.reviewedBy,
      updatedAt: new Date().toISOString(),
    });
    this.db
      .prepare(
        'UPDATE lesson_courseware_candidates SET status=?, candidate_json=?, updated_at=? WHERE project_id=? AND candidate_id=?',
      )
      .run(status, encodeJson(next), next.updatedAt, input.projectId, input.candidateId);
    return next;
  }

  /** 读取某 requestId 的收据；意图不一致时按 nonce 复用拒绝。 */
  receipt(
    projectId: string,
    requestId: string,
    action: string,
    intent: string,
  ): CoursewareReceipt | null {
    const row = this.db
      .prepare(
        'SELECT action, intent_json, result_json FROM lesson_courseware_receipts WHERE project_id=? AND request_id=?',
      )
      .get(projectId, requestId) as Row | undefined;
    if (!row) return null;
    if (str(row['action']) !== action || str(row['intent_json']) !== intent) {
      throw new StudyError('VERSION_CONFLICT', { reason: 'courseware_nonce_reused' });
    }
    const decoded = decodeJson<unknown>(
      row['result_json'],
      z.unknown(),
      null,
      'lesson_courseware_receipts.result_json',
    );
    if (!decoded.ok) throw new StudyError('INTERNAL', { reason: 'invalid_courseware_receipt' });
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
        'INSERT INTO lesson_courseware_receipts (project_id, request_id, action, intent_json, result_json) VALUES (?,?,?,?,?)',
      )
      .run(projectId, requestId, action, intent, encodeJson(result));
  }

  static statusOf(value: string): CoursewareCandidateStatus {
    const status = STATUS_OF[value];
    if (!status) throw new StudyError('INTERNAL', { reason: 'invalid_courseware_status', value });
    return status;
  }
}
