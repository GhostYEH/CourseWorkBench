export { createNodeSqliteDriver } from './driver';
export type { SqlDatabase, SqliteDriver, SqlRunResult, SqlStatement } from './driver';
export { SCHEMA_VERSION, applyMigrations } from './schema';
export { StudyStore } from './store';
export { CollabServiceStore } from './collaboration-service';
export type { CollabServiceStoreOptions } from './collaboration-service';
export type { CreateLocalClassroomRoomInput, ClassroomRoomSceneInput, ClassroomRoomCloseInput, ClassroomTeacherLeaseAcquireInput, ClassroomTeacherLeaseCheckInput, ClassroomRoomWriteResult } from './repositories/classroom-room';
export type { SaveAttemptGradeCandidateInput, ReviewAttemptGradeInput, RejectAttemptGradeCandidateInput } from './repositories/attempt-grading';
export type {
  AttemptRow, ClassroomAssetBindingRow, ClassroomAssetInfo, ClassroomAssetRow,
  ClassroomDocumentRow, ClassroomSceneSourceRow, ClassroomStateRow, DocumentFolderRow,
  CreateProposalInput, CreateSyllabusItemInput, EvidenceStored, ImportMaterialInput, KnowledgeRow,
  MaterialRawArchiveRow, MaterialRow, ProjectRow, ProposalRow, QuestionRow, ReviewOutcome, RunRow, SegmentRow,
  SyllabusItemRow,
  PlanVersionRow, RoleProfileRow, RoleWriteInput, RunEventRow, StepReceiptRow,
  ClassroomLinkRow, ClassroomActionRow, ClassroomSessionRow, CreateExplanationInput, CreateLessonDraftInput, EvidenceBundleRow, ExplanationRow, LessonReviewRow, LessonStatus, LessonVersionRow, PublishLessonInput,
  StoreOptions, SubmitAttemptInput, SubmitAttemptOutcome,
} from './store';
export { DocumentOrganizationError } from './repositories/document-organization';
export { ClassroomAssetQuotaExceededError, ClassroomAssetReferencedError } from './repositories/classroom-assets';
export {
  ClassroomRuntimeRepository,
  RuntimeAppendConflict,
  RuntimeSessionExists,
} from './repositories/classroom-runtime';
export { ClassroomKVRepository } from './repositories/classroom-kv';
export type {
  RuntimeAppendOptions,
  RuntimeRecordInput,
  RuntimeRecordRow,
  RuntimeQuizReceiptRow,
  RuntimeSessionRow,
  RuntimeStatus,
} from './repositories/classroom-runtime';
export {
  PROJECT_FORMAT_VERSION, assertManifestCompatible, ensureProjectLayout, isDirectory,
  projectPaths, readManifest, writeManifest,
} from './project-layout';
export type { ProjectManifest, ProjectPaths } from './project-layout';
export { decodeJson, encodeJson } from './json-codec';
export {
  ZipError,
  crc32,
  isPortableZipPath,
  readZip,
  writeZip,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_ENTRY_BYTES,
  ZIP_MAX_TOTAL_BYTES,
} from './zip';
export type { ZipEntryInput, ZipReadEntry } from './zip';
export { buildLessonExport } from './lesson-export';
export type { BuildLessonExportInput, LessonExportPackage } from './lesson-export';
export { createProjectBackup, restoreProjectBackup, ProjectBackupError } from './project-backup';
export type { CreateProjectBackupOptions, RestoreProjectBackupOptions } from './project-backup';
export type { DecodeResult } from './json-codec';
export { ClassroomBoardRepository } from './repositories/classroom-board';
export type { CreateClassroomBoardInput, ReviewClassroomBoardInput, PlayClassroomBoardInput } from './repositories/classroom-board';
export type { StartModelUsageCallInput, SettleModelUsageCallInput } from './repositories/model-usage';
export type { SaveScenePlanInput, CreateCoursewareCandidateInput } from './repositories/lesson-scene-plan';
export type {
  CreateScenePlanPatchCandidateInput,
  ScenePlanPatchReceipt,
} from './repositories/scene-plan-patch';
export { ProExternalTokensRepository } from './repositories/pro-external-tokens';
export type { CreateProExternalTokenInput } from './repositories/pro-external-tokens';
export {
  DeploymentAccessCodeRepository,
  DEPLOYMENT_ACCESS_TABLES,
} from './repositories/deployment-access';
export type { CreateDeploymentAccessCodeInput } from './repositories/deployment-access';
export { InteractiveSnapshotRepository } from './repositories/interactive-snapshots';
export type { InteractiveSnapshotRecord } from './repositories/interactive-snapshots';
export { CollaborationRepository } from './repositories/collaboration';
export type {
  AppendEventInput,
  AppendMessageInput,
  CollabAction,
  CollaborationRepositoryOptions,
  CreateCollabRoomInput,
  InvitationDecisionInput,
  InvitationRevokeInput,
  InviteInput,
  MemberReadinessInput,
  RegisterInput,
  StartCollabRoomInput,
  StoredInvitation,
  SyncSceneInput,
  SyncSceneResult,
} from './repositories/collaboration';
