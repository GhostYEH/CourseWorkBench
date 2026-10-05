import { summarizeModelUsage } from '@sew/study-domain';
import { ClassroomCommands } from './services/classroom-commands';
import { normalizeSharedModelCalls } from './services/model-accounting';
/**
 * SQLite 仓储层门面。
 *
 * 职责：打开/迁移数据库、暴露稳定的 `StudyStore` 公共接口、在需要时把跨域动作
 * 组合进同一个事务。独立的领域生命周期（项目、材料、候选、知识、题目、作答、
 * 运行、偏好、计划）已拆到 `./repositories/*`。
 *
 * 领域判断一律委托给 @sew/study-domain；本层不自行决定「能不能通过审核」。
 * 本地服务是唯一数据库写入者；所有写入串行执行，首版不支持多窗口并发编辑。
 */

import type { ClassroomBoardBindingDto,ClassroomBoardContentDto,FeedbackReviewCommand,ModelUsageCallDto,ModelUsageReportDto } from '@sew/study-contracts';
import {
STEP_RECEIPT_VERSION,
StudyError,
newId,
questionAssessmentSchema,
type AdmissionResultDto,
type AssessmentGradingDto,
type ClassroomPeerTurnDto,
type ClassroomStateDto,
type ExplanationCardDto,
type FrozenVersionsDto,
type LessonReviewDecision,
type MasteryStatus,
type ModelCallPurpose,
type PeerEngagement,
type PlanPayloadDto,
type QuestionAssessmentDto,
type QuestionOrigin,
type RecordScope,
type ReviewDecision,
type RoleKind,
type RunEventPayloadDto,
type RunState,
type StatementRevisionCandidateDto,
type CoursewareCandidateDto,
type ScenePlanDto,
} from '@sew/study-contracts';
import {
assertCardApprovable,
assertCardGrounded,
assertLessonReviewable,
assertLessonTeachable,
assertSessionActive,
buildEvidenceBundle,
buildStepKey,
computeInvalidation,
computeSyllabusCoverage,
decideAttempt,
gradeQuestionAssessment,judgeAnswer,
lessonReferencedKnowledgeIds,
resolveQuestionOrigin,
revisedStatements,
type MaterialChangeImpact,
type OriginRecord,
type SyllabusCoverageResult,
type SyllabusItemRecord,
type SyllabusMappingRecord
} from '@sew/study-domain';
import { createHash } from 'node:crypto';
import { createNodeSqliteDriver,type SqlDatabase,type SqliteDriver } from './driver';
import { AttemptGradingRepository,type AttemptGradeGenerationCallInput,type AttemptGradeGenerationFailure,type RejectAttemptGradeCandidateInput,type ReviewAttemptGradeInput,type SaveAttemptGradeCandidateInput } from './repositories/attempt-grading';
import { AttemptsRepository } from './repositories/attempts';
import { ClassroomRepository } from './repositories/classroom';
import type { ClassroomAssetBindingRow,ClassroomAssetInfo,ClassroomAssetRow } from './repositories/classroom-assets';
import { ClassroomAssetsRepository } from './repositories/classroom-assets';
import { ClassroomBoardRepository,type CreateClassroomBoardInput,type PlayClassroomBoardInput,type ReviewClassroomBoardInput } from './repositories/classroom-board';
import { ClassroomKVRepository } from './repositories/classroom-kv';
import { ClassroomRoomRepository,freezePublishedRoomCourse,type ClassroomRoomCloseInput,type ClassroomRoomSceneInput,type ClassroomTeacherLeaseAcquireInput,type ClassroomTeacherLeaseCheckInput,type CreateLocalClassroomRoomInput,type FreezeRoomCourseOptions } from './repositories/classroom-room';
import { ClassroomRuntimeRepository } from './repositories/classroom-runtime';
import {
DocumentOrganizationRepository,
type DocumentFolderRow,
} from './repositories/document-organization';
import { FeedbackReviewRepository } from './repositories/feedback-review';
import { KnowledgeRepository } from './repositories/knowledge';
import { LearnerIdentityRepository } from './repositories/learner-identity';
import {
LessonRepository,
type CreateLessonDraftInput,
type PublishLessonInput,
} from './repositories/lessons';
import { MaterialsRepository } from './repositories/materials';
import {
LessonStatementRevisionRepository,
type CreateStatementRevisionInput,
} from './repositories/lesson-statement-revision';
import {
LessonScenePlanRepository,
type CreateCoursewareCandidateInput,
type SaveScenePlanInput,
} from './repositories/lesson-scene-plan';
import { ModelUsageRepository,type ModelUsageLimits,type SettleModelUsageCallInput,type StartModelUsageCallInput } from './repositories/model-usage';
import { PlansRepository } from './repositories/plans';
import { PreferencesRepository } from './repositories/preferences';
import { ProjectsRepository } from './repositories/projects';
import { ProposalsRepository } from './repositories/proposals';
import { QuestionsRepository } from './repositories/questions';
import { RoleRepository,type RoleWriteInput } from './repositories/roles';
import type { RunEventRow,StepReceiptRow } from './repositories/runs';
import { RunsRepository } from './repositories/runs';
import type { CreateSyllabusItemInput,SyllabusItemRow } from './repositories/syllabus';
import { SyllabusRepository } from './repositories/syllabus';
import {
TeachingRepository,
type CreateExplanationInput,
} from './repositories/teaching';
import type {
AttemptRow,
ClassroomActionRow,
ClassroomLinkRow,
ClassroomSessionRow,
CreateProposalInput,
EvidenceBundleRow,
ExplanationRow,
ImportMaterialInput,
KnowledgeRow,
LessonReviewRow,
LessonVersionRow,
MaterialRow,
ProjectRow,
ProposalRow,
QuestionRow,
ReviewOutcome,
RoleProfileRow,
RunRow,
SegmentRow,
SubmitAttemptInput,
SubmitAttemptOutcome,
} from './repositories/types';
import { MIGRATIONS, SCHEMA_VERSION } from './schema';

export type {
ClassroomDocumentRow,
ClassroomSceneSourceRow,
ClassroomStateRow,
SaveClassroomDocumentInput
} from './repositories/classroom';
export { ClassroomAssetReferencedError } from './repositories/classroom-assets';
export type { ClassroomAssetBindingRow,ClassroomAssetInfo,ClassroomAssetRow } from './repositories/classroom-assets';
export type {
RuntimeAppendOptions,RuntimeQuizReceiptRow,RuntimeRecordInput,
RuntimeRecordRow,RuntimeSessionRow,
RuntimeStatus
} from './repositories/classroom-runtime';
export { DocumentOrganizationError } from './repositories/document-organization';
export type { DocumentFolderRow } from './repositories/document-organization';
export type {
CreateLessonDraftInput,PublishLessonInput
} from './repositories/lessons';
export type { RoleWriteInput } from './repositories/roles';
export type { RunEventRow,StepReceiptRow } from './repositories/runs';
export type { CreateSyllabusItemInput,SyllabusItemRow } from './repositories/syllabus';
export type { CreateExplanationInput } from './repositories/teaching';
export type {
AttemptRow,ClassroomActionRow,ClassroomLinkRow,ClassroomSessionRow,CreateProposalInput,EvidenceBundleRow,EvidenceStored,ExplanationRow,ImportMaterialInput,
KnowledgeRow,LessonReviewRow,LessonStatus,LessonVersionRow,MaterialRawArchiveRow,
MaterialRow,PlanVersionRow,ProjectRow,
ProposalRow,
QuestionRow,
ReviewOutcome,RoleProfileRow,RunRow,
SegmentRow,
SubmitAttemptInput,
SubmitAttemptOutcome
} from './repositories/types';

interface Row {
  [key: string]: unknown;
}

export interface StoreOptions {
  file: string;
  driver?: SqliteDriver;
}

export class StudyStore {
  private readonly classroomCommands: ClassroomCommands;
  private readonly db: SqlDatabase;
  private readonly driverName: string;
  private readonly projects: ProjectsRepository;
  private readonly materials: MaterialsRepository;
  private readonly proposals: ProposalsRepository;
  private readonly knowledge: KnowledgeRepository;
  private readonly questions: QuestionsRepository;
  private readonly attempts: AttemptsRepository;
  private readonly learnerIdentity: LearnerIdentityRepository;
  private readonly classroomBoard: ClassroomBoardRepository;
  private readonly feedbackReview: FeedbackReviewRepository;
  private readonly modelUsage: ModelUsageRepository;
  private readonly classroomRooms: ClassroomRoomRepository;
  private readonly attemptGrading: AttemptGradingRepository;
  private readonly runs: RunsRepository;
  private readonly preferences: PreferencesRepository;
  private readonly plans: PlansRepository;
  private readonly roles: RoleRepository;
  private readonly lessons: LessonRepository;
  private readonly lessonRevisions: LessonStatementRevisionRepository;
  private readonly scenePlans: LessonScenePlanRepository;
  private readonly teaching: TeachingRepository;
  private readonly syllabus: SyllabusRepository;
  private readonly classroom: ClassroomRepository;
  private readonly documentOrganization: DocumentOrganizationRepository;
  private readonly classroomAssets: ClassroomAssetsRepository;
  readonly runtime: ClassroomRuntimeRepository;
  readonly classroomKV: ClassroomKVRepository;

  private constructor(db: SqlDatabase, driverName: string, readonly databaseFile: string) {
    this.db = db;
    this.driverName = driverName;
    this.projects = new ProjectsRepository(db);
    this.materials = new MaterialsRepository(db);
    this.proposals = new ProposalsRepository(db);
    this.knowledge = new KnowledgeRepository(db);
    this.questions = new QuestionsRepository(db);
    this.attempts = new AttemptsRepository(db);
    this.learnerIdentity = new LearnerIdentityRepository(db);
    this.attemptGrading = new AttemptGradingRepository(db, {
      projectExists: id => this.projects.getProject(id) !== null,
      question: id => this.questions.getQuestion(id, 'formal'),
      admitted: ids => this.checkAdmission(ids, 'formal').allowed,
      applyMastery: (ids, correct, at) => this.knowledge.updateMasteryIfVerified(ids, correct ? 'passed' : 'to_reinforce', at, 'formal'),
    });
    this.runs = new RunsRepository(db);
    this.preferences = new PreferencesRepository(db);
    this.plans = new PlansRepository(db);
    this.roles = new RoleRepository(db);
    this.lessons = new LessonRepository(db);
    this.lessonRevisions = new LessonStatementRevisionRepository(db);
    this.scenePlans = new LessonScenePlanRepository(db);
    this.teaching = new TeachingRepository(db);
    this.syllabus = new SyllabusRepository(db);
    this.classroom = new ClassroomRepository(db);
    this.documentOrganization = new DocumentOrganizationRepository(db);
    this.classroomAssets = new ClassroomAssetsRepository(db);
    this.runtime = new ClassroomRuntimeRepository(db);
    this.classroomKV = new ClassroomKVRepository(db);
    this.classroomRooms = new ClassroomRoomRepository(db, {
      boundUid: projectId => this.learnerIdentity.read(projectId)?.uid ?? null,
      freeze: (input, options) => {
        const ready = this.assertLessonClassroomReady(input.lessonId, input.projectId);
        if (ready.lesson.version !== input.lessonVersion) throw new StudyError('VERSION_CONFLICT', { reason: 'room_lesson_version_changed' });
        const stageId = ready.link.stageId;
        if (!stageId) throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'room_document_not_attached' });
        const document = this.classroom.getDocument(input.projectId, stageId);
        const bundle = this.lessons.getBundle(ready.lesson.bundleId, input.projectId);
        if (!document || !bundle) throw new StudyError('INTERNAL', { reason: 'room_course_missing' });
        return freezePublishedRoomCourse({
          projectId: input.projectId, ...ready, bundle, document,
          // 由应用层传入已完整复验的冻结定义；存储层不再自己读一份更弱的版本。
          interactionDefinitions: options?.interactionDefinitions ?? null,
          sceneSources: [...this.classroom.listSceneSources(input.projectId, stageId).values()],
          bindings: this.classroomAssets.listBindings(input.projectId, stageId),
          lookupSegment: (m, r, s) => this.materials.lookupSegment(m, r, s, 'formal'),
          asset: assetId => this.classroomAssets.get(input.projectId, assetId),
        });
      },
      assertCourseReady: (projectId, course) => {
        const ready = this.assertLessonClassroomReady(course.lessonId, projectId);
        if (ready.lesson.version !== course.lessonVersion || ready.lesson.bundleDigest !== course.bundleDigest
          || ready.link.stageId !== course.stageId || ready.link.documentDigest !== course.documentDigest) {
          throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'room_course_version_changed' });
        }
      },
    });
    this.classroomBoard = new ClassroomBoardRepository(db, {
      assertBinding: (binding, content) => this.assertClassroomBoardBinding(binding, content),
      assertPlayable: (sessionId, binding) => {
        const ready = this.assertClassroomSessionReady(binding.projectId, sessionId);
        const classroom = this.requireSession(sessionId, binding.projectId);
        if (ready.lesson.lessonId !== binding.lessonId || ready.lesson.version !== binding.lessonVersion
          || classroom.currentSceneId !== binding.sceneId) {
          throw new StudyError('VERSION_CONFLICT', { reason: 'board_session_binding_changed' });
        }
      },
      sessionBinding: (projectId, sessionId) => {
        const classroom = this.requireSession(sessionId, projectId);
        return { lessonId: classroom.lessonId, lessonVersion: classroom.lessonVersion };
      },
    });
    this.feedbackReview = new FeedbackReviewRepository(db, {
      projectExists: id => this.projects.getProject(id) !== null,
      question: id => this.questions.getQuestion(id, 'formal'),
      knowledge: id => this.knowledge.getKnowledge(id, 'formal'),
      admitted: ids => this.checkAdmission(ids, 'formal').allowed,
    });
    this.modelUsage = new ModelUsageRepository(db);

    this.classroomCommands = new ClassroomCommands({
      teaching: this.teaching, runs: this.runs, roles: this.roles, lessons: this.lessons,
      transaction: action => this.transaction(action),
      assertClassroomSessionReady: (projectId, sessionId) => this.assertClassroomSessionReady(projectId, sessionId),
      classroomBoardStatementIds: (projectId, sessionId) => this.classroomBoardStatementIds(projectId, sessionId),
      checkAdmission: (knowledgeIds, scope) => this.checkAdmission(knowledgeIds, scope),
      requireSession: (sessionId, projectId) => this.requireSession(sessionId, projectId),
      toCard: row => this.toCard(row),
    });
  }

  static open(options: StoreOptions): StudyStore {
    const driver = options.driver ?? createNodeSqliteDriver();
    const db = driver.open(options.file);
    try {
      const store = new StudyStore(db, driver.name, options.file);
      store.migrate();
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  get driver(): string {
    return this.driverName;
  }

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const applied = new Set(
      this.db
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map((row) => Number((row as Row)['version'] ?? 0)),
    );
    if ([...applied].some(version => !Number.isSafeInteger(version) || version < 1 || version > SCHEMA_VERSION)) {
      throw new StudyError('PROJECT_FORMAT_UNSUPPORTED', { reason: 'unsupported_schema_version', supported: SCHEMA_VERSION });
    }
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString());
      });
    }
  }

  close(): void {
    this.db.close();
  }

  /** 一致性备份：不复制运行中的 .db 文件，交给驱动做快照。 */
  backupTo(targetFile: string): void {
    this.db.exec(`VACUUM INTO '${targetFile.replace(/'/g, "''")}'`);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  // ——————————————————————————— 项目 ———————————————————————————

  createProject(input: {
    projectId: string;
    displayName: string;
    subject?: string;
    goal?: string;
    examDate?: string | null;
    dailyMinutes?: number;
    learningMode?: 'beginner' | 'review';
  }): ProjectRow {
    return this.projects.createProject(input);
  }

  getProject(projectId: string): ProjectRow | null {
    return this.projects.getProject(projectId);
  }

  listProjects(): ProjectRow[] {
    return this.projects.listProjects();
  }

  updateProjectSettings(
    projectId: string,
    patch: Partial<{
      displayName: string;
      subject: string;
      goal: string;
      examDate: string | null;
      dailyMinutes: number;
      learningMode: 'beginner' | 'review';
    }>,
  ): ProjectRow {
    return this.projects.updateProjectSettings(projectId, patch);
  }

  // ——————————————————————————— 材料 ———————————————————————————

  /** 导入材料：登记新版本、切分段落、重算指纹，并把受影响的已核实知识点转为已失效。 */
  importMaterial(input: ImportMaterialInput): {
    material: MaterialRow;
    segments: SegmentRow[];
    invalidated: MaterialChangeImpact[];
  } {
    return this.materials.importMaterial(input, {
      invalidateKnowledge: (currentRevisions, scope) => this.invalidateAfterImport(currentRevisions, scope),
    });
  }

  /** 材料更新后的跨域失效：在同一事务内重算并落库（由 repository 回调注入）。 */
  private invalidateAfterImport(currentRevisions: Record<string, number>, scope: RecordScope): MaterialChangeImpact[] {
    const impacts = computeInvalidation(
      this.knowledge.listKnowledge(scope).map((k) => ({
        knowledgeId: k.knowledgeId,
        name: k.name,
        sourceStatus: k.sourceStatus,
        evidence: k.evidence,
      })),
      currentRevisions,
    );
    if (impacts.length > 0) {
      this.knowledge.invalidateKnowledgePoints(
        impacts.map((i) => i.knowledgeId),
        new Date().toISOString(),
        scope,
      );
    }
    return impacts;
  }

  listMaterials(scope: RecordScope = 'formal'): MaterialRow[] {
    return this.materials.listMaterials(scope);
  }

  getMaterial(materialId: string, revision?: number, scope: RecordScope = 'formal'): MaterialRow | null {
    return this.materials.getMaterial(materialId, revision, scope);
  }

  listMaterialVersions(materialId: string, scope: RecordScope = 'formal'): MaterialRow[] {
    return this.materials.listMaterialVersions(materialId, scope);
  }

  getSegments(materialId: string, revision: number): SegmentRow[] {
    return this.materials.getSegments(materialId, revision);
  }

  /** 读取归档的原始字节：未归档或摘要不符都按明确错误失败，不返回无法核对的原文。 */
  readMaterialRaw(materialId: string, revision: number, scope: RecordScope = 'formal') {
    return this.materials.readMaterialRaw(materialId, revision, scope);
  }

  /** 段落在归档原文中的字节区间与行号；段落不属于该版本或范围不符时明确失败。 */
  getSegmentSpan(
    materialId: string,
    revision: number,
    segmentId: string,
    scope: RecordScope = 'formal',
  ): SegmentRow {
    return this.materials.getSegmentSpan(materialId, revision, segmentId, scope);
  }

  currentRevisions(scope: RecordScope = 'formal'): Record<string, number> {
    return this.materials.currentRevisions(scope);
  }

  /**
   * 核实某材料版本可作为考试真题来源（服务端权威事实）。
   * 只接受已登记的 (materialId, revision)；重复核实幂等。
   */
  verifyMaterialAsExam(input: { materialId: string; revision: number; note?: string }): {
    materialId: string;
    revision: number;
    verifiedAt: string;
  } {
    return this.materials.verifyMaterialAsExam(input);
  }

  isMaterialVerifiedAsExam(materialId: string, revision: number): boolean {
    return this.materials.isMaterialVerifiedAsExam(materialId, revision);
  }

  // ————————————————————————— 候选与权威表 —————————————————————————

  createProposal(input: CreateProposalInput): ProposalRow {
    const scope = input.recordScope ?? 'formal';
    return this.proposals.createProposal(input, {
      scope,
      lookupSegment: (m, r, s) => this.materials.lookupSegment(m, r, s, scope),
      currentRevisions: this.materials.currentRevisions(scope),
      knownKnowledgeIds: new Set(this.knowledge.listKnowledge(scope).map((k) => k.knowledgeId)),
    });
  }

  listProposals(status?: ProposalRow['status'], scope: RecordScope = 'formal'): ProposalRow[] {
    return this.proposals.listProposals(status, scope);
  }

  listProposalsForScope(scope: RecordScope): ProposalRow[] {
    return this.proposals.listProposals(undefined, scope);
  }

  /**
   * 人工审核：先机械复验、再要求语义确认，最后在事务内写权威表。
   * 用户点击「通过」不能绕过缺失来源。
   */
  applyReview(input: {
    proposalId: string;
    decision: ReviewDecision;
    expectedRevision: number;
    semanticReviewed: boolean;
    note?: string;
    syllabus?: SyllabusMappingRecord | null;
  }): ReviewOutcome {
    return this.proposals.applyReview(input, {
      lookupSegment: (m, r, s) => this.materials.lookupSegment(m, r, s, 'formal'),
      scope: 'formal',
      currentRevisions: this.materials.currentRevisions('formal'),
      knownKnowledgeIds: new Set(this.knowledge.listKnowledge().map((k) => k.knowledgeId)),
      insertKnowledgePoint: (fields) => this.knowledge.insertKnowledgePoint(fields),
      syllabusItem: (itemId, scope) => this.syllabusRecord(itemId, scope),
      syllabusItemsRegistered: (scope) => this.syllabus.countItems(scope) > 0,
    });
  }

  applyDemoAuthorReview(input: {
    proposalId: string;
    decision: ReviewDecision;
    expectedRevision: number;
    semanticReviewed: boolean;
    note?: string;
    syllabus?: SyllabusMappingRecord | null;
  }): ReviewOutcome {
    return this.proposals.applyDemoAuthorReview(input, {
      scope: 'demo',
      lookupSegment: (m, r, s) => this.materials.lookupSegment(m, r, s, 'demo'),
      currentRevisions: this.materials.currentRevisions('demo'),
      knownKnowledgeIds: new Set(this.knowledge.listKnowledge('demo').map((k) => k.knowledgeId)),
      insertKnowledgePoint: (fields) => this.knowledge.insertKnowledgePoint(fields),
      syllabusItem: (itemId, scope) => this.syllabusRecord(itemId, scope),
      syllabusItemsRegistered: (scope) => this.syllabus.countItems(scope) > 0,
    });
  }

  /** 审核映射校验用的最简条目形状；范围不符按不存在处理，不泄露另一范围的数据。 */
  private syllabusRecord(itemId: string, scope: RecordScope): SyllabusItemRecord | null {
    const item = this.syllabus.getItem(itemId, scope);
    if (!item) return null;
    return {
      itemId: item.itemId,
      code: item.code,
      label: item.label,
      recordScope: item.recordScope,
      requirements: item.requirements,
    };
  }

  getProposal(proposalId: string, scope: RecordScope = 'formal'): ProposalRow | null {
    return this.proposals.getProposal(proposalId, scope);
  }

  /** 登记考纲原子项：来源段落必须可定位，同范围内编号重复会被拒绝。 */
  createSyllabusItem(input: CreateSyllabusItemInput): SyllabusItemRow {
    return this.syllabus.createItem(input);
  }

  listSyllabusItems(scope: RecordScope = 'formal'): SyllabusItemRow[] {
    return this.syllabus.listItems(scope);
  }

  /**
   * 考纲覆盖（《规划书》8.1）。
   *
   * 分母是登记的条目数，分子只算必要要素全部被覆盖的条目；准入判断与课堂、出题等
   * 入口共用同一实现，不给统计开第二条判定路径。
   */
  syllabusCoverage(scope: RecordScope = 'formal'): SyllabusCoverageResult {
    const points = this.knowledge.listKnowledge(scope);
    const admission = this.knowledge.checkAdmission(
      points.map((point) => point.knowledgeId),
      this.materials.currentRevisions(scope),
      scope,
    );
    return computeSyllabusCoverage({
      items: this.syllabus.recordsForCoverage(scope),
      points: points.map((point) => ({
        knowledgeId: point.knowledgeId,
        scopeStatus: point.scopeStatus,
        sourceStatus: point.sourceStatus,
        syllabusItemId: point.syllabusItemId,
        syllabusRequirementKey: point.syllabusRequirementKey,
      })),
      admittedIds: new Set(admission.admitted),
    });
  }

  listKnowledge(scope: RecordScope = 'formal'): KnowledgeRow[] {
    return this.knowledge.listKnowledge(scope);
  }

  getKnowledge(knowledgeId: string, scope: RecordScope = 'formal'): KnowledgeRow | null {
    return this.knowledge.getKnowledge(knowledgeId, scope);
  }

  setMastery(knowledgeId: string, mastery: MasteryStatus): KnowledgeRow {
    return this.knowledge.setMastery(knowledgeId, mastery);
  }

  /** 生成准入预检：所有入口共用同一实现，不存在「课堂生成特权」。 */
  checkAdmission(knowledgeIds: string[], scope: RecordScope = 'formal'): AdmissionResultDto {
    return this.knowledge.checkAdmission(knowledgeIds, this.materials.currentRevisions(scope), scope);
  }

  // ——————————————————————————— 题目 ———————————————————————————

  createQuestion(input: {
    assessment?: QuestionAssessmentDto | null;
    stem: string;
    answer: string;
    solution: string;
    knowledgeIds: string[];
    requestedOrigin: QuestionOrigin;
    originRecord: OriginRecord | null;
    recordScope?: RecordScope;
  }): { question: QuestionRow; forgedExamClaim: boolean; downgraded: boolean } {
    const scope = input.recordScope ?? 'formal';
    const parsedAssessment = questionAssessmentSchema.nullable().safeParse(input.assessment ?? null);
    if (!parsedAssessment.success) throw new StudyError('INVALID_ARGUMENT', { reason: 'invalid_assessment' });
    const admission = this.checkAdmission(input.knowledgeIds, scope);
    if (!admission.allowed) {
      const first = admission.blocked[0];
      throw new StudyError('KNOWLEDGE_NOT_VERIFIED', {
        knowledgeId: first?.knowledgeId,
        code: first?.code,
        missing: first?.missing,
      });
    }

    // 真题身份由服务端权威记录派生，绝不读取请求自报字段。
    const trusted = input.originRecord
      ? {
          materialRegistered:
            this.getMaterial(input.originRecord.materialId, input.originRecord.revision, scope) !== null,
          materialVerifiedAsExam: this.materials.isMaterialVerifiedAsExam(
            input.originRecord.materialId,
            input.originRecord.revision,
          ),
        }
      : { materialRegistered: false, materialVerifiedAsExam: false };
    const resolved = resolveQuestionOrigin(input.requestedOrigin, input.originRecord, trusted);

    const question = this.questions.insertQuestion({
      questionId: newId<'question'>('q'),
      assessment: parsedAssessment.data,
      stem: input.stem,
      answer: input.answer,
      solution: input.solution,
      knowledgeIds: input.knowledgeIds,
      origin: resolved.origin,
      originLabel: resolved.originLabel,
      originDetail: resolved.originDetail,
      originRecord: input.originRecord,
      requestedOrigin: input.requestedOrigin,
      forgedExamClaim: resolved.forgedExamClaim,
      recordScope: scope,
    });

    return { question, forgedExamClaim: resolved.forgedExamClaim, downgraded: resolved.downgraded };
  }

  getQuestion(questionId: string, scope: RecordScope = 'formal'): QuestionRow | null {
    return this.questions.getQuestion(questionId, scope);
  }

  listQuestions(scope: RecordScope = 'formal'): QuestionRow[] {
    return this.questions.listQuestions(scope);
  }

  // ——————————————————————————— 作答 ———————————————————————————

  /** 提交作答。幂等键命中即读取既有结果，不重复写入，也不重复更新掌握状态。 */
  submitAttempt(input: SubmitAttemptInput): SubmitAttemptOutcome {
    const existing = this.attempts.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      const question = this.questions.getQuestion(input.questionId, existing.recordScope);
      const decision = question
        ? decideAttempt(
            {
              questionId: input.questionId,
              actorType: input.actorType,
              kind: input.kind,
              answerText: input.answerText,
              processText: input.processText,
            },
            question.answer,
          )
        : null;
      if (
        !question ||
        existing.questionId !== input.questionId ||
        existing.actorType !== input.actorType ||
        existing.answerText !== input.answerText ||
        existing.processText !== input.processText ||
        existing.requestedKind !== input.kind ||
        existing.kind !== decision?.kind
      ) {
        throw new StudyError('VERSION_CONFLICT', {
          reason: 'idempotency_key_reused_for_different_attempt',
          questionId: input.questionId,
        });
      }
      return { attempt: existing, deduplicated: true, forcedSimulation: decision.forcedSimulation };
    }

    const question = this.questions.getQuestion(input.questionId);
    if (!question) throw new StudyError('NOT_FOUND', { questionId: input.questionId });

    // 新记录必须依据提交时的材料与范围状态重新准入；既有收据重试在上方直接返回。
    const admission = this.checkAdmission(question.knowledgeIds, question.recordScope);
    if (!admission.allowed) {
      const first = admission.blocked[0];
      throw new StudyError('KNOWLEDGE_NOT_VERIFIED', {
        knowledgeId: first?.knowledgeId,
        code: first?.code,
        missing: first?.missing,
      });
    }

    const grading: AssessmentGradingDto = question.assessment
      ? gradeQuestionAssessment(question.assessment, input.answerText)
      : question.recordScope === 'formal'
        ? { status: 'pending_review', correct: null, earned: null, maxScore: 0, answerVersion: null, basis: 'assessment_not_registered' }
        : (() => {
          const verdict = judgeAnswer(question.answer, input.answerText);
          return { status: verdict === 'unknown' ? 'pending_review' : verdict, correct: verdict === 'unknown' ? null : verdict === 'correct', earned: verdict === 'unknown' ? null : verdict === 'correct' ? 1 : 0, maxScore: 1, answerVersion: null, basis: 'demo_literal_answer' };
        })();
    const decision = decideAttempt(
      {
        questionId: input.questionId,
        actorType: input.actorType,
        kind: input.kind,
        answerText: input.answerText,
        processText: input.processText,
      },
      question.answer,
      grading.status === 'pending_review' ? 'unknown' : grading.status,
    );

    const attemptId = newId<'attempt'>('att');
    const now = new Date().toISOString();

    const attempt = this.db.transaction(() => {
      const inserted = this.attempts.insertAttempt({
        attemptId,
        questionRevision: question.revision, answerVersion: grading.answerVersion, grading,
        questionId: input.questionId,
        kind: decision.kind,
        requestedKind: input.kind,
        actorType: input.actorType,
        answerText: input.answerText,
        processText: input.processText,
        masteryAfter: question.recordScope === 'formal' ? decision.masteryAfter : null,
        attributionStatus: decision.attributionStatus,
        idempotencyKey: input.idempotencyKey,
        submittedAt: now,
      });

      if (question.recordScope === 'formal' && decision.kind === 'real' && input.actorType === 'human_learner') {
        const uid = this.learnerIdentity.read(input.projectId)?.uid;
        if (uid) this.feedbackReview.captureOriginal(input.projectId, uid, inserted.attemptId);
      }
      // 只有真实作答才更新掌握状态；模拟作答永远不写本人记录。
      if (question.recordScope === 'formal' && decision.kind === 'real' && decision.masteryAfter) {
        this.knowledge.updateMasteryIfVerified(question.knowledgeIds, decision.masteryAfter, now, 'formal');
      }
      return inserted;
    });

    return { attempt, deduplicated: false, forcedSimulation: decision.forcedSimulation };
  }

  listAttempts(kind?: 'real' | 'simulation', scope: RecordScope = 'formal'): AttemptRow[] {
    return this.attempts.listAttempts(kind, scope);
  }

  getAttemptByIdempotencyKey(idempotencyKey: string): AttemptRow | null {
    return this.attempts.getAnyByIdempotencyKey(idempotencyKey);
  }

  countAttemptKinds(): { real: number; simulation: number } {
    return this.attempts.countAttemptKinds('formal');
  }

  getAttemptGradingContext(projectId: string, attemptId: string) { return this.attemptGrading.context(projectId, attemptId); }
  getLocalLearnerBinding(projectId: string) { return this.learnerIdentity.read(projectId); }
  bindLocalLearner(projectId: string, uid: string) { return this.learnerIdentity.bind(projectId, uid); }
  createLocalClassroomRoom(input: CreateLocalClassroomRoomInput, trustedUid: string, options?: FreezeRoomCourseOptions) { return this.classroomRooms.create(input, trustedUid, options); }
  getClassroomRoom(projectId: string, roomId: string, trustedUid: string) { return this.classroomRooms.get(projectId, roomId, trustedUid); }
  listLocalClassroomRooms(projectId: string, trustedUid: string) { return this.classroomRooms.list(projectId, trustedUid); }
  readClassroomRoomSnapshot(projectId: string, roomId: string, trustedUid: string) { return this.classroomRooms.snapshot(projectId, roomId, trustedUid); }
  readClassroomRoomAsset(projectId: string, roomId: string, trustedUid: string, assetId: string) { return this.classroomRooms.asset(projectId, roomId, trustedUid, assetId); }
  setClassroomRoomScene(input: ClassroomRoomSceneInput, trustedUid: string) { return this.classroomRooms.setScene(input, trustedUid); }
  closeClassroomRoom(input: ClassroomRoomCloseInput, trustedUid: string) { return this.classroomRooms.close(input, trustedUid); }
  acquireClassroomTeacherLease(input: ClassroomTeacherLeaseAcquireInput, trustedUid: string) { return this.classroomRooms.acquireLease(input, trustedUid); }
  assertClassroomTeacherLease(input: ClassroomTeacherLeaseCheckInput, trustedUid: string) { return this.classroomRooms.assertLease(input, trustedUid); }
  renewClassroomTeacherLease(input: ClassroomTeacherLeaseCheckInput & { ttlMs: number }, trustedUid: string) { return this.classroomRooms.renewLease(input, trustedUid); }
  releaseClassroomTeacherLease(input: ClassroomTeacherLeaseCheckInput, trustedUid: string) { return this.classroomRooms.releaseLease(input, trustedUid); }
  bindClassroomRoomSession(projectId: string, roomId: string, sessionId: string, trustedUid: string) { return this.classroomRooms.bindSession(projectId, roomId, sessionId, trustedUid); }
  getClassroomRoomForSession(projectId: string, sessionId: string, trustedUid: string) { return this.classroomRooms.forSession(projectId, sessionId, trustedUid); }
  getAttemptGradeCandidateReceipt(projectId: string, attemptId: string, requestId: string) { return this.attemptGrading.getCandidateReceipt(projectId, attemptId, requestId); }
  getAttemptGradeGenerationCall(input: AttemptGradeGenerationCallInput) { return this.attemptGrading.getGenerationCall(input); }
  startAttemptGradeGenerationCall(input: AttemptGradeGenerationCallInput, runId: string, reservedTokens: number) { return this.attemptGrading.startGenerationCall(input, runId, reservedTokens); }
  settleAttemptGradeGenerationCall(
    input: AttemptGradeGenerationCallInput,
    failure: AttemptGradeGenerationFailure | null,
    accounting?: { accountedTokens: number; tokenMeasurement: 'actual' | 'estimated' | 'unknown'; elapsedMs: number },
  ) { return this.attemptGrading.settleGenerationCall(input, failure, accounting); }
  saveAttemptGradeCandidate(input: SaveAttemptGradeCandidateInput) { return this.attemptGrading.saveCandidate(input); }
  reviewAttemptGrade(input: ReviewAttemptGradeInput) { return this.attemptGrading.review(input); }
  rejectAttemptGradeCandidate(input: RejectAttemptGradeCandidateInput) { return this.attemptGrading.reject(input); }

  // ————————————————————————— 运行与收据 —————————————————————————

  getStepReceipt(stepKey: string): StepReceiptRow | null {
    return this.runs.getReceipt(stepKey);
  }

  createRun(runId: string, state: RunState, frozen: FrozenVersionsDto): RunRow {
    return this.runs.createRun(runId, state, frozen);
  }

  updateRunState(runId: string, state: RunState, terminatedReason?: string): RunRow {
    return this.runs.updateRunState(runId, state, terminatedReason);
  }

  getRun(runId: string): RunRow | null {
    return this.runs.getRun(runId);
  }

  /** 本项目最近一次 run；数据库按项目目录隔离，因此不需要项目列。 */
  getLatestRun(): RunRow | null {
    return this.runs.getLatestRun();
  }

  appendRunEvent(runId: string, seq: number, payload: RunEventPayloadDto): RunEventRow {
    return this.runs.appendRunEvent(runId, seq, payload);
  }

  listRunEvents(runId: string, afterSeq = 0): RunEventRow[] {
    return this.runs.listRunEvents(runId, afterSeq);
  }

  /**
   * 从已确认计划启动备考 run（PLAN-01）。
   *
   * 收据键由「项目 + 计划版本」决定：同一计划的重复启动读回既有 run 与既有事件，
   * 不产生第二个 run，也不重放已提交动作。run、run_started 事件与收据在同一事务落库。
   */
  startPlanRun(projectId: string): { run: RunRow; deduplicated: boolean } {
    const confirmed = this.plans.getConfirmedPlan(projectId);
    if (!confirmed) throw new StudyError('PLAN_NOT_CONFIRMED');
    if (confirmed.payload.confirmedTaskKnowledgeIds.length === 0) {
      throw new StudyError('PLAN_NOT_CONFIRMED', { reason: 'no_confirmed_tasks' });
    }

    const stepKey = buildStepKey('run-start', projectId, `v${confirmed.version}`);
    const existing = this.runs.getReceipt(stepKey);
    if (existing) {
      const run = this.runs.getRun(existing.result.runId);
      if (!run) {
        throw new StudyError('INTERNAL', { reason: 'receipt_run_missing', runId: existing.result.runId });
      }
      return { run, deduplicated: true };
    }

    const frozen = this.freezeRunVersions(projectId, confirmed.version);
    const runId = newId<'run'>('run');
    const state: RunState = 'plan_confirmed';
    this.db.transaction(() => {
      this.runs.createRun(runId, state, frozen);
      this.runs.appendRunEvent(runId, 1, { type: 'run_started', state, frozen });
      this.runs.saveReceipt(
        stepKey,
        { receiptVersion: STEP_RECEIPT_VERSION, runId, planVersion: confirmed.version, state },
        runId,
        'start',
      );
    });
    const run = this.runs.getRun(runId);
    if (!run) throw new StudyError('INTERNAL', { runId });
    return { run, deduplicated: false };
  }

  /**
   * 当前知识清单摘要。任何一条知识点的新增、审核或失效都会改变它，
   * 因此 run 冻结值与这里的返回值不一致，就说明冻结之后来源发生过变化。
   */
  knowledgeTableDigest(): string {
    const points = this.knowledge
      .listKnowledge('formal')
      .map((point) => `${point.knowledgeId}:${point.revision}:${point.sourceStatus}`)
      .sort();
    return createHash('sha256').update(points.join('|'), 'utf8').digest('hex');
  }

  /**
   * 共享预算消耗口径（BUDGET-01）。
   *
   * 生成、教师、AI 同学、评分、归因、复习共用同一份：run 事件里的 `model_call`
   * 是已结算台账，加上尚未结算的预占。`activeElapsedMs` 只累计真正在跑的外部调用，
   * 等待本人输入不算执行时间——它是额外信息，不改变 `calls`/`tokens` 的既有含义。
   */
  modelCallUsage(runId: string, ownGradingRequestId?: string, ownModelRequestId?: string): { calls: number; tokens: number; activeElapsedMs: number } {
    const calls = this.sharedModelUsageCalls(runId, ownGradingRequestId, ownModelRequestId);
    const summary = summarizeModelUsage(calls);
    return { calls: summary.total.calls, tokens: summary.consumedTokens, activeElapsedMs: summary.activeElapsedMs };
  }

  /** Read-only normalization: durable rows replace their run events; unmatched historical events remain visible. */
  sharedModelUsageCalls(runId: string, ownGradingRequestId?: string, ownModelRequestId?: string): ModelUsageCallDto[]{
    return normalizeSharedModelCalls({
      calls: this.modelUsage.listForRun(runId),
      grading: this.attemptGrading.generationAccounting(runId).rows,
      events: this.runs.listRunEvents(runId),
      projectId: this.listProjects()[0]?.projectId ?? 'historical',
    }, runId, ownGradingRequestId, ownModelRequestId);
  }

  /** 按 run 内单调序号追加事件。序号来自既有事件，重启后仍延续同一台账。 */
  appendNextRunEvent(runId: string, payload: RunEventPayloadDto): RunEventRow {
    const next = this.runs.lastRunSeq(runId) + 1;
    return this.runs.appendRunEvent(runId, next, payload);
  }

  /**
   * 冻结当前事实集合。
   *
   * 知识点用摘要表示：任何一条的新增、审核或失效都会改变它；模型配置尚未接入时
   * `modelProfileId` 保持 null，不用假身份填充分母。
   */
  private freezeRunVersions(projectId: string, planVersion: number): FrozenVersionsDto {
    const teaching = this.preferences.readTeachingPreference<Record<string, unknown>>(projectId);
    return {
      knowledgeTableDigest: this.knowledgeTableDigest(),
      materialRevisions: this.materials.currentRevisions('formal'),
      planVersion,
      lessonVersion: null,
      teachingPreferenceVersion: teaching.version,
      roleConfigDigest: this.roles.configDigest('formal'),
      modelProfileId: null,
    };
  }

  // ——————————————————————————— 偏好 ———————————————————————————

  readPreference<T>(key: string): { value: T | null; version: number } {
    return this.preferences.readPreference<T>(key);
  }

  writePreference(key: string, value: unknown): number {
    return this.preferences.writePreference(key, value);
  }

  readTeachingPreference<T>(projectId: string): { value: T | null; version: number } {
    return this.preferences.readTeachingPreference<T>(projectId);
  }

  writeTeachingPreference(projectId: string, value: unknown): number {
    return this.preferences.writeTeachingPreference(projectId, value);
  }

  // ——————————————————————————— 计划 ———————————————————————————

  savePlanVersion(
    projectId: string,
    version: number,
    status: 'draft' | 'confirmed',
    payload: PlanPayloadDto,
  ): void {
    this.plans.savePlanVersion(projectId, version, status, payload);
  }

  getConfirmedPlan(projectId: string): { version: number; payload: PlanPayloadDto } | null {
    const confirmed = this.plans.getConfirmedPlan(projectId);
    return confirmed ? { version: confirmed.version, payload: confirmed.payload } : null;
  }

  /** 最近一版计划（草案或已确认），用于界面展示与调整预览。 */
  getLatestPlan(projectId: string): {
    version: number;
    status: 'draft' | 'confirmed';
    payload: PlanPayloadDto;
  } | null {
    const latest = this.plans.getLatestPlan(projectId);
    return latest ? { version: latest.version, status: latest.status, payload: latest.payload } : null;
  }

  // ———————————————————— 证据包与课程版本 ————————————————————

  /**
   * 从已确认计划冻结一节课的证据包（LESSON-01）。
   *
   * 陈述的文本与条件由人工给出，来源一律取该知识点**已批准的证据**：审核人不能
   * 凭空指定段落。准入判定与课堂、出题共用同一实现。摘要相同则复用既有证据包。
   */
  buildLessonBundle(
    projectId: string,
    statements: Array<{ knowledgeId: string; text: string; conditions: string }>,
    questionIds: string[],
  ): EvidenceBundleRow {
    const confirmed = this.plans.getConfirmedPlan(projectId);
    if (!confirmed) throw new StudyError('PLAN_NOT_CONFIRMED');
    const project = this.projects.getProject(projectId);
    if (!project) throw new StudyError('NOT_FOUND', { projectId });

    const knowledge = this.knowledge.listKnowledge('formal');
    const byId = new Map(knowledge.map((point) => [point.knowledgeId, point]));
    const admission = this.checkAdmission(
      [...new Set(statements.map((statement) => statement.knowledgeId))],
      'formal',
    );
    const admitted = new Set(admission.admitted);
    const composed = statements.map((statement) => {
      const point = byId.get(statement.knowledgeId);
      if (!point) throw new StudyError('NOT_FOUND', { knowledgeId: statement.knowledgeId });
      const evidence = point.evidence.map((item) => ({
        materialId: item.materialId,
        revision: item.revision,
        segmentId: item.segmentId,
        use: item.use,
      }));
      return {
        knowledgeId: statement.knowledgeId,
        text: statement.text,
        conditions: statement.conditions,
        evidence,
      };
    });

    const questions = new Map(
      this.questions.listQuestions('formal').map((row) => [
        row.questionId,
        {
          questionId: row.questionId,
          revision: row.revision,
          origin: row.origin,
          knowledgeIds: row.knowledgeIds,
          snapshot: { stem: row.stem, answer: row.answer, solution: row.solution, assessment: row.assessment },
        },
      ]),
    );
    const teaching = this.preferences.readTeachingPreference<Record<string, unknown>>(projectId);
    const { bundle, digest } = buildEvidenceBundle({
      projectId,
      subject: project.subject,
      recordScope: 'formal',
      planVersion: confirmed.version,
      teachingPreferenceVersion: teaching.version,
      roleConfigDigest: this.roles.configDigest('formal'),
      statements: composed,
      questionIds,
      admittedKnowledgeIds: admitted,
      knowledgeVersions: knowledge.map((point) => ({ knowledgeId: point.knowledgeId, revision: point.revision })),
      materialRevisions: this.materials.currentRevisions('formal'),
      lookupSegment: (materialId, revision, segmentId) => this.materials.lookupSegment(materialId, revision, segmentId, 'formal'),
      questions,
    });
    return this.lessons.saveBundle(projectId, bundle, digest);
  }

  listEvidenceBundles(projectId: string): EvidenceBundleRow[] {
    return this.lessons.listBundles(projectId);
  }

  createLessonDraft(input: CreateLessonDraftInput): LessonVersionRow {
    return this.lessons.createDraft(input);
  }

  // ——————————————————— 陈述正文改写候选（LESSON-02） ———————————————————

  /** 写入一条模型改写候选；正文只是待核草案，不进入任何课程版本。 */
  createStatementRevision(input: CreateStatementRevisionInput) {
    return this.lessonRevisions.create(input);
  }

  getStatementRevision(projectId: string, candidateId: string) {
    return this.lessonRevisions.get(projectId, candidateId);
  }

  listStatementRevisions(projectId: string, lessonId: string, baseVersion: number) {
    return this.lessonRevisions.list(projectId, lessonId, baseVersion);
  }

  /** 项目内全部陈述改写候选：页面一次读全，按课程版本分组展示。 */
  listProjectStatementRevisions(projectId: string) {
    return this.lessonRevisions.listForProject(projectId);
  }

  /** 人工处置候选：pending → applied/rejected，并写入审核人身份。 */
  decideStatementRevision(input: {
    projectId: string;
    candidateId: string;
    decision: 'approved' | 'rejected';
    note: string;
    reviewedBy: string;
  }) {
    return this.lessonRevisions.decide(input);
  }

  statementRevisionReceipt(projectId: string, requestId: string, action: string, intent: string) {
    return this.lessonRevisions.receipt(projectId, requestId, action, intent);
  }

  saveStatementRevisionReceipt(
    projectId: string,
    requestId: string,
    action: string,
    intent: string,
    result: unknown,
  ): void {
    this.lessonRevisions.saveReceipt(projectId, requestId, action, intent, result);
  }

  /** 课程草案派生的幂等收据：命中时返回既有版本，不追加第二个草案。 */
  lessonDraftReceipt(projectId: string, requestId: string, intent: string) {
    return this.lessonRevisions.draftReceipt(projectId, requestId, intent);
  }

  saveLessonDraftReceipt(
    projectId: string,
    requestId: string,
    intent: string,
    lessonId: string,
    version: number,
  ): void {
    this.lessonRevisions.saveDraftReceipt(projectId, requestId, intent, lessonId, version);
  }

  /**
   * 人工处置一条陈述改写候选（LESSON-02 的「通过→派生新版本」闭环）。
   *
   * 通过时在同一个事务内：用候选正文替换基线陈述、按知识点当前已批准证据**重新冻结证据包**
   * （来源、准入在这一步重新复验），再追加一个新的草案版本；原版本、原证据包与旧陈述保持原样。
   * 拒绝只留档，不产生新版本。整个动作要求基线版本仍是草案。
   */
  applyStatementRevision(input: {
    projectId: string;
    candidateId: string;
    decision: 'approved' | 'rejected';
    note: string;
    reviewedBy: string;
  }): { candidate: StatementRevisionCandidateDto; lesson: LessonVersionRow | null } {
    const candidate = this.lessonRevisions.get(input.projectId, input.candidateId);
    if (!candidate) throw new StudyError('NOT_FOUND', { candidateId: input.candidateId });
    const base = this.lessons.getVersion(candidate.lessonId, candidate.baseVersion, input.projectId);
    if (!base) throw new StudyError('NOT_FOUND', { lessonId: candidate.lessonId, version: candidate.baseVersion });
    if (base.status !== 'draft') {
      throw new StudyError('STEP_ALREADY_COMMITTED', { status: base.status, reason: 'revision_base_not_draft' });
    }
    return this.transaction(() => {
      const decided = this.lessonRevisions.decide(input);
      if (input.decision === 'rejected') return { candidate: decided, lesson: null };
      const bundle = this.lessons.getBundle(base.bundleId, input.projectId);
      if (!bundle) throw new StudyError('INTERNAL', { bundleId: base.bundleId });
      // 只允许改写本版本实际选中的陈述：候选若指向本版本之外的包内陈述，
      // 派生时会被静默加入，等于绕过「逐场景勾选」把被排除的场景加回来。
      if (!base.statementIds.includes(candidate.statementId)) {
        throw new StudyError('INVALID_ARGUMENT', {
          reason: 'revision_statement_not_in_version',
          statementId: candidate.statementId,
        });
      }
      const revised = revisedStatements(bundle.bundle, {
        statementId: candidate.statementId,
        text: candidate.proposedText,
        conditions: candidate.proposedConditions,
      });
      const reFrozen = this.buildLessonBundle(input.projectId, revised, base.questionIds);
      // 新版本沿用基线的场景集合：只把目标陈述替换为改写后的新 statementId，
      // 其余场景（含基线已排除的）保持基线的取舍，不因改写而回加。
      // 新 statementId 从重冻结包里按正文取，保证与 buildEvidenceBundle 的编号一致（含来源）。
      const replacement = reFrozen.bundle.statements.find(
        (statement) =>
          statement.knowledgeId === candidate.knowledgeId &&
          statement.text === candidate.proposedText &&
          statement.conditions === candidate.proposedConditions,
      );
      if (!replacement) throw new StudyError('INTERNAL', { reason: 'revision_statement_missing' });
      const statementIds = base.statementIds.map((statementId) =>
        statementId === candidate.statementId ? replacement.statementId : statementId,
      );
      const draft = this.lessons.createDraft({
        projectId: input.projectId,
        lessonId: candidate.lessonId,
        title: base.title,
        bundleId: reFrozen.bundleId,
        statementIds,
        questionIds: base.questionIds,
      });
      return { candidate: decided, lesson: draft };
    });
  }

  listLessons(projectId: string): LessonVersionRow[] {
    return this.lessons.listLessons(projectId);
  }

  /**
   * 保存场景计划（LESSON-02 / OMA-021、OMA-022）。
   *
   * 只允许改草案版本的场景计划：发布/撤回/被取代的版本一经发布即冻结历史，不能被原地改写。
   * 计划与冻结证据包相容性（陈述/题目在本版本已选范围内、知识点由服务端沿用）由调用方
   * 用领域层判定，本层只负责版本状态与乐观并发。
   */
  saveScenePlan(input: SaveScenePlanInput): ScenePlanDto {
    const lesson = this.lessons.getVersion(input.lessonId, input.lessonVersion, input.projectId);
    if (!lesson) throw new StudyError('NOT_FOUND', { lessonId: input.lessonId, version: input.lessonVersion });
    if (lesson.status !== 'draft') {
      throw new StudyError('STEP_ALREADY_COMMITTED', { status: lesson.status, reason: 'plan_base_not_draft' });
    }
    return this.scenePlans.savePlan({ ...input, bundleId: lesson.bundleId });
  }

  getScenePlan(projectId: string, lessonId: string, lessonVersion: number): ScenePlanDto | null {
    return this.scenePlans.getPlan(projectId, lessonId, lessonVersion);
  }

  listProjectScenePlans(projectId: string): ScenePlanDto[] {
    return this.scenePlans.listPlansForProject(projectId);
  }

  /** 生成完整课件候选：只落待核区，不写入计划、不进入教学。 */
  createCoursewareCandidate(input: CreateCoursewareCandidateInput): CoursewareCandidateDto {
    return this.scenePlans.createCandidate(input);
  }

  getCoursewareCandidate(projectId: string, candidateId: string): CoursewareCandidateDto | null {
    return this.scenePlans.getCandidate(projectId, candidateId);
  }

  listProjectCoursewareCandidates(projectId: string): CoursewareCandidateDto[] {
    return this.scenePlans.listForProject(projectId);
  }

  coursewareReceipt(projectId: string, requestId: string, action: string, intent: string) {
    return this.scenePlans.receipt(projectId, requestId, action, intent);
  }

  saveCoursewareReceipt(
    projectId: string,
    requestId: string,
    action: string,
    intent: string,
    result: unknown,
  ): void {
    this.scenePlans.saveReceipt(projectId, requestId, action, intent, result);
  }

  /**
   * 人工处置完整课件候选（OMA-006 的「通过→写入场景计划」闭环）。
   *
   * 通过时在同一个事务内：把调用方已按冻结证据包规范化并复验过的场景写成该草案版本的
   * 场景计划，并把候选标记为 applied；拒绝只留档，不产生计划。
   * 基线版本必须是草案：已发布版本的计划不被原地改写。
   */
  applyCoursewareCandidate(input: {
    projectId: string;
    candidateId: string;
    decision: 'approved' | 'rejected';
    note: string;
    reviewedBy: string;
    /** 通过时写入计划的场景（调用方已用领域层复验来源与知识点）；拒绝时为 null。 */
    scenes: ScenePlanDto['scenes'] | null;
  }): { candidate: CoursewareCandidateDto; plan: ScenePlanDto | null } {
    const candidate = this.scenePlans.getCandidate(input.projectId, input.candidateId);
    if (!candidate) throw new StudyError('NOT_FOUND', { candidateId: input.candidateId });
    const base = this.lessons.getVersion(candidate.lessonId, candidate.baseVersion, input.projectId);
    if (!base) throw new StudyError('NOT_FOUND', { lessonId: candidate.lessonId, version: candidate.baseVersion });
    if (base.status !== 'draft') {
      throw new StudyError('STEP_ALREADY_COMMITTED', { status: base.status, reason: 'courseware_base_not_draft' });
    }
    return this.transaction(() => {
      const decided = this.scenePlans.decideCandidate(input);
      if (input.decision === 'rejected' || !input.scenes) return { candidate: decided, plan: null };
      const current = this.scenePlans.getPlan(input.projectId, candidate.lessonId, candidate.baseVersion);
      const plan = this.scenePlans.savePlan({
        projectId: input.projectId,
        lessonId: candidate.lessonId,
        lessonVersion: candidate.baseVersion,
        bundleId: base.bundleId,
        scenes: input.scenes,
        origin: 'model_generated',
        baseRevision: current?.revision ?? 0,
      });
      return { candidate: decided, plan };
    });
  }

  listLessonVersions(lessonId: string, projectId: string): LessonVersionRow[] {
    return this.lessons.listVersions(lessonId, projectId);
  }

  readLessonCatalog(projectId: string) {
    return this.lessons.readCatalog(projectId);
  }

  /** 单个课程版本行：课件装配与发布复核都要按版本精确取，不能取「最新一条」。 */
  getLessonVersion(lessonId: string, version: number, projectId: string): LessonVersionRow | null {
    return this.lessons.getVersion(lessonId, version, projectId);
  }

  getLessonClassroomLink(lessonId: string, projectId: string): ClassroomLinkRow | null {
    return this.lessons.getLink(lessonId, projectId);
  }

  /** 课件文档挂接到当前已发布版本；版本不在发布态时整笔不生效。 */
  attachLessonDocument(input: {
    projectId: string;
    lessonId: string;
    version: number;
    stageId: string;
    documentDigest: string;
  }): ClassroomLinkRow {
    return this.lessons.attachDocument(input);
  }

  getEvidenceBundle(projectId: string, bundleId: string): EvidenceBundleRow | null {
    return this.lessons.getBundle(bundleId, projectId);
  }

  /**
   * 课程版本引用到的知识点及其当前准入结论。
   *
   * 审核、发布、上课与模型调用四个入口共用这一份判定，避免出现「某处放行、某处阻断」
   * 的口径分裂。陈述在证据包里定位不到时按缺来源处理，不当作空引用放行。
   */
  private lessonAdmission(projectId: string, lesson: LessonVersionRow): {
    referenced: string[];
    admitted: Set<string>;
    blocked: string[];
    statementKnowledgeOf: (statementId: string) => string | null;
    questionKnowledgeOf: (questionId: string) => string[];
  } {
    const bundle = this.lessons.getBundle(lesson.bundleId, projectId);
    if (!bundle) throw new StudyError('INTERNAL', { bundleId: lesson.bundleId });
    const statementKnowledgeOf = (statementId: string): string | null =>
      bundle.bundle.statements.find((statement) => statement.statementId === statementId)?.knowledgeId ?? null;
    const questionKnowledgeOf = (questionId: string): string[] =>
      bundle.bundle.questions.find((question) => question.questionId === questionId)?.knowledgeIds ?? [];
    const referenced = lessonReferencedKnowledgeIds(lesson, { statementKnowledgeOf, questionKnowledgeOf });
    const admission = this.checkAdmission(referenced, 'formal');
    return {
      referenced,
      admitted: new Set(admission.admitted),
      blocked: admission.blocked.map((item) => item.knowledgeId),
      statementKnowledgeOf,
      questionKnowledgeOf,
    };
  }

  /**
   * 记录课程版本的人工审核结论（LESSON-02 的审核入口）。
   *
   * 批准前先复核准入：来源已失效的版本不能靠一次点击放行，界面拿到的是被阻断的知识点清单。
   * 审核结论只绑定该版本，改表述产生新草案版本后必须重新审核。
   */
  reviewLesson(input: {
    projectId: string;
    lessonId: string;
    version: number;
    decision: LessonReviewDecision;
    note: string;
  }): LessonReviewRow {
    const lesson = this.lessons.getVersion(input.lessonId, input.version, input.projectId);
    if (!lesson) throw new StudyError('NOT_FOUND', { lessonId: input.lessonId, version: input.version });
    assertLessonReviewable(lesson.status);
    const facts = this.lessonAdmission(input.projectId, lesson);
    if (input.decision === 'approved' && facts.blocked.length > 0) {
      throw new StudyError('KNOWLEDGE_INVALIDATED', { knowledgeIds: facts.blocked });
    }
    return this.lessons.recordReview({
      projectId: input.projectId,
      lessonId: input.lessonId,
      version: input.version,
      decision: input.decision,
      note: input.note,
      admittedKnowledgeIds: facts.referenced.filter((knowledgeId) => facts.admitted.has(knowledgeId)),
      blockedKnowledgeIds: facts.blocked,
    });
  }

  getLessonReview(lessonId: string, version: number, projectId: string): LessonReviewRow | null {
    return this.lessons.getReview(lessonId, version, projectId);
  }

  /** 发布课程：本版本必须已有人工审核通过记录，且引用来源仍准入。 */
  publishLesson(input: PublishLessonInput): LessonVersionRow {
    const lesson = this.lessons.getVersion(input.lessonId, input.version, input.projectId);
    if (!lesson) throw new StudyError('NOT_FOUND', { lessonId: input.lessonId, version: input.version });
    const facts = this.lessonAdmission(input.projectId, lesson);
    const review = this.lessons.getReview(input.lessonId, input.version, input.projectId);
    return this.lessons.publish(input, {
      admittedKnowledgeIds: facts.admitted,
      reviewApproved: review?.decision === 'approved',
      statementKnowledgeOf: facts.statementKnowledgeOf,
      questionKnowledgeOf: facts.questionKnowledgeOf,
    });
  }

  /** 撤回当前已发布的版本：课堂入口随即受阻，历史版本与证据包保持原样。 */
  withdrawLesson(input: { projectId: string; lessonId: string; reason: string }): LessonVersionRow {
    const published = this.lessons.publishedVersion(input.lessonId, input.projectId);
    if (!published) throw new StudyError('INVALID_ARGUMENT', { reason: 'lesson_not_published' });
    return this.lessons.withdraw({ ...input, version: published.version });
  }

  /**
   * 上课入口的统一复核（LESSON-02）。
   *
   * 返回当前可上的课程版本与课堂映射；未发布、未审核或来源失效都抛领域错误。
   * 页面不能自行判断「这节课还能上」，模型的教学调用也必须先过这道复核。
   */
  assertLessonClassroomReady(lessonId: string, projectId: string): {
    lesson: LessonVersionRow;
    link: ClassroomLinkRow;
    referencedKnowledgeIds: string[];
  } {
    const link = this.lessons.getLink(lessonId, projectId);
    if (!link || link.status !== 'published') {
      throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', {
        reason: 'no_published_link', status: link?.status ?? null, note: link?.statusNote ?? '',
      });
    }
    const lesson = this.lessons.getVersion(lessonId, link.lessonVersion, projectId);
    if (!lesson) throw new StudyError('INTERNAL', { lessonId, version: link.lessonVersion });
    const facts = this.lessonAdmission(projectId, lesson);
    const review = this.lessons.getReview(lessonId, lesson.version, projectId);
    assertLessonTeachable(
      { lessonStatus: lesson.status, reviewApproved: review?.decision === 'approved' },
      facts.referenced,
      facts.admitted,
    );
    return { lesson, link, referencedKnowledgeIds: facts.referenced };
  }

  // ——————————————————— 讲解卡、课堂会话与动作收据 ———————————————————

  /**
   * 登记一张讲解卡（TEACH-01）。
   *
   * 教师手写的卡片必须当场给出依据陈述；模型现场产生的内容允许先没有来源，
   * 但它停留在待核区，人工补上陈述并通过审核后才会进入播放队列。
   */
  createExplanation(input: CreateExplanationInput): ExplanationRow {
    const lesson = this.lessons.getVersion(input.lessonId, input.lessonVersion, input.projectId);
    if (!lesson) throw new StudyError('NOT_FOUND', { lessonId: input.lessonId, version: input.lessonVersion });
    const bundle = this.lessons.getBundle(lesson.bundleId, input.projectId);
    if (!bundle) throw new StudyError('INTERNAL', { bundleId: lesson.bundleId });
    if (input.origin === 'teacher_authored' || input.statementIds.length > 0) {
      assertCardGrounded(input.statementIds, bundle.bundle);
    }
    return this.teaching.createCard(input);
  }

  /** 草案卡片可编辑文本与依据陈述；已审核的卡片不再改写，避免结论与内容分叉。 */
  updateExplanationDraft(input: {
    projectId: string;
    explanationId: string;
    text?: string;
    statementIds?: string[];
  }): ExplanationRow {
    const card = this.teaching.getCard(input.explanationId, input.projectId);
    if (!card) throw new StudyError('NOT_FOUND', { explanationId: input.explanationId });
    if (card.status !== 'draft') throw new StudyError('STEP_ALREADY_COMMITTED', { status: card.status });
    if (input.text === undefined && input.statementIds === undefined) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'nothing_to_edit' });
    }
    const statementIds = input.statementIds ?? card.statementIds;
    if (input.statementIds !== undefined) {
      const lesson = this.lessons.getVersion(card.lessonId, card.lessonVersion, input.projectId);
      const bundle = lesson ? this.lessons.getBundle(lesson.bundleId, input.projectId) : null;
      if (!bundle) throw new StudyError('INTERNAL', { explanationId: card.explanationId });
      assertCardGrounded(statementIds, bundle.bundle);
    }
    return this.teaching.updateCard(input.explanationId, input.projectId, {
      text: input.text,
      statementIds,
    });
  }

  listExplanationCards(lessonId: string, lessonVersion: number, projectId: string): ExplanationRow[] {
    return this.teaching.listCards(lessonId, lessonVersion, projectId);
  }

  getExplanation(explanationId: string, projectId: string): ExplanationRow | null {
    return this.teaching.getCard(explanationId, projectId);
  }

  /** 审核讲解卡。批准前复核准入：来源已失效的陈述不能靠点一次审核放行。 */
  reviewExplanation(input: {
    projectId: string;
    explanationId: string;
    decision: 'approved' | 'rejected';
    note: string;
  }): ExplanationRow {
    const card = this.teaching.getCard(input.explanationId, input.projectId);
    if (!card) throw new StudyError('NOT_FOUND', { explanationId: input.explanationId });
    if (input.decision === 'approved') {
      const lesson = this.lessons.getVersion(card.lessonId, card.lessonVersion, input.projectId);
      const bundle = lesson ? this.lessons.getBundle(lesson.bundleId, input.projectId) : null;
      if (!bundle) throw new StudyError('INTERNAL', { explanationId: card.explanationId });
      const knowledgeIds = assertCardGrounded(card.statementIds, bundle.bundle);
      assertCardApprovable(
        { status: card.status, knowledgeIds },
        new Set(this.checkAdmission(knowledgeIds, 'formal').admitted),
      );
    }
    return this.teaching.reviewCard(input.explanationId, input.projectId, input.decision, input.note);
  }

  /**
   * 开一堂课：外层课堂 session 包住 Director 调度（《规划书》6.5）。
   *
   * 开课即走上课入口的统一复核（已发布 + 本版本已审核 + 来源仍准入），
   * 因此来源失效在第一步就阻断，不会讲到一半才发现无来源。
   */
  openClassroomSession(input: {
    projectId: string;
    lessonId: string;
    stageId: string | null;
    learnerKey: string;
    sceneId: string;
  }): ClassroomSessionRow {
    const ready = this.assertLessonClassroomReady(input.lessonId, input.projectId);
    const existing = this.teaching.getOpenSession(input.projectId);
    if (existing && existing.lessonId !== input.lessonId) {
      throw new StudyError('PROJECT_ALREADY_OPEN', { reason: 'classroom_session_running', sessionId: existing.sessionId });
    }
    if (existing) return existing;
    const run = this.runs.getLatestRun();
    const session = this.teaching.createSession({
      projectId: input.projectId,
      runId: run?.runId ?? null,
      lessonId: ready.lesson.lessonId,
      lessonVersion: ready.lesson.version,
      bundleId: ready.lesson.bundleId,
      stageId: input.stageId ?? ready.link.stageId,
      learnerKey: input.learnerKey,
      currentSceneId: input.sceneId,
    });
    if (run) this.runs.updateRunState(run.runId, 'in_class');
    return session;
  }

  getClassroomSession(sessionId: string, projectId: string): ClassroomSessionRow | null {
    return this.teaching.getSession(sessionId, projectId);
  }

  getOpenClassroomSession(projectId: string): ClassroomSessionRow | null {
    return this.teaching.getOpenSession(projectId);
  }

  listClassroomSessions(projectId: string): ClassroomSessionRow[] {
    return this.teaching.listSessions(projectId);
  }

  listClassroomActions(sessionId: string, projectId: string): ClassroomActionRow[] {
    return this.teaching.listActions(sessionId, projectId);
  }

  /** Every teaching entry revalidates the exact published version frozen by this session. */
  assertClassroomSessionReady(projectId: string, sessionId: string): ReturnType<StudyStore['assertLessonClassroomReady']> {
    const session = this.requireSession(sessionId, projectId);
    assertSessionActive(session.status);
    if (session.status === 'awaiting_learner') {
      throw new StudyError('CLASSROOM_AWAITING_LEARNER', { reason: 'awaiting_learner' });
    }
    const ready = this.assertLessonClassroomReady(session.lessonId, projectId);
    if (ready.lesson.version !== session.lessonVersion || ready.lesson.bundleId !== session.bundleId) {
      throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'session_lesson_version_changed' });
    }
    return ready;
  }

  /** 现场快照：会话、卡片队列、已播放编号、待核数量与 AI 同学发言。读取不写任何状态。 */
  classroomState(projectId: string, sessionId: string): ClassroomStateDto {
    const session = this.teaching.getSession(sessionId, projectId);
    if (!session) throw new StudyError('NOT_FOUND', { sessionId });
    const cards = this.teaching.listCards(session.lessonId, session.lessonVersion, projectId);
    const playedIds = this.teaching.playedCardIds(sessionId, projectId);
    // 同学档案即使被关闭也返回：界面据此提供「重新开启」，而不是让人去设置页找。
    const peerProfiles = this.roles.list('formal').filter((profile) => profile.kind === 'peer');
    return {
      session,
      cards: cards.map((card) => this.toCard(card)),
      playedIds,
      pendingReview: cards.filter((card) => card.status === 'draft').length,
      peers: peerProfiles.map((profile) => ({
        profileId: profile.profileId,
        name: profile.name,
        engagement: session.peersEngagement,
      })),
      peerTurns: this.teaching.listPeerTurns(sessionId, projectId, session.roundIndex),
    };
  }

  /**
   * 开关 AI 同学并调整参与度（PEER-01）。
   *
   * 开启时要求项目里至少存在一位同学档案：没有档案的「开启」只是空开关，
   * 会让人以为同学已经参与。关闭不影响教师会话，课堂照常继续。
   */
  setClassroomPeers(projectId: string, sessionId: string, input: {
    enabled: boolean;
    engagement?: PeerEngagement;
  }): ClassroomSessionRow{
    return this.classroomCommands.setClassroomPeers(projectId, sessionId, input);
  }

  /** 本轮同学发言条数：由发言表实际统计，不信任会话上的计数列。 */
  classroomPeerTurnCount(projectId: string, sessionId: string, roundIndex: number): number {
    return this.teaching.peerTurnCount(sessionId, projectId, roundIndex);
  }

  listClassroomPeerTurns(projectId: string, sessionId: string, roundIndex?: number): ClassroomPeerTurnDto[] {
    return this.teaching.listPeerTurns(sessionId, projectId, roundIndex);
  }

  getClassroomPeerTurnReceipt(input: {
    projectId: string; sessionId: string; requestId: string;
    roleProfileId: string; kind: 'question' | 'discussion' | 'example';
  }): ClassroomPeerTurnDto | null {
    this.requireSession(input.sessionId, input.projectId);
    const existing = this.teaching.getReceipt(buildStepKey('classroom-peer-turn', input.projectId, input.sessionId, input.requestId));
    if (!existing) return null;
    const receipt = existing.payload;
    if (receipt.kind !== 'peer_turn' || receipt.roleProfileId !== input.roleProfileId || receipt.peerKind !== input.kind) {
      throw new StudyError('VERSION_CONFLICT', { reason: 'peer_turn_context_changed' });
    }
    const turn = this.teaching.listPeerTurns(input.sessionId, input.projectId).find(item => item.turnId === receipt.turnId);
    if (!turn) throw new StudyError('INTERNAL', { reason: 'peer_turn_receipt_without_turn' });
    return turn;
  }

  /**
   * 记录一次 AI 同学发言，并同步推进轮内计数。
   *
   * 判定顺序与模型调用一致：先查重试收据，再判权限与上限，最后在同一事务里
   * 写发言、加计数、落收据。任何一步不过都不会留下半条发言。
   */
  recordClassroomPeerTurn(input: {
    projectId: string;
    sessionId: string;
    roleProfileId: string;
    kind: 'question' | 'discussion' | 'example';
    text: string;
    statementIds: string[];
    reviewedExampleId: string | null;
    /** 稳定请求 ID：同一次发言重试读回既有结果。 */
    requestId: string;
  }): { turn: ClassroomPeerTurnDto; deduplicated: boolean }{
    return this.classroomCommands.recordClassroomPeerTurn(input);
  }

  /**
   * 播放下一张已审核讲解卡。
   *
   * 队列按场景与位置确定；相同请求 ID 先查收据，再决定下一张卡片。
   */
  getClassroomPlayReceipt(projectId: string, sessionId: string, requestId: string) {
    const session = this.requireSession(sessionId, projectId);
    const existing = this.teaching.getReceipt(buildStepKey('classroom-play-request', projectId, sessionId, requestId));
    if (!existing) return null;
    // 收据命中就是幂等重放：此时不该再拿「当前场景」去比。切场景后重发同一个请求
    // 仍应读回原来那张卡，否则「重复提交读回既有收据」在换场后就失效了。
    if (existing.payload.kind === 'queue_empty') return { card: null, deduplicated: true, session, playedIds: this.teaching.playedCardIds(sessionId, projectId) };
    if (existing.payload.kind !== 'card_played') throw new StudyError('INTERNAL', { reason: 'play_receipt_invalid' });
    const saved = this.teaching.getCard(existing.payload.explanationId, projectId);
    if (!saved) throw new StudyError('INTERNAL', { reason: 'played_card_missing' });
    if (saved.sceneId !== existing.sceneId || saved.lessonId !== session.lessonId || saved.lessonVersion !== session.lessonVersion) {
      throw new StudyError('INTERNAL', { reason: 'play_receipt_binding_mismatch' });
    }
    return { card: this.toCard(saved), deduplicated: true, session, playedIds: this.teaching.playedCardIds(sessionId, projectId) };
  }

  getClassroomAdvanceReceipt(projectId: string, sessionId: string, sceneId: string, requestId: string) {
    const session = this.requireSession(sessionId, projectId);
    const existing = this.teaching.getReceipt(buildStepKey('classroom-scene-request', projectId, sessionId, requestId));
    if (!existing) return null;
    if (existing.payload.kind !== 'scene_advanced' || existing.payload.toSceneId !== sceneId) throw new StudyError('VERSION_CONFLICT', { reason: 'scene_request_context_changed' });
    return { session, deduplicated: true };
  }

  playNextExplanation(projectId: string, sessionId: string, requestId: string): {
    card: ExplanationCardDto | null;
    deduplicated: boolean;
    session: ClassroomSessionRow;
    playedIds: string[];
  }{
    return this.classroomCommands.playNextExplanation(projectId, sessionId, requestId);
  }

  /** 交还本人：会话进入等待状态并落库，重启后仍然等待，不会自行继续讲解。 */
  handBackToLearner(projectId: string, sessionId: string, reason: string): ClassroomSessionRow{
    return this.classroomCommands.handBackToLearner(projectId, sessionId, reason);
  }

  /** 本人作答归来：开始新一轮，轮内计数清零，整节课累计继续保留。 */
  markLearnerAnswered(projectId: string, sessionId: string): ClassroomSessionRow{
    return this.classroomCommands.markLearnerAnswered(projectId, sessionId);
  }

  /** 切换场景同样开启新一轮；等待本人时不允许跳过。 */
  advanceClassroomScene(projectId: string, sessionId: string, sceneId: string, requestId: string): {
    session: ClassroomSessionRow;
    deduplicated: boolean;
  }{
    return this.classroomCommands.advanceClassroomScene(projectId, sessionId, sceneId, requestId);
  }

  closeClassroomSession(projectId: string, sessionId: string, status: 'completed' | 'cancelled', reason: string): ClassroomSessionRow{
    return this.classroomCommands.closeClassroomSession(projectId, sessionId, status, reason);
  }

  /**
   * 记一次课堂模型调用：先按每轮与整节课上限判定，再在同一事务里计数并落收据。
   *
   * 收据 step key 由「会话 + 轮次 + 轮内序号」决定，重试读到既有收据不会重复计费。
   */
  noteClassroomModelCall(input: {
    projectId: string;
    sessionId: string;
    purpose: ModelCallPurpose;
    ok: boolean;
    totalTokens: number;
    callId?: string;
    expectedRoundIndex?: number;
    expectedSceneId?: string;
    /** A dispatched result whose frozen context is obsolete: account, never resume teaching. */
    discarded?: boolean;
    limits?: { maxCallsPerRound?: number; maxPeerTurnsPerRound?: number; maxLessonCalls?: number };
  }): ClassroomSessionRow{
    return this.classroomCommands.noteClassroomModelCall(input);
  }

  private requireSession(sessionId: string, projectId: string): ClassroomSessionRow {
    const session = this.teaching.getSession(sessionId, projectId);
    if (!session) throw new StudyError('NOT_FOUND', { sessionId });
    return session;
  }

  /** 行到合同的映射：卡片行的字段与共享 DTO 一致，映射只做一次显式拷贝。 */
  private toCard(row: ExplanationRow): ExplanationCardDto {
    return {
      explanationId: row.explanationId,
      projectId: row.projectId,
      lessonId: row.lessonId,
      lessonVersion: row.lessonVersion,
      sceneId: row.sceneId,
      position: row.position,
      kind: row.kind,
      origin: row.origin,
      status: row.status,
      text: row.text,
      statementIds: row.statementIds,
      reviewNote: row.reviewNote,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ————————————————————————— 角色档案 —————————————————————————

  listRoleProfiles(scope: RecordScope = 'formal'): RoleProfileRow[] {
    return this.roles.list(scope);
  }

  createRoleProfile(kind: RoleKind, input: RoleWriteInput, scope: RecordScope = 'formal'): RoleProfileRow {
    return this.roles.create(kind, input, scope);
  }

  updateRoleProfile(profileId: string, input: RoleWriteInput, scope: RecordScope = 'formal'): RoleProfileRow {
    return this.roles.update(profileId, input, scope);
  }

  deleteRoleProfile(profileId: string, scope: RecordScope = 'formal'): void {
    this.roles.delete(profileId, scope);
  }

  /** 角色集合摘要；未配置任何角色时为 null，run 冻结如实记录「未配置」。 */
  roleConfigDigest(scope: RecordScope = 'formal'): string | null {
    return this.roles.configDigest(scope);
  }

  // ————————————————————————— 课堂文档与状态 —————————————————————————

  /** 写入审核课件：文档与场景来源绑定在同一事务落库。 */
  saveClassroomDocument(
    input: Parameters<ClassroomRepository['saveDocument']>[0],
  ): ReturnType<ClassroomRepository['saveDocument']> {
    return this.classroom.saveDocument(input);
  }

  getClassroomDocument(projectId: string, stageId: string) {
    return this.classroom.getDocument(projectId, stageId);
  }

  listClassroomDocuments(projectId: string) {
    return this.classroom.listDocuments(projectId);
  }

  listClassroomSceneSources(projectId: string, stageId: string) {
    return this.classroom.listSceneSources(projectId, stageId);
  }

  /** 场景写入必须带上调用方算好的新指纹，避免文档与 digest 脱节。 */
  putClassroomScene(projectId: string, stageId: string, scene: unknown, digest: string) {
    return this.classroom.putScene(projectId, stageId, scene, digest);
  }

  deleteClassroomDocument(projectId: string, stageId: string): void {
    this.classroom.deleteDocument(projectId, stageId);
  }

  listClassroomFolders(projectId: string): DocumentFolderRow[] {
    return this.documentOrganization.listFolders(projectId);
  }

  createClassroomFolder(projectId: string, id: string, name: string, limit?: number) {
    return this.documentOrganization.createFolder(projectId, id, name, limit);
  }

  renameClassroomFolder(projectId: string, id: string, name: string): DocumentFolderRow | null {
    return this.documentOrganization.renameFolder(projectId, id, name);
  }

  /** Delete only the organization folder; memberships cascade to unfiled documents. */
  deleteClassroomFolder(projectId: string, id: string): boolean {
    return this.documentOrganization.deleteFolder(projectId, id);
  }

  setClassroomDocumentFolder(projectId: string, stageId: string, folderId: string | null): boolean {
    return this.documentOrganization.setStageFolder(projectId, stageId, folderId);
  }

  listClassroomDocumentFolderIds(projectId: string): Map<string, string> {
    return this.documentOrganization.listDocumentFolderIds(projectId);
  }

  readClassroomState(projectId: string, stageId: string) {
    return this.classroom.readState(projectId, stageId);
  }

  writeClassroomState(projectId: string, stageId: string, currentSceneId: string) {
    return this.classroom.writeState(projectId, stageId, currentSceneId);
  }

  putClassroomAsset(projectId: string, assetId: string, mediaType: string, metadata: Record<string, unknown>, bytes: Uint8Array, scope: RecordScope = 'formal'): ClassroomAssetRow {
    return this.classroomAssets.put(projectId, assetId, mediaType, metadata, bytes, scope);
  }

  getClassroomAsset(projectId: string, assetId: string): ClassroomAssetRow | null {
    return this.classroomAssets.get(projectId, assetId);
  }

  getClassroomAssetInfo(projectId: string, assetId: string): ClassroomAssetInfo | null {
    return this.classroomAssets.getInfo(projectId, assetId);
  }

  classroomAssetBytes(projectId: string): number {
    return this.classroomAssets.totalBytes(projectId);
  }

  listClassroomAssets(projectId: string): Array<Omit<ClassroomAssetRow, 'bytes'>> {
    return this.classroomAssets.list(projectId);
  }

  deleteClassroomAsset(projectId: string, assetId: string): void {
    this.classroomAssets.delete(projectId, assetId);
  }

  /** 未被课件绑定的资源清单（回收候选，不含字节）。 */
  listReclaimableAssets(projectId: string, scope: RecordScope = 'formal'): ClassroomAssetInfo[] {
    return this.classroomAssets.listUnbound(projectId, scope);
  }

  /** 显式回收未绑定资源；被引用时整体放弃，候选不存在按幂等跳过。 */
  reclaimAssets(
    projectId: string,
    assetIds: readonly string[],
    scope: RecordScope = 'formal',
  ): { reclaimed: string[]; freedBytes: number } {
    return this.classroomAssets.reclaim(projectId, assetIds, scope);
  }

  putClassroomAssetBinding(projectId: string, stageId: string, sceneId: string, slot: string, assetId: string, scope: RecordScope = 'formal'): ClassroomAssetBindingRow {
    return this.classroomAssets.putBinding(projectId, stageId, sceneId, slot, assetId, scope);
  }

  getClassroomAssetBinding(projectId: string, stageId: string, sceneId: string, slot: string): ClassroomAssetBindingRow | null {
    return this.classroomAssets.getBinding(projectId, stageId, sceneId, slot);
  }

  listClassroomAssetBindings(projectId: string, stageId: string): ClassroomAssetBindingRow[] {
    return this.classroomAssets.listBindings(projectId, stageId);
  }

  private assertClassroomBoardBinding(binding: ClassroomBoardBindingDto, content: ClassroomBoardContentDto): void {
    const ready = this.assertLessonClassroomReady(binding.lessonId, binding.projectId);
    if (ready.lesson.version !== binding.lessonVersion || !ready.link.stageId) {
      throw new StudyError('VERSION_CONFLICT', { reason: 'board_lesson_version_changed' });
    }
    const source = this.classroom.listSceneSources(binding.projectId, ready.link.stageId).get(binding.sceneId);
    const bundle = this.lessons.getBundle(ready.lesson.bundleId, binding.projectId);
    if (!source || source.recordScope !== 'formal' || !source.reviewedBy || !bundle) {
      throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING');
    }
    const allowed = new Set(bundle.bundle.statements.filter(statement => ready.lesson.statementIds.includes(statement.statementId)
      && source.knowledgeIds.includes(statement.knowledgeId)).map(statement => statement.statementId));
    if (content.kind === 'focus') {
      // 教师聚焦只能指向**这一版冻结课件里真实存在**的元素：不能凭空指一个不存在的对象，
      // 否则共享投影与课堂画布会指向空白。
      const document = this.classroom.getDocument(binding.projectId, ready.link.stageId);
      const scenes = (document?.document as { scenes?: Array<{ id?: string; content?: { canvas?: { elements?: Array<{ id?: string }> } } }> } | undefined)?.scenes ?? [];
      const scene = scenes.find(item => item.id === binding.sceneId);
      const elementIds = new Set((scene?.content?.canvas?.elements ?? []).map(element => String(element.id ?? '')));
      if (!elementIds.has(content.elementId)) {
        throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING', { reason: 'board_focus_element_missing', elementId: content.elementId });
      }
    }
    if (binding.statementIds.length === 0 || binding.statementIds.some(id => !allowed.has(id))) {
      throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING', { reason: 'board_statement_outside_scene' });
    }
  }

  /** Historical read does not resume a teacher or bypass the new-action guard. */
  classroomBoardState(projectId: string, sessionId: string) { return this.classroomBoard.state(projectId, sessionId); }
  classroomBoardStatementIds(projectId: string, sessionId: string): string[] {
    const classroom = this.requireSession(sessionId, projectId);
    const lesson = this.lessons.getVersion(classroom.lessonId, classroom.lessonVersion, projectId);
    const bundle = lesson ? this.lessons.getBundle(lesson.bundleId, projectId) : null;
    const source = classroom.stageId ? this.classroom.listSceneSources(projectId, classroom.stageId).get(classroom.currentSceneId) : null;
    if (!lesson || !bundle || !source) return [];
    return bundle.bundle.statements.filter(statement => lesson.statementIds.includes(statement.statementId)
      && source.knowledgeIds.includes(statement.knowledgeId)).map(statement => statement.statementId);
  }
  /**
   * 当前场景里可被教师聚焦的元素编号。
   *
   * 只读冻结课件，供界面给出「真实存在」的候选项；服务端在写入时仍会独立复验一次，
   * 因此界面即使被绕过也指不到不存在的元素。
   */
  classroomBoardElementIds(projectId: string, sessionId: string): string[] {
    const classroom = this.requireSession(sessionId, projectId);
    if (!classroom.stageId) return [];
    const document = this.classroom.getDocument(projectId, classroom.stageId);
    const scenes = (document?.document as { scenes?: Array<{ id?: string; content?: { canvas?: { elements?: Array<{ id?: string }> } } }> } | undefined)?.scenes ?? [];
    const scene = scenes.find(item => item.id === classroom.currentSceneId);
    return (scene?.content?.canvas?.elements ?? []).map(element => String(element.id ?? '')).filter(Boolean);
  }
  createClassroomBoardItem(input: CreateClassroomBoardInput) { return this.classroomBoard.create(input); }
  reviewClassroomBoardItem(input: ReviewClassroomBoardInput) { return this.classroomBoard.review(input); }
  playClassroomBoardItem(input: PlayClassroomBoardInput) { return this.classroomBoard.play(input); }
  getClassroomBoardPlayReceipt(input: PlayClassroomBoardInput) { return this.classroomBoard.getPlayReceipt(input); }

  getFeedbackContext(projectId: string, uid: string, attemptId: string) { return this.feedbackReview.context(projectId, uid, attemptId); }
  listReviewTasks(projectId: string, uid: string) { return this.feedbackReview.tasks(projectId, uid); }
  feedbackCommand(projectId: string, uid: string, command: FeedbackReviewCommand, origin: 'manual' | 'model' = 'manual') { return this.feedbackReview.command(projectId, uid, command, origin); }

  getModelUsageCall(projectId: string, requestId: string, intent?: string) { return this.modelUsage.get(projectId, requestId, intent); }
  listModelUsageCalls(projectId: string) { return this.modelUsage.list(projectId); }
  startModelUsageCall(input: StartModelUsageCallInput, limits: ModelUsageLimits) {
    return this.transaction(() => this.modelUsage.start(input, this.modelCallUsage(input.runId), limits));
  }
  settleModelUsageCall(projectId: string, requestId: string, input: SettleModelUsageCallInput) { return this.modelUsage.settle(projectId, requestId, input); }
  saveModelUsageCallResult(projectId: string, requestId: string, result: ModelUsageCallDto['result']) { return this.modelUsage.saveResult(projectId, requestId, result); }
  /**
   * 共享预算报告：实际/估算/未知分开，未结算清单可见（BUDGET-01）。
   *
   * 评分调用记在自己的表里（需要题目/规则版本列），但同属这份额度。只合并
   * `started` 会让**已结算的评分从报告里消失**，也无法表达「已派发但用量未知」；
   * 所以这里按同一套口径把评分的实际/估算/未知/预占四桶一起并入，并给出按用途明细。
   */
  modelUsageReport(runId: string, limits: ModelUsageLimits): ModelUsageReportDto {
    return this.modelUsage.report(runId, limits, this.sharedModelUsageCalls(runId));
  }

  countRows(table: string): number {
    const allowed = new Set([
      'materials',
      'proposals',
      'knowledge_points',
      'questions',
      'attempts',
      'step_receipts',
      'runs',
    ]);
    if (!allowed.has(table)) throw new StudyError('INVALID_ARGUMENT', { table });
    const sql =
      table === 'materials'
        ? 'SELECT COUNT(*) AS c FROM source_versions'
        : `SELECT COUNT(*) AS c FROM ${table}`;
    const row = this.db.prepare(sql).get() as Row;
    return Number(row['c'] ?? 0);
  }
}
