import { z } from 'zod';
import { EVIDENCE_USE } from '../status';
import { MASTERY_STATUS } from '../status';
import { RECORD_SCOPE } from '../status';
import { REVIEW_DECISION } from '../status';
import { REVIEW_PROVENANCE } from '../status';
import { SCOPE_STATUS } from '../status';
import { SOURCE_STATUS } from '../status';
import { projectScopeSchema } from './project';
import { syllabusMappingSchema } from './syllabus';

// —— 知识点候选与证据 ——

export const evidenceRefSchema = z.object({
  materialId: z.string().min(1),
  revision: z.number().int().positive(),
  segmentId: z.string().min(1),
  use: z.enum(EVIDENCE_USE),
});
export type EvidenceRefInput = z.infer<typeof evidenceRefSchema>;

export const knowledgeProposeSchema = z.object({
  scope: projectScopeSchema,
  name: z.string().min(2).max(120),
  concept: z.string().min(2).max(2000),
  conditions: z.string().max(2000).default(''),
  scopeStatus: z.enum(SCOPE_STATUS),
  prerequisites: z.array(z.string()).default([]),
  evidence: z.array(evidenceRefSchema).min(0),
  acceptance: z.string().max(500).default(''),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
  /** AI 只能提交候选；该字段由调用方声明来源，不改变权威写入权限。 */
  proposedBy: z.enum(['ai', 'user']).default('ai'),
});
export type KnowledgeProposeInput = z.infer<typeof knowledgeProposeSchema>;

/** 机械检查结果：只说明引用可定位，不说明语义支持。 */
export const mechanicalCheckSchema = z.object({
  passed: z.boolean(),
  checks: z.array(
    z.object({
      code: z.string(),
      ok: z.boolean(),
      detail: z.string(),
    }),
  ),
});
export type MechanicalCheckDto = z.infer<typeof mechanicalCheckSchema>;

export const proposalSchema = z.object({
  proposalId: z.string(),
  name: z.string(),
  concept: z.string(),
  conditions: z.string(),
  scopeStatus: z.enum(SCOPE_STATUS),
  recordScope: z.enum(RECORD_SCOPE),
  prerequisites: z.array(z.string()),
  evidence: z.array(evidenceRefSchema.extend({ fingerprint: z.string(), excerpt: z.string() })),
  acceptance: z.string(),
  priority: z.enum(['high', 'medium', 'low']),
  proposedBy: z.enum(['ai', 'user']),
  status: z.enum(['pending', 'approved', 'rejected', 'needs_material']),
  mechanical: mechanicalCheckSchema,
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
  reviewNote: z.string().nullable(),
  reviewProvenance: z.enum(REVIEW_PROVENANCE).nullable(),
  /** 乐观并发版本：审核提交必须基于该版本，过期提交失败。 */
  revision: z.number().int().nonnegative(),
});
export type ProposalDto = z.infer<typeof proposalSchema>;

export const reviewApplySchema = z.object({
  scope: projectScopeSchema,
  proposalId: z.string().min(1),
  decision: z.enum(REVIEW_DECISION),
  /** 乐观并发：审核基于该版本，过期提交失败。 */
  expectedRevision: z.number().int().nonnegative(),
  note: z.string().max(1000).default(''),
  /** 审核者必须已读过原文并作出语义判断；机械通过不等于语义通过。 */
  semanticReviewed: z.boolean(),
  /** 人工审核时确定的考纲条目映射；只有「考纲内」候选可以携带。 */
  syllabus: syllabusMappingSchema.nullable().default(null),
});
export type ReviewApplyInput = z.infer<typeof reviewApplySchema>;

export const knowledgePointSchema = z.object({
  knowledgeId: z.string(),
  name: z.string(),
  concept: z.string(),
  conditions: z.string(),
  sourceStatus: z.enum(SOURCE_STATUS),
  recordScope: z.enum(RECORD_SCOPE),
  reviewProvenance: z.enum(REVIEW_PROVENANCE).nullable(),
  scopeStatus: z.enum(SCOPE_STATUS),
  masteryStatus: z.enum(MASTERY_STATUS),
  /** 考纲条目映射；未映射时为 null，覆盖统计把它当缺口而不是已完成。 */
  syllabusItemId: z.string().nullable(),
  syllabusRequirementKey: z.string().nullable(),
  prerequisites: z.array(z.string()),
  evidence: z.array(
    z.object({
      materialId: z.string(),
      revision: z.number().int().positive(),
      segmentId: z.string(),
      use: z.enum(EVIDENCE_USE),
      readableLocation: z.string().nullable(),
      fingerprint: z.string(),
      excerpt: z.string(),
    }),
  ),
  acceptance: z.string(),
  priority: z.enum(['high', 'medium', 'low']),
  revision: z.number().int().nonnegative(),
});
export type KnowledgePointDto = z.infer<typeof knowledgePointSchema>;
