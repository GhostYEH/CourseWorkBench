/**
 * 存储记录 → API DTO 的映射边界。
 *
 * 路由只返回这里定义的 DTO，不再把 SQLite row 直接透传给客户端；
 * 这样存储结构变化不会意外改变对外合同，答案等敏感字段也在此显式决定是否暴露。
 */

import type {
  AttemptDto,
  KnowledgePointDto,
  MaterialDto,
  ProposalDto,
  QuestionDto,
  QuestionListItemDto,
  SegmentDto,
} from '@sew/study-contracts';
import type {
  AttemptRow,
  KnowledgeRow,
  MaterialRow,
  ProposalRow,
  QuestionRow,
  SegmentRow,
} from '@sew/study-storage';

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
});

export const toSegmentDto = (row: SegmentRow): SegmentDto => ({
  segmentId: row.segmentId,
  ordinal: row.ordinal,
  text: row.text,
  fingerprint: row.fingerprint,
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

/** 列表项：不含答案与解析，供未授权列表与客户端缓存使用。 */
export const toQuestionListItemDto = (row: QuestionRow): QuestionListItemDto => ({
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
  answer: row.answer,
  solution: row.solution,
});

export const toAttemptDto = (row: AttemptRow, deduplicated = false): AttemptDto => ({
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
