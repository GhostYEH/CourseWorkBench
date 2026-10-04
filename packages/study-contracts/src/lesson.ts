/**
 * 课程证据包与课程版本（《规划书》5.4 / 7，LESSON-01）。
 *
 * 证据包是「一节课允许说什么」的冻结集合：项目与科目范围、计划与知识版本、
 * 材料与段落版本及摘要、允许的陈述与条件、题目与答案版本、审核结论、教学与角色版本。
 * 它只提供必要原文与准入内容，不含模型密钥、任意磁盘路径或整个项目文件。
 */

import { z } from 'zod';
import { RECORD_SCOPE, REVIEW_PROVENANCE } from './status';
import { GENERATED_ID_PATTERN } from './ids';
import { evidenceRefSchema, projectScopeSchema } from './api';

/** 证据包结构版本。 */
export const EVIDENCE_BUNDLE_VERSION = 1;

/** 课程版本状态：草案可改，已发布固定，被新版本取代后标记 superseded。 */
export const LESSON_STATUS = ['draft', 'published', 'superseded'] as const;
export type LessonStatus = (typeof LESSON_STATUS)[number];

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
