/**
 * 存储层行类型与行映射。
 *
 * 这些是 `StudyStore` 门面向上暴露的稳定数据结构；repository 只负责 SQL，
 * 行到领域对象的映射集中在这里，避免各 repository 各自解释 JSON 列。
 */

import type {
  ClassroomActionKind,
  ClassroomActionPayloadDto,
  ClassroomSessionStatus,
  EvidenceUse,
  ExplanationKind,
  ExplanationOrigin,
  ExplanationStatus,
  FrozenVersionsDto,
  EvidenceBundleDto,
  LessonReviewDecision,
  MasteryStatus,
  MaterialRawArchiveDto,
  MechanicalCheckDto,
  PeerEngagement,
  PlanPayloadDto,
  QuestionOrigin,
  QuestionAssessmentDto,
  AssessmentGradingDto,
  RecordScope,
  ReviewProvenance,
  RoleExplanation,
  RoleKind,
  RolePermissionsDto,
  RunState,
  ScopeStatus,
  SourceStatus,
} from '@sew/study-contracts';
import {
  assessmentGradingSchema,
  questionAssessmentSchema,
  LESSON_STATUS,
  RUN_STATE,
  StudyError,
} from '@sew/study-contracts';
import type { OriginRecord } from '@sew/study-domain';
import { z } from 'zod';
import {
  decodeJson,
  evidenceListSchema,
  frozenVersionsSchema,
  knowledgeIdsSchema,
  mechanicalSchema,
  originRecordSchema,
  prerequisitesSchema,
} from '../json-codec';

export type Row = Record<string, unknown>;

export const str = (value: unknown): string => (typeof value === 'string' ? value : '');
export const num = (value: unknown): number =>
  typeof value === 'number' ? value : Number(value ?? 0);
export const nullableStr = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;
export const intOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
export const recordScope = (value: unknown): RecordScope => {
  if (value === 'formal' || value === 'demo') return value;
  throw new StudyError('INTERNAL', { reason: 'invalid_record_scope' });
};
/** run 状态是恢复判定输入：未知状态不能降级成某个默认值继续跑。 */
export const runState = (value: unknown): RunState => {
  if (typeof value === 'string' && (RUN_STATE as readonly string[]).includes(value))
    return value as RunState;
  throw new StudyError('INTERNAL', { reason: 'invalid_run_state' });
};
export const reviewProvenance = (value: unknown): ReviewProvenance | null => {
  if (value === null || value === undefined) return null;
  if (value === 'user_semantic' || value === 'demo_author') return value;
  throw new StudyError('INTERNAL', { reason: 'invalid_review_provenance' });
};

export interface ProjectRow {
  projectId: string;
  displayName: string;
  subject: string;
  goal: string;
  examDate: string | null;
  dailyMinutes: number;
  learningMode: 'beginner' | 'review';
  formatVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface MaterialRow {
  materialId: string;
  revision: number;
  recordScope: RecordScope;
  displayName: string;
  materialType: 'txt' | 'md';
  readableLocation: string | null;
  importedAt: string;
  normalizationVersion: string;
  fingerprint: string;
  segmentCount: number;
  referencedByKnowledge: number;
  /** 原始文件字节的归档状态；未归档时不能按原文打开。 */
  rawArchive: MaterialRawArchiveDto;
  /** 人工核实「该版本可作为考试真题来源」的记录；未核实时为 null。 */
  examVerification: { verifiedAt: string; note: string } | null;
}

/** `source_raw_archives` 的一行（不含字节），供服务端核对与打开原文副本使用。 */
export interface MaterialRawArchiveRow {
  materialId: string;
  revision: number;
  storageMode: 'archived';
  absentReason: null;
  originalName: string | null;
  mediaType: 'text/plain' | 'text/markdown';
  sha256: string;
  byteLength: number;
  archivedAt: string;
}

export interface SegmentRow {
  materialId: string;
  revision: number;
  segmentId: string;
  ordinal: number;
  text: string;
  fingerprint: string;
  /** 段落在归档原文中的 UTF-8 字节区间与行号；原文未归档时为 null。 */
  rawStartByte: number | null;
  rawEndByte: number | null;
  rawLineStart: number | null;
  rawLineEnd: number | null;
}

export interface EvidenceStored {
  materialId: string;
  revision: number;
  segmentId: string;
  use: EvidenceUse;
  fingerprint?: string;
  excerpt?: string;
}

export interface ProposalRow {
  proposalId: string;
  name: string;
  concept: string;
  conditions: string;
  scopeStatus: ScopeStatus;
  recordScope: RecordScope;
  prerequisites: string[];
  evidence: EvidenceStored[];
  acceptance: string;
  priority: 'high' | 'medium' | 'low';
  proposedBy: 'ai' | 'user';
  status: 'pending' | 'approved' | 'rejected' | 'needs_material';
  mechanical: MechanicalCheckDto;
  reviewNote: string | null;
  reviewProvenance: ReviewProvenance | null;
  createdAt: string;
  reviewedAt: string | null;
  revision: number;
}

export interface KnowledgeRow {
  knowledgeId: string;
  name: string;
  concept: string;
  conditions: string;
  sourceStatus: SourceStatus;
  recordScope: RecordScope;
  reviewProvenance: ReviewProvenance | null;
  scopeStatus: ScopeStatus;
  masteryStatus: MasteryStatus;
  /** 考纲条目映射；未映射为 null，覆盖统计按缺口单列而不是按已完成计。 */
  syllabusItemId: string | null;
  syllabusRequirementKey: string | null;
  prerequisites: string[];
  evidence: EvidenceStored[];
  acceptance: string;
  priority: 'high' | 'medium' | 'low';
  originProposalId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionRow {
  assessment: QuestionAssessmentDto | null;
  questionId: string;
  stem: string;
  answer: string;
  solution: string;
  knowledgeIds: string[];
  recordScope: RecordScope;
  origin: QuestionOrigin;
  originLabel: string;
  originDetail: string | null;
  originRecord: OriginRecord | null;
  /** 请求声明的身份（可能被降级），供评测区分合法新编题与被阻止的伪装题。 */
  requestedOrigin: QuestionOrigin;
  /** true 表示这是一次「新编题自称真题」的结构性伪装尝试。 */
  forgedExamClaim: boolean;
  revision: number;
  createdAt: string;
}

export interface AttemptRow {
  questionRevision: number | null;
  answerVersion: number | null;
  grading: AssessmentGradingDto | null;
  recordScope: RecordScope;
  attemptId: string;
  questionId: string;
  kind: 'real' | 'simulation';
  /** 请求声明的 kind（可能因主体非本人被强制为 simulation）。 */
  requestedKind: 'real' | 'simulation';
  actorType: string;
  answerText: string;
  processText: string;
  masteryAfter: MasteryStatus | null;
  attributionStatus: 'pending_process' | 'proposed';
  idempotencyKey: string;
  submittedAt: string;
}

/** 课程版本状态与合同同源，避免存储层自己维护一份会漂移的清单。 */
export type LessonStatus = (typeof LESSON_STATUS)[number];

/** 课程版本的一次人工审核结论。 */
export interface LessonReviewRow {
  projectId: string;
  lessonId: string;
  version: number;
  decision: LessonReviewDecision;
  note: string;
  /** 审核当时的准入快照：记录「按当时事实批准」，而不是永久担保。 */
  admittedKnowledgeIds: string[];
  blockedKnowledgeIds: string[];
  /**
   * 审核当时的计划内容基线：计划改了内容，旧审核即失效。无计划的历史课程为 null，
   * 按「证据包即内容」处理（保持兼容，不把旧审核一律判失效）。
   */
  planRevision: number | null;
  planDigest: string | null;
  reviewedAt: string;
}

/** 冻结的证据包一行；bundle 按权威列校验。 */
export interface EvidenceBundleRow {
  bundleId: string;
  projectId: string;
  digest: string;
  frozenAt: string;
  bundle: EvidenceBundleDto;
}

export interface LessonVersionRow {
  lessonId: string;
  version: number;
  projectId: string;
  title: string;
  status: LessonStatus;
  bundleId: string;
  bundleDigest: string;
  statementIds: string[];
  questionIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** 课程 ↔ OpenMAIC stage 的当前映射（classroom_links 侧表）。 */
export interface ClassroomLinkRow {
  lessonId: string;
  projectId: string;
  lessonVersion: number;
  stageId: string | null;
  stageDocumentVersion: number | null;
  documentDigest: string | null;
  evidenceBundleId: string | null;
  status: LessonStatus;
  /** 状态说明：撤回原因等人类可读依据，界面必须与状态一起显示。 */
  statusNote: string;
  createdAt: string;
  updatedAt: string;
}

/** 讲解卡行：statementIds 指向冻结证据包内的陈述编号。 */
export interface ExplanationRow {
  explanationId: string;
  projectId: string;
  lessonId: string;
  lessonVersion: number;
  sceneId: string;
  position: number;
  kind: ExplanationKind;
  origin: ExplanationOrigin;
  status: ExplanationStatus;
  text: string;
  statementIds: string[];
  reviewNote: string;
  createdAt: string;
  updatedAt: string;
}

/** 课堂会话行：等待状态与预算计数都落库，重启后按原样继续等待。 */
export interface ClassroomSessionRow {
  sessionId: string;
  projectId: string;
  runId: string | null;
  lessonId: string;
  lessonVersion: number;
  bundleId: string;
  stageId: string | null;
  learnerKey: string;
  status: ClassroomSessionStatus;
  awaitingReason: string;
  currentSceneId: string;
  roundIndex: number;
  roundCalls: number;
  roundPeerTurns: number;
  lessonCalls: number;
  peersEnabled: boolean;
  /** 同学参与度：只影响开口频率，不是权限旋钮。 */
  peersEngagement: PeerEngagement;
  createdAt: string;
  updatedAt: string;
}

/** 课堂动作收据行：payload 即动作结果，重复 step_key 读回它而不重复执行。 */
export interface ClassroomActionRow {
  stepKey: string;
  sessionId: string;
  projectId: string;
  kind: ClassroomActionKind;
  sceneId: string;
  payload: ClassroomActionPayloadDto;
  at: string;
}

/** 角色档案行：权限位是派生值，不来自任何写入请求。 */
export interface RoleProfileRow {
  profileId: string;
  kind: RoleKind;
  name: string;
  persona: string;
  explanation: RoleExplanation;
  configVersion: number;
  recordScope: RecordScope;
  permissions: RolePermissionsDto;
  createdAt: string;
  updatedAt: string;
}

/** 计划版本行：载荷已经是校验过的 v1 形状，不再有泛型断言。 */
export interface PlanVersionRow {
  version: number;
  status: 'draft' | 'confirmed';
  createdAt: string;
  payload: PlanPayloadDto;
}

export const mapPlanStatus = (value: string): PlanVersionRow['status'] => {
  if (value === 'confirmed' || value === 'draft') return value;
  throw new StudyError('INTERNAL', { reason: 'invalid_plan_status', status: value });
};

export interface RunRow {
  runId: string;
  state: RunState;
  /** 冻结版本集合：恢复必须核对该摘要，损坏时按权威列拒绝。 */
  frozen: FrozenVersionsDto;
  terminatedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImportMaterialInput {
  projectId: string;
  displayName: string;
  materialType: 'txt' | 'md';
  readableLocation?: string | undefined;
  /** 已授权文件的原始文本内容。文件读取由本地服务在主进程授权后执行。 */
  rawText: string;
  /**
   * 原生选择器读到的原样字节（含 BOM 与原换行风格）。粘贴导入没有原文件，为 null，
   * 此时归档记录明确写成 absent，不伪装成可打开的原文。
   */
  rawBytes?: Uint8Array | null;
  /** 选择器文件名字面，仅用于展示与人工核对；不作为路径参与任何文件操作。 */
  originalName?: string | null;
  /** Internal provisioning scope; HTTP import DTOs cannot set this field. */
  recordScope?: RecordScope;
}

export interface CreateProposalInput {
  projectId: string;
  name: string;
  concept: string;
  conditions: string;
  scopeStatus: ScopeStatus;
  prerequisites: string[];
  evidence: Array<{ materialId: string; revision: number; segmentId: string; use: EvidenceUse }>;
  acceptance: string;
  priority: 'high' | 'medium' | 'low';
  proposedBy: 'ai' | 'user';
  /** Internal provisioning scope; HTTP candidates default to formal. */
  recordScope?: RecordScope;
}

export interface ReviewOutcome {
  proposal: ProposalRow;
  knowledgePoint: KnowledgeRow | null;
  /** 审核结论为通过、但业务上仍需人工语义确认时为 true。 */
  requiresSemanticReview: boolean;
}

export interface SubmitAttemptInput {
  projectId: string;
  questionId: string;
  idempotencyKey: string;
  actorType: 'human_learner' | 'teacher_ai' | 'peer_ai' | 'system';
  answerText: string;
  processText: string;
  kind: 'real' | 'simulation';
}

export interface SubmitAttemptOutcome {
  attempt: AttemptRow;
  deduplicated: boolean;
  /** 模拟作答被强制改写时为 true，服务层据此记录一次越权尝试。 */
  forcedSimulation: boolean;
}

/**
 * JSON 列解析策略。
 *
 * `authoritative` 为 true 时，该列是权威事实的必要输入（例如知识点的前置依赖与证据），
 * 损坏数据不能被静默替换，调用方应抛出 `StudyError('INTERNAL')` 而不是继续。
 */
export interface JsonColumnPolicy {
  warn: (error: string) => void;
  onAuthoritativeFailure: (error: string) => never;
}

/** 默认策略：非权威列记录一行诊断并降级；权威列损坏时拒绝使用。 */
export const defaultJsonPolicy: JsonColumnPolicy = {
  warn: (error) => console.warn(`[study-storage] ${error}`),
  onAuthoritativeFailure: (error): never => {
    throw new StudyError('INTERNAL', { context: error });
  },
};

/** 解析 JSON 列：损坏时按策略处理，并返回显式 fallback。 */
export const readJsonColumn = <T>(
  value: unknown,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  fallback: T,
  context: string,
  policy: JsonColumnPolicy,
): T => {
  const decoded = decodeJson(value, schema, fallback, context);
  if (!decoded.ok && decoded.error) {
    policy.warn(decoded.error);
  }
  return decoded.value;
};

/** 权威 JSON 列：损坏即拒绝，避免用空值掩盖事实。 */
export const readAuthoritativeJsonColumn = <T>(
  value: unknown,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  context: string,
  policy: JsonColumnPolicy,
): T => {
  const decoded = decodeJson<T | undefined>(value, schema, undefined, context);
  if (!decoded.ok) {
    policy.onAuthoritativeFailure(decoded.error ?? `${context}: 权威 JSON 列不可用`);
  }
  const result = decoded.value;
  if (result === undefined) {
    policy.onAuthoritativeFailure(`${context}: 权威 JSON 列缺失，不能作为空值继续`);
  }
  return result;
};

/** Required JSON values share the decoder while preserving the caller's diagnostic reason. */
export const readRequiredJsonColumn = <T>(
  value: unknown,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  context: string,
  details: Record<string, unknown>,
): T =>
  readAuthoritativeJsonColumn(value, schema, context, {
    warn: defaultJsonPolicy.warn,
    onAuthoritativeFailure: (diagnostic) => {
      defaultJsonPolicy.warn(diagnostic);
      throw new StudyError('INTERNAL', details);
    },
  });

export const mapProject = (row: Row): ProjectRow => ({
  projectId: str(row['project_id']),
  displayName: str(row['display_name']),
  subject: str(row['subject']),
  goal: str(row['goal']),
  examDate: nullableStr(row['exam_date']),
  dailyMinutes: num(row['daily_minutes']),
  learningMode: str(row['learning_mode']) === 'review' ? 'review' : 'beginner',
  formatVersion: num(row['format_version']),
  createdAt: str(row['created_at']),
  updatedAt: str(row['updated_at']),
});

export const mapSegment = (row: Row): SegmentRow => ({
  materialId: str(row['material_id']),
  revision: num(row['revision']),
  segmentId: str(row['segment_id']),
  ordinal: num(row['ordinal']),
  text: str(row['text']),
  fingerprint: str(row['fingerprint']),
  rawStartByte: intOrNull(row['raw_start_byte']),
  rawEndByte: intOrNull(row['raw_end_byte']),
  rawLineStart: intOrNull(row['raw_line_start']),
  rawLineEnd: intOrNull(row['raw_line_end']),
});

export const mapRawArchive = (row: Row): MaterialRawArchiveDto => {
  const mode = str(row['raw_storage_mode']);
  if (mode === 'archived') {
    return {
      state: 'archived',
      sha256: str(row['raw_sha256']),
      byteLength: num(row['raw_byte_length']),
      mediaType: str(row['raw_media_type']) === 'text/markdown' ? 'text/markdown' : 'text/plain',
      originalName: nullableStr(row['raw_original_name']),
      archivedAt: str(row['raw_archived_at']),
    };
  }
  if (mode === 'absent') {
    return {
      state: 'absent',
      reason: str(row['raw_absent_reason']) === 'text_import' ? 'text_import' : 'legacy_import',
    };
  }
  // 每个材料版本都必须有一条归档记录：缺行说明不变量被破坏，不能当作未归档降级。
  throw new StudyError('INTERNAL', { reason: 'raw_archive_row_missing' });
};

export const mapMaterial = (row: Row): MaterialRow => ({
  materialId: str(row['material_id']),
  revision: num(row['revision']),
  recordScope: recordScope(row['record_scope']),
  displayName: str(row['display_name']),
  materialType: str(row['material_type']) === 'md' ? 'md' : 'txt',
  readableLocation: nullableStr(row['readable_location']),
  importedAt: str(row['imported_at']),
  normalizationVersion: str(row['normalization_version']),
  fingerprint: str(row['fingerprint']),
  segmentCount: num(row['segment_count']),
  referencedByKnowledge: num(row['referenced']),
  rawArchive: mapRawArchive(row),
  examVerification:
    typeof row['exam_verified_at'] === 'string'
      ? { verifiedAt: row['exam_verified_at'], note: str(row['exam_note']) }
      : null,
});

export const mapProposal = (row: Row, policy: JsonColumnPolicy): ProposalRow => ({
  proposalId: str(row['proposal_id']),
  name: str(row['name']),
  concept: str(row['concept']),
  conditions: str(row['conditions']),
  scopeStatus: str(row['scope_status']) as ScopeStatus,
  recordScope: recordScope(row['record_scope']),
  prerequisites: readJsonColumn(
    row['prerequisites_json'],
    prerequisitesSchema,
    [],
    'proposals.prerequisites_json',
    policy,
  ),
  evidence: readJsonColumn(
    row['evidence_json'],
    evidenceListSchema,
    [],
    'proposals.evidence_json',
    policy,
  ),
  acceptance: str(row['acceptance']),
  priority: (str(row['priority']) || 'medium') as ProposalRow['priority'],
  proposedBy: str(row['proposed_by']) === 'user' ? 'user' : 'ai',
  status: (str(row['status']) || 'pending') as ProposalRow['status'],
  mechanical: readJsonColumn(
    row['mechanical_json'],
    mechanicalSchema,
    { passed: false, checks: [] },
    'proposals.mechanical_json',
    policy,
  ),
  reviewNote: nullableStr(row['review_note']),
  reviewProvenance: reviewProvenance(row['review_provenance']),
  createdAt: str(row['created_at']),
  reviewedAt: nullableStr(row['reviewed_at']),
  revision: num(row['revision']),
});

export const mapKnowledge = (row: Row, policy: JsonColumnPolicy): KnowledgeRow => ({
  knowledgeId: str(row['knowledge_id']),
  name: str(row['name']),
  concept: str(row['concept']),
  conditions: str(row['conditions']),
  sourceStatus: (str(row['source_status']) || 'pending') as SourceStatus,
  recordScope: recordScope(row['record_scope']),
  reviewProvenance: reviewProvenance(row['review_provenance']),
  scopeStatus: str(row['scope_status']) as ScopeStatus,
  masteryStatus: (str(row['mastery_status']) || 'untested') as MasteryStatus,
  syllabusItemId: nullableStr(row['syllabus_item_id']),
  syllabusRequirementKey: nullableStr(row['syllabus_requirement_key']),
  prerequisites: readAuthoritativeJsonColumn(
    row['prerequisites_json'],
    prerequisitesSchema,
    'knowledge_points.prerequisites_json',
    policy,
  ),
  evidence: readAuthoritativeJsonColumn(
    row['evidence_json'],
    evidenceListSchema,
    'knowledge_points.evidence_json',
    policy,
  ),
  acceptance: str(row['acceptance']),
  priority: (str(row['priority']) || 'medium') as KnowledgeRow['priority'],
  originProposalId: nullableStr(row['origin_proposal_id']),
  revision: num(row['revision']),
  createdAt: str(row['created_at']),
  updatedAt: str(row['updated_at']),
});

export const mapQuestion = (row: Row, policy: JsonColumnPolicy): QuestionRow => ({
  assessment:
    row['assessment_json'] == null
      ? null
      : readAuthoritativeJsonColumn(
          row['assessment_json'],
          questionAssessmentSchema,
          'questions.assessment_json',
          policy,
        ),
  questionId: str(row['question_id']),
  stem: str(row['stem']),
  answer: str(row['answer']),
  solution: str(row['solution']),
  // knowledge_ids_json 是准入判断的输入；损坏即拒绝，不能降级为空数组绕过准入。
  knowledgeIds: readAuthoritativeJsonColumn(
    row['knowledge_ids_json'],
    knowledgeIdsSchema,
    'questions.knowledge_ids_json',
    policy,
  ),
  recordScope: recordScope(row['record_scope']),
  origin: str(row['origin']) as QuestionOrigin,
  originLabel: str(row['origin_label']),
  originDetail: nullableStr(row['origin_detail']),
  originRecord: readJsonColumn<OriginRecord | null>(
    row['origin_record_json'],
    originRecordSchema.nullable(),
    null,
    'questions.origin_record_json',
    policy,
  ),
  requestedOrigin: (str(row['requested_origin']) || 'ai_new') as QuestionOrigin,
  forgedExamClaim: num(row['forged_exam_claim']) !== 0,
  revision: num(row['revision']),
  createdAt: str(row['created_at']),
});

export const mapAttempt = (row: Row): AttemptRow => ({
  questionRevision: intOrNull(row['question_revision']),
  answerVersion: intOrNull(row['answer_version']),
  grading:
    row['grading_json'] == null
      ? null
      : readAuthoritativeJsonColumn(
          row['grading_json'],
          assessmentGradingSchema,
          'attempts.grading_json',
          defaultJsonPolicy,
        ),
  recordScope: recordScope(row['record_scope']),
  attemptId: str(row['attempt_id']),
  questionId: str(row['question_id']),
  // 失败开放会把被改写的 kind 当成真实作答污染本人统计；只有严格 'real' 才是 real。
  kind: str(row['kind']) === 'real' ? 'real' : 'simulation',
  requestedKind: str(row['requested_kind']) === 'real' ? 'real' : 'simulation',
  actorType: str(row['actor_type']),
  answerText: str(row['answer_text']),
  processText: str(row['process_text']),
  masteryAfter: nullableStr(row['mastery_after']) as MasteryStatus | null,
  attributionStatus: str(row['attribution_status']) === 'proposed' ? 'proposed' : 'pending_process',
  idempotencyKey: str(row['idempotency_key']),
  submittedAt: str(row['submitted_at']),
});

export const mapRun = (row: Row, policy: JsonColumnPolicy): RunRow => ({
  runId: str(row['run_id']),
  state: runState(row['state']),
  frozen: readAuthoritativeJsonColumn(
    row['frozen_json'],
    frozenVersionsSchema,
    'runs.frozen_json',
    policy,
  ),
  terminatedReason: nullableStr(row['terminated_reason']),
  createdAt: str(row['created_at']),
  updatedAt: str(row['updated_at']),
});
