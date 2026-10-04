/**
 * 课程证据包与课程版本（LESSON-01 的纯判断）。
 *
 * 证据包一旦冻结就不随来源更新改写：旧课仍然记录它当时引用的材料版本与摘要。
 * 这里只做机械可核对的部分——引用可定位、陈述指向的知识点已通过准入、题目只引用
 * 包内知识点；「引用是否真的支持该陈述」仍由人工语义审核决定，不在本层宣称。
 */

import { StudyError } from '@sew/study-contracts';
import type {
  BundleQuestionDto,
  BundleStatementDto,
  EvidenceBundleDto,
  EvidenceRefInput,
  LessonStatus,
  QuestionOrigin,
} from '@sew/study-contracts';
import { canonicalJson } from './classroom';
import { fingerprintOf } from './normalize';
export interface BundleSegmentRecord {
  materialId: string;
  revision: number;
  segmentId: string;
  text: string;
  fingerprint: string;
}

export interface BundleQuestionRecord {
  questionId: string;
  revision: number;
  origin: QuestionOrigin;
  knowledgeIds: string[];
}

export interface EvidenceBundleInput {
  projectId: string;
  subject: string;
  recordScope: EvidenceBundleDto['recordScope'];
  planVersion: number;
  teachingPreferenceVersion: number;
  roleConfigDigest: string | null;
  /**
   * 陈述及其来源。证据引用由服务从知识点的已批准证据填入（审核人不能凭空指定段落）：
   * 领域层只核对它是否仍可定位、指纹是否仍然一致。
   */
  statements: Array<{
    knowledgeId: string;
    text: string;
    conditions: string;
    evidence: EvidenceRefInput[];
  }>;
  questionIds: string[];
  /** 陈述引用的知识点必须已经核实且通过准入。 */
  admittedKnowledgeIds: ReadonlySet<string>;
  knowledgeVersions: Array<{ knowledgeId: string; revision: number }>;
  materialRevisions: Record<string, number>;
  /** 只查找同一记录范围内的已登记段落；查不到即视为不可定位。 */
  lookupSegment: (materialId: string, revision: number, segmentId: string) => BundleSegmentRecord | undefined;
  questions: ReadonlyMap<string, BundleQuestionRecord>;
}

/** 证据包摘要：同样的输入必得同一个摘要，因此重复冻结不会堆出第二份证据包。 */
export const evidenceBundleDigest = (bundle: EvidenceBundleDto): string =>
  fingerprintOf(canonicalJson(bundle));

/**
 * 陈述编号按内容生成：同一条陈述在任何一次冻结里都得到同一个编号，
 * 因此重复冻结按摘要复用，不会堆出第二份证据包。
 */
export const statementIdOf = (input: { knowledgeId: string; text: string; conditions: string }): string =>
  `stmt_${fingerprintOf(canonicalJson(input)).slice(0, 24)}`;

/**
 * 组装并校验证据包。
 *
 * 失败即整包不成立：陈述缺来源、引用指向旧版本或已失效段落、题目引用包外知识点，
 * 都不允许「先冻结再补齐」。
 */
export const buildEvidenceBundle = (input: EvidenceBundleInput): { bundle: EvidenceBundleDto; digest: string } => {
  if (input.statements.length === 0) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'no_statements' });
  }

  const statements: BundleStatementDto[] = [];
  const segmentDigests: EvidenceBundleDto['segmentDigests'] = [];
  for (const statement of input.statements) {
    if (!input.admittedKnowledgeIds.has(statement.knowledgeId)) {
      throw new StudyError('KNOWLEDGE_NOT_VERIFIED', {
        knowledgeId: statement.knowledgeId,
        reason: 'statement_not_admitted',
      });
    }
    if (statement.evidence.length === 0) {
      throw new StudyError('SOURCE_MISSING', { knowledgeId: statement.knowledgeId });
    }
    const evidence = statement.evidence;
    const statementId = statementIdOf(statement);
    for (const ref of evidence) {
      const segment = input.lookupSegment(ref.materialId, ref.revision, ref.segmentId);
      if (!segment) {
        throw new StudyError('SOURCE_SEGMENT_NOT_FOUND', {
          statementId,
          materialId: ref.materialId,
          revision: ref.revision,
          segmentId: ref.segmentId,
        });
      }
      if (fingerprintOf(segment.text) !== segment.fingerprint) {
        throw new StudyError('SOURCE_FINGERPRINT_MISMATCH', { statementId, segmentId: ref.segmentId });
      }
      const key = `${ref.materialId}|${ref.revision}|${ref.segmentId}`;
      if (!segmentDigests.some((entry) => `${entry.materialId}|${entry.revision}|${entry.segmentId}` === key)) {
        segmentDigests.push({
          materialId: ref.materialId,
          revision: ref.revision,
          segmentId: ref.segmentId,
          fingerprint: segment.fingerprint,
        });
      }
    }
    if (!statements.some((entry) => entry.statementId === statementId)) {
      statements.push({ statementId, knowledgeId: statement.knowledgeId, text: statement.text, conditions: statement.conditions, evidence });
    }
  }

  const bundleKnowledgeIds = new Set(statements.map((statement) => statement.knowledgeId));
  const questions: BundleQuestionDto[] = [];
  for (const questionId of [...new Set(input.questionIds)]) {
    const question = input.questions.get(questionId);
    if (!question) {
      throw new StudyError('NOT_FOUND', { questionId, reason: 'question_not_in_project' });
    }
    const outside = question.knowledgeIds.filter((id) => !bundleKnowledgeIds.has(id));
    if (outside.length > 0) {
      throw new StudyError('KNOWLEDGE_SCOPE_INVALID', { questionId, outside });
    }
    questions.push({
      questionId: question.questionId,
      revision: question.revision,
      origin: question.origin,
      knowledgeIds: [...question.knowledgeIds],
    });
  }

  const bundle: EvidenceBundleDto = {
    bundleVersion: 1,
    projectId: input.projectId,
    subject: input.subject,
    recordScope: input.recordScope,
    planVersion: input.planVersion,
    knowledgeVersions: input.knowledgeVersions
      .filter((entry) => bundleKnowledgeIds.has(entry.knowledgeId))
      .sort((left, right) => left.knowledgeId.localeCompare(right.knowledgeId)),
    materialRevisions: input.materialRevisions,
    segmentDigests,
    statements,
    questions,
    reviewProvenance: 'user_semantic',
    teachingPreferenceVersion: input.teachingPreferenceVersion,
    roleConfigDigest: input.roleConfigDigest,
  };
  return { bundle, digest: evidenceBundleDigest(bundle) };
};

/** 课件修改永远产生新的草案版本，不覆盖已发布版本。 */
export const nextLessonVersion = (existingVersions: readonly number[]): number =>
  existingVersions.length === 0 ? 1 : Math.max(...existingVersions) + 1;

/** 发布前的复核输入：未审核或任一引用失效都不能发布。 */
export interface LessonPublishFacts {
  status: LessonStatus;
  /** 该课程版本是否已有本地用户的 approved 审核记录。缺失记录时模型输出只是草案。 */
  reviewApproved: boolean;
  referencedKnowledgeIds: string[];
}

/**
 * 课程版本引用到的知识点清单。
 *
 * 陈述必须能在冻结的证据包里定位；定位不到就是「包外陈述」，不能靠后续审核补进来。
 */
export const lessonReferencedKnowledgeIds = (
  lesson: { statementIds: string[]; questionIds: string[] },
  deps: {
    statementKnowledgeOf: (statementId: string) => string | null;
    questionKnowledgeOf: (questionId: string) => string[];
  },
): string[] => {
  const statementKnowledge = lesson.statementIds.map((statementId) => {
    const knowledgeId = deps.statementKnowledgeOf(statementId);
    if (knowledgeId === null) {
      throw new StudyError('SOURCE_MISSING', { statementId, reason: 'statement_not_in_bundle' });
    }
    return knowledgeId;
  });
  return [...new Set([
    ...statementKnowledge,
    ...lesson.questionIds.flatMap((questionId) => deps.questionKnowledgeOf(questionId)),
  ])];
};

/**
 * 来源准入复验。审核、发布、上课与模型调用四个入口共用这一份判定，
 * 避免出现「某个入口放行、另一个入口阻断」的口径分裂。
 */
export const assertLessonKnowledgeAdmitted = (
  referencedKnowledgeIds: readonly string[],
  admittedKnowledgeIds: ReadonlySet<string>,
): void => {
  const blocked = referencedKnowledgeIds.filter((knowledgeId) => !admittedKnowledgeIds.has(knowledgeId));
  if (blocked.length > 0) throw new StudyError('KNOWLEDGE_INVALIDATED', { knowledgeIds: blocked });
};

/** 只有草案版本可审核：已发布、已被取代或已撤回的版本不能再改判。 */
export const assertLessonReviewable = (status: LessonStatus): void => {
  if (status !== 'draft') {
    throw new StudyError('STEP_ALREADY_COMMITTED', { status, reason: 'only_draft_reviewable' });
  }
};

export const assertLessonPublishable = (
  facts: LessonPublishFacts,
  admittedKnowledgeIds: ReadonlySet<string>,
): void => {
  if (facts.status !== 'draft') {
    throw new StudyError('STEP_ALREADY_COMMITTED', { status: facts.status });
  }
  if (!facts.reviewApproved) {
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'lesson_version_not_approved' });
  }
  assertLessonKnowledgeAdmitted(facts.referencedKnowledgeIds, admittedKnowledgeIds);
};

/**
 * 课堂入口的复核：当前映射必须指向「已发布 + 本版本审核通过 + 来源仍准入」的课程版本。
 * 撤回与来源失效都会在这里阻断，而不是等到页面渲染时才发现。
 */
export const assertLessonTeachable = (
  facts: { lessonStatus: LessonStatus | null; reviewApproved: boolean },
  referencedKnowledgeIds: readonly string[],
  admittedKnowledgeIds: ReadonlySet<string>,
): void => {
  if (facts.lessonStatus !== 'published') {
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'lesson_not_published', status: facts.lessonStatus });
  }
  if (!facts.reviewApproved) {
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'review_missing' });
  }
  assertLessonKnowledgeAdmitted(referencedKnowledgeIds, admittedKnowledgeIds);
};
