export { createNodeSqliteDriver } from './driver';
export type { SqlDatabase, SqliteDriver, SqlRunResult, SqlStatement } from './driver';
export { SCHEMA_VERSION } from './schema';
export { StudyStore } from './store';
export type {
  AttemptRow, ClassroomAssetBindingRow, ClassroomAssetInfo, ClassroomAssetRow,
  ClassroomDocumentRow, ClassroomSceneSourceRow, ClassroomStateRow, DocumentFolderRow,
  CreateProposalInput, CreateSyllabusItemInput, EvidenceStored, ImportMaterialInput, KnowledgeRow,
  MaterialRawArchiveRow, MaterialRow, ProjectRow, ProposalRow, QuestionRow, ReviewOutcome, RunRow, SegmentRow,
  SyllabusItemRow,
  PlanVersionRow, RoleProfileRow, RoleWriteInput, RunEventRow, StepReceiptRow,
  ClassroomLinkRow, CreateLessonDraftInput, EvidenceBundleRow, LessonReviewRow, LessonStatus, LessonVersionRow, PublishLessonInput,
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
export type { DecodeResult } from './json-codec';
