/** Stable public contracts; internal additions must be exported explicitly. */
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
} from './lesson';
export type {
  LessonStatus, LessonReviewDecision, BundleStatementDto, BundleQuestionDto, EvidenceBundleDto, EvidenceBundleViewDto,
  LessonVersionDto, LessonDraftInput, LessonPublishInput, LessonReviewInput, LessonWithdrawInput,
  LessonReviewRecordDto, LessonBundleBuildInput,
} from './lesson';
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
