/**
 * @sew/study-domain —— 权威与准入层。
 *
 * 领域核心不依赖 React / Electron / Next.js；它只接受已读取的数据并返回决策，
 * 由 study-storage 负责事务落库、由本地服务负责调用编排。
 */

export {
  normalizeText, fingerprintOf, splitSegments, normalizeMaterial,
  locateRawSegments, normalizeMaterialWithRawSpans,
} from './normalize';
export type {
  RawSegment, NormalizedMaterial, RawSegmentSpan, LocatedSegment, MaterialWithRawSpans,
} from './normalize';
export { runMechanicalCheck, assertMechanicalPassed } from './source';
export type { RegisteredSegment, MechanicalCheckInput, MechanicalCheckResult } from './source';
export { decideProposal, computeInvalidation } from './knowledge';
export type { ReviewDecisionInput, ReviewDecisionResult, MaterialChangeImpact } from './knowledge';
export { checkAdmission } from './admission';
export type { KnowledgeRecord, AdmissionInput } from './admission';
export { validateSyllabusMapping, computeSyllabusCoverage } from './syllabus';
export {
  buildEvidenceBundle, evidenceBundleDigest, statementIdOf, nextLessonVersion, assertLessonPublishable,
} from './lesson';
export type {
  BundleSegmentRecord, BundleQuestionRecord, EvidenceBundleInput, LessonPublishFacts,
} from './lesson';
export type {
  SyllabusRequirementRecord, SyllabusItemRecord, SyllabusMappingRecord,
  SyllabusCoveragePointRecord, SyllabusCoverageItemResult, SyllabusCoverageResult,
} from './syllabus';
export { resolveQuestionOrigin } from './question';
export type { OriginRecord, TrustedOriginFacts, OriginResolution } from './question';
export { normalizeAnswer, judgeAnswer, decideAttempt, assertRealWriteAllowed, buildStepKey } from './attempt';
export type { AttemptRequest, AttemptDecision, AnswerVerdict } from './attempt';
export {
  canonicalJson, classroomDocumentDigest, dslVersionState, stripQuizAnswers, assertSceneSourceBindings,
} from './classroom';
export type { DslVersionState, StrippedQuizScene, SceneSourceBinding } from './classroom';
