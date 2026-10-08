/**
 * 领域状态枚举。
 *
 * 《规划书》4.1 要求把「来源状态」「范围状态」「掌握状态」三个维度分开记录：
 * 「来源已核实」不等于「学习者已掌握」。
 */

/** 当前材料是否支持这一项。 */
export const SOURCE_STATUS = ['pending', 'verified', 'invalidated'] as const;
export type SourceStatus = (typeof SOURCE_STATUS)[number];

/** 为什么把这一项放进学习范围。 */
export const SCOPE_STATUS = ['in_syllabus', 'prerequisite', 'scope_pending', 'out_of_scope'] as const;
export type ScopeStatus = (typeof SCOPE_STATUS)[number];

/** 数据是否属于可纳入正式学习统计的记录范围。 */
export const RECORD_SCOPE = ['formal', 'demo'] as const;
export type RecordScope = (typeof RECORD_SCOPE)[number];

/** 权威记录产生时使用的语义审查来源。演示编者结论只对演示分区有效。 */
export const REVIEW_PROVENANCE = ['user_semantic', 'demo_author'] as const;
export type ReviewProvenance = (typeof REVIEW_PROVENANCE)[number];

/** 学习者有什么实际表现。 */
export const MASTERY_STATUS = ['untested', 'to_reinforce', 'to_retest', 'passed'] as const;
export type MasteryStatus = (typeof MASTERY_STATUS)[number];

/** 候选审核结论。 */
export const REVIEW_DECISION = ['approved', 'rejected', 'needs_material'] as const;
export type ReviewDecision = (typeof REVIEW_DECISION)[number];

/** 引用用途：考纲章节名可以支持范围判断，但未必支持公式或条件。 */
export const EVIDENCE_USE = ['scope_basis', 'concept_basis', 'method_basis'] as const;
export type EvidenceUse = (typeof EVIDENCE_USE)[number];

/**
 * 题目身份由可信创建/导入记录判定，AI 自报「真题」不生效。
 * material_original = 材料原题（≠ 考试真题）；exam_original 需人工核实材料身份。
 */
export const QUESTION_ORIGIN = ['exam_original', 'material_original', 'material_rewrite', 'ai_new'] as const;
export type QuestionOrigin = (typeof QUESTION_ORIGIN)[number];

/** 会话中的发言/动作主体。AI 同学作答不能写成本人提交。 */
export const ACTOR_TYPE = ['human_learner', 'teacher_ai', 'peer_ai', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPE)[number];

/**
 * 角色档案类型。权限位由服务端按 kind 派生，任何写入请求都不能自报权限，
 * 因此数据库里根本没有存放「客户端声称的权限」的列。
 */
export const ROLE_KIND = ['teacher', 'peer'] as const;
export type RoleKind = (typeof ROLE_KIND)[number];

/** 同学档案上限（PEER-01：零至两名同学）。 */
export const MAX_PEER_PROFILES = 2;

/** 角色讲解方式：与教学表达偏好同一组取值，但不改变任何事实或权限。 */
export const ROLE_EXPLANATION = ['intuitive', 'rigorous', 'concise'] as const;
export type RoleExplanation = (typeof ROLE_EXPLANATION)[number];

export const ROLE_KIND_LABEL: Record<RoleKind, string> = {
  teacher: 'AI 教师',
  peer: 'AI 同学',
};

/** 作答分区：模拟数据可参与软件评测，不能更新本人掌握状态。 */
export const ATTEMPT_KIND = ['real', 'simulation'] as const;
export type AttemptKind = (typeof ATTEMPT_KIND)[number];

/**
 * 运行事件类型。放在状态枚举一侧，供 `plan.ts` 的载荷 schema 与 `events.ts` 的事件
 * 类型共同引用，避免同一份清单出现两个来源。
 */
export const RUN_EVENT_TYPES = [
  'run_started',
  'step_started',
  'draft_delta',
  'proposal_created',
  'review_required',
  'answer_required',
  'step_committed',
  'run_completed',
  'run_failed',
  'run_cancelled',
  'model_call',
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/**
 * 模型调用用途。诊断用途不在此列：连接测试有独立限额，且不能用来产出教学内容。
 * `lesson_draft` 只产出待人工审核的草案；`teaching_prompt` 要求课程已发布并审核通过。
 *
 * BUDGET-01 起，课堂教师、AI 同学与后续的错因归因、复习建议共用同一份 run 额度，
 * 所以它们也必须作为独立用途出现在这里，才能在同一张台账上分开明细、合并计数。
 */
export const MODEL_CALL_PURPOSE = [
  'lesson_draft',
  'teaching_prompt',
  'peer_turn',
  'attempt_grading',
  'error_attribution',
  'review_suggestion',
  'statement_revision',
  'courseware_generation',
  'collab_teaching_ai',
  'pbl_guidance',
] as const;
export type ModelCallPurpose = (typeof MODEL_CALL_PURPOSE)[number];

/** 运行状态机（《规划书》6.3）。 */
export const RUN_STATE = [
  'preparing_materials',
  'awaiting_review',
  'plan_confirmed',
  'drafting_lesson',
  'awaiting_lesson_review',
  'published',
  'in_class',
  'awaiting_answer',
  'collecting_feedback',
  'completed',
  'cancelled',
  'failed',
] as const;
export type RunState = (typeof RUN_STATE)[number];

/** 中文展示文案：状态必须同时用文字与图标表达，不能只靠颜色。 */
export const SOURCE_STATUS_LABEL: Record<SourceStatus, string> = {
  pending: '待核实',
  verified: '已核实',
  invalidated: '已失效',
};

export const SCOPE_STATUS_LABEL: Record<ScopeStatus, string> = {
  in_syllabus: '考纲内',
  prerequisite: '必要前置',
  scope_pending: '范围待核',
  out_of_scope: '范围外',
};

export const MASTERY_STATUS_LABEL: Record<MasteryStatus, string> = {
  untested: '未测',
  to_reinforce: '待补',
  to_retest: '待复测',
  passed: '已通过验收',
};

export const QUESTION_ORIGIN_LABEL: Record<QuestionOrigin, string> = {
  exam_original: '考试真题',
  material_original: '材料原题',
  material_rewrite: '材料改写',
  ai_new: 'AI 新编题',
};

export const ACTOR_TYPE_LABEL: Record<ActorType, string> = {
  human_learner: '本人',
  teacher_ai: 'AI 教师',
  peer_ai: 'AI 同学',
  system: '系统',
};
