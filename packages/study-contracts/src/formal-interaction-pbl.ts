/**
 * PBL（项目制学习）互动族的合同（OMA-046 / OMA-047 / OMA-048 / OMA-049）。
 *
 * 形状照 `formal-interaction.ts`：冻结定义 + 公开投影 + 记录与收据 + 命令，
 * 判定全部是纯函数（在 `study-domain/src/formal-interaction-pbl.ts`），本文件不判对错。
 *
 * 四条不可让的语义都体现在字段上，不靠注释约束：
 * 1. **本人交付与 AI 贡献是两种记录**（OMA-047）：交付记录的 `actorType` 是
 *    `human_learner` 字面量，AI 贡献记录只能是 `teacher_ai` / `peer_ai`，且认领状态是
 *    单独字段、由单独的认领头绪改。所以「AI 替本人交付」在合同层就没有字段可填。
 * 2. **评价候选与确定性检查分开**（OMA-048）：`pblAssessmentCandidateSchema` 里没有任何
 *    能表达「通过 / 打分」的字段；确定性结论 `pblDeterministicOutcomeSchema` 只能由服务端
 *    构造，写入命令不接受它的实例。
 * 3. **公开投影去掉评分依据**（OMA-048）：`rubrics` 与里程碑上的 `rubricIds` 只留在服务端，
 *    下发界面/共享房间的是 `pblProjectPublicDefinitionSchema`。
 * 4. **模拟器的证据与正式记录同形不同分区**（OMA-049）：`pblRunEvidenceSchema` 是判定引擎
 *    唯一的输入，正式记录与演练动作都投影成它。演练动作落在 `recordScope: 'demo'`，
 *    永远不会变成 `pblRecordSchema`（那里只有 `'formal'`），因此演练写不进本人记录。
 *
 * 本文件不 import `./index`（会成环）。主智能体接入 barrel 时按现有写法追加导出即可。
 */

import { z } from 'zod';
import { projectScopeSchema } from './api';
import { learnerUidSchema } from './learner-profile';

const id = z.string().min(1).max(200);
const text = (max: number) => z.string().trim().min(1).max(max);
const base = { id, title: text(120), statementIds: z.array(id).min(1).max(24) };

/**
 * 项目角色类型（OMA-046「角色选择」）。
 *
 * `learner` 是承担交付的真人席位；`mentor` / `peer_ai` 是协作席位（AI 导师席 / AI 同学席），
 * 只能给建议与反馈，不能交付、不能宣布达成。权限位不写在定义里，由领域按 kind 派生——
 * 定义里放权限就等于允许模型或客户端自报权限。
 */
export const PBL_ROLE_KINDS = ['learner', 'mentor', 'peer_ai'] as const;
export type PblRoleKind = (typeof PBL_ROLE_KINDS)[number];

/** 阶段任务状态（OMA-047）。`verified` 只由确定性检查达成，永不由自报达成。 */
export const PBL_TASK_STATUSES = [
  'available',
  'in_progress',
  'submitted',
  'needs_revision',
  'verified',
] as const;
export type PblTaskStatus = (typeof PBL_TASK_STATUSES)[number];

/**
 * 成员在任务更新里可以申报的状态。
 *
 * 少了 `available`（那是还没开任务的初始态）与 `verified`（达成由检查决定）。
 * 用它而不是全量枚举，是为了让「自报已通过」在 schema 层就填不进去。
 */
export const PBL_REPORTABLE_TASK_STATUSES = ['in_progress', 'submitted', 'needs_revision'] as const;
export type PblReportableTaskStatus = (typeof PBL_REPORTABLE_TASK_STATUSES)[number];

/**
 * 确定性检查种类（OMA-048「确定性检查」）。
 *
 * 判定式在领域层，条件来自冻结定义。客户端既不能声明结果，也不能声明自己属于哪一种检查。
 */
export const PBL_CHECK_KINDS = [
  'deliverable_submitted',
  'deliverable_contains',
  'deliverable_min_length',
  'contribution_acknowledged',
  'milestone_reached',
] as const;
export type PblCheckKind = (typeof PBL_CHECK_KINDS)[number];

/** 交付物形态：必须是真实产物，而不是「我做完了」的自述。 */
export const PBL_ARTIFACT_KINDS = [
  'report',
  'prototype',
  'dataset',
  'slides',
  'log',
  'other',
] as const;
export type PblArtifactKind = (typeof PBL_ARTIFACT_KINDS)[number];

/** 评价档位。档位固定三条，出具候选的一方不能自造一档「优秀」。 */
export const PBL_JUDGEMENT_LEVELS = ['exemplary', 'adequate', 'developing'] as const;
export type PblJudgementLevel = (typeof PBL_JUDGEMENT_LEVELS)[number];

/**
 * 可试走的动作（OMA-049「PBL 模拟器」）。
 *
 * 不含 `review`：冻结项目定义是人工审核动作，让模拟器能自演它就等于演练数据冒充了权威定义。
 */
export const PBL_SIMULATION_OPERATIONS = [
  'open',
  'update',
  'submit',
  'contribute',
  'acknowledge',
  'requestFeedback',
  'feedback',
  'assess',
  'acceptEvaluation',
] as const;
export type PblSimulationOperation = (typeof PBL_SIMULATION_OPERATIONS)[number];

const deterministicCheckBase = {
  id,
  /** 面向成员的一句话条件，属于公开投影：成员需要知道要满足什么。 */
  label: text(200),
  /** 判定条件的可读陈述，公开；它是任务要求，不是评分依据。 */
  expectation: text(500),
};

export const pblDeterministicCheckSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...deterministicCheckBase,
      kind: z.literal('deliverable_submitted'),
      /** 限定交付物形态；null 表示任一形态的本人交付都算。 */
      artifactKind: z.enum(PBL_ARTIFACT_KINDS).nullable(),
    })
    .strict(),
  z
    .object({
      ...deterministicCheckBase,
      kind: z.literal('deliverable_contains'),
      /** 交付物正文必须包含的全部片段（逐字比较，不做「差不多」匹配）。 */
      fragments: z.array(z.string().min(1).max(100)).min(1).max(8),
      artifactKind: z.enum(PBL_ARTIFACT_KINDS).nullable(),
    })
    .strict(),
  z
    .object({
      ...deterministicCheckBase,
      kind: z.literal('deliverable_min_length'),
      minChars: z.number().int().positive().max(100000),
      artifactKind: z.enum(PBL_ARTIFACT_KINDS).nullable(),
    })
    .strict(),
  z
    .object({
      ...deterministicCheckBase,
      kind: z.literal('contribution_acknowledged'),
      /** 需要本人显式认领（吸收/核实）的 AI 贡献条数下限。 */
      minAcknowledged: z.number().int().positive().max(50),
    })
    .strict(),
  z
    .object({
      ...deterministicCheckBase,
      kind: z.literal('milestone_reached'),
      /** 前序里程碑编号；必须指向序号更小的里程碑，否则冻结时判为环。 */
      milestoneId: id,
    })
    .strict(),
]);
export type PblDeterministicCheckDto = z.infer<typeof pblDeterministicCheckSchema>;

/**
 * 评分依据（rubric）。**不公开**：公开投影整段丢弃它，包括档位描述。
 *
 * 它描述「导师凭什么评价」；「成员要做什么」由检查的 `expectation` 与任务的 `outcome` 承担。
 * 两者分开发布，成员既知道要交付什么，又不会收到评分答案。
 */
export const pblRubricSchema = z
  .object({
    id,
    criterion: text(300),
    levels: z
      .array(z.object({ level: z.enum(PBL_JUDGEMENT_LEVELS), descriptor: text(500) }).strict())
      .min(3)
      .max(3),
  })
  .strict();
export type PblRubricDto = z.infer<typeof pblRubricSchema>;

export const pblProjectRoleSchema = z
  .object({
    id,
    name: text(80),
    kind: z.enum(PBL_ROLE_KINDS),
    /** 这个席位做什么。公开。 */
    responsibilities: z.array(text(300)).min(1).max(12),
    /**
     * 席位绑定的 UID。真人席位必须是成员 UID；协作席位的 UID 由服务端登记（AI 席未登记时
     * 为 null，此时 AI 动作被拒）。客户端不能自报 UID，因此这个字段是「服务端事实」。
     */
    memberUid: learnerUidSchema.nullable(),
  })
  .strict();
export type PblProjectRoleDto = z.infer<typeof pblProjectRoleSchema>;

export const pblProjectGoalSchema = z
  .object({
    id,
    statement: text(300),
    /** 目标达成时看得见什么结果（面向成员，公开）。 */
    successDescription: text(500),
  })
  .strict();
export type PblProjectGoalDto = z.infer<typeof pblProjectGoalSchema>;

export const pblPhaseTaskSchema = z
  .object({
    ...base,
    /** 所属阶段（如「调研」「设计」「制作」「复盘」）。 */
    phase: text(60),
    /** 本阶段要产出的结果，面向成员，公开。 */
    outcome: text(500),
    /** 本阶段接受哪些交付物形态。 */
    artifactKinds: z.array(z.enum(PBL_ARTIFACT_KINDS)).min(1).max(6),
    /** 允许承接本阶段任务的真人席位编号。 */
    roleIds: z.array(id).min(1).max(12),
    /** 本阶段任务的确定性检查（达成时全部通过才算 `verified`）。 */
    checks: z.array(pblDeterministicCheckSchema).max(12),
    /** 本阶段计入哪些里程碑（编号必须存在于定义中）。 */
    milestoneIds: z.array(id).min(1).max(12),
  })
  .strict();
export type PblPhaseTaskDto = z.infer<typeof pblPhaseTaskSchema>;

export const pblMilestoneSchema = z
  .object({
    ...base,
    /** 里程碑序号；`milestone_reached` 只能指向序号更小的里程碑。 */
    order: z.number().int().positive().max(12),
    /** 本里程碑的确定性检查（公开，判定在服务端）。 */
    checks: z.array(pblDeterministicCheckSchema).min(1).max(12),
    /** 本里程碑引用的评分依据编号（**私有**，公开投影丢弃）。 */
    rubricIds: z.array(id).max(12),
    /** 本里程碑覆盖的阶段任务（交付按任务归属计入里程碑检查）。 */
    taskIds: z.array(id).min(1).max(24),
  })
  .strict();
export type PblMilestoneDto = z.infer<typeof pblMilestoneSchema>;

export const pblProjectDefinitionSchema = z
  .object({
    ...base,
    /** 真实情境（OMA-046）：为谁解决什么真实问题、受什么真实约束。 */
    authenticContext: z
      .object({
        audience: text(200),
        problem: text(1000),
        constraints: z.array(text(300)).min(1).max(12),
      })
      .strict(),
    /** 项目背景叙事，面向成员，公开。 */
    background: text(2000),
    /** 项目目标（OMA-046）。 */
    goals: z.array(pblProjectGoalSchema).min(1).max(8),
    /** 项目级检查（目标达成证据），公开。 */
    projectChecks: z.array(pblDeterministicCheckSchema).max(12),
    /** 角色席位，含真人与可选协作席。 */
    roles: z.array(pblProjectRoleSchema).min(1).max(12),
    /** 阶段任务（OMA-047）。 */
    tasks: z.array(pblPhaseTaskSchema).min(1).max(24),
    /** 里程碑（OMA-047）。 */
    milestones: z.array(pblMilestoneSchema).min(1).max(12),
    /** 评分依据（OMA-048）：私有，只在服务端。 */
    rubrics: z.array(pblRubricSchema).min(1).max(12),
    /** 里程碑之间的节奏天数，用于服务端进度提示；null 表示不设。 */
    cadenceDays: z.number().int().positive().max(120).nullable(),
  })
  .strict();
export type PblProjectDefinitionDto = z.infer<typeof pblProjectDefinitionSchema>;

/**
 * 公开投影（类型层）：没有 `rubrics`，里程碑里没有 `rubricIds`，任务里没有 `rubricIds`。
 *
 * 交付正文（私人产物）与导师评语不在定义里，因此这里不需要剥离；它们由
 * `pblPublicProjectStateSchema` 与领域的投影函数控制在本人视图之内。
 */
export const pblProjectPublicDefinitionSchema = z
  .object({
    ...base,
    authenticContext: z
      .object({ audience: z.string(), problem: z.string(), constraints: z.array(z.string()) })
      .strict(),
    background: z.string(),
    goals: z.array(pblProjectGoalSchema),
    projectChecks: z.array(pblDeterministicCheckSchema),
    roles: z.array(pblProjectRoleSchema),
    tasks: z.array(pblPhaseTaskSchema),
    milestones: z
      .array(
        z
          .object({
            ...base,
            order: z.number().int(),
            checks: z.array(pblDeterministicCheckSchema),
            taskIds: z.array(id).min(1),
          })
          .strict(),
      )
      .min(1),
    cadenceDays: z.number().int().nullable(),
  })
  .strict();
export type PblProjectPublicDefinitionDto = z.infer<typeof pblProjectPublicDefinitionSchema>;

export const pblFrozenSchema = z
  .object({
    version: z.literal(1),
    projectId: id,
    lessonId: id,
    lessonVersion: z.number().int().positive(),
    bundleDigest: id,
    reviewedBy: id,
    reviewNote: z.string().min(2).max(2000),
    definition: pblProjectDefinitionSchema,
  })
  .strict();
export type PblFrozenDto = z.infer<typeof pblFrozenSchema>;

export const pblBindingSchema = z
  .object({
    version: z.literal(1),
    stageId: id,
    /** 项目定义编号：同一 stage 可以挂多个 PBL 项目。 */
    definitionId: id,
    documentDigest: id,
    definitionDigest: id,
  })
  .strict();
export type PblBindingDto = z.infer<typeof pblBindingSchema>;

/**
 * 记录基座。
 *
 * `uid` / `recordScope` / `actorType` / `createdAt` 只出现在**记录**里，命令里没有对应字段可填，
 * 因此请求体无法把别人的交付写成自己的、也无法把 AI 贡献冒充本人。
 * `recordScope` 固定 `formal`：演练数据不在这个形状里（见 `pblRunEvidenceSchema`）。
 */
const recordBase = {
  version: z.literal(1),
  uid: learnerUidSchema,
  recordScope: z.literal('formal'),
  binding: pblBindingSchema,
  createdAt: z.string().datetime(),
  /** 幂等键：同 nonce 同内容重试读回既有收据；不同内容复用 nonce 被拒。 */
  nonce: id,
};

/** 交付内容的必填校验（正文非空）；草稿另有可空的变体。 */
const deliverableContent = {
  artifactKind: z.enum(PBL_ARTIFACT_KINDS),
  artifactTitle: text(200),
  /** 真实产物正文——服务端的确定性检查读它。 */
  artifactText: z.string().min(1).max(20000),
  /** 资源引用（图片/数据文件），指向已登记资源，不内联内容。 */
  assetRefs: z.array(id).max(20),
  /** 本人声明本条交付对应哪些目标（只作呈现对应，不构成判定）。 */
  goalIds: z.array(id).max(8),
};

/** 本人交付的可填部分。 */
export const pblDeliverablePayloadSchema = z
  .object({
    taskId: id,
    /** 显式归属的里程碑；null 表示按阶段任务的 `milestoneIds` 计入。 */
    milestoneId: id.nullable(),
    ...deliverableContent,
  })
  .strict();
export type PblDeliverablePayloadInput = z.infer<typeof pblDeliverablePayloadSchema>;

/** 本人的阶段交付（OMA-047「本人交付」）。 */
export const pblDeliverableRecordSchema = z
  .object({
    ...recordBase,
    kind: z.literal('deliverable'),
    /** 字面量：AI 席位不能写这条记录。 */
    actorType: z.literal('human_learner'),
    ...pblDeliverablePayloadSchema.shape,
  })
  .strict();
export type PblDeliverableRecordDto = z.infer<typeof pblDeliverableRecordSchema>;

/** AI 贡献的可填部分（认领字段不在这里：只有本人能认领）。 */
export const pblContributionPayloadSchema = z
  .object({
    /** 贡献来自哪个协作席位。 */
    roleId: id,
    taskId: id,
    milestoneId: id.nullable(),
    /** 贡献内容：建议、片段、数据示例等。 */
    content: z.string().min(1).max(8000),
    /** 依据的真实产物编号（必须指向本项目已落库产物，见领域 `assertPblContributionGrounded`）。 */
    basisArtifactIds: z.array(id).min(1).max(20),
  })
  .strict();
export type PblContributionPayloadInput = z.infer<typeof pblContributionPayloadSchema>;

/**
 * AI 贡献（OMA-047「AI 贡献单独标记」）。
 *
 * `actorType` 只能是协作席位两类；`acknowledgedByUid` 记录本人是否已把这条贡献吸收进自己的
 * 工作。未认领的贡献只增加 `aiContributionCount`，永远不计入 `ownSubmissionCount`，
 * 也不会复制成一份「本人交付」。
 */
export const pblAiContributionRecordSchema = z
  .object({
    ...recordBase,
    kind: z.literal('contribution'),
    actorType: z.enum(['teacher_ai', 'peer_ai']),
    ...pblContributionPayloadSchema.shape,
    acknowledgedByUid: learnerUidSchema.nullable(),
    acknowledgedAt: z.string().datetime().nullable(),
  })
  .strict();
export type PblAiContributionRecordDto = z.infer<typeof pblAiContributionRecordSchema>;

/** 导师反馈的可填部分（`actorType` 不在这里：由服务端按席位种类写入）。 */
export const pblFeedbackPayloadSchema = z
  .object({
    taskId: id,
    milestoneId: id.nullable(),
    /** 反馈针对的产物编号（真实产物）。 */
    basisArtifactIds: z.array(id).min(1).max(20),
    /** 逐条依据：每条意见都写明它看的是哪份产物的哪一点。 */
    points: z
      .array(z.object({ artifactId: id, observation: text(1000), suggestion: text(1000) }).strict())
      .min(1)
      .max(20),
  })
  .strict();
export type PblFeedbackPayloadInput = z.infer<typeof pblFeedbackPayloadSchema>;

/**
 * 导师指导（OMA-048「反馈依据真实产物」）。
 *
 * `basisArtifactIds` 非空，且领域要求每一条都命中已落库的真实产物；
 * 没有产物依据的反馈在领域层被拒，而不是一句空泛建议。
 */
export const pblMentorFeedbackRecordSchema = z
  .object({
    ...recordBase,
    kind: z.literal('feedback'),
    actorType: z.enum(['teacher_ai', 'peer_ai', 'human_learner']),
    ...pblFeedbackPayloadSchema.shape,
  })
  .strict();
export type PblMentorFeedbackRecordDto = z.infer<typeof pblMentorFeedbackRecordSchema>;

/**
 * AI 评价候选（OMA-048「评价候选」）。
 *
 * 这里**没有** `passed` / `score`：候选只能表达「对照哪条评分依据、看到哪份产物、
 * 给出哪一档描述性判断」。确定性结论另由 `pblDeterministicOutcomeSchema` 表示，
 * 两者在 `pblMilestoneEvaluationSchema` 里并列呈现，互不改写。
 */
export const pblAssessmentCandidateSchema = z
  .object({
    candidateId: id,
    rubricId: id,
    judgement: z.enum(PBL_JUDGEMENT_LEVELS),
    rationale: text(1000),
    /** 评语依据的产物编号，必须真实存在。 */
    basisArtifactIds: z.array(id).min(1).max(20),
  })
  .strict();
export type PblAssessmentCandidateDto = z.infer<typeof pblAssessmentCandidateSchema>;

/** 一次评价的可填部分。 */
export const pblAssessmentPayloadSchema = z
  .object({
    milestoneId: id,
    /** 只能提交评价候选；本形状没有任何字段可以提交判定结论。 */
    candidates: z.array(pblAssessmentCandidateSchema).min(1).max(24),
    /** 出具候选的席位（真人导师可为 null）。 */
    roleId: id.nullable(),
    /** 引用目标编号，供呈现层把评语挂到目标上。 */
    goalIds: z.array(id).max(8),
  })
  .strict();
export type PblAssessmentPayloadInput = z.infer<typeof pblAssessmentPayloadSchema>;

/**
 * 评价记录（OMA-048）。
 *
 * 只存候选；`deterministic` / `reached` 不落在这里——每次读取由 `pblMilestoneEvaluations`
 * 依据当前证据重算，所以历史落库固化不了一个过期结论。人工采纳是另一条记录
 * （`pblEvaluationAcceptanceRecordSchema`），因此「人采纳了哪些候选」不会被写入者改写。
 */
export const pblAssessmentRecordSchema = z
  .object({
    ...recordBase,
    kind: z.literal('assessment'),
    actorType: z.enum(['teacher_ai', 'peer_ai', 'human_learner']),
    ...pblAssessmentPayloadSchema.shape,
  })
  .strict();
export type PblAssessmentRecordDto = z.infer<typeof pblAssessmentRecordSchema>;

/**
 * 人工采纳评价候选（OMA-048「评价候选和确定性检查分开」的落库形态）。
 *
 * 采纳只能由真人成员发出，指向一条已落库的评价记录；它不改写那条记录，也不带任何
 * 可以表达「里程碑达成」的字段——达成与否只看确定性检查。
 */
export const pblEvaluationAcceptanceRecordSchema = z
  .object({
    ...recordBase,
    kind: z.literal('acceptance'),
    actorType: z.literal('human_learner'),
    milestoneId: id,
    /** 被采纳的评价记录的 nonce。 */
    assessmentNonce: id,
    acceptedCandidateIds: z.array(id).min(1).max(24),
  })
  .strict();
export type PblEvaluationAcceptanceRecordDto = z.infer<typeof pblEvaluationAcceptanceRecordSchema>;

/** 人工采纳的可填部分（milestoneId 不在这里：由服务端从被采纳的评价记录取）。 */
export const pblAcceptancePayloadSchema = z
  .object({
    assessmentNonce: id,
    acceptedCandidateIds: z.array(id).min(1).max(24),
  })
  .strict();
export type PblAcceptancePayloadInput = z.infer<typeof pblAcceptancePayloadSchema>;

/** 本人认领一条 AI 贡献（OMA-047：认领动作单独成记录，不改动贡献内容与作者）。 */
export const pblAcknowledgeRecordSchema = z
  .object({
    ...recordBase,
    kind: z.literal('acknowledge'),
    actorType: z.literal('human_learner'),
    /** 被认领的 AI 贡献记录的 nonce（认领只建立关联，不复制内容）。 */
    contributionNonce: id,
    /** 认领时本人的说明：这条我吸收了/我核实过了。 */
    note: text(1000),
  })
  .strict();
export type PblAcknowledgeRecordDto = z.infer<typeof pblAcknowledgeRecordSchema>;

/**
 * 阶段任务进度（OMA-049「开任务/任务更新」）。
 *
 * 存的是**申报**；读取视图里的权威状态由记录推导，`reportedStatus` 的枚举里没有 `verified`。
 * `derivedStatus` 由服务端在写入时重算，客户端没有这个字段可填。
 */
export const pblTaskProgressRecordSchema = z
  .object({
    ...recordBase,
    kind: z.literal('task_progress'),
    actorType: z.literal('human_learner'),
    /** `open` = 开任务（选择席位）；`update` = 任务更新。 */
    intent: z.enum(['open', 'update']),
    taskId: id,
    /** 开任务时选择的席位；更新时为 null。 */
    roleId: id.nullable(),
    /** 申报的进展状态（不含 `verified`）。 */
    reportedStatus: z.enum(PBL_REPORTABLE_TASK_STATUSES),
    /** 本人对本次进展的说明，是记录正文而不是判定依据。 */
    report: text(1000),
    /** 服务端在写入时刻推导出的权威状态（重启后可核对语义）。 */
    derivedStatus: z.enum(PBL_TASK_STATUSES),
  })
  .strict();
export type PblTaskProgressRecordDto = z.infer<typeof pblTaskProgressRecordSchema>;

export const pblRecordSchema = z.discriminatedUnion('kind', [
  pblDeliverableRecordSchema,
  pblAiContributionRecordSchema,
  pblMentorFeedbackRecordSchema,
  pblAssessmentRecordSchema,
  pblEvaluationAcceptanceRecordSchema,
  pblAcknowledgeRecordSchema,
  pblTaskProgressRecordSchema,
]);
export type PblRecordDto = z.infer<typeof pblRecordSchema>;

export const pblReceiptSchema = z
  .object({
    id,
    createdAt: z.string(),
    payload: pblRecordSchema,
    /** Server-derived reference for a deliverable; legacy receipts may omit it. */
    artifactId: id.nullable().optional(),
  })
  .strict();
export type PblReceiptDto = z.infer<typeof pblReceiptSchema>;

/**
 * 检查结论。
 *
 * 由服务端计算后随读回呈现或落库；**没有任何命令接受这个对象的实例**，
 * 因此写路径伪造不出「已通过全部检查」。
 */
export const pblDeterministicOutcomeSchema = z
  .object({
    checkId: id,
    kind: z.enum(PBL_CHECK_KINDS),
    passed: z.boolean(),
    /** 判定口径的机器可读说明（例如 `missing_fragment:预算`）。 */
    detail: z.string().max(500),
    /** 参与判定的产物编号，使判定依据可回溯到真实产物。 */
    evidenceArtifactIds: z.array(id).max(20),
  })
  .strict();
export type PblDeterministicOutcomeDto = z.infer<typeof pblDeterministicOutcomeSchema>;

/** 任务呈现视图（OMA-047「任务状态和本人交付重启可读」）。 */
export const pblTaskViewSchema = z
  .object({
    taskId: id,
    /** 权威状态：由记录推导，草稿与 AI 贡献都不能把它推到 `verified`。 */
    status: z.enum(PBL_TASK_STATUSES),
    /** 承接该任务的席位；null 表示还没人开这个任务。 */
    claimedByRoleId: id.nullable(),
    claimedByUid: learnerUidSchema.nullable(),
    /** 本人最新草稿标题（正文只在本人视图给出，共享投影里为 null）。 */
    ownDraftTitle: z.string().nullable(),
    /** 本人已交付次数（AI 贡献不计入）。 */
    ownSubmissionCount: z.number().int().nonnegative(),
    /** AI 贡献条数，与本人交付分开计数。 */
    aiContributionCount: z.number().int().nonnegative(),
    /** 其中已被本人认领的条数。 */
    acknowledgedContributionCount: z.number().int().nonnegative(),
    /** 本阶段确定性检查结论（达成与否的可回溯依据）。 */
    deterministic: z.array(pblDeterministicOutcomeSchema),
  })
  .strict();
export type PblTaskViewDto = z.infer<typeof pblTaskViewSchema>;

/** 里程碑评估：候选与确定性检查并列，`reached` 只由后者决定（OMA-048）。 */
export const pblMilestoneEvaluationSchema = z
  .object({
    milestoneId: id,
    /** 确定性检查结论，逐条对应定义里的 `checks`。 */
    deterministic: z.array(pblDeterministicOutcomeSchema).min(1),
    /** 是否达成——全部确定性检查通过才为 true，与候选无关。 */
    reached: z.boolean(),
    /** 「评价候选」线：AI 出具的候选与人工采纳结论，与 `reached` 无关。 */
    assessment: z
      .object({
        candidates: z.array(pblAssessmentCandidateSchema).max(24),
        acceptedCandidateIds: z.array(id).max(24),
        /** 候选出自哪些评价记录（人工采纳时按记录定位）。 */
        assessmentNonces: z.array(id).max(24),
      })
      .strict(),
  })
  .strict();
export type PblMilestoneEvaluationDto = z.infer<typeof pblMilestoneEvaluationSchema>;

/** 阶段任务草稿（尚未提交，不进入确定性判定）。 */
export const pblDeliverableDraftSchema = z
  .object({
    version: z.literal(1),
    uid: learnerUidSchema,
    recordScope: z.literal('formal'),
    binding: pblBindingSchema,
    updatedAt: z.string().datetime(),
    nonce: id,
    ...pblDeliverablePayloadSchema.shape,
    /** 草稿允许正文暂空（还没写完），提交时由 `pblDeliverablePayloadSchema` 要求非空。 */
    artifactText: z.string().max(20000),
  })
  .strict();
export type PblDeliverableDraftDto = z.infer<typeof pblDeliverableDraftSchema>;

/**
 * 判定引擎的唯一输入（正式记录与演练动作都投影成它）。
 *
 * 这一层同形不同分区：正式记录 `recordScope: 'formal'`，模拟器动作 `recordScope: 'demo'`。
 * 因为判定只认这个形状，模拟器才能「真的跑起来」——它跑的就是生产判定，
 * 而不是另写一份更宽松的演示逻辑；而它落在 demo 分区，产不出正式记录。
 */
export const pblRunEvidenceSchema = z
  .object({
    version: z.literal(1),
    /** 这条证据产生于正式记录还是演练动作。 */
    source: z.enum(['formal_record', 'simulation']),
    recordScope: z.enum(['formal', 'demo']),
    uid: learnerUidSchema,
    /** 席位编号（交付/认领/任务动作为真人席位，贡献/反馈/评价为协作席位）。 */
    roleId: id.nullable(),
    actorType: z.enum(['human_learner', 'teacher_ai', 'peer_ai']),
    operation: z.enum([
      'open',
      'update',
      'submit',
      'contribute',
      'acknowledge',
      'requestFeedback',
      'feedback',
      'assess',
      'acceptEvaluation',
    ]),
    nonce: id,
    createdAt: z.string().datetime(),
    taskId: id.nullable(),
    milestoneId: id.nullable(),
    artifactKind: z.enum(PBL_ARTIFACT_KINDS).nullable(),
    /** 交付正文：仅提交动作有；其它动作为 null，避免把私人正文带进无关判定。 */
    artifactText: z.string().max(20000).nullable(),
    /** 认领动作指向的贡献 nonce / 反馈与评价指向的产物依据之外的引用锚点；其它动作为 null。 */
    contributionNonce: id.nullable(),
    /** 采纳动作指向的评价记录 nonce；其它动作为 null。 */
    assessmentNonce: id.nullable(),
    /** 任务申报状态。 */
    reportedStatus: z.enum(PBL_REPORTABLE_TASK_STATUSES).nullable(),
    /** 本条证据引用的产物编号（反馈/评价/贡献的依据）。 */
    basisArtifactIds: z.array(id).max(20),
    /** 评价候选（只有 assess 动作有）。 */
    candidates: z.array(pblAssessmentCandidateSchema).max(24),
    /** 采纳的候选编号（只有 acceptEvaluation 动作有）。 */
    acceptedCandidateIds: z.array(id).max(24),
    /** 交付声明对应的目标编号（只有 submit 有；供目标覆盖率呈现）。 */
    goalIds: z.array(id).max(8),
  })
  .strict();
export type PblRunEvidenceDto = z.infer<typeof pblRunEvidenceSchema>;

/**
 * 模拟器单步输入（OMA-049）。
 *
 * `actorType` / `recordScope` 都不在这里——由服务端按会话与「这是演练」两件事写死，
 * 所以「在模拟器里冒充本人写正式记录」没有入口；能影响的只有动作正文。
 */
export const pblSimulationStepSchema = z
  .object({
    scope: projectScopeSchema,
    binding: pblBindingSchema,
    operation: z.enum(PBL_SIMULATION_OPERATIONS),
    actorUid: learnerUidSchema,
    nonce: id,
    taskId: id.nullable(),
    roleId: id.nullable(),
    milestoneId: id.nullable(),
    reportedStatus: z.enum(PBL_REPORTABLE_TASK_STATUSES).nullable(),
    deliverable: pblDeliverablePayloadSchema.nullable(),
    contribution: pblContributionPayloadSchema.nullable(),
    contributionNonce: id.nullable(),
    feedback: pblFeedbackPayloadSchema.nullable(),
    assessment: pblAssessmentPayloadSchema.nullable(),
    /** 采纳候选：按「本次演练里已出具候选的评价动作」的 nonce 定位。 */
    assessmentNonce: id.nullable(),
    acceptedCandidateIds: z.array(id).max(24).nullable(),
    /** 针对哪些产物请求反馈。 */
    artifactIds: z.array(id).max(20).nullable(),
    note: z.string().trim().max(1000),
  })
  .strict();
type PblSimulationStepShapeDto = z.infer<typeof pblSimulationStepSchema>;

/** 每种演练动作必须带与可以带的字段。 */
const SIMULATION_STEP_FIELDS: Record<
  PblSimulationOperation,
  {
    required: readonly (keyof PblSimulationStepShapeDto)[];
    allowed: readonly (keyof PblSimulationStepShapeDto)[];
  }
> = {
  open: {
    required: ['taskId', 'roleId', 'reportedStatus'],
    allowed: ['taskId', 'roleId', 'reportedStatus', 'milestoneId'],
  },
  update: {
    required: ['taskId', 'reportedStatus'],
    allowed: ['taskId', 'reportedStatus', 'milestoneId'],
  },
  submit: {
    required: ['taskId', 'deliverable'],
    allowed: ['taskId', 'deliverable', 'milestoneId'],
  },
  contribute: {
    required: ['taskId', 'contribution'],
    allowed: ['taskId', 'contribution', 'milestoneId'],
  },
  acknowledge: {
    required: ['taskId', 'contributionNonce'],
    allowed: ['taskId', 'contributionNonce', 'milestoneId'],
  },
  requestFeedback: {
    required: ['taskId', 'artifactIds'],
    allowed: ['taskId', 'artifactIds', 'milestoneId'],
  },
  feedback: { required: ['taskId', 'feedback'], allowed: ['taskId', 'feedback', 'milestoneId'] },
  assess: {
    required: ['taskId', 'assessment'],
    allowed: ['taskId', 'assessment', 'roleId', 'milestoneId'],
  },
  acceptEvaluation: {
    required: ['assessmentNonce', 'acceptedCandidateIds'],
    allowed: ['assessmentNonce', 'acceptedCandidateIds', 'milestoneId'],
  },
};

/**
 * 动作载荷的形状校验（放在 schema 层，避免调用方各自记一遍）。
 *
 * 漏带会让判定引擎收到一条「什么都不做」的演练步；多带会让一个动作同时冒充另一种动作
 * （例如在 submit 里夹一条 AI 贡献，把模型产出混进本人交付）。
 */
export const pblSimulationStepSchemaChecked = pblSimulationStepSchema.superRefine((step, ctx) => {
  const spec = SIMULATION_STEP_FIELDS[step.operation];
  for (const key of spec.required) {
    if (step[key] === null || step[key] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `PBL 模拟动作 ${step.operation} 缺少 ${key}`,
      });
    }
  }
  for (const key of [
    'taskId',
    'roleId',
    'milestoneId',
    'reportedStatus',
    'deliverable',
    'contribution',
    'contributionNonce',
    'feedback',
    'assessment',
    'assessmentNonce',
    'acceptedCandidateIds',
    'artifactIds',
  ] as const) {
    if (step[key] !== null && !spec.allowed.includes(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `PBL 模拟动作 ${step.operation} 不能携带 ${key}`,
      });
    }
  }
});
export type PblSimulationStepInput = PblSimulationStepShapeDto;

/** 模拟器视图（OMA-049「PBL 模拟器与任务工具」）。 */
export const pblSimulationStateSchema = z
  .object({
    version: z.literal(1),
    simulated: z.literal(true),
    /** 模拟器落在演示分区，绝不写本人正式记录。 */
    recordScope: z.literal('demo'),
    definition: pblProjectPublicDefinitionSchema,
    binding: pblBindingSchema,
    /** 已试走的动作（demo 分区），用于逐步推进时重算而不是只回显一步。 */
    steps: z.array(pblRunEvidenceSchema),
    tasks: z.array(pblTaskViewSchema),
    milestones: z.array(pblMilestoneEvaluationSchema),
    /** 演练中可用的产物编号（供后续反馈/评价动作引用）。 */
    artifactIds: z.array(id),
    /** 允许试走的动作（与守卫同源，界面不需要自己再判一次）。 */
    allowedOperations: z.array(z.enum(PBL_SIMULATION_OPERATIONS)),
    /** 每次运行允许试走的步数上限，防止模拟器变成无限写入器。 */
    stepBudget: z
      .object({ maxSteps: z.number().int().positive(), used: z.number().int().nonnegative() })
      .strict(),
  })
  .strict();
export type PblSimulationStateDto = z.infer<typeof pblSimulationStateSchema>;

const commandBase = { scope: projectScopeSchema, binding: pblBindingSchema };

export const pblReviewCommandSchema = z
  .object({
    ...commandBase,
    operation: z.literal('review'),
    lessonId: id,
    lessonVersion: z.number().int().positive(),
    /** 只有真的逐条核对过才填 true，且必须是字面量 true。 */
    semanticReviewed: z.literal(true),
    reviewNote: z.string().min(2).max(2000),
    definition: pblProjectDefinitionSchema,
  })
  .strict();

/** 保存草稿：只填内容，身份由服务端绑定。 */
export const pblDraftCommandSchema = z
  .object({
    ...commandBase,
    operation: z.literal('draft'),
    actorUid: learnerUidSchema,
    /** 草稿允许正文暂空，所以这里用可空正文的变体。 */
    draft: pblDeliverablePayloadSchema.extend({ artifactText: z.string().max(20000) }).strict(),
    nonce: id,
  })
  .strict();
export type PblDraftCommandInput = z.infer<typeof pblDraftCommandSchema>;

export const pblSubmitCommandSchema = z
  .object({
    ...commandBase,
    operation: z.literal('submit'),
    actorUid: learnerUidSchema,
    deliverable: pblDeliverablePayloadSchema,
    nonce: id,
  })
  .strict();

export const pblContributeCommandSchema = z
  .object({
    ...commandBase,
    operation: z.literal('contribute'),
    /** 协作席位执行：只能带服务端已登记的席位 UID。 */
    actorUid: learnerUidSchema,
    contribution: pblContributionPayloadSchema,
    nonce: id,
  })
  .strict();

export const pblAcknowledgeCommandSchema = z
  .object({
    ...commandBase,
    operation: z.literal('acknowledge'),
    actorUid: learnerUidSchema,
    contributionNonce: id,
    note: text(1000),
    nonce: id,
  })
  .strict();

export const pblTaskCommandSchema = z
  .object({
    ...commandBase,
    operation: z.literal('task'),
    /** `open` = 开任务（选择席位），`update` = 任务更新。 */
    intent: z.enum(['open', 'update']),
    actorUid: learnerUidSchema,
    taskId: id,
    /** 开任务必须给席位；更新时由服务端沿用已承接的席位，客户端不能改换。 */
    roleId: id.nullable(),
    reportedStatus: z.enum(PBL_REPORTABLE_TASK_STATUSES),
    report: text(1000),
    nonce: id,
  })
  .strict();

export const pblFeedbackRequestCommandSchema = z
  .object({
    ...commandBase,
    operation: z.literal('requestFeedback'),
    actorUid: learnerUidSchema,
    taskId: id,
    /** 请求针对的真实产物（必须已落库）。 */
    artifactIds: z.array(id).min(1).max(20),
    question: text(1000),
    nonce: id,
  })
  .strict();

export const pblFeedbackCommandSchema = z
  .object({
    ...commandBase,
    operation: z.literal('feedback'),
    actorUid: learnerUidSchema,
    feedback: pblFeedbackPayloadSchema,
    nonce: id,
  })
  .strict();

export const pblAssessCommandSchema = z
  .object({
    ...commandBase,
    operation: z.literal('assess'),
    actorUid: learnerUidSchema,
    assessment: pblAssessmentPayloadSchema,
    nonce: id,
  })
  .strict();

/** 人工采纳某几条评价候选（人的决定；不改变确定性结论，也不能声称里程碑达成）。 */
export const pblAcceptEvaluationCommandSchema = z
  .object({
    ...commandBase,
    operation: z.literal('acceptEvaluation'),
    actorUid: learnerUidSchema,
    /** 指向已落库的评价记录 nonce。 */
    assessmentNonce: id,
    acceptedCandidateIds: z.array(id).min(1).max(24),
    nonce: id,
  })
  .strict();

/** 打开 PBL 模拟器（OMA-049）。只读：命令里没有任何可落库正文的字段。 */
export const pblSimulateCommandSchema = z
  .object({
    ...commandBase,
    operation: z.literal('simulate'),
    viewerUid: learnerUidSchema.nullable(),
    /** 本次模拟的步数上限（有上限，避免无限演练）。 */
    maxSteps: z.number().int().positive().max(50),
  })
  .strict();

export const pblCommandSchema = z.discriminatedUnion('operation', [
  pblReviewCommandSchema,
  pblDraftCommandSchema,
  pblSubmitCommandSchema,
  pblContributeCommandSchema,
  pblAcknowledgeCommandSchema,
  pblTaskCommandSchema,
  pblFeedbackRequestCommandSchema,
  pblFeedbackCommandSchema,
  pblAssessCommandSchema,
  pblAcceptEvaluationCommandSchema,
  pblSimulateCommandSchema,
]);
export type PblCommand = z.infer<typeof pblCommandSchema>;

/** 会写入正式记录的操作（受成员资格、席位与冻结前置约束）。 */
export const PBL_WRITE_OPERATIONS = [
  'review',
  'draft',
  'submit',
  'contribute',
  'acknowledge',
  'task',
  'requestFeedback',
  'feedback',
  'assess',
  'acceptEvaluation',
] as const;
export type PblWriteOperation = (typeof PBL_WRITE_OPERATIONS)[number];

/**
 * PBL 项目的读取状态（OMA-047「重启可读」）。
 *
 * 私人内容（交付正文、AI 贡献正文、导师评语、草稿）只出现在这里的 `ownSubmissions` /
 * `contributions` / `feedback` / `ownDraft` 字段；共享快照走 `pblPublicProjectStateSchema`，
 * 那里一个正文字段都没有（见领域 `publicPblProjectState`）。
 */
export const pblProjectStateSchema = z
  .object({
    definition: pblProjectPublicDefinitionSchema,
    binding: pblBindingSchema,
    viewerUid: learnerUidSchema.nullable(),
    /** 查看者是否为项目成员：非成员只读到公开定义与计数，不读到任何正文。 */
    viewerIsMember: z.boolean(),
    tasks: z.array(pblTaskViewSchema),
    milestones: z.array(pblMilestoneEvaluationSchema),
    ownDraft: pblDeliverableDraftSchema.nullable(),
    /** Latest durable draft for each task; older consumers retain ownDraft. */
    ownDrafts: z.array(pblDeliverableDraftSchema).max(24).optional(),
    /** Projection of human acknowledgment records, without rewriting AI authorship. */
    acknowledgedContributionNonces: z.array(id).optional(),
    ownSubmissions: z.array(pblReceiptSchema),
    contributions: z.array(pblReceiptSchema),
    feedback: z.array(pblReceiptSchema),
    assessments: z.array(pblReceiptSchema),
    count: z.number().int().nonnegative(),
    deduplicated: z.boolean(),
  })
  .strict();
export type PblProjectStateDto = z.infer<typeof pblProjectStateSchema>;

/** 共享/呈现层的公开状态：只有定义、任务计数与确定性结论（无正文、无评语、无评分依据）。 */
export const pblPublicProjectStateSchema = z
  .object({
    version: z.literal(1),
    definition: pblProjectPublicDefinitionSchema,
    binding: pblBindingSchema,
    tasks: z.array(pblTaskViewSchema),
    /** 里程碑只到「确定性检查结论 + 是否达成」，候选与评语不进共享层。 */
    milestones: z
      .array(
        z
          .object({
            milestoneId: id,
            deterministic: z.array(pblDeterministicOutcomeSchema).min(1),
            reached: z.boolean(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type PblPublicProjectStateDto = z.infer<typeof pblPublicProjectStateSchema>;
