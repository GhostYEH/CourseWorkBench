/**
 * @sew/study-domain —— 权威与准入层。
 *
 * 领域核心不依赖 React / Electron / Next.js；它只接受已读取的数据并返回决策，
 * 由 study-storage 负责事务落库、由本地服务负责调用编排。
 */

export {
  normalizeText,
  fingerprintOf,
  splitSegments,
  normalizeMaterial,
  locateRawSegments,
  normalizeMaterialWithRawSpans,
} from './normalize';
export type {
  RawSegment,
  NormalizedMaterial,
  RawSegmentSpan,
  LocatedSegment,
  MaterialWithRawSpans,
} from './normalize';
export { runMechanicalCheck, assertMechanicalPassed } from './source';
export type { RegisteredSegment, MechanicalCheckInput, MechanicalCheckResult } from './source';
export { decideProposal, computeInvalidation } from './knowledge';
export type { ReviewDecisionInput, ReviewDecisionResult, MaterialChangeImpact } from './knowledge';
export { checkAdmission } from './admission';
export type { KnowledgeRecord, AdmissionInput } from './admission';
export { validateSyllabusMapping, computeSyllabusCoverage } from './syllabus';
export {
  buildEvidenceBundle,
  evidenceBundleDigest,
  statementIdOf,
  nextLessonVersion,
  assertLessonPublishable,
  assertLessonReviewable,
  assertLessonTeachable,
  assertLessonKnowledgeAdmitted,
  lessonReferencedKnowledgeIds,
} from './lesson';
export type {
  BundleSegmentRecord,
  BundleQuestionRecord,
  EvidenceBundleInput,
  LessonPublishFacts,
} from './lesson';
export {
  findBundleStatement,
  revisedStatements,
  assertStatementRevisionDecidable,
  statementRevisionPrompt,
} from './statement-revision';
export type { RevisedStatementInput } from './statement-revision';
export {
  SCENE_PLAN_LIMIT,
  assertRichTextSafe,
  assertElementSafe,
  assertPlanGrounded,
  normalizeSceneOrder,
  planSceneId,
  planElementId,
  replaceSceneElements,
  duplicateScene,
  removeScene,
  reorderScenes,
  assertPlanEditable,
  assertCoursewareDecidable,
  coursewarePrompt,
  scenePlanDigest,
  digestOfScenePlan,
  planSceneDigest,
  diffScenePlans,
  mergeScenePlans,
  applyMergeResolutions,
  outlineOrderedScenes,
  assertPlanInteractionsReviewed,
  assertReviewMatchesPlan,
  assertPlanPublishable,
} from './scene-plan';
export type {
  PlanSceneChange,
  ScenePlanDiff,
  PlanMergeConflict,
  PlanMergeResult,
  SceneMergeResolution,
  SceneMergeResolutionChoice,
} from './scene-plan';
export { applyScenePlanPatch, scenePlanPatchPrompt } from './scene-plan-patch';
export type { ScenePatchContext, ScenePatchOutcome } from './scene-plan-patch';
export { proExternalTokenHash, assertProExternalTokenUsable } from './pro-external';
export type { ProExternalTokenFacts } from './pro-external';
export { assertModelCallAdmitted, modelCallQuotaRemaining } from './guard';
export type { ModelCallGuardFacts } from './guard';
export {
  assertCardGrounded,
  assertCardApprovable,
  assertCardPlayable,
  assertSessionActive,
  assertClassroomBudget,
  nextPlayableCard,
} from './teaching';
export type { ClassroomBudgetUse } from './teaching';
export {
  peerTurnCeiling,
  shouldPeerSpeak,
  assertPeerTurnAllowed,
  peerCapabilities,
  assertPeerTurnGrounded,
  peerAttemptPartition,
  peerSchedule,
} from './peer';
export type { PeerScheduleReason } from './peer';
export {
  assertCollabInvitationCreatable,
  assertCollabInvitationDecidable,
  assertCollabInvitationRevocable,
  assertCollabMessageWritable,
  assertCollabEventAppendable,
  assertCollabResyncCursor,
  assertCollabRoomStartable,
  assertCollabAdmission,
  assertCollabSnapshotMatch,
  assertCollabTeacherEventAllowed,
} from './collaboration';
export type {
  CollabInvitationStatus,
  CollabInvitationFacts,
  CollabReadiness,
} from './collaboration';
export {
  collabSecretHash,
  collabSecretMatches,
  assertCollabRegistrationCreatable,
  assertCollabCredentialUsable,
  assertCollabSessionIssuable,
  assertCollabCredentialRevocable,
  assertCollabSceneSyncable,
  assertCollabSnapshotUploadable,
} from './collaboration-auth';
export type { CollabCredentialStatus, CollabCredentialFacts } from './collaboration-auth';
export { decideCollabTeaching, assertCollabBoardHistoryConsistent } from './collaboration-teaching';
export {
  reserveSharedModelTokens,
  sharedModelDeadlineMs,
  assertSharedModelSettlement,
  assertSharedBudget,
  sharedBudgetRemaining,
  settlementMeasurement,
  costMeasurement,
  resumePolicyForUnsettled,
} from './budget';
export {
  formalInteractionHash,
  formalInteractionSceneId,
  formalInteractionDefinitionSessionId,
  formalInteractionObservationSessionId,
  publicFormalInteractionDefinition,
  orderingMatches,
  parameterResult,
  proceduralSkillCheck,
} from './formal-interaction';
export type { ProceduralSkillCheck, ProceduralSkillStepCheck } from './formal-interaction';
export {
  deploymentAccessCodeHash,
  assertDeploymentAccessUsable,
  deploymentCapability,
} from './deployment-access';
export type { DeploymentAccessCodeFacts } from './deployment-access';
export { computeCourseCompletion } from './course-completion';
export type {
  CompletionAttemptFact,
  CompletionQuestionFact,
  CompletionKnowledgeResult,
  CourseCompletionResult,
} from './course-completion';
export { decideInteractiveSnapshot } from './interactive-snapshot';
export type {
  InteractiveSnapshotFacts,
  SnapshotDecision,
  SnapshotDecisionReason,
} from './interactive-snapshot';
export type { SharedBudgetLimits, SharedBudgetUsage } from './budget';
export type {
  SyllabusRequirementRecord,
  SyllabusItemRecord,
  SyllabusMappingRecord,
  SyllabusCoveragePointRecord,
  SyllabusCoverageItemResult,
  SyllabusCoverageResult,
} from './syllabus';
export { resolveQuestionOrigin } from './question';
export type { OriginRecord, TrustedOriginFacts, OriginResolution } from './question';
export {
  normalizeAnswer,
  judgeAnswer,
  decideAttempt,
  assertRealWriteAllowed,
  buildStepKey,
  answerDisplayPolicy,
} from './attempt';
export type {
  AttemptRequest,
  AttemptDecision,
  AnswerVerdict,
  AnswerDisplayPolicy,
} from './attempt';
export {
  canonicalJson,
  classroomDocumentDigest,
  dslVersionState,
  stripQuizAnswers,
  assertSceneSourceBindings,
} from './classroom';
export type { DslVersionState, StrippedQuizScene, SceneSourceBinding } from './classroom';

export { gradeQuestionAssessment } from './assessment';
export { gradeReviewedAnswer } from './attempt-grading';

export { consumptionOf, summarizeModelUsage } from './model-usage';
export {
  evaluationDigest,
  recomputeEvaluation,
  freezeEvaluation,
  verifyFrozenEvaluation,
  assertEvaluationComparable,
} from './evaluation';

// PBL 项目制学习（OMA-046~049）
export {
  pblHash,
  pblProjectSceneId,
  pblDefinitionSessionId,
  pblRecordSessionId,
  pblSimulationSessionId,
  pblArtifactId,
  pblArtifactIdFromRecord,
  pblReceiptId,
  pblReceiptFrom,
  publicPblProjectDefinition,
  publicPblProjectState,
  assertPblDefinitionCoherent,
  assertPblDefinitionFrozen,
  assertPblBindingMatchesFrozen,
  assertPblCommandScope,
  pblRolePermissions,
  pblOperationAllowed,
  assertPblOperationAllowed,
  pblRoleByUid,
  pblLearnerRole,
  pblCollaboratorRole,
  pblIsMember,
  pblCommandActorRole,
  assertPblTaskOpenable,
  assertPblArtifactKindAllowed,
  assertPblDeliverableReferences,
  pblDeliverableRecordFrom,
  pblContributionRecordFrom,
  pblActorTypeOfSeat,
  pblAiActorTypeOfSeat,
  pblFeedbackRecordFrom,
  pblAssessmentRecordFrom,
  pblAcceptanceRecordFrom,
  pblAcknowledgeRecordFrom,
  pblTaskProgressRecordFrom,
  pblDraftFrom,
  pblDraftPayload,
  pblEvidenceFromRecord,
  pblEvidenceFromStep,
  pblSplitEvidence,
  pblAcknowledgedContributionNonces,
  runPblDeterministicCheck,
  pblMilestoneEvaluationsFromSets,
  pblMilestoneEvaluations,
  pblTaskCheckOutcomes,
  pblTaskStatus,
  pblTaskViewsFromSets,
  pblTaskViews,
  pblGoalCoverage,
  pblExistingArtifactIds,
  assertPblFeedbackGrounded,
  assertPblCandidateGrounded,
  assertPblContributionGrounded,
  assertPblAcknowledgesExistingContribution,
  assertPblAcceptanceTargetsAssessment,
  assertPblSimulationCannotWriteFormal,
  assertPblRecordGroundedInDefinition,
  pblEvidenceFromRecords,
  pblMeetsMinLength,
  pblSimulationAllowedOperations,
  pblSimulationStepAllowed,
  openPblSimulation,
  runPblSimulationStep,
  pblMilestoneSummary,
  pblPrivateContentViewerAllowed,
} from './formal-interaction-pbl';
export type {
  PblServerFacts,
  PblEvidence,
  PblEvidenceSets,
  PblCheckContext,
} from './formal-interaction-pbl';

// 媒体生成：图像/视频/TTS/ASR 与多模态用量（OMA-060~065）
export {
  mediaConsumptionOf,
  summarizeMediaUsage,
  mediaLedgerForRun,
  assertMediaBudget,
  mediaReservationOf,
  assertMediaGenerationAdmitted,
  assertMediaProductCandidate,
  mediaSettlement,
  mediaCostMeasurement,
  settleMediaTask,
  mediaPollOutcome,
  mediaPollDecision,
  cancelMediaTask,
  mediaResumePolicy,
  mediaTaskOutcome,
  mediaTextLedgerEntry,
} from './media-generation';

// 生成式教师 / AI 同学公共输出（OMA-029）
export {
  collabTeachingAiGate,
  collabTeachingAiGateError,
  collabTeachingAiAutoResumePolicy,
  collabTeachingAiGenerationRequest,
  assertCollabTeachingAiStateConsistent,
  assertCollabTeachingAiBodyPublicable,
  collabTeachingAiPublicProjection,
  decideCollabTeachingAi,
} from './collaboration-teaching-ai';
export type {
  CollabTeachingAiWaiting,
  CollabTeachingAiGenerationRequest,
  CollabTeachingAiPublicItem,
} from './collaboration-teaching-ai';

// 完整导出：可编辑 PPTX 与 MP4 渲染任务（OMA-067/071）
export {
  PPTX_EXPORT_VERSION,
  PPTX_EXPORT_FORMAT,
  EMU_PER_PIXEL,
  PPTX_SLIDE_SIZES,
  PPTX_MODEL_KEYS,
  classifyMediaReference,
  isPortableMediaReference,
  redactedReferenceHint,
  splitFormulaSegments,
  richTextToRuns,
  richTextToPlainText,
  pptxScaleOf,
  pptxCentipointsFromPixels,
  pptxDeckSchemaViolations,
  assertPptxDeckSchemaClosed,
  collectPptxAssetRefs,
  pptxDeckDigest,
  buildPptxDeck,
  pptxDeckEditabilityViolations,
  assertPptxDeckEditable,
} from './lesson-export-pptx';
export type {
  PptxSlideSizeName,
  PptxSlideSize,
  PptxTheme,
  PptxFrame,
  PptxTextRun,
  PptxTextRole,
  PptxTextShape,
  PptxPictureShape,
  PptxFormulaShape,
  PptxChartShape,
  PptxTableShape,
  PptxLineShape,
  PptxShape,
  PptxFidelity,
  PptxSlide,
  PptxIssue,
  PptxMediaFact,
  PptxDeckIdentity,
  BuildPptxDeckOptions,
  BuildPptxDeckInput,
  PptxDeck,
  MediaReferenceKind,
  FormulaSegment,
} from './lesson-export-pptx';
export {
  MP4_EXPORT_VERSION,
  MP4_EXPORT_FORMAT,
  MP4_RUNTIME_KINDS,
  MP4_RUNTIME_STATUS,
  MP4_JOB_STATES,
  MP4_JOB_EVENTS,
  MP4_FAILURE_CLASSES,
  MP4_FAILURE_DISPOSITION,
  MP4_RECOVERY_ACTIONS,
  MP4_DELIVERY_STATUS,
  normalizeMp4Runtimes,
  mp4BlockingRuntimes,
  mp4RenderPlanDigest,
  buildMp4RenderPlan,
  mp4JobAllowedEvents,
  createMp4RenderJob,
  applyMp4JobEvent,
  mp4FailureIsResumable,
  mp4TrustedSegments,
  recoverMp4Job,
  mp4JobProgress,
  mp4JobResultView,
  mp4PlanDurationUpperBoundMs,
  mp4PlanMatchesScenes,
  mp4PlanDigestOf,
} from './lesson-export-mp4';
export type {
  Mp4RuntimeKind,
  Mp4RuntimeStatus,
  Mp4JobState,
  Mp4JobEvent,
  Mp4FailureClass,
  Mp4FailureDisposition,
  Mp4RecoveryAction,
  Mp4DeliveryStatus,
  Mp4EncodingProfile,
  Mp4Canvas,
  Mp4RuntimeDeclaration,
  Mp4Segment,
  Mp4JobIdentity,
  BuildMp4RenderPlanInput,
  Mp4RenderPlan,
  Mp4SegmentArtifact,
  Mp4JobFailure,
  Mp4RenderJob,
  Mp4RecoveryFacts,
  Mp4RecoveryDecision,
  Mp4JobResultView,
} from './lesson-export-mp4';
export {
  directorCandidateDigest,
  directorCurrentStep,
  assertDirectorContinuable,
} from './director';
