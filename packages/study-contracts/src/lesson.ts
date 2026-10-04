/**
 * 课程证据包与课程版本（《规划书》5.4 / 7，LESSON-01）。
 *
 * 证据包是「一节课允许说什么」的冻结集合：项目与科目范围、计划与知识版本、
 * 材料与段落版本及摘要、允许的陈述与条件、题目与答案版本、审核结论、教学与角色版本。
 * 它只提供必要原文与准入内容，不含模型密钥、任意磁盘路径或整个项目文件。
 */

import { z } from 'zod';
import { questionAssessmentSchema } from './assessment';
import { RECORD_SCOPE, REVIEW_PROVENANCE } from './status';
import { GENERATED_ID_PATTERN } from './ids';
import { evidenceRefSchema, projectScopeSchema } from './api';

/** 证据包结构版本。 */
export const EVIDENCE_BUNDLE_VERSION = 1;

/**
 * 课程版本状态。草案可改，已发布固定，被新版本取代记 superseded，
 * 主动停用记 withdrawn —— 撤回与被取代含义不同，不能混用同一个状态。
 */
export const LESSON_STATUS = ['draft', 'published', 'superseded', 'withdrawn'] as const;
export type LessonStatus = (typeof LESSON_STATUS)[number];

/** 课程版本的人工审核结论。只有 approved 才允许发布与上课。 */
export const LESSON_REVIEW_DECISION = ['approved', 'rejected'] as const;
export type LessonReviewDecision = (typeof LESSON_REVIEW_DECISION)[number];

/** 一条学科陈述：必须绑定知识点与至少一条可定位原文。 */
export const bundleStatementSchema = z
  .object({
    statementId: z.string().regex(GENERATED_ID_PATTERN),
    knowledgeId: z.string().min(1),
    text: z.string().min(2).max(2000),
    conditions: z.string().max(2000),
    evidence: z.array(evidenceRefSchema).min(1),
  })
  .strict();
export type BundleStatementDto = z.infer<typeof bundleStatementSchema>;

export const bundleQuestionSchema = z
  .object({
    questionId: z.string().min(1),
    snapshot: z.object({ stem: z.string(), answer: z.string(), solution: z.string(), assessment: questionAssessmentSchema.nullable() }).strict().optional(),
    /** 题目与答案版本一起冻结，旧课不会跟着新题本悄悄改写。 */
    revision: z.number().int().positive(),
    origin: z.string().min(1),
    knowledgeIds: z.array(z.string()),
  })
  .strict();
export type BundleQuestionDto = z.infer<typeof bundleQuestionSchema>;

export const evidenceBundleSchema = z
  .object({
    bundleVersion: z.literal(EVIDENCE_BUNDLE_VERSION),
    projectId: z.string().min(1),
    subject: z.string().max(60),
    recordScope: z.enum(RECORD_SCOPE),
    planVersion: z.number().int().positive(),
    knowledgeVersions: z
      .array(z.object({ knowledgeId: z.string(), revision: z.number().int().nonnegative() }).strict())
      .min(1),
    materialRevisions: z.record(z.string(), z.number().int().positive()),
    segmentDigests: z
      .array(
        z
          .object({
            materialId: z.string(),
            revision: z.number().int().positive(),
            segmentId: z.string(),
            fingerprint: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    statements: z.array(bundleStatementSchema).min(1),
    questions: z.array(bundleQuestionSchema),
    reviewProvenance: z.enum(REVIEW_PROVENANCE),
    teachingPreferenceVersion: z.number().int().nonnegative(),
    roleConfigDigest: z.string().nullable(),
  })
  .strict();
export type EvidenceBundleDto = z.infer<typeof evidenceBundleSchema>;

export const evidenceBundleRowSchema = z
  .object({
    bundleId: z.string(),
    digest: z.string().min(1),
    frozenAt: z.string(),
    bundle: evidenceBundleSchema,
  })
  .strict();
export type EvidenceBundleViewDto = z.infer<typeof evidenceBundleRowSchema>;

export const lessonVersionSchema = z
  .object({
    lessonId: z.string(),
    version: z.number().int().positive(),
    title: z.string(),
    status: z.enum(LESSON_STATUS),
    bundleId: z.string(),
    bundleDigest: z.string(),
    statementIds: z.array(z.string()),
    questionIds: z.array(z.string()),
    /** stage 与文档摘要属于 classroom_links 侧表，不在版本行里重复一份。 */
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type LessonVersionDto = z.infer<typeof lessonVersionSchema>;

const statementIdsField = {
  statementIds: z.array(z.string().min(1)).min(1),
  questionIds: z.array(z.string().min(1)).default([]),
};

export const lessonDraftSchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('draft'),
    lessonId: z.string().regex(GENERATED_ID_PATTERN).nullable(),
    bundleId: z.string().min(1),
    title: z.string().min(2).max(120),
    ...statementIdsField,
  })
  .strict();
export type LessonDraftInput = z.infer<typeof lessonDraftSchema>;

export const lessonPublishSchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('publish'),
    lessonId: z.string().min(1),
    version: z.number().int().positive(),
  })
  .strict();
export type LessonPublishInput = z.infer<typeof lessonPublishSchema>;

/** 正式课件文档装配命令（LESSON-02）：只指定课程版本，文档内容由服务端从证据包生成。 */
export const lessonDocumentAssembleSchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('attach-document'),
    lessonId: z.string().min(1),
    version: z.number().int().positive(),
  })
  .strict();
export type LessonDocumentAssembleInput = z.infer<typeof lessonDocumentAssembleSchema>;

export const formalLessonSceneSchema = z
  .object({
    sceneId: z.string().min(1),
    sceneType: z.string().min(1),
    title: z.string(),
    knowledgeIds: z.array(z.string().min(1)).min(1),
    questionId: z.string().nullable(),
    /** 课堂侧栏要显示真实审核出处，不能由页面另编一句。 */
    reviewedBy: z.string().min(1),
    reviewNote: z.string(),
  })
  .strict();
export type FormalLessonSceneDto = z.infer<typeof formalLessonSceneSchema>;

export const formalLessonDocumentSchema = z
  .object({
    lessonId: z.string().min(1),
    lessonVersion: z.number().int().positive(),
    stageId: z.string().min(1),
    digest: z.string().min(1),
    dslVersion: z.string().min(1),
    sceneCount: z.number().int().nonnegative(),
    scenes: z.array(formalLessonSceneSchema),
    /** 未进入课件的陈述/题目与原因：缺口必须显示，不能静默省略。 */
    skipped: z.array(z.object({ kind: z.enum(['statement', 'question']), id: z.string(), reason: z.string() }).strict()),
    reused: z.boolean(),
    /** 课件是否已挂到该版本的课堂映射上；未挂接时课堂会给出明确指引而不是空白页。 */
    attached: z.boolean(),
  })
  .strict();
export type FormalLessonDocumentDto = z.infer<typeof formalLessonDocumentSchema>;


export const lessonReviewSchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('review'),
    lessonId: z.string().min(1),
    version: z.number().int().positive(),
    decision: z.enum(LESSON_REVIEW_DECISION),
    note: z.string().max(500),
  })
  .strict();
export type LessonReviewInput = z.infer<typeof lessonReviewSchema>;

export const lessonWithdrawSchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('withdraw'),
    lessonId: z.string().min(1),
    reason: z.string().max(500),
  })
  .strict();
export type LessonWithdrawInput = z.infer<typeof lessonWithdrawSchema>;

/**
 * 一次课程版本审核的权威记录。
 *
 * `admittedKnowledgeIds` / `blockedKnowledgeIds` 是审核当时的准入快照：审核结论只对
 * 该课程版本及其证据包摘要有效，来源更新后新版本必须重新审核。审核人身份由服务端写入，
 * 请求体里没有 reviewer 字段，客户端不能自报「已由谁审核」。
 */
export const lessonReviewRecordSchema = z
  .object({
    projectId: z.string().min(1),
    lessonId: z.string().min(1),
    version: z.number().int().positive(),
    decision: z.enum(LESSON_REVIEW_DECISION),
    note: z.string(),
    admittedKnowledgeIds: z.array(z.string()),
    blockedKnowledgeIds: z.array(z.string()),
    reviewedAt: z.string(),
  })
  .strict();
export type LessonReviewRecordDto = z.infer<typeof lessonReviewRecordSchema>;

export const lessonBundleBuildSchema = z
  .object({
    scope: projectScopeSchema,
    action: z.literal('build-bundle'),
    /** 每条陈述的文本与条件由审核人给定；来源取自知识点已批准的证据。 */
    statements: z
      .array(
        z
          .object({
            knowledgeId: z.string().min(1),
            text: z.string().min(2).max(2000),
            conditions: z.string().max(2000),
          })
          .strict(),
      )
      .min(1)
      .max(40),
    questionIds: z.array(z.string().min(1)).max(40),
  })
  .strict();
export type LessonBundleBuildInput = z.infer<typeof lessonBundleBuildSchema>;
