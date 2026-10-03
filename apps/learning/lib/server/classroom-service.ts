/**
 * 使用上游 DSL/renderer 的演示课堂服务适配（M0 前置）。
 *
 * 课件文本来自仓库内登记的演示材料，落库路径复用真实准入链：
 * 用户明确确认导入 → 导入材料 → 登记编者审核结论 → 出题 → 组装 DSL 文档 →
 * 写入 SQLite。任何一步不满足准入就不落库，课堂停在「待核实」而不是伪造内容。
 *
 * 渲染端拿到的是**去掉判分依据**的文档：判分只由服务依据题目权威记录完成。
 */

import { DSL_VERSION, validateScene, validateStage } from '@openmaic/dsl';
import { StudyError, type ClassroomSceneBinding } from '@sew/study-contracts';
import { assertSceneSourceBindings, classroomDocumentDigest, dslVersionState, normalizeMaterial, stripQuizAnswers, type SceneSourceBinding } from '@sew/study-domain';
import type { ClassroomDocumentRow, QuestionRow } from '@sew/study-storage';
import type { Session } from './service';
import { ensureReviewedDemoAssets } from './classroom-demo-assets';
import {
  FIXED_KNOWLEDGE,
  FIXED_LESSON_ID,
  FIXED_MATERIAL,
  FIXED_QUESTION,
  FIXED_REVIEW,
  REVIEWED_FIXED_LESSON,
  SCENE_QUIZ_ID,
} from '../classroom/reviewed-lesson';

export interface EnsuredLesson {
  stageId: string;
  lessonId: string;
  digest: string;
  sceneCount: number;
  bindings: ClassroomSceneBinding[];
}

const SCENE_TYPES = ['slide', 'quiz', 'interactive', 'pbl'] as const;
type SceneType = (typeof SCENE_TYPES)[number];

const sceneTypeOf = (scene: unknown): SceneType => {
  const value = scene && typeof scene === 'object' ? String((scene as { type?: unknown }).type ?? '') : '';
  if (!(SCENE_TYPES as readonly string[]).includes(value)) {
    throw new StudyError('INTERNAL', { reason: 'unknown_scene_type', type: value });
  }
  return value as SceneType;
};

const assertValidDocument = (document: { stage: unknown; scenes: unknown[] }): void => {
  const stageResult = validateStage(document.stage);
  if (!stageResult.valid) {
    throw new StudyError('INTERNAL', {
      reason: 'dsl_stage_invalid',
      errors: stageResult.errors,
    });
  }
  for (const scene of document.scenes) {
    const result = validateScene(scene);
    if (!result.valid) {
      throw new StudyError('INTERNAL', {
        reason: 'dsl_scene_invalid',
        sceneId: String((scene as { id?: unknown }).id ?? ''),
        errors: result.errors,
      });
    }
  }
};

/** 导入演示材料（幂等）：已登记则复用当前修订版本。 */
const ensureMaterial = (session: Session): { materialId: string; revision: number } => {
  const existing = session.store
    .listMaterials('demo')
    .find((material) => material.displayName === FIXED_MATERIAL.displayName);
  if (existing) {
    if (existing.fingerprint !== normalizeMaterial(FIXED_MATERIAL.rawText).fingerprint ||
        existing.readableLocation !== FIXED_MATERIAL.readableLocation || existing.materialType !== FIXED_MATERIAL.materialType) {
      throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'demo_material_identity_conflict' });
    }
    const revision = session.store.currentRevisions('demo')[existing.materialId] ?? existing.revision;
    return { materialId: existing.materialId, revision };
  }
  const { material, segments } = session.store.importMaterial({
    projectId: session.projectId,
    displayName: FIXED_MATERIAL.displayName,
    materialType: FIXED_MATERIAL.materialType,
    readableLocation: FIXED_MATERIAL.readableLocation,
    rawText: FIXED_MATERIAL.rawText,
    recordScope: 'demo',
  });
  if (segments.length === 0) {
    throw new StudyError('INTERNAL', { reason: 'material_without_segments' });
  }
  return { materialId: material.materialId, revision: material.revision };
};

const findSegmentByMarker = (
  session: Session,
  materialId: string,
  revision: number,
  marker: string,
  label: string,
): string => {
  const segment = session.store
    .getSegments(materialId, revision)
    .find((item) => item.text.includes(marker));
  if (!segment) {
    throw new StudyError('SOURCE_SEGMENT_NOT_FOUND', { materialId, revision, marker: label });
  }
  return segment.segmentId;
};

/** 走真实审核链写入权威知识点（幂等）。 */
const ensureKnowledge = (session: Session, materialId: string, revision: number): string => {
  const existing = session.store.listKnowledge('demo').find((point) => point.name === FIXED_KNOWLEDGE.name);
  const conceptSegmentId = findSegmentByMarker(
    session,
    materialId,
    revision,
    FIXED_KNOWLEDGE.conceptMarker,
    'concept',
  );
  const methodSegmentId = findSegmentByMarker(
    session,
    materialId,
    revision,
    FIXED_KNOWLEDGE.methodMarker,
    'method',
  );
  if (existing) {
    const expectedEvidence = [
      { segmentId: conceptSegmentId, use: 'concept_basis' },
      { segmentId: methodSegmentId, use: 'method_basis' },
    ];
    if (existing.concept !== FIXED_KNOWLEDGE.concept || existing.conditions !== FIXED_KNOWLEDGE.conditions ||
        existing.evidence.length !== expectedEvidence.length ||
        !expectedEvidence.every((expected) => existing.evidence.some((evidence) =>
          evidence.materialId === materialId && evidence.revision === revision &&
          evidence.segmentId === expected.segmentId && evidence.use === expected.use))) {
      throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'demo_knowledge_identity_conflict' });
    }
    return existing.knowledgeId;
  }

  const proposal = session.store.createProposal({
    projectId: session.projectId,
    name: FIXED_KNOWLEDGE.name,
    concept: FIXED_KNOWLEDGE.concept,
    conditions: FIXED_KNOWLEDGE.conditions,
    scopeStatus: 'in_syllabus',
    prerequisites: [],
    evidence: [
      { materialId, revision, segmentId: conceptSegmentId, use: 'concept_basis' },
      { materialId, revision, segmentId: methodSegmentId, use: 'method_basis' },
    ],
    acceptance: FIXED_KNOWLEDGE.acceptance,
    priority: FIXED_KNOWLEDGE.priority,
    proposedBy: 'user',
    recordScope: 'demo',
  });

  const outcome = session.store.applyDemoAuthorReview({
    proposalId: proposal.proposalId,
    decision: 'approved',
    expectedRevision: proposal.revision,
    // 该课件是仓库内登记、已由编者对照原文审核的演示材料。
    semanticReviewed: true,
    note: FIXED_REVIEW.reviewNote,
  });
  if (!outcome.knowledgePoint) {
    throw new StudyError('KNOWLEDGE_NOT_VERIFIED', {
      reason: 'review_did_not_write_authoritative_row',
      proposalId: proposal.proposalId,
    });
  }
  return outcome.knowledgePoint.knowledgeId;
};

/** 题目必须由已准入知识点支撑；请求方身份声明不生效。 */
const ensureQuestion = (session: Session, knowledgeId: string): string => {
  const existing = session.store.listQuestions('demo').find((question) => question.stem === FIXED_QUESTION.stem);
  if (existing) {
    if (existing.answer !== FIXED_QUESTION.answer || existing.solution !== FIXED_QUESTION.solution ||
        existing.knowledgeIds.length !== 1 || existing.knowledgeIds[0] !== knowledgeId || existing.origin !== 'ai_new') {
      throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'demo_question_identity_conflict' });
    }
    return existing.questionId;
  }
  const created = session.store.createQuestion({
    stem: FIXED_QUESTION.stem,
    answer: FIXED_QUESTION.answer,
    solution: FIXED_QUESTION.solution,
    knowledgeIds: [knowledgeId],
    requestedOrigin: 'ai_new',
    originRecord: null,
    recordScope: 'demo',
  });
  return created.question.questionId;
};

/**
 * 显式初始化演示课件，返回场景绑定。只允许由用户确认的初始化命令调用，
 * 页面访问、文档读取与文档保存不得隐式触发本函数。
 * 重复调用幂等：文档指纹一致时不重写。
 */
export const ensureFixedLesson = (session: Session): EnsuredLesson => {
  return session.store.transaction(() => {
  const material = ensureMaterial(session);
  const knowledgeId = ensureKnowledge(session, material.materialId, material.revision);

  const admission = session.store.checkAdmission([knowledgeId], 'demo');
  if (!admission.allowed) {
    const first = admission.blocked[0];
    throw new StudyError('KNOWLEDGE_NOT_VERIFIED', {
      knowledgeId: first?.knowledgeId,
      code: first?.code,
      missing: first?.missing,
    });
  }

  const questionId = ensureQuestion(session, knowledgeId);

  const document = REVIEWED_FIXED_LESSON.document;
  // Persist the checked-in image and font only from this explicit confirmation path.
  ensureReviewedDemoAssets(session, document.stage.id);
  assertValidDocument(document);
  const versionState = dslVersionState(document.dslVersion, DSL_VERSION);
  if (versionState === 'future') {
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'dsl_version_future',
      declared: document.dslVersion,
      supported: DSL_VERSION,
    });
  }

  const bindings: ClassroomSceneBinding[] = document.scenes.map((scene) => ({
    sceneId: scene.id,
    sceneType: sceneTypeOf(scene),
    knowledgeIds: [knowledgeId],
    questionId: scene.id === SCENE_QUIZ_ID ? questionId : null,
    reviewedBy: FIXED_REVIEW.reviewedBy,
    reviewNote: FIXED_REVIEW.reviewNote,
  }));

  const bindingMap = new Map<string, SceneSourceBinding>(
    bindings.map((binding) => [
      binding.sceneId,
      {
        sceneId: binding.sceneId,
        knowledgeIds: binding.knowledgeIds,
        questionId: binding.questionId,
        reviewedBy: binding.reviewedBy,
        reviewNote: binding.reviewNote,
      },
    ]),
  );
  assertSceneSourceBindings(
    document.scenes.map((scene) => scene.id),
    bindingMap,
  );

  const digest = classroomDocumentDigest(document);
  const stored = session.store.getClassroomDocument(session.projectId, document.stage.id);
  if (!stored || stored.digest !== digest) {
    session.store.saveClassroomDocument({
      recordScope: 'demo',
      projectId: session.projectId,
      stageId: document.stage.id,
      lessonId: FIXED_LESSON_ID,
      dslVersion: document.dslVersion ?? '',
      document,
      digest,
      sceneCount: document.scenes.length,
      scenes: bindings.map((binding) => ({
        sceneId: binding.sceneId,
        knowledgeIds: binding.knowledgeIds,
        questionId: binding.questionId,
      })),
      reviewedBy: FIXED_REVIEW.reviewedBy,
      reviewNote: FIXED_REVIEW.reviewNote,
    });
  }

  return {
    stageId: document.stage.id,
    lessonId: FIXED_LESSON_ID,
    digest,
    sceneCount: document.scenes.length,
    bindings,
  };
  });
};

export interface RenderableDocument {
  document: unknown;
  digest: string;
  stageId: string;
  lessonId: string;
  sceneCount: number;
}

/**
 * 读取用于渲染的文档：先去掉测验判分依据，再按真实 DSL 校验器复验一次，
 * 保证交给渲染端的仍是一份合法文档。
 */
export const loadRenderableDocument = (
  session: Session,
  stageId: string,
): RenderableDocument | null => {
  const stored: ClassroomDocumentRow | null = session.store.getClassroomDocument(
    session.projectId,
    stageId,
  );
  if (!stored) return null;
  if (stored.recordScope !== 'demo') {
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { stageId, reason: 'demo_scope_mismatch' });
  }
  if (stored.digest !== REVIEWED_DOCUMENT_DIGEST ||
      classroomDocumentDigest(stored.document) !== REVIEWED_DOCUMENT_DIGEST) {
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', {
      stageId,
      reason: 'stored_digest_mismatch',
      stored: stored.digest,
    });
  }
  const sourceBindings = session.store.listClassroomSceneSources(session.projectId, stageId);
  assertSceneSourceBindings(reviewedLesson.sceneIds, sourceBindings);
  if ([...sourceBindings.values()].some((binding) => binding.recordScope !== stored.recordScope)) {
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { stageId, reason: 'scene_record_scope_mismatch' });
  }
  for (const scene of reviewedLesson.document.scenes) {
    const binding = sourceBindings.get(scene.id)!;
    if (scene.type !== 'quiz') {
      if (binding.questionId !== null) {
        throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'unexpected_scene_question', sceneId: scene.id });
      }
      continue;
    }
    const question: QuestionRow | null = binding.questionId
      ? session.store.getQuestion(binding.questionId, stored.recordScope)
      : null;
    if (!question || question.stem !== FIXED_QUESTION.stem || question.answer !== FIXED_QUESTION.answer ||
        question.solution !== FIXED_QUESTION.solution || question.origin !== 'ai_new' || question.recordScope !== stored.recordScope ||
        question.knowledgeIds.length !== binding.knowledgeIds.length ||
        !question.knowledgeIds.every((id: string) => binding.knowledgeIds.includes(id))) {
      throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'quiz_question_binding_mismatch', sceneId: scene.id });
    }
  }
  const knowledgeIds = [...new Set([...sourceBindings.values()].flatMap((binding) => binding.knowledgeIds))];
  const admission = session.store.checkAdmission(knowledgeIds, 'demo');
  if (!admission.allowed) {
    throw new StudyError('KNOWLEDGE_NOT_VERIFIED', {
      stageId,
      blocked: admission.blocked,
    });
  }
  const stripped = stripQuizAnswers(stored.document);
  const scenes = (stripped.document as { scenes?: unknown[] }).scenes ?? [];
  for (const scene of scenes) {
    const result = validateScene(scene);
    if (!result.valid) {
      throw new StudyError('INTERNAL', {
        reason: 'stripped_scene_invalid',
        sceneId: String((scene as { id?: unknown }).id ?? ''),
        errors: result.errors,
      });
    }
  }
  return {
    document: stripped.document,
    digest: stored.digest,
    stageId: stored.stageId,
    lessonId: stored.lessonId,
    sceneCount: stored.sceneCount,
  };
};

/**
 * 登记审核课件的指纹。文档与单个场景的写入都必须与它（或对应场景的指纹）
 * 完全一致；读取时再复验一次，避免任何路径写入过偏离内容后仍被当作审核课件下发。
 */
export const REVIEWED_DOCUMENT_DIGEST = classroomDocumentDigest(REVIEWED_FIXED_LESSON.document);

const reviewedSceneOf = (sceneId: string): unknown | undefined =>
  REVIEWED_FIXED_LESSON.document.scenes.find((scene) => scene.id === sceneId);

/** 单个场景的登记指纹：场景级写入按它校验，并用于刷新文档 digest。 */
export const reviewedSceneDigest = (sceneId: string): string | null => {
  const scene = reviewedSceneOf(sceneId);
  return scene === undefined ? null : classroomDocumentDigest(scene);
};

export const assertReviewedDocumentWrite = (document: unknown): string => {
  const digest = classroomDocumentDigest(document);
  if (digest !== REVIEWED_DOCUMENT_DIGEST) {
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', {
      digest,
      expectedStageId: REVIEWED_FIXED_LESSON.stageId,
    });
  }
  return digest;
};

export const reviewedLesson = REVIEWED_FIXED_LESSON;
