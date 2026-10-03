/**
 * 领域 HTTP 合同（`/api/study/*`）。
 *
 * 入参统一按对象与 schema 校验，响应带结果或错误码。
 * 渲染层只持项目 ID 与绑定标识，不能向 HTTP API 提交任意磁盘路径。
 */

import { z } from 'zod';
import {
  ACTOR_TYPE,
  ATTEMPT_KIND,
  EVIDENCE_USE,
  MASTERY_STATUS,
  QUESTION_ORIGIN,
  RECORD_SCOPE,
  REVIEW_DECISION,
  REVIEW_PROVENANCE,
  SCOPE_STATUS,
  SOURCE_STATUS,
} from './status';
import { SUPPORTED_MATERIAL_TYPES } from './fingerprint';

/** 所有领域请求都携带项目身份；服务端据此校验打开代次。 */
export const projectScopeSchema = z.object({
  projectId: z.string().min(1),
  generation: z.number().int().nonnegative(),
});
export type ProjectScope = z.infer<typeof projectScopeSchema>;

/** 项目设置写入：始终与打开项目代次绑定，并至少包含一个设置字段。 */
export const projectSettingsPatchSchema = z
  .object({
    scope: projectScopeSchema,
    displayName: z.string().min(1).max(120).optional(),
    subject: z.string().max(60).optional(),
    goal: z.string().max(500).optional(),
    examDate: z.string().max(20).nullable().optional(),
    dailyMinutes: z.number().int().min(0).max(720).optional(),
    learningMode: z.enum(['beginner', 'review']).optional(),
  })
  .refine(
    (value) => Object.entries(value).some(([key, entry]) => key !== 'scope' && entry !== undefined),
    { message: '至少需要提供一个项目设置字段' },
  );
export type ProjectSettingsPatchInput = z.infer<typeof projectSettingsPatchSchema>;

// —— 材料 ——

/**
 * 导入材料。
 *
 * 导入模式用 `mode` 判别联合表达，而不是靠界面文案推断：
 * - `mode: 'file'`：`sourcePath` 必须是主进程已授权的原生选择结果；服务端不接受
 *   来自课堂 iframe 的磁盘路径，也不接受渲染层自报的任意路径。
 * - `mode: 'text'`：直接给出正文，供开发/演示与粘贴导入使用，仍走同一套规范化与指纹。
 */
const materialImportBase = {
  scope: projectScopeSchema,
  displayName: z.string().min(1).max(200),
  type: z.enum(SUPPORTED_MATERIAL_TYPES),
  /** 材料在考纲/教材中的可读位置，例如「人教版必修一 3.2」。 */
  readableLocation: z.string().max(200).optional(),
};

export const materialImportFileSchema = z.object({
  ...materialImportBase,
  mode: z.literal('file'),
  sourcePath: z.string().min(1),
});
export type MaterialImportFileInput = z.infer<typeof materialImportFileSchema>;

export const materialImportTextSchema = z.object({
  ...materialImportBase,
  mode: z.literal('text'),
  rawText: z.string().min(1),
});
export type MaterialImportTextInput = z.infer<typeof materialImportTextSchema>;

export const materialImportSchema = z.discriminatedUnion('mode', [
  materialImportFileSchema,
  materialImportTextSchema,
]);
export type MaterialImportInput = z.infer<typeof materialImportSchema>;

export const materialSchema = z.object({
  materialId: z.string(),
  displayName: z.string(),
  type: z.enum(SUPPORTED_MATERIAL_TYPES),
  revision: z.number().int().positive(),
  recordScope: z.enum(RECORD_SCOPE),
  readableLocation: z.string().nullable(),
  importedAt: z.string(),
  segmentCount: z.number().int().nonnegative(),
  normalizationVersion: z.string(),
  fingerprint: z.string(),
  /** 引用该材料的已核实知识点数量，用于删除前引用检查。 */
  referencedByKnowledge: z.number().int().nonnegative(),
});
export type MaterialDto = z.infer<typeof materialSchema>;

export const segmentSchema = z.object({
  segmentId: z.string(),
  ordinal: z.number().int().positive(),
  text: z.string(),
  fingerprint: z.string(),
});
export type SegmentDto = z.infer<typeof segmentSchema>;

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

// —— 生成准入 ——

export const admissionCheckSchema = z.object({
  scope: projectScopeSchema,
  knowledgeIds: z.array(z.string()).min(1),
});
export type AdmissionCheckInput = z.infer<typeof admissionCheckSchema>;

export const admissionResultSchema = z.object({
  allowed: z.boolean(),
  /** 允许进入生成的知识点（已核实、未失效、范围合规、前置满足）。 */
  admitted: z.array(z.string()),
  blocked: z.array(
    z.object({
      knowledgeId: z.string(),
      code: z.string(),
      message: z.string(),
      /** 缺什么材料，界面据此显示补材料入口。 */
      missing: z.array(z.string()),
    }),
  ),
});
export type AdmissionResultDto = z.infer<typeof admissionResultSchema>;

// —— 题目身份 ——

export const questionCreateSchema = z.object({
  scope: projectScopeSchema,
  stem: z.string().min(2),
  answer: z.string().default(''),
  solution: z.string().default(''),
  knowledgeIds: z.array(z.string()).min(1),
  /** 请求方声明的身份只是请求；服务端按可信记录裁定。 */
  requestedOrigin: z.enum(QUESTION_ORIGIN),
  /**
   * 原题/改写必须提供可信出处记录。
   *
   * 注意：这里**不含** `materialVerifiedAsExam` 之类可由请求自报的字段。
   * 「材料已被人工核实为考试真题」属于服务端权威事实，只能由授权审核操作写入，
   * 再由服务端按 `(materialId, revision)` 派生，请求方无法自我授予真题身份。
   */
  originRecord: z
    .object({
      materialId: z.string(),
      revision: z.number().int().positive(),
      questionNumber: z.string().max(60).default(''),
      /** 改写题必须绑定原题并记录修改内容。 */
      rewrittenFrom: z.string().nullable().default(null),
      rewriteNote: z.string().max(500).default(''),
    })
    .nullable()
    .default(null),
});
export type QuestionCreateInput = z.infer<typeof questionCreateSchema>;

/**
 * 题目列表项：按使用场景最小化字段，**不含**标准答案与解析。
 * 未授权的列表响应与客户端缓存都不应出现答案。
 */
export const questionListItemSchema = z.object({
  questionId: z.string(),
  stem: z.string(),
  knowledgeIds: z.array(z.string()),
  /** 服务端裁定后的身份。 */
  origin: z.enum(QUESTION_ORIGIN),
  /** 面向学习者展示的出处文字，由模板统一渲染。 */
  originLabel: z.string(),
  originDetail: z.string().nullable(),
  recordScope: z.enum(RECORD_SCOPE),
  revision: z.number().int().positive(),
});
export type QuestionListItemDto = z.infer<typeof questionListItemSchema>;

/**
 * 题目详情：仅在授权判分路径或明确需要的详情流程中返回标准答案与解析。
 * 列表、缓存与课堂默认视图不得使用该 DTO。
 */
export const questionSchema = questionListItemSchema.extend({
  answer: z.string(),
  solution: z.string(),
});
export type QuestionDto = z.infer<typeof questionSchema>;

/** 需要答案的入口必须显式声明；服务端据此决定是否返回 `questionSchema`。 */
export const questionDetailQuerySchema = z.object({
  // 注意：不能用 z.coerce.boolean()——它对任意非空字符串都返回 true，
  // 会让 `?includeAnswer=false` 意外泄露答案。这里只接受字面量 'true'。
  includeAnswer: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});
export type QuestionDetailQuery = z.infer<typeof questionDetailQuerySchema>;

// —— 课堂 ——

/**
 * 场景来源绑定：渲染层据此显示「来源可定位」并把测验提交绑到真实题目身份。
 * 题目 ID 由服务端派生，请求方不能自带一个来路不明的 questionId。
 */
export const classroomSceneBindingSchema = z.object({
  sceneId: z.string().min(1),
  sceneType: z.enum(['slide', 'quiz', 'interactive', 'pbl']),
  knowledgeIds: z.array(z.string().min(1)).min(1),
  questionId: z.string().min(1).nullable(),
  reviewedBy: z.string().min(1),
  reviewNote: z.string(),
});
export type ClassroomSceneBinding = z.infer<typeof classroomSceneBindingSchema>;

// —— 作答 ——

export const attemptSubmitSchema = z.object({
  scope: projectScopeSchema,
  questionId: z.string().min(1),
  /** 客户端生成的幂等键：重复请求读取既有收据，不重复写入。 */
  idempotencyKey: z.string().min(8),
  actorType: z.enum(ACTOR_TYPE),
  answerText: z.string().default(''),
  /** 解题过程；缺失时通常无法确定具体错因。 */
  processText: z.string().default(''),
  kind: z.enum(ATTEMPT_KIND).default('real'),
});
export type AttemptSubmitInput = z.infer<typeof attemptSubmitSchema>;

export const attemptSchema = z.object({
  recordScope: z.enum(RECORD_SCOPE),
  attemptId: z.string(),
  questionId: z.string(),
  kind: z.enum(ATTEMPT_KIND),
  actorType: z.enum(ACTOR_TYPE),
  answerText: z.string(),
  processText: z.string(),
  submittedAt: z.string(),
  deduplicated: z.boolean(),
  /** 真实作答才可能更新掌握状态；模拟作答始终为 null。 */
  masteryAfter: z.enum(MASTERY_STATUS).nullable(),
  /** 缺少过程时允许待确认。 */
  attributionStatus: z.enum(['pending_process', 'proposed']),
});
export type AttemptDto = z.infer<typeof attemptSchema>;

// —— 工作台总览 ——

export const workbenchStateSchema = z.object({
  project: z.object({
    projectId: z.string(),
    displayName: z.string(),
    displayPath: z.string(),
    generation: z.number().int().nonnegative(),
    subject: z.string(),
    goal: z.string(),
    examDate: z.string().nullable(),
    dailyMinutes: z.number().int().nonnegative(),
    learningMode: z.enum(['beginner', 'review']),
  }),
  counts: z.object({
    materials: z.number().int().nonnegative(),
    knowledgeVerified: z.number().int().nonnegative(),
    knowledgePending: z.number().int().nonnegative(),
    knowledgeInvalidated: z.number().int().nonnegative(),
    /** 候选计数不算知识覆盖数。 */
    proposalsPending: z.number().int().nonnegative(),
    questions: z.number().int().nonnegative(),
    attemptsReal: z.number().int().nonnegative(),
    attemptsSimulation: z.number().int().nonnegative(),
  }),
  plan: z.object({
    confirmedVersion: z.number().int().nullable(),
    taskCount: z.number().int().nonnegative(),
  }),
  /** 演示与验收用的准入摘要，不参与学习统计。 */
  admission: z.object({
    readyKnowledge: z.number().int().nonnegative(),
    blockedBySource: z.number().int().nonnegative(),
  }),
});
export type WorkbenchStateDto = z.infer<typeof workbenchStateSchema>;

export const preferencesSchema = z.object({
  version: z.number().int().positive().default(1),
  theme: z.enum(['paper', 'light', 'dark', 'system']),
  accentPreset: z.enum(['cinnabar', 'teal', 'indigo']),
  uiFont: z.literal('system-sans'),
  readingFont: z.enum(['system-sans', 'system-serif']),
  readingFontSizePx: z.number().int().min(16).max(24),
  readingLineHeight: z.number().min(1.5).max(2),
  readingMaxWidthPx: z.number().int().min(640).max(920),
  zoom: z.number().min(0.8).max(1.5),
  density: z.enum(['standard', 'compact']),
  reduceMotion: z.enum(['system', 'on', 'off']),
  panelTreeWidth: z.number().int().min(180).max(360),
  panelRightWidth: z.number().int().min(260).max(440),
  bottomPanelHeight: z.number().int().min(28).max(400),
});
export type PreferencesDto = z.infer<typeof preferencesSchema>;

export const teachingPreferenceSchema = z.object({
  version: z.number().int().positive().default(1),
  learningMode: z.enum(['beginner', 'review']),
  explanation: z.enum(['intuitive', 'rigorous', 'concise']),
  hintDepth: z.enum(['light', 'stepwise', 'full']),
  exerciseBalance: z.enum(['explanation-first', 'balanced', 'practice-first']),
  selfExplanation: z.boolean(),
  everydayExamples: z.enum(['moderate', 'minimal']),
  extraPreference: z.string().max(500),
});
export type TeachingPreferenceDto = z.infer<typeof teachingPreferenceSchema>;

/**
 * 偏好写入请求（共享 schema）。
 *
 * - 外观/阅读是**用户级全局**偏好，不需要 scope；
 * - 教学表达是**项目级**事实，写入必须显式携带 scope，由服务复验打开代次，
 *   避免过期请求写进重新打开的项目。
 */
export const preferencesWriteSchema = z
  .object({
    scope: projectScopeSchema.optional(),
    appearance: preferencesSchema.optional(),
    teaching: teachingPreferenceSchema.optional(),
  })
  .refine((value) => value.appearance !== undefined || value.teaching !== undefined, {
    message: '至少需要提供 appearance 或 teaching 之一',
  })
  .refine((value) => value.teaching === undefined || value.scope !== undefined, {
    message: '教学表达属于项目，写入必须携带 scope',
  });
export type PreferencesWriteInput = z.infer<typeof preferencesWriteSchema>;

// —— 权威事实：材料是否为「考试真题」来源 ——
/**
 * 人工核实「该材料版本可作为考试真题来源」。这是服务端权威事实，
 * 只通过授权审核操作写入；题目身份据此派生，请求方不能自报。
 */
export const materialExamVerificationSchema = z.object({
  scope: projectScopeSchema,
  materialId: z.string().min(1),
  revision: z.number().int().positive(),
  note: z.string().max(500).default(''),
});
export type MaterialExamVerificationInput = z.infer<typeof materialExamVerificationSchema>;

// —— 最近项目（原生 IPC 独立 DTO）——

/**
 * 最近项目列表项。与「已打开项目」是不同对象：最近项目可能不存在磁盘目录、
 * 也没有打开代次，因此单独定义 DTO，不复用 OpenedProjectPayload 的语义。
 */
export const recentProjectSchema = z.object({
  displayPath: z.string(),
  displayName: z.string(),
  /** 上次打开时间（ISO 字符串），仅用于排序展示。 */
  lastOpenedAt: z.string(),
});
export type RecentProjectDto = z.infer<typeof recentProjectSchema>;

// —— 统一响应边界 ——

/** 所有领域 HTTP 响应共享同一信封：成功带 data，失败带 error。 */
export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    pending: boolean;
    details?: Record<string, unknown>;
  };
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;
