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
  buildEvidenceBundle, evidenceBundleDigest, statementIdOf, nextLessonVersion,
  assertLessonPublishable, assertLessonReviewable, assertLessonTeachable,
  assertLessonKnowledgeAdmitted, lessonReferencedKnowledgeIds,
} from './lesson';
export type {
  BundleSegmentRecord, BundleQuestionRecord, EvidenceBundleInput, LessonPublishFacts,
} from './lesson';
export {
  findBundleStatement, revisedStatements, assertStatementRevisionDecidable, statementRevisionPrompt,
} from './statement-revision';
export type { RevisedStatementInput } from './statement-revision';
export {
  SCENE_PLAN_LIMIT, assertRichTextSafe, assertElementSafe, assertPlanGrounded,
  normalizeSceneOrder, planSceneId, planElementId, replaceSceneElements, duplicateScene,
  removeScene, reorderScenes, assertPlanEditable, assertCoursewareDecidable, coursewarePrompt,
} from './scene-plan';
export { assertModelCallAdmitted, modelCallQuotaRemaining } from './guard';
export type { ModelCallGuardFacts } from './guard';
export {
  assertCardGrounded, assertCardApprovable, assertCardPlayable, assertSessionActive,
  assertClassroomBudget, nextPlayableCard,
} from './teaching';
export type { ClassroomBudgetUse } from './teaching';
export {
  peerTurnCeiling, shouldPeerSpeak, assertPeerTurnAllowed, peerCapabilities,
  assertPeerTurnGrounded, peerAttemptPartition,
} from './peer';
export {
  reserveSharedModelTokens, sharedModelDeadlineMs, assertSharedModelSettlement,
  assertSharedBudget, sharedBudgetRemaining, settlementMeasurement, costMeasurement, resumePolicyForUnsettled,
} from './budget';
export {
  formalInteractionHash, formalInteractionSceneId, formalInteractionDefinitionSessionId,
  formalInteractionObservationSessionId, publicFormalInteractionDefinition,
} from './formal-interaction';
export type { SharedBudgetLimits, SharedBudgetUsage } from './budget';
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

export { gradeQuestionAssessment } from './assessment';
export { gradeReviewedAnswer } from './attempt-grading';

export { consumptionOf, summarizeModelUsage } from './model-usage';
export { evaluationDigest, recomputeEvaluation, freezeEvaluation, verifyFrozenEvaluation, assertEvaluationComparable } from './evaluation';
