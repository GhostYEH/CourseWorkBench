/**
 * 存储记录 → API DTO 的映射边界。
 *
 * 路由只返回这里定义的 DTO，不再把 SQLite row 直接透传给客户端；
 * 这样存储结构变化不会意外改变对外合同，答案等敏感字段也在此显式决定是否暴露。
 */

import type {
  AttemptDto,
  ClassroomSessionDto,
  ExplanationCardDto,
  KnowledgePointDto,
  LessonReviewRecordDto,
  LessonVersionDto,
  MaterialDto,
  ProposalDto,
  QuestionDto,
  QuestionListItemDto,
  RoleProfileDto,
  SegmentDto,
  SyllabusItemDto,
} from '@sew/study-contracts';
import type {
  AttemptRow,
  ClassroomSessionRow,
  ExplanationRow,
  KnowledgeRow,
  LessonReviewRow,
  LessonVersionRow,
  MaterialRow,
  ProposalRow,
  QuestionRow,
  RoleProfileRow,
  SegmentRow,
  SyllabusItemRow,
} from '@sew/study-storage';

export const toLessonVersionDto = (row: LessonVersionRow): LessonVersionDto => ({
  lessonId: row.lessonId,
  version: row.version,
  title: row.title,
  status: row.status,
  bundleId: row.bundleId,
  bundleDigest: row.bundleDigest,
  statementIds: row.statementIds,
  questionIds: row.questionIds,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const toLessonReviewDto = (row: LessonReviewRow): LessonReviewRecordDto => ({
  projectId: row.projectId,
  lessonId: row.lessonId,
  version: row.version,
  decision: row.decision,
  note: row.note,
  admittedKnowledgeIds: row.admittedKnowledgeIds,
  blockedKnowledgeIds: row.blockedKnowledgeIds,
  planRevision: row.planRevision,
  planDigest: row.planDigest,
  reviewedAt: row.reviewedAt,
});

/** 讲解卡与课堂会话按显式 DTO 出界面，存储行字段变化不会静默变成对外合同。 */
export const toExplanationDto = (row: ExplanationRow): ExplanationCardDto => ({
  explanationId: row.explanationId,
  projectId: row.projectId,
  lessonId: row.lessonId,
  lessonVersion: row.lessonVersion,
  sceneId: row.sceneId,
  position: row.position,
  kind: row.kind,
  origin: row.origin,
  status: row.status,
  text: row.text,
  statementIds: row.statementIds,
  reviewNote: row.reviewNote,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const toClassroomSessionDto = (row: ClassroomSessionRow): ClassroomSessionDto => ({
  sessionId: row.sessionId,
  projectId: row.projectId,
  runId: row.runId,
  lessonId: row.lessonId,
  lessonVersion: row.lessonVersion,
  bundleId: row.bundleId,
  stageId: row.stageId,
  learnerKey: row.learnerKey,
  status: row.status,
  awaitingReason: row.awaitingReason,
  currentSceneId: row.currentSceneId,
  roundIndex: row.roundIndex,
  roundCalls: row.roundCalls,
  roundPeerTurns: row.roundPeerTurns,
  lessonCalls: row.lessonCalls,
  peersEnabled: row.peersEnabled,
  peersEngagement: row.peersEngagement,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const toMaterialDto = (row: MaterialRow): MaterialDto => ({
  materialId: row.materialId,
  displayName: row.displayName,
  type: row.materialType,
  revision: row.revision,
  recordScope: row.recordScope,
  readableLocation: row.readableLocation,
  importedAt: row.importedAt,
  segmentCount: row.segmentCount,
  normalizationVersion: row.normalizationVersion,
  fingerprint: row.fingerprint,
  referencedByKnowledge: row.referencedByKnowledge,
  rawArchive: row.rawArchive,
  examVerification: row.examVerification,
});

export const toSegmentDto = (row: SegmentRow): SegmentDto => ({
  segmentId: row.segmentId,
  ordinal: row.ordinal,
  text: row.text,
  fingerprint: row.fingerprint,
  rawStartByte: row.rawStartByte,
  rawEndByte: row.rawEndByte,
  rawLineStart: row.rawLineStart,
  rawLineEnd: row.rawLineEnd,
});

export const toProposalDto = (row: ProposalRow): ProposalDto => ({
  proposalId: row.proposalId,
  name: row.name,
  concept: row.concept,
  conditions: row.conditions,
  scopeStatus: row.scopeStatus,
  recordScope: row.recordScope,
  prerequisites: row.prerequisites,
  evidence: row.evidence.map((item) => ({
    materialId: item.materialId,
    revision: item.revision,
    segmentId: item.segmentId,
    use: item.use,
    fingerprint: item.fingerprint ?? '',
    excerpt: item.excerpt ?? '',
  })),
  acceptance: row.acceptance,
  priority: row.priority,
  proposedBy: row.proposedBy,
  status: row.status,
  mechanical: row.mechanical,
  createdAt: row.createdAt,
  reviewedAt: row.reviewedAt,
  reviewNote: row.reviewNote,
  reviewProvenance: row.reviewProvenance,
  /** 乐观并发版本：审核提交必须基于该版本，客户端据此比对。 */
  revision: row.revision,
});

export const toKnowledgePointDto = (row: KnowledgeRow): KnowledgePointDto => ({
  knowledgeId: row.knowledgeId,
  name: row.name,
  concept: row.concept,
  conditions: row.conditions,
  sourceStatus: row.sourceStatus,
  recordScope: row.recordScope,
  reviewProvenance: row.reviewProvenance,
  scopeStatus: row.scopeStatus,
  masteryStatus: row.masteryStatus,
  syllabusItemId: row.syllabusItemId,
  syllabusRequirementKey: row.syllabusRequirementKey,
  prerequisites: row.prerequisites,
  evidence: row.evidence.map((item) => ({
    materialId: item.materialId,
    revision: item.revision,
    segmentId: item.segmentId,
    use: item.use,
    readableLocation: null,
    fingerprint: item.fingerprint ?? '',
    excerpt: item.excerpt ?? '',
  })),
  acceptance: row.acceptance,
  priority: row.priority,
  revision: row.revision,
});

/** 角色档案：权限位是服务端派生值，渲染层只读展示。 */
export const toRoleProfileDto = (row: RoleProfileRow): RoleProfileDto => ({
  profileId: row.profileId,
  kind: row.kind,
  name: row.name,
  persona: row.persona,
  explanation: row.explanation,
  configVersion: row.configVersion,
  recordScope: row.recordScope,
  permissions: row.permissions,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const toSyllabusItemDto = (row: SyllabusItemRow): SyllabusItemDto => ({
  itemId: row.itemId,
  code: row.code,
  label: row.label,
  recordScope: row.recordScope,
  requirements: row.requirements,
  source: row.source,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** 列表项：不含答案与解析，供未授权列表与客户端缓存使用。 */
export const toQuestionListItemDto = (row: QuestionRow): QuestionListItemDto => ({
  assessment: row.assessment
    ? {
        type: row.assessment.type,
        options: row.assessment.options,
        maxScore: row.assessment.maxScore,
        answerVersion: row.assessment.answerVersion,
      }
    : null,
  questionId: row.questionId,
  stem: row.stem,
  knowledgeIds: row.knowledgeIds,
  origin: row.origin,
  originLabel: row.originLabel,
  originDetail: row.originDetail,
  recordScope: row.recordScope,
  revision: row.revision,
});

/** 详情：仅在授权判分或明确需要答案的流程中返回。 */
export const toQuestionDetailDto = (row: QuestionRow): QuestionDto => ({
  ...toQuestionListItemDto(row),
  assessment: row.assessment,
  answer: row.answer,
  solution: row.solution,
});

export const toAttemptDto = (row: AttemptRow, deduplicated = false): AttemptDto => ({
  questionRevision: row.questionRevision,
  answerVersion: row.answerVersion,
  grading: row.grading,
  recordScope: row.recordScope,
  attemptId: row.attemptId,
  questionId: row.questionId,
  kind: row.kind,
  actorType: row.actorType as AttemptDto['actorType'],
  answerText: row.answerText,
  processText: row.processText,
  submittedAt: row.submittedAt,
  deduplicated,
  masteryAfter: row.masteryAfter,
  attributionStatus: row.attributionStatus,
});
