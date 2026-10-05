/** Stable public contracts; internal additions must be exported explicitly. */
export { MAX_EVALUATION_IMPORT_BYTES, evaluationTaskSchema, evaluationValueSchema, evaluationDatasetSchema, evaluationConfigSchema, evaluationGoldSchema, evaluationPredictionsSchema, evaluationRateSchema, evaluationReportSchema, frozenEvaluationSchema } from './evaluation';
export type { EvaluationDataset, EvaluationConfig, EvaluationGold, EvaluationPredictions, EvaluationReport, EvaluationValue, FrozenEvaluation } from './evaluation';
export {
  asId, newId, GENERATED_ID_PATTERN, SEGMENT_ID_PATTERN, SYLLABUS_REQUIREMENT_KEY_PATTERN,
} from './ids';
export type {
  ProjectId, RunId, SessionId, MaterialId, SegmentId, KnowledgeId, ProposalId, ReviewId,
  QuestionId, AttemptId, StepId, LessonId, StageId, LearnerKey, ProjectGeneration,
} from './ids';
export {
  SOURCE_STATUS, SCOPE_STATUS, RECORD_SCOPE, REVIEW_PROVENANCE, MASTERY_STATUS, REVIEW_DECISION, EVIDENCE_USE, QUESTION_ORIGIN,
  ACTOR_TYPE, ATTEMPT_KIND, RUN_STATE, SOURCE_STATUS_LABEL, SCOPE_STATUS_LABEL,
  MASTERY_STATUS_LABEL, QUESTION_ORIGIN_LABEL, ACTOR_TYPE_LABEL,
  ROLE_KIND, ROLE_EXPLANATION, ROLE_KIND_LABEL, MAX_PEER_PROFILES,
  MODEL_CALL_PURPOSE,
} from './status';
export {
  PLAN_PAYLOAD_VERSION, STEP_RECEIPT_VERSION,
  planEvidenceRefSchema, planTaskSchema, planGapSchema, planPayloadSchema,
  frozenVersionsSchema, runStartReceiptSchema, runEventPayloadSchema, runSnapshotSchema,
} from './plan';
export type {
  PlanTaskDto, PlanGapDto, PlanPayloadDto, FrozenVersionsDto, RunStartReceiptDto,
  RunEventPayloadDto, RunEventTypeDto, RunSnapshotDto,
} from './plan';
export {
  EVIDENCE_BUNDLE_VERSION, LESSON_STATUS, LESSON_REVIEW_DECISION,
  bundleStatementSchema, bundleQuestionSchema, evidenceBundleSchema, evidenceBundleRowSchema,
  lessonVersionSchema, lessonDraftSchema, lessonPublishSchema, lessonReviewSchema,
  lessonWithdrawSchema, lessonReviewRecordSchema, lessonBundleBuildSchema,
  lessonDocumentAssembleSchema, formalLessonSceneSchema, formalLessonDocumentSchema,
  STATEMENT_REVISION_STATUS, statementRevisionProposeSchema, statementRevisionApplySchema,
  statementRevisionOutputSchema, statementRevisionCandidateSchema,
} from './lesson';
export type {
  LessonStatus, LessonReviewDecision, BundleStatementDto, BundleQuestionDto, EvidenceBundleDto, EvidenceBundleViewDto,
  LessonVersionDto, LessonDraftInput, LessonPublishInput, LessonReviewInput, LessonWithdrawInput,
  LessonReviewRecordDto, LessonBundleBuildInput,
  LessonDocumentAssembleInput, FormalLessonSceneDto, FormalLessonDocumentDto,
  StatementRevisionStatus, StatementRevisionProposeInput, StatementRevisionApplyInput,
  StatementRevisionOutput, StatementRevisionCandidateDto,
} from './lesson';
export {
  SCENE_PLAN_VERSION, SCENE_PLAN_WRITE_LIMIT, PLAN_SCENE_KINDS, PLAN_ELEMENT_KINDS, RICH_TEXT_TAGS,
  planElementStyleSchema, planElementSchema, planSceneSchema, scenePlanSchema,
  scenePlanSaveSchema, coursewareProposeSchema, coursewareSceneOutputSchema, coursewareOutputSchema,
  COURSEWARE_CANDIDATE_STATUS, coursewareCandidateSchema, coursewareApplySchema,
  SCENE_PLAN_RECEIPT_STATES, scenePlanReceiptSchema,
} from './scene-plan';
export type {
  PlanSceneKind, PlanElementKind, PlanElementStyleDto, PlanElementDto, PlanSceneDto,
  ScenePlanDto, ScenePlanSaveInput, CoursewareProposeInput, CoursewareSceneOutput,
  CoursewareOutput, CoursewareCandidateStatus, CoursewareCandidateDto, CoursewareApplyInput,
  ScenePlanReceiptState, ScenePlanReceiptDto,
} from './scene-plan';
export {
  EXPLANATION_KIND, EXPLANATION_ORIGIN, EXPLANATION_STATUS, EXPLANATION_TEXT_MAX_LENGTH,
  CLASSROOM_SESSION_STATUS, CLASSROOM_ACTION_KINDS,
  CLASSROOM_ROUND_LIMITS, CLASSROOM_LESSON_MAX_CALLS,
  PEER_ENGAGEMENT, PEER_ENGAGEMENT_LABEL,
  explanationCardSchema, explanationCreateSchema, explanationEditSchema, explanationReviewSchema,
  classroomSessionSchema, classroomActionSchema, classroomActionPayloadSchema, classroomStateSchema,
  classroomPeerTurnSchema, classroomPeersSchema, classroomPeerTurnSchemaInput,
  classroomOpenSchema, classroomPlaySchema, classroomHandbackSchema, classroomAnsweredSchema,
  classroomAdvanceSchema, classroomCloseSchema, classroomCommandSchema,
} from './teaching';
export type {
  ExplanationKind, ExplanationOrigin, ExplanationStatus, ClassroomSessionStatus, ClassroomActionKind,
  ExplanationCardDto, ExplanationCreateInput, ExplanationEditInput, ExplanationReviewInput,
  ClassroomSessionDto, ClassroomActionDto, ClassroomActionPayloadDto, ClassroomStateDto,
  PeerEngagement, ClassroomPeerTurnDto, ClassroomPeersInput, ClassroomPeerTurnInput,
  ClassroomOpenInput, ClassroomPlayInput, ClassroomHandbackInput, ClassroomAnsweredInput,
  ClassroomAdvanceInput, ClassroomCloseInput, ClassroomCommand,
} from './teaching';
export type {
  SourceStatus, ScopeStatus, RecordScope, ReviewProvenance, MasteryStatus, ReviewDecision, EvidenceUse, QuestionOrigin,
  ActorType, AttemptKind, RunState, RoleKind, RoleExplanation, ModelCallPurpose,
} from './status';
export {
  STUDY_ERROR_CODES, STUDY_ERROR_MESSAGE, PENDING_ONLY_CODES, StudyError, isStudyError,
  toErrorPayload,
} from './errors';
export type {
  StudyErrorCode, StudyErrorPayload,
} from './errors';
export {
  RUN_EVENT_TYPES,
} from './events';
export type {
  RunEventType, RunEventBase, RunStartedEvent, StepStartedEvent, DraftDeltaEvent,
  ProposalCreatedEvent, ReviewRequiredEvent, AnswerRequiredEvent, StepCommittedEvent,
  RunCompletedEvent, RunFailedEvent, RunCancelledEvent, ModelCallEvent, RunEvent, FrozenVersions,
} from './events';
export {
  IPC, PRELOAD_BRIDGE_NAME, IPC_METHOD_CHANNEL,
} from './ipc';
export type {
  IpcChannel, ServiceReadyPayload, ServiceStatusPayload, OpenedProjectPayload,
  PickedFilesPayload, ServiceStatePayload, IpcContract, IpcMethod, IpcHandlerMap,
  OpenMaterialOriginalRequest, OpenMaterialOriginalResult,
  NativeBridge,
} from './ipc';
export {
  NORMALIZATION_VERSION, FINGERPRINT_ALGORITHM, SEGMENT_ID_PREFIX, formatSegmentId,
  parseSegmentId, SUPPORTED_MATERIAL_TYPES, MAX_MATERIAL_BYTES,
} from './fingerprint';
export type {
  MaterialType,
} from './fingerprint';
export {
  modelConnectionInputSchema, modelTestResultSchema, modelConnectionStatusSchema,
  modelChatMessageSchema, modelGenerationInputSchema, modelGenerationUsageSchema, modelGenerationResultSchema,
} from './model-connection';
export type {
  ModelConnectionInput, ModelTestResult, ModelConnectionStatus,
  ModelChatMessage, ModelGenerationInput, ModelGenerationUsageDto, ModelGenerationResultDto,
} from './model-connection';
export { apiErrorPayloadSchema, apiEnvelopeSchema, runtimeApiFailureSchema, apiResponses } from './responses';
export {
  THEME_IDS, ACCENT_PRESETS, STATUS_TOKEN_KEYS,
} from './tokens';
export type {
  ThemeId, ThemeChoice, AccentPreset, ThemeTokens, DesignTokens, StatusTokenKey,
} from './tokens';
export {
  projectScopeSchema, projectSettingsPatchSchema, materialImportFileSchema,
  materialImportTextSchema, materialImportSchema, materialSchema, segmentSchema,
  evidenceRefSchema, knowledgeProposeSchema, mechanicalCheckSchema, proposalSchema,
  reviewApplySchema, knowledgePointSchema, admissionCheckSchema, admissionResultSchema,
  questionCreateSchema, questionListItemSchema, questionSchema, questionDetailQuerySchema,
  attemptSubmitSchema, attemptSchema, workbenchStateSchema, preferencesSchema,
  teachingPreferenceSchema, preferencesWriteSchema, materialExamVerificationSchema,
  materialRawArchiveSchema, materialRawQuerySchema, materialRawViewSchema,
  materialOriginalOpenSchema,
  syllabusRequirementSchema, syllabusMappingSchema, syllabusItemCreateSchema,
  syllabusItemSchema, syllabusCoverageItemSchema, syllabusCoverageSchema,
  classroomAssetInfoSchema, assetReclaimReportSchema, assetReclaimSchema, assetReclaimResultSchema,
  rolePermissionsSchema, roleProfileSchema, roleCreateSchema, roleUpdateSchema, roleDeleteSchema,
  recentProjectSchema, classroomSceneBindingSchema,
  interactionDirectionSchema, interactionSubmitSchema, interactionPayloadSchema,
  interactionSubmissionSchema, interactionStateSchema,
} from './api';
export type {
  ProjectScope, ProjectSettingsPatchInput, MaterialImportFileInput, MaterialImportTextInput,
  MaterialImportInput, MaterialDto, SegmentDto, EvidenceRefInput, KnowledgeProposeInput,
  MechanicalCheckDto, ProposalDto, ReviewApplyInput, KnowledgePointDto, AdmissionCheckInput,
  AdmissionResultDto, QuestionCreateInput, QuestionListItemDto, QuestionDto,
  QuestionDetailQuery, AttemptSubmitInput, AttemptDto, WorkbenchStateDto, PreferencesDto,
  TeachingPreferenceDto, PreferencesWriteInput, MaterialExamVerificationInput,
  MaterialRawArchiveDto, MaterialRawQuery, MaterialRawViewDto, MaterialOriginalOpenInput,
  SyllabusRequirementInput, SyllabusMappingInput, SyllabusItemCreateInput, SyllabusItemDto,
  SyllabusCoverageItemDto, SyllabusCoverageDto,
  ClassroomAssetInfoDto, AssetReclaimReportDto, AssetReclaimInput, AssetReclaimResultDto,
  RolePermissionsDto, RoleProfileDto, RoleCreateInput, RoleUpdateInput, RoleDeleteInput,
  RecentProjectDto, ClassroomSceneBinding, ApiSuccess, ApiFailure, ApiEnvelope,
  InteractionSubmitInput, InteractionSubmissionDto, InteractionStateDto,
} from './api';

export { selectedAnswerSetSchema, questionAssessmentSchema, questionAssessmentMetadataSchema, assessmentGradingSchema } from './assessment';
export type { QuestionAssessmentDto, QuestionAssessmentMetadataDto, AssessmentGradingDto } from './assessment';
export { attemptGradeCandidateSchema, attemptGradeReviewSchema, attemptGradingContextSchema, attemptGradingCommandSchema } from './attempt-grading';
export type { AttemptGradeCandidateDto, AttemptGradeReviewDto, AttemptGradingContextDto, AttemptGradingCommand } from './attempt-grading';
export { LEGACY_LOCAL_LEARNER_KEY, learnerUidSchema, learnerProfileSchema, learnerProfileUpdateSchema } from './learner-profile';
export type { LearnerProfileDto, LearnerProfileUpdateInput } from './learner-profile';
export { classroomRoomCourseSchema, classroomSharedSceneSchema, classroomSharedAssetSchema, classroomSharedCourseSchema, classroomRoomMemberSchema, classroomRoomSchema, classroomInvitationSchema, classroomTeacherLeaseSchema, classroomRoomCreateSchema, classroomRoomCommandSchema } from './classroom-room';
export type { ClassroomSharedCourseDto, ClassroomRoomDto, ClassroomInvitationDto, ClassroomTeacherLeaseDto } from './classroom-room';
export { classroomBoardContentSchema, classroomBoardBindingSchema, classroomBoardItemSchema, classroomBoardEffectSchema, classroomBoardStateSchema, classroomBoardItemResultSchema, classroomBoardPlayResultSchema, classroomBoardCommandSchema } from './classroom-board';
export type { ClassroomBoardBindingDto, ClassroomBoardContentDto, ClassroomBoardItemDto, ClassroomBoardEffectDto, ClassroomBoardStateDto, ClassroomBoardCommand } from './classroom-board';
export { formalInteractionDefinitionSchema, formalInteractionPublicDefinitionSchema, formalInteractionFrozenSchema, formalInteractionValuesSchema, formalInteractionBindingSchema, formalInteractionRecordSchema, formalInteractionReceiptSchema, formalInteractionStateSchema, formalInteractionCommandSchema } from './formal-interaction';
export type { FormalInteractionDefinitionDto, FormalInteractionFrozenDto, FormalInteractionCommand, FormalInteractionStateDto, FormalInteractionBindingDto, FormalInteractionValuesDto, FormalInteractionRecordDto } from './formal-interaction';
export { errorTagSchema, processEvidenceSchema, errorConclusionSchema, feedbackEntrySchema, feedbackSnapshotSchema, feedbackContextSchema, reviewTaskSchema, feedbackReviewCommandSchema, feedbackResultSchema, personalAttemptSubmitResultSchema, feedbackModelInputSchema, feedbackModelResultSchema, reviewSuggestionOutputSchema } from './feedback-review';
export type { FeedbackReviewCommand, FeedbackContextDto, ReviewTaskDto, FeedbackModelInput, FeedbackModelResultDto } from './feedback-review';
export {
  modelUsageCallSchema, modelUsageSummarySchema, modelUsageBreakdownSchema, modelUsageReportSchema,
  MODEL_USAGE_PURPOSE, MODEL_USAGE_MEASUREMENT, MODEL_COST_MEASUREMENT, measurementOf,
} from './model-usage';
export type {
  ModelUsageCallDto, ModelUsageSummaryDto, ModelUsageBreakdownDto, ModelUsageReportDto,
  ModelUsagePurpose, ModelUsageMeasurement, ModelCostMeasurement,
} from './model-usage';
export {
  recoveryCheckpointSchema, recoveryLayerResultSchema, recoveryQuerySchema,
  RECOVERY_LAYERS, RECOVERY_LAYER_LABEL, RECOVERY_STATUS,
} from './recovery';
export type {
  RecoveryCheckpointDto, RecoveryLayerResultDto, RecoveryQueryInput, RecoveryLayer, RecoveryStatus,
} from './recovery';
export { PROJECT_BACKUP_VERSION, backupProjectManifestSchema, projectBackupFileSchema, projectBackupManifestSchema } from './project-backup';
export type { ProjectBackupManifest, ProjectBackupFile, ProjectBackupResult } from './project-backup';
