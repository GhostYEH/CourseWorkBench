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

import { createHash } from 'node:crypto';
import {
  STEP_RECEIPT_VERSION,
  StudyError,
  newId,
  type AdmissionResultDto,
  type FrozenVersionsDto,
  type MasteryStatus,
  type PlanPayloadDto,
  type QuestionOrigin,
  type ReviewDecision,
  type RecordScope,
  type RoleKind,
  type RunEventPayloadDto,
  type RunState,
} from '@sew/study-contracts';
import {
  computeInvalidation,
  computeSyllabusCoverage,
  decideAttempt,
  buildEvidenceBundle,
  buildStepKey,
  resolveQuestionOrigin,
  type MaterialChangeImpact,
  type OriginRecord,
  type SyllabusCoverageResult,
  type SyllabusItemRecord,
  type SyllabusMappingRecord,
} from '@sew/study-domain';
import { createNodeSqliteDriver, type SqlDatabase, type SqliteDriver } from './driver';
import { MIGRATIONS } from './schema';
import { AttemptsRepository } from './repositories/attempts';
import { ClassroomRepository } from './repositories/classroom';
import { ClassroomAssetsRepository } from './repositories/classroom-assets';
import {
  DocumentOrganizationRepository,
  type DocumentFolderRow,
} from './repositories/document-organization';
import { ClassroomRuntimeRepository } from './repositories/classroom-runtime';
import { ClassroomKVRepository } from './repositories/classroom-kv';
import { KnowledgeRepository } from './repositories/knowledge';
import { MaterialsRepository } from './repositories/materials';
import { PlansRepository } from './repositories/plans';
import { PreferencesRepository } from './repositories/preferences';
import { ProjectsRepository } from './repositories/projects';
import { ProposalsRepository } from './repositories/proposals';
import { QuestionsRepository } from './repositories/questions';
import { RunsRepository } from './repositories/runs';
import { RoleRepository, type RoleWriteInput } from './repositories/roles';
import {
  LessonRepository,
  type CreateLessonDraftInput,
  type PublishLessonInput,
} from './repositories/lessons';
import type { RunEventRow, StepReceiptRow } from './repositories/runs';
import { SyllabusRepository } from './repositories/syllabus';
import type { CreateSyllabusItemInput, SyllabusItemRow } from './repositories/syllabus';
import type {
  AttemptRow,
  ClassroomLinkRow,
  CreateProposalInput,
  EvidenceBundleRow,
  ImportMaterialInput,
  KnowledgeRow,
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
import type { ClassroomAssetBindingRow, ClassroomAssetInfo, ClassroomAssetRow } from './repositories/classroom-assets';

export type {
  ClassroomDocumentRow,
  ClassroomSceneSourceRow,
  ClassroomStateRow,
  SaveClassroomDocumentInput,
} from './repositories/classroom';
export type { DocumentFolderRow } from './repositories/document-organization';
export { DocumentOrganizationError } from './repositories/document-organization';
export type { ClassroomAssetBindingRow, ClassroomAssetInfo, ClassroomAssetRow } from './repositories/classroom-assets';
export { ClassroomAssetReferencedError } from './repositories/classroom-assets';
export type { CreateSyllabusItemInput, SyllabusItemRow } from './repositories/syllabus';
export type { PlanVersionRow, RoleProfileRow } from './repositories/types';
export type {
  ClassroomLinkRow, EvidenceBundleRow, LessonStatus, LessonVersionRow,
} from './repositories/types';
export type {
  CreateLessonDraftInput, PublishLessonInput,
} from './repositories/lessons';
export type { RunEventRow, StepReceiptRow } from './repositories/runs';
export type { RoleWriteInput } from './repositories/roles';
export type {
  RuntimeAppendOptions,
  RuntimeRecordInput,
  RuntimeRecordRow,
  RuntimeQuizReceiptRow,
  RuntimeSessionRow,
  RuntimeStatus,
} from './repositories/classroom-runtime';
export type {
  AttemptRow,
  CreateProposalInput,
  EvidenceStored,
  ImportMaterialInput,
  KnowledgeRow,
  MaterialRawArchiveRow,
  MaterialRow,
  ProjectRow,
  ProposalRow,
  QuestionRow,
  ReviewOutcome,
  RunRow,
  SegmentRow,
  SubmitAttemptInput,
  SubmitAttemptOutcome,
} from './repositories/types';

interface Row {
  [key: string]: unknown;
}

export interface StoreOptions {
  file: string;
  driver?: SqliteDriver;
}

export class StudyStore {
  private readonly db: SqlDatabase;
  private readonly driverName: string;
  private readonly projects: ProjectsRepository;
  private readonly materials: MaterialsRepository;
  private readonly proposals: ProposalsRepository;
  private readonly knowledge: KnowledgeRepository;
  private readonly questions: QuestionsRepository;
  private readonly attempts: AttemptsRepository;
  private readonly runs: RunsRepository;
  private readonly preferences: PreferencesRepository;
  private readonly plans: PlansRepository;
  private readonly roles: RoleRepository;
  private readonly lessons: LessonRepository;
  private readonly syllabus: SyllabusRepository;
  private readonly classroom: ClassroomRepository;
  private readonly documentOrganization: DocumentOrganizationRepository;
  private readonly classroomAssets: ClassroomAssetsRepository;
  readonly runtime: ClassroomRuntimeRepository;
  readonly classroomKV: ClassroomKVRepository;

  private constructor(db: SqlDatabase, driverName: string) {
    this.db = db;
    this.driverName = driverName;
    this.projects = new ProjectsRepository(db);
    this.materials = new MaterialsRepository(db);
    this.proposals = new ProposalsRepository(db);
    this.knowledge = new KnowledgeRepository(db);
    this.questions = new QuestionsRepository(db);
    this.attempts = new AttemptsRepository(db);
    this.runs = new RunsRepository(db);
    this.preferences = new PreferencesRepository(db);
    this.plans = new PlansRepository(db);
    this.roles = new RoleRepository(db);
    this.lessons = new LessonRepository(db);
    this.syllabus = new SyllabusRepository(db);
    this.classroom = new ClassroomRepository(db);
    this.documentOrganization = new DocumentOrganizationRepository(db);
    this.classroomAssets = new ClassroomAssetsRepository(db);
    this.runtime = new ClassroomRuntimeRepository(db);
    this.classroomKV = new ClassroomKVRepository(db);
  }

  static open(options: StoreOptions): StudyStore {
    const driver = options.driver ?? createNodeSqliteDriver();
    const db = driver.open(options.file);
    const store = new StudyStore(db, driver.name);
    store.migrate();
    return store;
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
    stem: string;
    answer: string;
    solution: string;
    knowledgeIds: string[];
    requestedOrigin: QuestionOrigin;
    originRecord: OriginRecord | null;
    recordScope?: RecordScope;
  }): { question: QuestionRow; forgedExamClaim: boolean; downgraded: boolean } {
    const scope = input.recordScope ?? 'formal';
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

    const decision = decideAttempt(
      {
        questionId: input.questionId,
        actorType: input.actorType,
        kind: input.kind,
        answerText: input.answerText,
        processText: input.processText,
      },
      question.answer,
    );

    const attemptId = newId<'attempt'>('att');
    const now = new Date().toISOString();

    const attempt = this.db.transaction(() => {
      const inserted = this.attempts.insertAttempt({
        attemptId,
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
   * 冻结当前事实集合。
   *
   * 知识点用摘要表示：任何一条的新增、审核或失效都会改变它；模型配置尚未接入时
   * `modelProfileId` 保持 null，不用假身份填充分母。
   */
  private freezeRunVersions(projectId: string, planVersion: number): FrozenVersionsDto {
    const points = this.knowledge
      .listKnowledge('formal')
      .map((point) => `${point.knowledgeId}:${point.revision}:${point.sourceStatus}`)
      .sort();
    const teaching = this.preferences.readTeachingPreference<Record<string, unknown>>(projectId);
    return {
      knowledgeTableDigest: createHash('sha256').update(points.join('|'), 'utf8').digest('hex'),
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

  listLessons(projectId: string): LessonVersionRow[] {
    return this.lessons.listLessons(projectId);
  }

  listLessonVersions(lessonId: string, projectId: string): LessonVersionRow[] {
    return this.lessons.listVersions(lessonId, projectId);
  }

  getLessonClassroomLink(lessonId: string, projectId: string): ClassroomLinkRow | null {
    return this.lessons.getLink(lessonId, projectId);
  }

  /** 发布课程：陈述与题目引用的知识点必须仍在准入范围内。 */
  publishLesson(input: PublishLessonInput): LessonVersionRow {
    const lesson = this.lessons.getVersion(input.lessonId, input.version, input.projectId);
    if (!lesson) throw new StudyError('NOT_FOUND', { lessonId: input.lessonId, version: input.version });
    const bundle = this.lessons.getBundle(lesson.bundleId, input.projectId);
    if (!bundle) throw new StudyError('INTERNAL', { bundleId: lesson.bundleId });

    const statementKnowledgeOf = (statementId: string): string | null =>
      bundle.bundle.statements.find((statement) => statement.statementId === statementId)?.knowledgeId ?? null;
    const questionKnowledgeOf = (questionId: string): string[] =>
      bundle.bundle.questions.find((question) => question.questionId === questionId)?.knowledgeIds ?? [];
    const referenced = [
      ...new Set([
        ...lesson.statementIds.flatMap((id) => [statementKnowledgeOf(id)]).filter((id): id is string => id !== null),
        ...lesson.questionIds.flatMap((id) => questionKnowledgeOf(id)),
      ]),
    ];
    const admitted = new Set(this.checkAdmission(referenced, 'formal').admitted);
    return this.lessons.publish(input, { admittedKnowledgeIds: admitted, statementKnowledgeOf, questionKnowledgeOf });
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
