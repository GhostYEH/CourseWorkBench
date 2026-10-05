import { z } from 'zod';
import {
  StudyError,
  coursewareCandidateSchema,
  coursewareApplySchema,
  modelGenerationResultSchema,
  scenePlanSchema,
  scenePlanSaveSchema,
  planSceneSchema,
  type CoursewareCandidateDto,
  type ScenePlanDto,
} from '@sew/study-contracts';
import { scenePlanDigest } from '@sew/study-domain';
import type { SqlDatabase } from '../driver';
import { decodeJson, encodeJson } from '../json-codec';
import type { Row } from '../repositories/types';

const legacyPlanSchema = scenePlanSchema.omit({ digest: true });
const legacyCandidateSchema = coursewareCandidateSchema.omit({
  basePlanRevision: true,
  basePlanDigest: true,
});
const objectSchema = z.record(z.unknown());
const applyIntentSchema = z
  .object({
    candidateId: z.string().min(1),
    decision: z.enum(['approved', 'rejected']),
    note: z.string(),
  })
  .strict();
const savePlanIntentSchema = scenePlanSaveSchema
  .omit({ scope: true, action: true, requestId: true })
  // 旧写入合同允许 48 场景；历史回执不受新写入的 24 场景限制。
  .extend({ scenes: z.array(planSceneSchema).min(1).max(48) });
const applyPlanIntentSchema = coursewareApplySchema
  .omit({ scope: true, action: true, requestId: true })
  .extend({
    expectedPlanRevision: z.number().int().nonnegative().nullable(),
    override: z.boolean(),
  });

// 本地写入始终使用 toISOString；拒绝 Date.parse 的宽松日期纠正和缺时区输入。
const recordedTime = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
};

const restorePublishedReviewBinding = (db: SqlDatabase, row: Row, plan: ScenePlanDto): void => {
  const review = db
    .prepare(
      `SELECT r.reviewed_at, v.updated_at AS published_at, v.bundle_id
       FROM lesson_reviews r JOIN lesson_versions v
       ON v.project_id=r.project_id AND v.lesson_id=r.lesson_id AND v.version=r.version
       WHERE r.project_id=? AND r.lesson_id=? AND r.version=?
       AND r.decision='approved' AND r.plan_revision IS NULL AND r.plan_digest IS NULL
       AND v.status='published'`,
    )
    .get(plan.projectId, plan.lessonId, plan.lessonVersion) as Row | undefined;
  if (!review || review['bundle_id'] !== plan.bundleId) return;
  const planAt = recordedTime(plan.updatedAt);
  const storedPlanAt = recordedTime(row['updated_at']);
  const reviewedAt = recordedTime(review['reviewed_at']);
  const publishedAt = recordedTime(review['published_at']);
  // 只有严格可证明「最后保存早于审核，审核不晚于发布」时补绑定。同毫秒不能证明先后。
  if (
    planAt === null ||
    storedPlanAt !== planAt ||
    reviewedAt === null ||
    publishedAt === null ||
    !(planAt < reviewedAt && reviewedAt <= publishedAt)
  )
    return;
  db.prepare(
    'UPDATE lesson_reviews SET plan_revision=?, plan_digest=? WHERE project_id=? AND lesson_id=? AND version=?',
  ).run(plan.revision, plan.digest, plan.projectId, plan.lessonId, plan.lessonVersion);
};

function invalid(context: string): never {
  throw new StudyError('INTERNAL', { reason: 'invalid_scene_plan_migration', context });
}

const jsonObject = (value: unknown, context: string): Record<string, unknown> => {
  if (typeof value !== 'string' || value.trim().length === 0) return invalid(context);
  const decoded = decodeJson(value, objectSchema, {}, context);
  return decoded.ok ? decoded.value : invalid(context);
};

const upgradePlan = (value: unknown, context: string): ScenePlanDto => {
  const current = scenePlanSchema.safeParse(value);
  if (current.success) {
    if (current.data.digest !== scenePlanDigest(current.data)) return invalid(context);
    return current.data;
  }
  const legacy = legacyPlanSchema.safeParse(value);
  if (!legacy.success) return invalid(context);
  return scenePlanSchema.parse({ ...legacy.data, digest: scenePlanDigest(legacy.data) });
};

const upgradeCandidate = (value: unknown, context: string): CoursewareCandidateDto => {
  const current = coursewareCandidateSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = legacyCandidateSchema.safeParse(value);
  if (!legacy.success) return invalid(context);
  // 旧库从未保存生成时的计划基线。不能用当前计划冒充旧候选所依据的内容。
  // 0/null 在已有计划时必然触发版本冲突，必须重新查看并明确确认覆盖。
  return coursewareCandidateSchema.parse({
    ...legacy.data,
    basePlanRevision: 0,
    basePlanDigest: null,
  });
};

const upgradeApplyResult = (value: Record<string, unknown>, context: string) => {
  const result = {
    ...value,
    candidate: upgradeCandidate(value['candidate'], context),
    plan: value['plan'] === null ? null : upgradePlan(value['plan'], context),
  };
  const parsed = z
    .object({
      candidate: coursewareCandidateSchema,
      plan: scenePlanSchema.nullable(),
      deduplicated: z.boolean().optional(),
    })
    .strict()
    .safeParse(result);
  if (!parsed.success) return invalid(context);
  if (
    parsed.data.plan &&
    (parsed.data.plan.projectId !== parsed.data.candidate.projectId ||
      parsed.data.plan.lessonId !== parsed.data.candidate.lessonId ||
      parsed.data.plan.lessonVersion !== parsed.data.candidate.baseVersion)
  )
    invalid(context);
  return parsed.data;
};

/** 调用方必须将此数据升级与 schema_migrations 回执放在同一事务中。 */
export const migrateScenePlanJson = (db: SqlDatabase): void => {
  for (const row of db.prepare('SELECT * FROM lesson_scene_plans').all() as Row[]) {
    const context = `lesson_scene_plans[${String(row['lesson_id'])}#${String(row['lesson_version'])}]`;
    const plan = upgradePlan(jsonObject(row['plan_json'], context), context);
    if (
      plan.projectId !== row['project_id'] ||
      plan.lessonId !== row['lesson_id'] ||
      plan.lessonVersion !== row['lesson_version'] ||
      plan.bundleId !== row['bundle_id'] ||
      plan.revision !== row['revision'] ||
      plan.origin !== row['origin']
    )
      invalid(context);
    db.prepare(
      'UPDATE lesson_scene_plans SET plan_json=? WHERE project_id=? AND lesson_id=? AND lesson_version=?',
    ).run(encodeJson(plan), plan.projectId, plan.lessonId, plan.lessonVersion);
    restorePublishedReviewBinding(db, row, plan);
  }
  for (const row of db.prepare('SELECT * FROM lesson_courseware_candidates').all() as Row[]) {
    const context = `lesson_courseware_candidates[${String(row['candidate_id'])}]`;
    const candidate = upgradeCandidate(jsonObject(row['candidate_json'], context), context);
    if (
      candidate.candidateId !== row['candidate_id'] ||
      candidate.projectId !== row['project_id'] ||
      candidate.lessonId !== row['lesson_id'] ||
      candidate.baseVersion !== row['base_version'] ||
      candidate.status !== row['status'] ||
      candidate.basePlanRevision !== row['base_plan_revision'] ||
      candidate.basePlanDigest !== row['base_plan_digest']
    )
      invalid(context);
    db.prepare(
      'UPDATE lesson_courseware_candidates SET candidate_json=?, base_plan_revision=?, base_plan_digest=? WHERE candidate_id=?',
    ).run(
      encodeJson(candidate),
      candidate.basePlanRevision,
      candidate.basePlanDigest,
      candidate.candidateId,
    );
  }
  for (const row of db.prepare('SELECT * FROM lesson_courseware_receipts').all() as Row[]) {
    const context = `lesson_courseware_receipts[${String(row['request_id'])}]`;
    const value = jsonObject(row['result_json'], context);
    if (row['action'] === 'propose') {
      const result = {
        ...value,
        candidate:
          value['candidate'] === null ? null : upgradeCandidate(value['candidate'], context),
      };
      const parsed = z
        .object({
          candidate: coursewareCandidateSchema.nullable(),
          generation: modelGenerationResultSchema,
          deduplicated: z.boolean(),
        })
        .strict()
        .safeParse(result);
      if (!parsed.success) invalid(context);
      if (parsed.data.candidate && parsed.data.candidate.projectId !== row['project_id'])
        invalid(context);
      db.prepare(
        'UPDATE lesson_courseware_receipts SET result_json=? WHERE project_id=? AND request_id=?',
      ).run(encodeJson(parsed.data), row['project_id'], row['request_id']);
    } else if (row['action'] === 'apply') {
      const result = upgradeApplyResult(value, context);
      const intent = applyIntentSchema.safeParse(jsonObject(row['intent_json'], context));
      if (
        !intent.success ||
        intent.data.candidateId !== result.candidate.candidateId ||
        result.candidate.projectId !== row['project_id']
      )
        invalid(context);
      if (
        result.candidate.status !==
          (intent.data.decision === 'approved' ? 'applied' : 'rejected') ||
        (intent.data.decision === 'approved' ? result.plan === null : result.plan !== null)
      )
        invalid(context);
      const nextIntent = encodeJson({
        candidateId: intent.data.candidateId,
        decision: intent.data.decision,
        note: intent.data.note,
        expectedPlanRevision: null,
        override: false,
      });
      const completedResult = encodeJson({ candidate: result.candidate, plan: result.plan });
      const existing = db
        .prepare(
          'SELECT action, intent_json, state, result_json FROM lesson_scene_plan_receipts WHERE project_id=? AND request_id=?',
        )
        .get(row['project_id'], row['request_id']) as Row | undefined;
      if (existing) {
        if (
          existing['action'] !== 'apply-courseware' ||
          existing['intent_json'] !== nextIntent ||
          existing['state'] !== 'completed'
        )
          invalid(context);
        const existingResult = upgradeApplyResult(
          jsonObject(existing['result_json'], context),
          context,
        );
        if (encodeJson(existingResult) !== completedResult) invalid(context);
      }
      if (!existing)
        db.prepare(
          `INSERT INTO lesson_scene_plan_receipts
        (project_id,request_id,action,intent_json,state,result_json,message,error_code,error_reason,created_at)
        VALUES (?,?,'apply-courseware',?,'completed',?,'',NULL,NULL,?)`,
        ).run(
          row['project_id'],
          row['request_id'],
          nextIntent,
          completedResult,
          result.candidate.updatedAt,
        );
      db.prepare(
        'UPDATE lesson_courseware_receipts SET result_json=? WHERE project_id=? AND request_id=?',
      ).run(encodeJson(result), row['project_id'], row['request_id']);
    } else invalid(context);
  }
  // v28 已经落过的回执也可能嵌套旧 DTO；按快照本身升级，不能替换为当前内容。
  for (const row of db
    .prepare("SELECT * FROM lesson_scene_plan_receipts WHERE state='completed'")
    .all() as Row[]) {
    const context = `lesson_scene_plan_receipts[${String(row['request_id'])}]`;
    const value = jsonObject(row['result_json'], context);
    let result: unknown;
    if (row['action'] === 'save-scene-plan') {
      if (Object.keys(value).length !== 1 || !('plan' in value)) invalid(context);
      const plan = upgradePlan(value['plan'], context);
      const intent = savePlanIntentSchema.safeParse(jsonObject(row['intent_json'], context));
      if (
        !intent.success ||
        plan.projectId !== row['project_id'] ||
        plan.lessonId !== intent.data.lessonId ||
        plan.lessonVersion !== intent.data.version
      )
        invalid(context);
      result = { plan };
    } else if (row['action'] === 'apply-courseware') {
      const upgraded = upgradeApplyResult(value, context);
      if ('deduplicated' in upgraded) invalid(context);
      const intent = applyPlanIntentSchema.safeParse(jsonObject(row['intent_json'], context));
      if (
        !intent.success ||
        upgraded.candidate.projectId !== row['project_id'] ||
        upgraded.candidate.candidateId !== intent.data.candidateId ||
        upgraded.candidate.status !==
          (intent.data.decision === 'approved' ? 'applied' : 'rejected') ||
        (intent.data.decision === 'approved' ? upgraded.plan === null : upgraded.plan !== null)
      )
        invalid(context);
      result = upgraded;
    } else invalid(context);
    db.prepare(
      'UPDATE lesson_scene_plan_receipts SET result_json=? WHERE project_id=? AND request_id=?',
    ).run(encodeJson(result), row['project_id'], row['request_id']);
  }
  // 无法证明时序的旧审核仍保留 NULL；草案必须重审。历史课件、发布状态、题目和作答不改写。
};
