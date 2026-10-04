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
} from './status';
export type {
  SourceStatus, ScopeStatus, RecordScope, ReviewProvenance, MasteryStatus, ReviewDecision, EvidenceUse, QuestionOrigin,
  ActorType, AttemptKind, RunState,
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
  RunCompletedEvent, RunFailedEvent, RunCancelledEvent, RunEvent, FrozenVersions,
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
export { modelConnectionInputSchema, modelTestResultSchema, modelConnectionStatusSchema } from './model-connection';
export type { ModelConnectionInput, ModelTestResult, ModelConnectionStatus } from './model-connection';
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
  RecentProjectDto, ClassroomSceneBinding, ApiSuccess, ApiFailure, ApiEnvelope,
  InteractionSubmitInput, InteractionSubmissionDto, InteractionStateDto,
} from './api';
