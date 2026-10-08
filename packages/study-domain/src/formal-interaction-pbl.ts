/**
 * PBL（项目制学习）互动族的纯判定（OMA-046 / OMA-047 / OMA-048 / OMA-049）。
 *
 * 这一层不做 IO，也不知道数据库与 HTTP：输入是「已冻结定义 + 记录 / 演练动作」，
 * 输出是「公开投影 / 权威任务状态 / 确定性检查结论 / 权限结论」。应用层负责取数与写库，
 * 但所有「通过与否」的口径都在这里，避免两处规则漂移成「按钮亮着但服务端拒绝」。
 *
 * 判定只认一个输入形状 `PblEvidence`（合同 `pblRunEvidenceSchema`）：
 * - 正式记录投影成它：`pblEvidenceFromRecord`（`source: 'formal_record'`）；
 * - 模拟器单步投影成它：`pblEvidenceFromStep`（`source: 'simulation'`、`recordScope: 'demo'`）。
 * 所以模拟器跑的是**同一套生产判定**而不是另写一份宽松的演示逻辑（OMA-049「均实际运行」），
 * 而 demo 证据变不成 `pblRecordSchema` 的任何实例（那里的 `recordScope` 是 `formal` 字面量，
 * 并且写入路径先过 `assertPblSimulationCannotWriteFormal`）。
 *
 * 与验收条款的对应：
 * - OMA-046：`assertPblDefinitionCoherent` + `assertPblDefinitionFrozen`——背景/角色/目标/
 *   阶段任务/里程碑/评分依据互相闭环，且只有冻结复验过的定义驱动判定。
 * - OMA-047：`pblTaskViews` / `pblMilestoneEvaluations` 完全由记录推导（重启可读）；
 *   AI 贡献与本人交付分开计数，
 *   未认领的贡献永远不进 `ownSubmissionCount`。
 * - OMA-048：`assertPblFeedbackGrounded`（反馈逐条绑定真实产物）；「评价候选」与
 *   「确定性检查」两条线并列，`reached` 只由检查决定，人工采纳不改 `reached`。
 * - OMA-049：`pblRolePermissions` 按席位种类派生权限；`runPblSimulationStep` 真推进状态且
 *   逐次守权限；`assertPblSimulationCannotWriteFormal` 拦演练写。
 */

import { StudyError, isStudyError } from '@sew/study-contracts';
import {
  PBL_ARTIFACT_KINDS,
  PBL_CHECK_KINDS,
  PBL_SIMULATION_OPERATIONS,
  pblBindingSchema,
  pblFrozenSchema,
  pblRecordSchema,
  pblRunEvidenceSchema,
  type PblAcceptancePayloadInput,
  type PblAcknowledgeRecordDto,
  type PblAiContributionRecordDto,
  type PblArtifactKind,
  type PblAssessmentCandidateDto,
  type PblAssessmentPayloadInput,
  type PblAssessmentRecordDto,
  type PblBindingDto,
  type PblCommand,
  type PblDeliverableDraftDto,
  type PblDeliverablePayloadInput,
  type PblDeliverableRecordDto,
  type PblDeterministicCheckDto,
  type PblDeterministicOutcomeDto,
  type PblEvaluationAcceptanceRecordDto,
  type PblFeedbackPayloadInput,
  type PblFrozenDto,
  type PblMentorFeedbackRecordDto,
  type PblMilestoneDto,
  type PblMilestoneEvaluationDto,
  type PblPhaseTaskDto,
  type PblProjectDefinitionDto,
  type PblProjectPublicDefinitionDto,
  type PblProjectRoleDto,
  type PblPublicProjectStateDto,
  type PblRecordDto,
  type PblReportableTaskStatus,
  type PblRoleKind,
  type PblRunEvidenceDto,
  type PblSimulationOperation,
  type PblSimulationStateDto,
  type PblSimulationStepInput,
  type PblTaskProgressRecordDto,
  type PblTaskStatus,
  type PblTaskViewDto,
} from '@sew/study-contracts';
import { formalInteractionHash, formalInteractionSceneId } from './formal-interaction';

/** 与正式互动共用同一摘要实现：同一份 JSON 在两个族里必须算出同一个摘要。 */
export const pblHash = formalInteractionHash;

/** PBL 场景编号：由项目定义编号派生，一个定义一个场景（OMA-046）。 */
export const pblProjectSceneId = (definitionId: string): string => {
  const readable = formalInteractionSceneId(`pbl_${definitionId}`);
  // Definition IDs allow free text; planned scene IDs must be safe and bounded.
  // Preserve existing short IDs, hash everything that would otherwise be renamed or truncated.
  return /^[a-z0-9_]{1,60}$/.test(readable)
    ? readable
    : `scene_pbl_${pblHash(definitionId).slice(0, 40)}`;
};

/** 冻结定义的存放分区（按课程版本）。 */
export const pblDefinitionSessionId = (lessonId: string, version: number): string =>
  `sew-pbl-definition-v1-${pblHash([lessonId, version])}`;

/** 本人 PBL 记录的存放分区（按项目 + 本人 UID + 绑定）。 */
export const pblRecordSessionId = (
  projectId: string,
  uid: string,
  binding: PblBindingDto,
): string => `sew-pbl-record-v1-${pblHash([projectId, uid, binding])}`;

/** 演练数据的存放分区：与正式记录分区物理隔开，读判定证据时也不混用。 */
export const pblSimulationSessionId = (
  projectId: string,
  uid: string,
  binding: PblBindingDto,
): string => `sew-pbl-simulation-v1-${pblHash([projectId, uid, binding])}`;

/**
 * 产物的可引用编号（AI 贡献 / 反馈 / 评价候选靠它指向真实产物）。
 *
 * 只对「来源 + 作者 + 幂等键」取摘要：同一条正式记录或同一步演练在任何重试下得到同一个
 * 编号，而且不依赖对象键序（否则 `JSON.stringify` 的键顺序一变，全部引用就断了）。
 * 演练产物编号与正式产物编号空间不重叠：演练里的交付永远指向不到正式记录，反之也一样。
 */
export const pblArtifactId = (identity: {
  source: 'formal_record' | 'simulation';
  uid: string;
  nonce: string;
}): string => `pbl_art_${pblHash([identity.source, identity.uid, identity.nonce]).slice(0, 32)}`;

/** 证据的产物编号。 */
const evidenceArtifactId = (evidence: PblRunEvidenceDto): string =>
  pblArtifactId({ source: evidence.source, uid: evidence.uid, nonce: evidence.nonce });

/** 本人交付记录（正式）的产物编号。 */
export const pblArtifactIdFromRecord = (record: PblDeliverableRecordDto): string =>
  pblArtifactId({ source: 'formal_record', uid: record.uid, nonce: record.nonce });

/** 记录收据编号：同一条记录在任何重试下得到同一个 id。 */
export const pblReceiptId = (record: PblRecordDto): string => `pbl-${pblHash(record)}`;

/** 把记录包成收据（正文逐字保留）。 */
export const pblReceiptFrom = (
  record: PblRecordDto,
): { id: string; createdAt: string; payload: PblRecordDto; artifactId: string | null } => ({
  id: pblReceiptId(record),
  createdAt: record.createdAt,
  payload: record,
  artifactId: record.kind === 'deliverable' ? pblArtifactIdFromRecord(record) : null,
});

const invalid = (reason: string, extra?: Record<string, unknown>): never => {
  throw new StudyError('INVALID_ARGUMENT', { reason, ...extra });
};

const rejected = (
  code:
    | 'ROLE_PERMISSION_DENIED'
    | 'NOT_FOUND'
    | 'VERSION_CONFLICT'
    | 'INTERNAL'
    | 'CLASSROOM_SCENE_SOURCE_MISSING'
    | 'SIMULATION_WRITE_FORBIDDEN'
    | 'PROJECT_NOT_AUTHORIZED'
    | 'PROJECT_GENERATION_STALE',
  reason: string,
  extra?: Record<string, unknown>,
): never => {
  throw new StudyError(code, { reason, ...extra });
};

/**
 * 公开投影：去掉 `rubrics` 与里程碑上的 `rubricIds`（OMA-048）。
 *
 * 只删字段，不改写任何面向成员的内容（背景、目标、角色职责、任务成果、检查条件与期望
 * 全部逐字保留）：成员需要知道「要做什么」，但不需要看到「导师凭什么打分」。
 */
export const publicPblProjectDefinition = (
  definition: PblProjectDefinitionDto,
): PblProjectPublicDefinitionDto => ({
  id: definition.id,
  title: definition.title,
  statementIds: definition.statementIds,
  authenticContext: {
    audience: definition.authenticContext.audience,
    problem: definition.authenticContext.problem,
    constraints: definition.authenticContext.constraints,
  },
  background: definition.background,
  goals: definition.goals.map((goal) => ({ ...goal })),
  projectChecks: definition.projectChecks.map((check) => ({ ...check })),
  roles: definition.roles.map((role) => ({ ...role })),
  tasks: definition.tasks.map((task) => ({ ...task })),
  milestones: definition.milestones.map((milestone) => ({
    id: milestone.id,
    title: milestone.title,
    statementIds: milestone.statementIds,
    order: milestone.order,
    checks: milestone.checks.map((check) => ({ ...check })),
    taskIds: milestone.taskIds,
  })),
  cadenceDays: definition.cadenceDays,
});

/**
 * 共享快照（OMA-047 私人产物 + OMA-048 评分依据都不进共享层）。
 *
 * 只留定义公开投影、任务计数、确定性结论与是否达成：交付正文、草稿标题、AI 贡献正文、
 * 导师评语、评价候选与采纳结论一律不进这里。
 */
export const publicPblProjectState = (input: {
  definition: PblProjectDefinitionDto;
  binding: PblBindingDto;
  tasks: readonly PblTaskViewDto[];
  milestones: readonly PblMilestoneEvaluationDto[];
}): PblPublicProjectStateDto => ({
  version: 1,
  definition: publicPblProjectDefinition(input.definition),
  binding: input.binding,
  tasks: input.tasks.map((task) => ({
    ...task,
    ownDraftTitle: null,
    deterministic: task.deterministic.map((outcome) => ({ ...outcome })),
  })),
  milestones: input.milestones.map((milestone) => ({
    milestoneId: milestone.milestoneId,
    deterministic: milestone.deterministic.map((outcome) => ({ ...outcome })),
    reached: milestone.reached,
  })),
});

const duplicates = (values: readonly string[]): string[] =>
  values.filter((value, index) => values.indexOf(value) !== index);

/** 单条检查能否真的被判定（条件不能引用不存在的东西，也不允许自引用）。 */
const assertPblCheckRunnable = (
  definition: PblProjectDefinitionDto,
  check: PblDeterministicCheckDto,
  ownMilestoneId: string | null,
): void => {
  if (!PBL_CHECK_KINDS.includes(check.kind))
    invalid('unsupported_pbl_check_kind', { checkId: check.id });
  if (check.kind === 'milestone_reached') {
    const known = definition.milestones.some((milestone) => milestone.id === check.milestoneId);
    if (!known)
      invalid('unknown_milestone_reference', { checkId: check.id, milestoneId: check.milestoneId });
    if (ownMilestoneId !== null && ownMilestoneId === check.milestoneId) {
      invalid('milestone_self_reference', { checkId: check.id, milestoneId: ownMilestoneId });
    }
  }
  if (
    check.kind === 'contribution_acknowledged' &&
    !definition.roles.some((role) => role.kind !== 'learner')
  ) {
    // 要求「认领 AI 贡献」却没有协作席位：这条检查永远无法通过。
    invalid('acknowledge_check_without_ai_role', { checkId: check.id });
  }
  if (check.kind === 'deliverable_contains') {
    const blank = check.fragments.filter((fragment) => fragment.trim().length === 0);
    if (blank.length > 0) invalid('empty_check_fragment', { checkId: check.id });
  }
  if (
    (check.kind === 'deliverable_submitted' ||
      check.kind === 'deliverable_contains' ||
      check.kind === 'deliverable_min_length') &&
    check.artifactKind !== null &&
    !PBL_ARTIFACT_KINDS.includes(check.artifactKind)
  ) {
    invalid('unknown_artifact_kind', { checkId: check.id, artifactKind: check.artifactKind });
  }
};

/**
 * 冻结前的定义自洽校验（OMA-046「真实 PBL 场景，有项目背景、角色与目标」）。
 *
 * 「真实」不是靠模型自称成立的：情境、角色、目标、阶段任务、里程碑、评分依据必须互相闭环。
 * 任何一处引用落空都在冻结时被拒，避免出现「任务说要做但检查读不到产物」的静默空场景。
 */
export const assertPblDefinitionCoherent = (definition: PblProjectDefinitionDto): void => {
  const roleIds = definition.roles.map((role) => role.id);
  const taskIds = definition.tasks.map((task) => task.id);
  const milestoneIds = definition.milestones.map((milestone) => milestone.id);
  const rubricIds = definition.rubrics.map((rubric) => rubric.id);
  for (const [label, ids] of [
    ['role', roleIds],
    ['task', taskIds],
    ['milestone', milestoneIds],
    ['rubric', rubricIds],
    ['goal', definition.goals.map((goal) => goal.id)],
  ] as const) {
    const repeated = duplicates(ids);
    if (repeated.length > 0) invalid(`duplicate_${label}_ids`, { repeated });
  }

  // 检查编号在项目内全局唯一：跨阶段/跨里程碑重名会让确定性结论指向错误的检查。
  const repeatedChecks = duplicates([
    ...definition.projectChecks.map((check) => check.id),
    ...definition.tasks.flatMap((task) => task.checks.map((check) => check.id)),
    ...definition.milestones.flatMap((milestone) => milestone.checks.map((check) => check.id)),
  ]);
  if (repeatedChecks.length > 0) invalid('duplicate_check_ids', { repeated: repeatedChecks });

  // 至少一个真人席位：PBL 的交付主体必须是人，否则「本人交付」无从谈起。
  if (!definition.roles.some((role) => role.kind === 'learner'))
    invalid('pbl_requires_learner_role');
  // 真人席位必须绑定成员 UID，且一个人不能占两个席位（否则交付归属含糊）。
  if (definition.roles.some((role) => role.kind === 'learner' && role.memberUid === null)) {
    invalid('learner_role_without_member');
  }
  const repeatedUids = duplicates(
    definition.roles
      .filter((role) => role.memberUid !== null)
      .map((role) => role.memberUid as string),
  );
  if (repeatedUids.length > 0) invalid('duplicate_member_uid', { repeated: repeatedUids });

  for (const task of definition.tasks) {
    const unknownRoles = task.roleIds.filter((roleId) => !roleIds.includes(roleId));
    if (unknownRoles.length > 0) invalid('unknown_role_in_task', { taskId: task.id, unknownRoles });
    // 只有真人席位能承接任务：协作席位可以建议，但不能「开任务」或交付。
    const nonLearner = task.roleIds.filter(
      (roleId) => definition.roles.find((role) => role.id === roleId)!.kind !== 'learner',
    );
    if (nonLearner.length > 0)
      invalid('ai_role_cannot_claim_task', { taskId: task.id, nonLearner });
    const unknownMilestones = task.milestoneIds.filter(
      (milestoneId) => !milestoneIds.includes(milestoneId),
    );
    if (unknownMilestones.length > 0)
      invalid('unknown_milestone_in_task', { taskId: task.id, unknownMilestones });
    for (const check of task.checks) {
      assertPblCheckRunnable(definition, check, null);
      if (check.kind === 'milestone_reached' && !milestoneIds.includes(check.milestoneId)) {
        invalid('unknown_milestone_reference', { checkId: check.id, taskId: task.id });
      }
    }
  }

  const orderOf = new Map(
    definition.milestones.map((milestone) => [milestone.id, milestone.order]),
  );
  const repeatedOrders = duplicates(definition.milestones.map((milestone) => `${milestone.order}`));
  if (repeatedOrders.length > 0) invalid('duplicate_milestone_order', { repeated: repeatedOrders });

  for (const milestone of definition.milestones) {
    const unknownTasks = milestone.taskIds.filter((taskId) => !taskIds.includes(taskId));
    if (unknownTasks.length > 0)
      invalid('unknown_task_in_milestone', { milestoneId: milestone.id, unknownTasks });
    const unknownRubrics = milestone.rubricIds.filter((rubricId) => !rubricIds.includes(rubricId));
    if (unknownRubrics.length > 0)
      invalid('unknown_rubric_in_milestone', { milestoneId: milestone.id, unknownRubrics });
    for (const check of milestone.checks) {
      assertPblCheckRunnable(definition, check, milestone.id);
      if (check.kind === 'milestone_reached') {
        const prerequisite = orderOf.get(check.milestoneId);
        // 前序不存在，或指向自己/更晚的里程碑，都构成依赖环或永远等不到的检查。
        if (prerequisite === undefined || prerequisite >= milestone.order) {
          invalid('milestone_dependency_not_earlier', {
            milestoneId: milestone.id,
            prerequisite: check.milestoneId,
          });
        }
      }
    }
  }
  for (const check of definition.projectChecks) assertPblCheckRunnable(definition, check, null);
};

/**
 * 定义是否已冻结复验（OMA-046 / OMA-049 的前置门）。
 *
 * 未冻结就没有可核验的判定条件，任何写入都应停在「先审核项目定义」，
 * 而不是先接受一个来路不明的项目正文。落库正文每次读取都重跑自洽校验：
 * 定义被改写过的记录不再驱动判定（破损是数据问题，按内部错误报，不伪装成参数不合法）。
 */
export const assertPblDefinitionFrozen = (frozen: PblFrozenDto | null): PblFrozenDto => {
  if (!frozen) rejected('CLASSROOM_SCENE_SOURCE_MISSING', 'pbl_definition_not_frozen');
  const parsed = pblFrozenSchema.safeParse(frozen);
  if (!parsed.success) rejected('INTERNAL', 'invalid_pbl_frozen_definition');
  try {
    assertPblDefinitionCoherent(parsed.data!.definition);
  } catch (error) {
    if (isStudyError(error) && error.code === 'INVALID_ARGUMENT') {
      rejected('INTERNAL', 'pbl_frozen_definition_incoherent', { cause: error.details });
    }
    throw error;
  }
  return parsed.data!;
};

/** 绑定是否指向这份冻结定义（防止用旧绑定写新定义，或把别的项目的绑定挪过来）。 */
export const assertPblBindingMatchesFrozen = (
  frozen: PblFrozenDto,
  binding: PblBindingDto,
): void => {
  const parsed = pblBindingSchema.safeParse(binding);
  if (!parsed.success) rejected('VERSION_CONFLICT', 'pbl_binding_malformed');
  // 摘要取自传入的冻结定义对象本身（与 formal-interaction 同口径），不用重解析结果——
  // 否则将来给 schema 加一个默认值就会让全部历史绑定的摘要漂移。
  if (parsed.data!.definitionDigest !== pblHash(frozen.definition)) {
    rejected('VERSION_CONFLICT', 'pbl_binding_stale');
  }
  if (parsed.data!.definitionId !== frozen.definition.id) {
    rejected('VERSION_CONFLICT', 'pbl_binding_definition_mismatch');
  }
};

/** 命令作用域与当前打开项目是否一致（跨项目/跨代次写入在此拒绝）。 */
export const assertPblCommandScope = (
  scope: { projectId: string; generation: number },
  facts: { projectId: string; generation: number },
): void => {
  if (scope.projectId !== facts.projectId)
    rejected('PROJECT_NOT_AUTHORIZED', 'pbl_project_mismatch');
  if (scope.generation !== facts.generation)
    rejected('PROJECT_GENERATION_STALE', 'pbl_generation_mismatch');
};

/** 席位种类派生的权限表（OMA-049「守权限」；没有任何一处可以自报权限位）。 */
export const pblRolePermissions = (
  role: PblProjectRoleDto,
): {
  canOpenTask: boolean;
  canSubmitDeliverable: boolean;
  canAcknowledgeContribution: boolean;
  canRequestFeedback: boolean;
  canAcceptEvaluation: boolean;
  canWriteAiContribution: boolean;
  canGiveFeedback: boolean;
  canProposeAssessment: boolean;
  /** 字面量 false：达成里程碑不是任何席位的权限，而是确定性检查的结果。 */
  canReachMilestone: false;
} => {
  const human = role.kind === 'learner';
  return {
    canOpenTask: human,
    canSubmitDeliverable: human,
    canAcknowledgeContribution: human,
    canRequestFeedback: human,
    canAcceptEvaluation: human,
    canWriteAiContribution: !human,
    canGiveFeedback: !human,
    canProposeAssessment: !human,
    canReachMilestone: false,
  };
};

/** 动作 → 所需权限位（演练与正式写入共用这一张表，不给演练开后门）。 */
const PBL_OPERATION_PERMISSION: Record<
  PblSimulationOperation,
  keyof ReturnType<typeof pblRolePermissions>
> = {
  open: 'canOpenTask',
  update: 'canOpenTask',
  submit: 'canSubmitDeliverable',
  contribute: 'canWriteAiContribution',
  acknowledge: 'canAcknowledgeContribution',
  requestFeedback: 'canRequestFeedback',
  feedback: 'canGiveFeedback',
  assess: 'canProposeAssessment',
  acceptEvaluation: 'canAcceptEvaluation',
};

/** 某席位能否执行某动作（返回布尔，供呈现层决定按钮；写入门禁仍逐次调 `assertPblOperationAllowed`）。 */
export const pblOperationAllowed = (role: PblProjectRoleDto, operation: string): boolean => {
  const key = PBL_OPERATION_PERMISSION[operation as PblSimulationOperation];
  return key !== undefined && pblRolePermissions(role)[key] === true;
};

/** 动作门禁：席位不符直接拒。 */
export const assertPblOperationAllowed = (role: PblProjectRoleDto, operation: string): void => {
  if (!pblOperationAllowed(role, operation)) {
    rejected('ROLE_PERMISSION_DENIED', 'pbl_seat_cannot_run_operation', {
      operation,
      roleKind: role.kind,
    });
  }
};

/** 按 UID 找席位（真人或协作）；找不到就是非成员。 */
export const pblRoleByUid = (
  definition: PblProjectDefinitionDto,
  uid: string,
): PblProjectRoleDto => {
  const role = definition.roles.find((candidate) => candidate.memberUid === uid);
  if (!role) rejected('ROLE_PERMISSION_DENIED', 'not_project_member');
  return role!;
};

/** 按 UID 找真人席位（交付/认领/任务/采纳/请求反馈的入口守卫）。 */
export const pblLearnerRole = (
  definition: PblProjectDefinitionDto,
  uid: string,
): PblProjectRoleDto => {
  const role = pblRoleByUid(definition, uid);
  if (role.kind !== 'learner') {
    rejected('ROLE_PERMISSION_DENIED', 'learner_seat_required', { roleKind: role.kind });
  }
  return role;
};

/**
 * 协作席位守卫（贡献/反馈/评价候选）。
 *
 * 「真人不能冒充 AI 产物」与「未登记的协作席位不能凭空拿一个 UID 当模型」都在这里：
 * 未登记的协作席位 `memberUid === null`，永远匹配不上任何传入的 UID，所以会被 `not_project_member` 拒。
 */
export const pblCollaboratorRole = (
  definition: PblProjectDefinitionDto,
  uid: string,
): PblProjectRoleDto => {
  const role = pblRoleByUid(definition, uid);
  if (role.kind === 'learner') {
    rejected('ROLE_PERMISSION_DENIED', 'ai_seat_required', { roleKind: role.kind });
  }
  return role;
};

/** 该 UID 是否项目成员（读取路径用它决定给不给私人内容，不抛错）。 */
export const pblIsMember = (definition: PblProjectDefinitionDto, uid: string | null): boolean =>
  uid !== null && definition.roles.some((role) => role.memberUid === uid);

/**
 * 写入命令的权限守卫（OMA-049）。
 *
 * 每个写入命令的「谁能发」在这里判一次并返回实际使用的席位；权限来自席位种类派生，
 * 而不是请求里的任何布尔位。`review` / `simulate` 不是席位动作，单独拒。
 */
export const pblCommandActorRole = (
  definition: PblProjectDefinitionDto,
  command: PblCommand,
): { role: PblProjectRoleDto; ai: boolean } => {
  switch (command.operation) {
    case 'draft':
    case 'submit':
    case 'acknowledge':
    case 'task':
    case 'requestFeedback':
    case 'acceptEvaluation':
      return { role: pblLearnerRole(definition, command.actorUid), ai: false };
    case 'contribute':
    case 'feedback':
    case 'assess':
      return { role: pblCollaboratorRole(definition, command.actorUid), ai: true };
    case 'review':
    case 'simulate':
      return rejected('ROLE_PERMISSION_DENIED', 'pbl_operation_is_not_a_seat_action');
  }
};

/** 开任务与任务更新的第二道门：任务存在，且该席位被本阶段允许承接。 */
export const assertPblTaskOpenable = (
  definition: PblProjectDefinitionDto,
  taskId: string,
  roleId: string,
): PblPhaseTaskDto => {
  const task = definition.tasks.find((candidate) => candidate.id === taskId);
  if (!task) rejected('NOT_FOUND', 'pbl_task_not_in_definition', { taskId });
  if (!task!.roleIds.includes(roleId)) {
    rejected('ROLE_PERMISSION_DENIED', 'role_not_allowed_for_task', { taskId, roleId });
  }
  return task!;
};

/** 交付形态是否被该阶段任务接受（防止把「复盘日志」塞进「原型」阶段绕过形态检查）。 */
export const assertPblArtifactKindAllowed = (
  task: PblPhaseTaskDto,
  artifactKind: PblArtifactKind,
): void => {
  if (!PBL_ARTIFACT_KINDS.includes(artifactKind))
    invalid('unknown_artifact_kind', { artifactKind });
  if (!task.artifactKinds.includes(artifactKind)) {
    invalid('artifact_kind_not_allowed', { taskId: task.id, artifactKind });
  }
};

/** 交付所声明的里程碑与目标是否都在定义里（引用落空的交付不参与判定，直接拒）。 */
export const assertPblDeliverableReferences = (
  definition: PblProjectDefinitionDto,
  payload: PblDeliverablePayloadInput,
): void => {
  if (
    payload.milestoneId !== null &&
    !definition.milestones.some((milestone) => milestone.id === payload.milestoneId)
  ) {
    invalid('unknown_milestone_reference', { milestoneId: payload.milestoneId });
  }
  const goals = new Set(definition.goals.map((goal) => goal.id));
  const unknown = payload.goalIds.filter((goalId) => !goals.has(goalId));
  if (unknown.length > 0) invalid('unknown_goal_reference', { unknown });
};

/** 一次写入所需的服务端事实：身份、时间与席位都由应用层给出，客户端没有对应字段可填。 */
export interface PblServerFacts {
  uid: string;
  createdAt: string;
  /** 该会话持有的席位（真人成员或已登记协作席位），由存储层/会话确定。 */
  role: PblProjectRoleDto;
}

/**
 * 构造本人交付记录。
 *
 * 客户端能影响的只有 `pblDeliverablePayloadSchema` 的字段；`uid` / `actorType` /
 * `recordScope` / `binding` / `createdAt` 全部来自 `PblServerFacts` 与命令绑定，
 * 所以这条记录不可能是「对方冒充的我」。
 */
export const pblDeliverableRecordFrom = (
  command: Extract<PblCommand, { operation: 'submit' }>,
  facts: PblServerFacts,
): PblDeliverableRecordDto => ({
  version: 1,
  uid: facts.uid,
  recordScope: 'formal',
  binding: command.binding,
  createdAt: facts.createdAt,
  nonce: command.nonce,
  kind: 'deliverable',
  actorType: 'human_learner',
  ...command.deliverable,
});

/** 构造 AI 贡献记录：`actorType` 按席位种类派生，认领字段留空由本人的认领动作填。 */
export const pblContributionRecordFrom = (
  command: Extract<PblCommand, { operation: 'contribute' }>,
  facts: PblServerFacts,
): PblAiContributionRecordDto => {
  if (command.contribution.roleId !== facts.role.id) {
    rejected('ROLE_PERMISSION_DENIED', 'contribution_seat_mismatch');
  }
  return {
    version: 1,
    uid: facts.uid,
    recordScope: 'formal',
    binding: command.binding,
    createdAt: facts.createdAt,
    nonce: command.nonce,
    kind: 'contribution',
    actorType: pblAiActorTypeOfSeat(facts.role.kind),
    ...command.contribution,
    acknowledgedByUid: null,
    acknowledgedAt: null,
  };
};

/**
 * 席位种类 → 记录 `actorType`。
 *
 * 定义里的 `mentor` 记录到 `teacher_ai`（导师席产出的就是教师侧 AI 输出），
 * `peer_ai` 保持 `peer_ai`，真人席位保持 `human_learner`。映射只在这里一处，
 * 所以「反馈记录的 actorType」不可能与「出具它的席位种类」对不上。
 */
export const pblActorTypeOfSeat = (
  kind: PblRoleKind,
): 'human_learner' | 'teacher_ai' | 'peer_ai' =>
  kind === 'learner' ? 'human_learner' : kind === 'peer_ai' ? 'peer_ai' : 'teacher_ai';

/**
 * 协作席位的 `actorType`（AI 贡献专用：合同里这条记录的枚举不含 `human_learner`）。
 *
 * 真人席位走到这里说明调用方漏了 `pblCollaboratorRole` 守卫——按越权拒，而不是替它选一个值。
 */
export const pblAiActorTypeOfSeat = (kind: PblRoleKind): 'teacher_ai' | 'peer_ai' => {
  if (kind === 'learner')
    rejected('ROLE_PERMISSION_DENIED', 'ai_seat_required', { roleKind: kind });
  return kind === 'peer_ai' ? 'peer_ai' : 'teacher_ai';
};

/** 构造导师反馈记录（`actorType` 按席位派生，客户端不能自报）。 */
export const pblFeedbackRecordFrom = (
  command: Extract<PblCommand, { operation: 'feedback' }>,
  facts: PblServerFacts,
): PblMentorFeedbackRecordDto => ({
  version: 1,
  uid: facts.uid,
  recordScope: 'formal',
  binding: command.binding,
  createdAt: facts.createdAt,
  nonce: command.nonce,
  kind: 'feedback',
  actorType: pblActorTypeOfSeat(facts.role.kind),
  ...command.feedback,
});

/** 构造评价记录（只装候选；采纳结论由真人另发 `acceptEvaluation`，不写在这里）。 */
export const pblAssessmentRecordFrom = (
  command: Extract<PblCommand, { operation: 'assess' }>,
  facts: PblServerFacts,
): PblAssessmentRecordDto => {
  if (command.assessment.roleId !== null && command.assessment.roleId !== facts.role.id) {
    rejected('ROLE_PERMISSION_DENIED', 'assessment_seat_mismatch');
  }
  return {
    version: 1,
    uid: facts.uid,
    recordScope: 'formal',
    binding: command.binding,
    createdAt: facts.createdAt,
    nonce: command.nonce,
    kind: 'assessment',
    actorType: pblActorTypeOfSeat(facts.role.kind),
    milestoneId: command.assessment.milestoneId,
    roleId: command.assessment.roleId ?? facts.role.id,
    candidates: command.assessment.candidates,
    goalIds: command.assessment.goalIds,
  };
};

/**
 * 构造人工采纳记录（只有真人成员能出）。
 *
 * 采纳指向一条已落库的评价记录；`milestoneId` 从那条记录取，调用方给不了——
 * 因此「采纳候选」这件事绑不到一个错误的里程碑上。
 */
export const pblAcceptanceRecordFrom = (
  command: Extract<PblCommand, { operation: 'acceptEvaluation' }>,
  facts: PblServerFacts,
  target: PblAssessmentRecordDto,
): PblEvaluationAcceptanceRecordDto => {
  if (facts.role.kind !== 'learner') {
    rejected('ROLE_PERMISSION_DENIED', 'only_learner_accepts_evaluation');
  }
  return {
    version: 1,
    uid: facts.uid,
    recordScope: 'formal',
    binding: command.binding,
    createdAt: facts.createdAt,
    nonce: command.nonce,
    kind: 'acceptance',
    actorType: 'human_learner',
    milestoneId: target.milestoneId,
    assessmentNonce: target.nonce,
    acceptedCandidateIds: command.acceptedCandidateIds,
  };
};

/** 构造认领记录（把某条 AI 贡献标为「我已吸收/已核实」，不改它的内容与作者）。 */
export const pblAcknowledgeRecordFrom = (
  command: Extract<PblCommand, { operation: 'acknowledge' }>,
  facts: PblServerFacts,
): PblAcknowledgeRecordDto => ({
  version: 1,
  uid: facts.uid,
  recordScope: 'formal',
  binding: command.binding,
  createdAt: facts.createdAt,
  nonce: command.nonce,
  kind: 'acknowledge',
  actorType: 'human_learner',
  contributionNonce: command.contributionNonce,
  note: command.note,
});

/**
 * 构造开任务 / 任务更新记录（OMA-049「开任务/任务更新均实际运行」）。
 *
 * `derivedStatus` 由调用方在同一次写入里用 `pblTaskViews` 重算后传入，客户端没有这个字段：
 * 所以「我申报已完成」与「服务端认定已达成的状态」是两条信息，前者进 `reportedStatus`
 * （枚举里没有 `verified`），后者进 `derivedStatus`。
 */
export const pblTaskProgressRecordFrom = (
  command: Extract<PblCommand, { operation: 'task' }>,
  facts: PblServerFacts,
  derivedStatus: PblTaskStatus,
): PblTaskProgressRecordDto => ({
  version: 1,
  uid: facts.uid,
  recordScope: 'formal',
  binding: command.binding,
  createdAt: facts.createdAt,
  nonce: command.nonce,
  kind: 'task_progress',
  actorType: 'human_learner',
  intent: command.intent,
  taskId: command.taskId,
  roleId: command.intent === 'open' ? command.roleId : facts.role.id,
  reportedStatus: command.reportedStatus,
  report: command.report,
  derivedStatus,
});

/** 构造草稿（与提交的区别只在正文可为空）。 */
export const pblDraftFrom = (
  command: Pick<Extract<PblCommand, { operation: 'draft' }>, 'binding' | 'draft' | 'nonce'>,
  facts: PblServerFacts,
): PblDeliverableDraftDto => ({
  version: 1,
  uid: facts.uid,
  recordScope: 'formal',
  binding: command.binding,
  updatedAt: facts.createdAt,
  nonce: command.nonce,
  ...command.draft,
});

/** 草稿 → 交付载荷（提交时正文必须非空，由 `pblDeliverablePayloadSchema` 把关）。 */
export const pblDraftPayload = (draft: PblDeliverableDraftDto): PblDeliverablePayloadInput => ({
  taskId: draft.taskId,
  milestoneId: draft.milestoneId,
  artifactKind: draft.artifactKind,
  artifactTitle: draft.artifactTitle,
  artifactText: draft.artifactText,
  assetRefs: draft.assetRefs,
  goalIds: draft.goalIds,
});

/** 判定引擎的输入（合同形状的类型别名；读代码时一眼看出这条数据是干什么用的）。 */
export type PblEvidence = PblRunEvidenceDto;

/**
 * 正式记录 → 判定证据。
 *
 * 身份字段逐字搬，不做任何「宽容修正」：一条 `actorType` 与内容不符的记录会在
 * `assertPblRecordGroundedInDefinition` 里被拒，而不是在这里被悄悄改对。
 */
export const pblEvidenceFromRecord = (record: PblRecordDto): PblEvidence => {
  const shared = {
    version: 1 as const,
    source: 'formal_record' as const,
    recordScope: 'formal' as const,
    uid: record.uid,
    actorType: record.actorType,
    nonce: record.nonce,
    createdAt: record.createdAt,
    taskId: null as string | null,
    milestoneId: null as string | null,
    artifactKind: null as PblArtifactKind | null,
    artifactText: null as string | null,
    contributionNonce: null as string | null,
    assessmentNonce: null as string | null,
    reportedStatus: null as PblReportableTaskStatus | null,
    basisArtifactIds: [] as string[],
    candidates: [] as PblAssessmentCandidateDto[],
    acceptedCandidateIds: [] as string[],
    goalIds: [] as string[],
    roleId: null as string | null,
  };
  switch (record.kind) {
    case 'deliverable':
      return {
        ...shared,
        operation: 'submit',
        taskId: record.taskId,
        milestoneId: record.milestoneId,
        artifactKind: record.artifactKind,
        artifactText: record.artifactText,
        goalIds: record.goalIds,
      };
    case 'contribution':
      return {
        ...shared,
        operation: 'contribute',
        roleId: record.roleId,
        taskId: record.taskId,
        milestoneId: record.milestoneId,
        basisArtifactIds: record.basisArtifactIds,
      };
    case 'feedback':
      return {
        ...shared,
        operation: 'feedback',
        taskId: record.taskId,
        milestoneId: record.milestoneId,
        basisArtifactIds: record.basisArtifactIds,
      };
    case 'assessment':
      return {
        ...shared,
        operation: 'assess',
        roleId: record.roleId,
        milestoneId: record.milestoneId,
        basisArtifactIds: record.candidates.flatMap((candidate) => candidate.basisArtifactIds),
        candidates: record.candidates,
        goalIds: record.goalIds,
      };
    case 'acceptance':
      return {
        ...shared,
        operation: 'acceptEvaluation',
        milestoneId: record.milestoneId,
        assessmentNonce: record.assessmentNonce,
        acceptedCandidateIds: record.acceptedCandidateIds,
      };
    case 'acknowledge':
      return {
        ...shared,
        operation: 'acknowledge',
        contributionNonce: record.contributionNonce,
        // 认领证据带上被认领贡献的归属，使「这条认领属于哪个任务」不必回查贡献记录也能对齐。
        basisArtifactIds: [],
      };
    case 'task_progress':
      return {
        ...shared,
        operation: record.intent,
        roleId: record.roleId,
        taskId: record.taskId,
        reportedStatus: record.reportedStatus,
      };
  }
};

/** 演练数据的时间戳固定为纪元零点：演练不是真实时刻发生的事，也不参与任何时序权威。 */
const DEMO_TIMESTAMP = '1970-01-01T00:00:00.000Z';

/**
 * 演练单步 → 判定证据（`recordScope: 'demo'`）。
 *
 * 与正式证据同形，差别只在来源与分区：判定不看来源放水，而写入路径拿不到它的正式形状。
 */
export const pblEvidenceFromStep = (
  step: PblSimulationStepInput,
  facts: { role: PblProjectRoleDto },
): PblEvidence => {
  const actorType = pblActorTypeOfSeat(facts.role.kind);
  const operation = step.operation;
  return pblRunEvidenceSchema.parse({
    version: 1,
    source: 'simulation',
    recordScope: 'demo',
    uid: step.actorUid,
    roleId: facts.role.id,
    actorType,
    operation,
    nonce: step.nonce,
    createdAt: DEMO_TIMESTAMP,
    taskId: step.taskId,
    milestoneId:
      step.milestoneId ??
      step.assessment?.milestoneId ??
      step.feedback?.milestoneId ??
      step.contribution?.milestoneId ??
      null,
    artifactKind: step.deliverable?.artifactKind ?? null,
    artifactText: step.deliverable?.artifactText ?? null,
    contributionNonce: step.contributionNonce,
    assessmentNonce: step.assessmentNonce,
    reportedStatus: step.reportedStatus,
    basisArtifactIds:
      step.feedback?.basisArtifactIds ??
      step.contribution?.basisArtifactIds ??
      step.assessment?.candidates.flatMap((candidate) => candidate.basisArtifactIds) ??
      step.artifactIds ??
      [],
    candidates: step.assessment?.candidates ?? [],
    acceptedCandidateIds: step.acceptedCandidateIds ?? [],
    goalIds: step.deliverable?.goalIds ?? [],
  });
};

/** 拆分证据（按动作种类），并吸收同 nonce 重试（重试不重复计数）。 */
export interface PblEvidenceSets {
  submissions: PblEvidence[];
  contributions: PblEvidence[];
  feedback: PblEvidence[];
  assessments: PblEvidence[];
  acceptances: PblEvidence[];
  acknowledgements: PblEvidence[];
  taskActions: PblEvidence[];
}

export const pblSplitEvidence = (evidence: readonly PblEvidence[]): PblEvidenceSets => {
  const sets: PblEvidenceSets = {
    submissions: [],
    contributions: [],
    feedback: [],
    assessments: [],
    acceptances: [],
    acknowledgements: [],
    taskActions: [],
  };
  const seen = new Set<string>();
  for (const item of evidence) {
    // 幂等：同来源 + 同作者 + 同 nonce 只算一次，否则一次重试会把「本人交付 1 次」读成 2 次。
    const key = `${item.source}|${item.uid}|${item.nonce}`;
    if (seen.has(key)) continue;
    seen.add(key);
    switch (item.operation) {
      case 'submit':
        sets.submissions.push(item);
        break;
      case 'contribute':
        sets.contributions.push(item);
        break;
      case 'feedback':
        sets.feedback.push(item);
        break;
      case 'assess':
        sets.assessments.push(item);
        break;
      case 'acceptEvaluation':
        sets.acceptances.push(item);
        break;
      case 'acknowledge':
        sets.acknowledgements.push(item);
        break;
      case 'open':
      case 'update':
        sets.taskActions.push(item);
        break;
    }
  }
  return sets;
};

/**
 * 已被本人认领的 AI 贡献 nonce 集合（OMA-047）。
 *
 * 只统计指向真实存在的贡献的认领：一条悬空认领不增加计数，
 * 所以「凭空说一句我认领过了」凑不出检查的通过条件。
 */
export const pblAcknowledgedContributionNonces = (
  sets: Pick<PblEvidenceSets, 'acknowledgements' | 'contributions'>,
): Set<string> => {
  const existing = new Set(sets.contributions.map((item) => item.nonce));
  return new Set(
    sets.acknowledgements
      .filter((item) => item.contributionNonce !== null && existing.has(item.contributionNonce))
      .map((item) => item.contributionNonce as string),
  );
};

/** 一条检查的可见证据范围。 */
export interface PblCheckContext {
  deliverables: readonly PblEvidence[];
  contributions: readonly PblEvidence[];
  acknowledgedNonces: ReadonlySet<string>;
  reachedMilestoneIds: ReadonlySet<string>;
}

/**
 * 运行一条确定性检查（判定式只在这里，输入只有定义里的条件与已落库证据）。
 *
 * 未知种类不是「跳过」而是拒绝：一条拼错种类的检查看起来会通过，正是这类静默放行
 * 会让里程碑在什么都没交付时被标为达成。
 */
export const runPblDeterministicCheck = (
  check: PblDeterministicCheckDto,
  context: PblCheckContext,
): PblDeterministicOutcomeDto => {
  // 交付类检查只统计形态匹配的交付；artifactKind 为 null 表示任一形态都算。
  const scoped =
    check.kind === 'deliverable_submitted' ||
    check.kind === 'deliverable_contains' ||
    check.kind === 'deliverable_min_length'
      ? context.deliverables.filter(
          (item) => check.artifactKind === null || item.artifactKind === check.artifactKind,
        )
      : context.deliverables;
  const evidence = scoped.map(evidenceArtifactId);
  const outcome = (
    passed: boolean,
    detail: string,
    ids: string[] = evidence,
  ): PblDeterministicOutcomeDto => ({
    checkId: check.id,
    kind: check.kind,
    passed,
    detail,
    evidenceArtifactIds: ids,
  });
  switch (check.kind) {
    case 'deliverable_submitted':
      return outcome(
        scoped.length > 0,
        scoped.length > 0 ? `submitted:${scoped.length}` : 'no_deliverable',
        scoped.length > 0 ? evidence : [],
      );
    case 'deliverable_min_length': {
      if (scoped.length === 0) return outcome(false, 'no_deliverable', []);
      const longest = scoped.reduce(
        (max, item) => Math.max(max, (item.artifactText ?? '').length),
        0,
      );
      return outcome(
        longest >= check.minChars,
        `chars:${longest}<${check.minChars}=${longest < check.minChars}`,
      );
    }
    case 'deliverable_contains': {
      if (scoped.length === 0) return outcome(false, 'no_deliverable', []);
      const joined = scoped.map((item) => item.artifactText ?? '').join('\n');
      const missing = check.fragments.filter((fragment) => !joined.includes(fragment));
      return outcome(
        missing.length === 0,
        missing.length === 0 ? 'all_fragments_present' : `missing_fragment:${missing.join(',')}`,
      );
    }
    case 'contribution_acknowledged': {
      const count = context.contributions.filter((item) =>
        context.acknowledgedNonces.has(item.nonce),
      ).length;
      return outcome(
        count >= check.minAcknowledged,
        `acknowledged:${count}<${check.minAcknowledged}=${count < check.minAcknowledged}`,
        [],
      );
    }
    case 'milestone_reached': {
      const reached = context.reachedMilestoneIds.has(check.milestoneId);
      return outcome(
        reached,
        reached
          ? `milestone_reached:${check.milestoneId}`
          : `milestone_not_reached:${check.milestoneId}`,
        [],
      );
    }
  }
  return invalid('unsupported_pbl_check_kind', { kind: (check as { kind: string }).kind });
};

/** 里程碑可见的本人交付（显式挂在里程碑上的，或落在该里程碑覆盖的任务上的）。 */
const milestoneDeliverables = (
  milestone: PblMilestoneDto,
  sets: PblEvidenceSets,
): PblEvidence[] => {
  const taskIds = new Set(milestone.taskIds);
  return sets.submissions.filter(
    (item) =>
      item.milestoneId === milestone.id ||
      (item.milestoneId === null && item.taskId !== null && taskIds.has(item.taskId)),
  );
};

const milestoneContributions = (
  milestone: PblMilestoneDto,
  sets: PblEvidenceSets,
): PblEvidence[] => {
  const taskIds = new Set(milestone.taskIds);
  return sets.contributions.filter(
    (item) =>
      item.milestoneId === milestone.id ||
      (item.milestoneId === null && item.taskId !== null && taskIds.has(item.taskId)),
  );
};

/**
 * 逐里程碑评估（OMA-047 里程碑 + OMA-048 两条线）。
 *
 * 两件事严格分开：
 * - **确定性检查**：`reached = 全部通过`，只看已存在的交付/认领/前序里程碑；
 *   里程碑按 `order` 递增累计，使 `milestone_reached` 不可能成环。
 * - **评价候选**：AI 候选与人工采纳结论并列放在 `assessment` 里，
 *   **不参与** `every`——候选再多、全被采纳也不会让里程碑达成。
 *
 * 演练证据与正式证据走同一个函数，唯一区别是来源标记；因此「模拟器里跑到达成」与
 * 「正式记录里达成」的判定式完全一致。
 */
export const pblMilestoneEvaluationsFromSets = (
  definition: PblProjectDefinitionDto,
  sets: PblEvidenceSets,
): PblMilestoneEvaluationDto[] => {
  const acknowledgedNonces = pblAcknowledgedContributionNonces(sets);
  const ordered = [...definition.milestones].sort((left, right) => left.order - right.order);
  const reachedSoFar = new Set<string>();
  // 采纳只加在它所指向的那条评价记录上：指向不存在评价的采纳不会产生任何被采纳的候选。
  const acceptedByAssessmentNonce = new Map<string, string[]>();
  for (const acceptance of sets.acceptances) {
    if (acceptance.assessmentNonce === null) continue;
    const known = acceptedByAssessmentNonce.get(acceptance.assessmentNonce) ?? [];
    acceptedByAssessmentNonce.set(acceptance.assessmentNonce, [
      ...known,
      ...acceptance.acceptedCandidateIds,
    ]);
  }
  return ordered.map((milestone) => {
    const deliverables = milestoneDeliverables(milestone, sets);
    const deterministic = milestone.checks.map((check) =>
      runPblDeterministicCheck(check, {
        deliverables,
        contributions: milestoneContributions(milestone, sets),
        acknowledgedNonces,
        reachedMilestoneIds: new Set(reachedSoFar),
      }),
    );
    const reached = deterministic.every((outcome) => outcome.passed);
    if (reached) reachedSoFar.add(milestone.id);
    const assessments = sets.assessments.filter((item) => item.milestoneId === milestone.id);
    const candidates = assessments.flatMap((item) => item.candidates);
    const knownCandidateIds = new Set(candidates.map((candidate) => candidate.candidateId));
    const accepted = assessments
      .flatMap((item) => acceptedByAssessmentNonce.get(item.nonce) ?? [])
      .filter((candidateId) => knownCandidateIds.has(candidateId));
    return {
      milestoneId: milestone.id,
      deterministic,
      reached,
      assessment: {
        candidates,
        acceptedCandidateIds: [...new Set(accepted)],
        assessmentNonces: assessments.map((item) => item.nonce),
      },
    };
  });
};

/** 入口糖：证据数组 → 里程碑评估。 */
export const pblMilestoneEvaluations = (
  definition: PblProjectDefinitionDto,
  evidence: readonly PblEvidence[],
): PblMilestoneEvaluationDto[] =>
  pblMilestoneEvaluationsFromSets(definition, pblSplitEvidence(evidence));

/** 某阶段任务可见的证据（交付/贡献按 taskId 归属）。 */
const taskEvidence = (task: PblPhaseTaskDto, sets: PblEvidenceSets) => ({
  deliverables: sets.submissions.filter((item) => item.taskId === task.id),
  contributions: sets.contributions.filter((item) => item.taskId === task.id),
});

/** 单任务的确定性检查结论（与里程碑同一判定函数，只是可见范围收窄到本任务）。 */
export const pblTaskCheckOutcomes = (
  sets: PblEvidenceSets,
  task: PblPhaseTaskDto,
  reachedMilestoneIds: ReadonlySet<string>,
): PblDeterministicOutcomeDto[] => {
  const visible = taskEvidence(task, sets);
  return task.checks.map((check) =>
    runPblDeterministicCheck(check, {
      deliverables: visible.deliverables,
      contributions: visible.contributions,
      acknowledgedNonces: pblAcknowledgedContributionNonces(sets),
      reachedMilestoneIds,
    }),
  );
};

/**
 * 权威任务状态（OMA-047「任务状态…重启可读」）。
 *
 * 由证据推导，自上而下取第一条成立者：
 * 1. 有真人交付 → 本阶段检查全部通过则 `verified`，否则 `submitted`；
 * 2. 最新一次申报为 `needs_revision` → `needs_revision`；
 * 3. 有真人开过席位 → `in_progress`；
 * 4. 否则 `available`。
 *
 * 没有「本人申报 verified」这条路（合同枚举里就不存在），草稿也不影响状态——
 * 没有交付就没有可核验的产物。
 */
export const pblTaskStatus = (
  task: PblPhaseTaskDto,
  sets: PblEvidenceSets,
  outcomes: readonly PblDeterministicOutcomeDto[],
): { status: PblTaskStatus; claimedByRoleId: string | null; claimedByUid: string | null } => {
  const actions = sets.taskActions.filter((item) => item.taskId === task.id);
  const latest = (list: PblEvidence[]): PblEvidence | null =>
    list.reduce<PblEvidence | null>(
      (last, item) => (last === null || item.createdAt >= last.createdAt ? item : last),
      null,
    );
  const opened = latest(actions.filter((item) => item.operation === 'open'));
  const updated = latest(actions.filter((item) => item.operation === 'update'));
  const claimedByRoleId = opened?.roleId ?? null;
  const claimedByUid = opened?.uid ?? null;
  const submissions = sets.submissions.filter((item) => item.taskId === task.id);
  if (submissions.length > 0) {
    return {
      status: outcomes.every((outcome) => outcome.passed) ? 'verified' : 'submitted',
      claimedByRoleId,
      claimedByUid,
    };
  }
  if (updated?.reportedStatus === 'needs_revision') {
    return { status: 'needs_revision', claimedByRoleId, claimedByUid };
  }
  if (claimedByRoleId !== null) return { status: 'in_progress', claimedByRoleId, claimedByUid };
  return { status: 'available', claimedByRoleId: null, claimedByUid: null };
};

/**
 * 任务视图（OMA-047 读回）：状态、席位、本人交付与 AI 贡献**分开计数**。
 *
 * 未认领的 AI 贡献只加 `aiContributionCount`，绝不加 `ownSubmissionCount`；
 * 认领只加 `acknowledgedContributionCount`，不复制出一份「本人交付」。
 * 里程碑达成情况作为阶段检查的输入一起算（阶段检查里的 `milestone_reached` 依赖它）。
 */
export const pblTaskViewsFromSets = (
  definition: PblProjectDefinitionDto,
  sets: PblEvidenceSets,
  draft: PblDeliverableDraftDto | null,
): PblTaskViewDto[] => {
  const reachedMilestoneIds = new Set(
    pblMilestoneEvaluationsFromSets(definition, sets)
      .filter((milestone) => milestone.reached)
      .map((milestone) => milestone.milestoneId),
  );
  const acknowledgedNonces = pblAcknowledgedContributionNonces(sets);
  return definition.tasks.map((task) => {
    const deterministic = pblTaskCheckOutcomes(sets, task, reachedMilestoneIds);
    const status = pblTaskStatus(task, sets, deterministic);
    const contributions = sets.contributions.filter((item) => item.taskId === task.id);
    return {
      taskId: task.id,
      status: status.status,
      claimedByRoleId: status.claimedByRoleId,
      claimedByUid: status.claimedByUid,
      ownDraftTitle: draft !== null && draft.taskId === task.id ? draft.artifactTitle : null,
      ownSubmissionCount: sets.submissions.filter((item) => item.taskId === task.id).length,
      aiContributionCount: contributions.length,
      acknowledgedContributionCount: contributions.filter((item) =>
        acknowledgedNonces.has(item.nonce),
      ).length,
      deterministic,
    };
  });
};

export const pblTaskViews = (
  definition: PblProjectDefinitionDto,
  evidence: readonly PblEvidence[],
  draft: PblDeliverableDraftDto | null,
): PblTaskViewDto[] => pblTaskViewsFromSets(definition, pblSplitEvidence(evidence), draft);

/**
 * 目标覆盖（呈现用，**不是判定**）。
 *
 * 目标回答「为什么做这个项目」，达成与否由里程碑检查决定，所以这里只报有多少条真实交付/
 * 评价引用过它，不给结论——防止目标句本身变成第二条打分通道。
 */
export const pblGoalCoverage = (
  definition: PblProjectDefinitionDto,
  evidence: readonly PblEvidence[],
): Array<{ goalId: string; evidenceCount: number }> => {
  const sets = pblSplitEvidence(evidence);
  const counter = new Map<string, number>();
  for (const item of [...sets.submissions, ...sets.assessments]) {
    for (const goalId of item.goalIds) counter.set(goalId, (counter.get(goalId) ?? 0) + 1);
  }
  return definition.goals.map((goal) => ({
    goalId: goal.id,
    evidenceCount: counter.get(goal.id) ?? 0,
  }));
};

/** 已存在的本人交付编号集合（AI 贡献/反馈/评价候选只能引用它）。 */
export const pblExistingArtifactIds = (evidence: readonly PblEvidence[]): Set<string> =>
  new Set(pblSplitEvidence(evidence).submissions.map(evidenceArtifactId));

/**
 * 反馈是否真依据产物（OMA-048「反馈依据真实产物」）。
 *
 * 两条都成立才放行：`basisArtifactIds` 全部命中已存在的本人交付；`points` 里每条的
 * `artifactId` 都在 `basisArtifactIds` 里。少任何一条就是「凭空评语」，拒。
 */
export const assertPblFeedbackGrounded = (
  feedback: PblFeedbackPayloadInput,
  deliverables: readonly PblEvidence[],
): void => {
  if (feedback.basisArtifactIds.length === 0) invalid('feedback_without_basis');
  const byId = new Set(pblSplitEvidence(deliverables).submissions.map(evidenceArtifactId));
  const ungrounded = feedback.basisArtifactIds.filter((artifactId) => !byId.has(artifactId));
  if (ungrounded.length > 0) invalid('feedback_basis_not_a_real_artifact', { ungrounded });
  const basis = new Set(feedback.basisArtifactIds);
  const floating = feedback.points
    .filter((point) => !basis.has(point.artifactId))
    .map((point) => point.artifactId);
  if (floating.length > 0) invalid('feedback_point_without_basis', { floating });
};

/**
 * 评价候选是否真依据产物（OMA-048）。
 *
 * 候选必须引用真实交付，且引用的评分依据属于该里程碑：
 * 「凭 rubric-A 评里程碑-B」这种跨项目拼贴在这里被拒。
 */
export const assertPblCandidateGrounded = (
  definition: PblProjectDefinitionDto,
  payload: PblAssessmentPayloadInput,
  artifactIds: ReadonlySet<string>,
): void => {
  const milestone = definition.milestones.find((candidate) => candidate.id === payload.milestoneId);
  if (!milestone)
    rejected('NOT_FOUND', 'pbl_milestone_not_in_definition', { milestoneId: payload.milestoneId });
  const knownRubrics = new Set(definition.rubrics.map((rubric) => rubric.id));
  const allowed = new Set(milestone!.rubricIds);
  for (const candidate of payload.candidates) {
    if (!knownRubrics.has(candidate.rubricId)) {
      invalid('assessment_rubric_not_in_definition', { candidateId: candidate.candidateId });
    }
    if (!allowed.has(candidate.rubricId)) {
      invalid('assessment_rubric_not_for_milestone', { candidateId: candidate.candidateId });
    }
    const ungrounded = candidate.basisArtifactIds.filter(
      (artifactId) => !artifactIds.has(artifactId),
    );
    if (ungrounded.length > 0) {
      invalid('assessment_basis_not_a_real_artifact', {
        candidateId: candidate.candidateId,
        ungrounded,
      });
    }
  }
  const goals = new Set(definition.goals.map((goal) => goal.id));
  const unknownGoals = payload.goalIds.filter((goalId) => !goals.has(goalId));
  if (unknownGoals.length > 0) invalid('unknown_goal_reference', { unknown: unknownGoals });
};

/**
 * AI 贡献是否真依据产物（OMA-047：AI 说的是「针对你这份东西的建议」，不是泛谈）。
 *
 * 依据必须是**同一阶段任务**里已存在的本人交付：否则模型可以引用别的阶段/别的项目的产物，
 * 把贡献伪装成有依据。
 */
export const assertPblContributionGrounded = (
  contribution: { taskId: string; basisArtifactIds: readonly string[] },
  evidence: readonly PblEvidence[],
): void => {
  if (contribution.basisArtifactIds.length === 0)
    invalid('contribution_without_basis', { taskId: contribution.taskId });
  const sets = pblSplitEvidence(evidence);
  const own = new Set(
    sets.submissions.filter((item) => item.taskId === contribution.taskId).map(evidenceArtifactId),
  );
  const ungrounded = contribution.basisArtifactIds.filter((artifactId) => !own.has(artifactId));
  if (ungrounded.length > 0) invalid('contribution_basis_not_a_real_artifact', { ungrounded });
};

/** 认领指向的贡献必须真实存在（悬空认领凑不出 `contribution_acknowledged` 的通过条件）。 */
export const assertPblAcknowledgesExistingContribution = (
  contributionNonce: string,
  evidence: readonly PblEvidence[],
): void => {
  const exists = pblSplitEvidence(evidence).contributions.some(
    (item) => item.nonce === contributionNonce,
  );
  if (!exists) rejected('NOT_FOUND', 'pbl_contribution_not_found', { contributionNonce });
};

/** 采纳指向的评价记录必须存在，且被采纳的候选必须出自那条记录。 */
export const assertPblAcceptanceTargetsAssessment = (
  payload: Pick<PblAcceptancePayloadInput, 'assessmentNonce' | 'acceptedCandidateIds'>,
  evidence: readonly PblEvidence[],
): PblEvidence => {
  const target = pblSplitEvidence(evidence).assessments.find(
    (item) => item.nonce === payload.assessmentNonce,
  );
  if (!target)
    rejected('NOT_FOUND', 'pbl_assessment_not_found', { assessmentNonce: payload.assessmentNonce });
  const known = new Set(target!.candidates.map((candidate) => candidate.candidateId));
  const unknown = payload.acceptedCandidateIds.filter((candidateId) => !known.has(candidateId));
  if (unknown.length > 0) invalid('assessment_candidate_not_found', { unknown });
  return target!;
};

/**
 * 演练绝不能写正式记录（OMA-049；与 `SIMULATION_WRITE_FORBIDDEN` 同口径）。
 *
 * 一旦某个写入被判定为演练来源就直接拒，不降级、不「当成参考记录存一下」。
 */
export const assertPblSimulationCannotWriteFormal = (evidence: PblEvidence): void => {
  if (evidence.source === 'simulation' || evidence.recordScope !== 'formal') {
    rejected('SIMULATION_WRITE_FORBIDDEN', 'pbl_simulation_step', { nonce: evidence.nonce });
  }
};

/**
 * 记录归属复核（重启 / 重放时逐条查，OMA-047）。
 *
 * 有人绕开应用层改写了落库正文——例如把某条 AI 贡献的 `actorType` 改成 `human_learner`，
 * 或把交付指向一个不属于本项目的席位——这里抛错，而不是把它当作事实参与判定。
 */
export const assertPblRecordGroundedInDefinition = (
  definition: PblProjectDefinitionDto,
  record: PblRecordDto,
): void => {
  const corrupt = (): never =>
    rejected('INTERNAL', 'pbl_record_not_grounded', { kind: record.kind });
  const roleById = new Map(definition.roles.map((role) => [role.id, role]));
  const taskIds = new Set(definition.tasks.map((task) => task.id));
  const milestoneIds = new Set(definition.milestones.map((milestone) => milestone.id));
  if ('taskId' in record && !taskIds.has(record.taskId)) corrupt();
  if (
    'milestoneId' in record &&
    record.milestoneId !== null &&
    !milestoneIds.has(record.milestoneId)
  )
    corrupt();
  const learnerSeat = definition.roles.find(
    (role) => role.kind === 'learner' && role.memberUid === record.uid,
  );
  if (
    record.kind === 'deliverable' ||
    record.kind === 'acknowledge' ||
    record.kind === 'task_progress'
  ) {
    // 这三类只能由真人成员出：actorType 与席位种类必须一致。
    if (record.actorType !== 'human_learner' || !learnerSeat) corrupt();
    if (record.kind === 'task_progress' && record.roleId !== null) {
      const seat = roleById.get(record.roleId);
      if (!seat || seat.kind !== 'learner' || seat.memberUid !== record.uid) corrupt();
    }
  }
  if (record.kind === 'contribution') {
    const seat = roleById.get(record.roleId);
    if (
      !seat ||
      seat.memberUid !== record.uid ||
      seat.kind === 'learner' ||
      pblActorTypeOfSeat(seat.kind) !== record.actorType
    )
      corrupt();
  }
  if (record.kind === 'feedback') {
    const seat = definition.roles.find((role) => role.memberUid === record.uid);
    if (!seat) corrupt();
    if (pblActorTypeOfSeat(seat!.kind) !== record.actorType) corrupt();
  }
  if (record.kind === 'assessment') {
    const seat = definition.roles.find((role) => role.memberUid === record.uid);
    if (!seat) corrupt();
    const claimed = record.roleId === null ? seat! : roleById.get(record.roleId);
    if (!claimed || claimed.memberUid !== record.uid) corrupt();
    if (!milestoneIds.has(record.milestoneId)) corrupt();
  }
  if (record.kind === 'acceptance') {
    if (!learnerSeat) corrupt();
    if (!milestoneIds.has(record.milestoneId)) corrupt();
  }
  const parsed = pblRecordSchema.safeParse(record);
  if (!parsed.success) corrupt();
};

/**
 * 正式记录 → 校验过的证据集合（读取路径入口；逐条复核后才参与判定）。
 *
 * 同时返回原记录，便于呈现层组装收据（正文只给本人视图）。
 */
export const pblEvidenceFromRecords = (
  definition: PblProjectDefinitionDto,
  records: readonly PblRecordDto[],
  binding: PblBindingDto,
): { records: PblRecordDto[]; evidence: PblEvidence[] } => {
  const evidence: PblEvidence[] = [];
  const checked: PblRecordDto[] = [];
  for (const record of records) {
    const parsed = pblRecordSchema.safeParse(record);
    if (!parsed.success) rejected('INTERNAL', 'invalid_pbl_record');
    const value = parsed.data!;
    // 绑定不符的记录不参与判定：把别的项目/别的定义版本的记录挪过来是一种越权写入。
    if (
      value.binding.definitionDigest !== binding.definitionDigest ||
      value.binding.stageId !== binding.stageId
    ) {
      rejected('VERSION_CONFLICT', 'pbl_record_binding_mismatch', { nonce: value.nonce });
    }
    assertPblRecordGroundedInDefinition(definition, value);
    const item = pblEvidenceFromRecord(value);
    assertPblSimulationCannotWriteFormal(item);
    checked.push(value);
    evidence.push(item);
  }
  return { records: checked, evidence };
};

/** 交付/记录正文是否达到某条长度检查（供即时提示；判定仍只在检查里跑）。 */
export const pblMeetsMinLength = (value: string, minChars: number): boolean =>
  value.length >= minChars;

/** 模拟器可试走的动作（与守卫同源，界面据此决定按钮，服务端仍逐次守权限）。 */
export const pblSimulationAllowedOperations = (): PblSimulationOperation[] => [
  ...PBL_SIMULATION_OPERATIONS,
];

/** 演练单步是否被允许（动作在白名单内且预算未用满）。 */
export const pblSimulationStepAllowed = (
  step: { operation: string },
  budget: { maxSteps: number; used: number },
): { allowed: boolean; reason: string | null; remaining: number } => {
  const remaining = Math.max(0, budget.maxSteps - budget.used);
  if (!PBL_SIMULATION_OPERATIONS.includes(step.operation as PblSimulationOperation)) {
    return { allowed: false, reason: 'operation_not_simulatable', remaining };
  }
  if (remaining <= 0)
    return { allowed: false, reason: 'simulation_step_budget_exhausted', remaining };
  return { allowed: true, reason: null, remaining };
};

/** 组装 PBL 状态（呈现层与模拟器共用：同一套推导，避免两边各算一份）。 */
const pblBuildView = (input: {
  definition: PblProjectDefinitionDto;
  binding: PblBindingDto;
  evidence: readonly PblEvidence[];
  draft: PblDeliverableDraftDto | null;
}): { tasks: PblTaskViewDto[]; milestones: PblMilestoneEvaluationDto[] } => {
  const sets = pblSplitEvidence(input.evidence);
  return {
    tasks: pblTaskViewsFromSets(input.definition, sets, input.draft),
    milestones: pblMilestoneEvaluationsFromSets(input.definition, sets),
  };
};

/**
 * 打开 PBL 模拟器（OMA-049）。只读：命令里没有任何可落库正文的字段。
 *
 * 初始状态里每个里程碑都是**未达成**，而不是空白或默认通过。
 */
export const openPblSimulation = (
  frozen: PblFrozenDto,
  binding: PblBindingDto,
  facts: { maxSteps: number },
): PblSimulationStateDto => {
  const definition = assertPblDefinitionFrozen(frozen).definition;
  assertPblBindingMatchesFrozen(frozen, binding);
  const view = pblBuildView({ definition, binding, evidence: [], draft: null });
  return {
    version: 1,
    simulated: true,
    recordScope: 'demo',
    definition: publicPblProjectDefinition(definition),
    binding,
    steps: [],
    tasks: view.tasks,
    milestones: view.milestones,
    artifactIds: [],
    allowedOperations: pblSimulationAllowedOperations(),
    stepBudget: { maxSteps: facts.maxSteps, used: 0 },
  };
};

/**
 * 走一步 PBL 模拟（OMA-049「模拟器/开任务/任务更新均实际运行且守权限」）。
 *
 * 这一步真的算：追加一条 demo 证据后用**与正式读取同一套**的推导重算整个状态，
 * 不是回显一步，也不是另写一份更宽松的演示逻辑。权限逐次守：
 * - 席位与动作不符 → `ROLE_PERMISSION_DENIED`（同一张权限表）；
 * - 预算用满 → `ROLE_PERMISSION_DENIED`；
 * - 交付形态/引用落空、无依据的贡献/反馈/评价 → 与正式写入同样的 `INVALID_ARGUMENT`；
 * - 想让演练写进本人记录 → `assertPblSimulationCannotWriteFormal` 拦下。
 */
export const runPblSimulationStep = (
  state: PblSimulationStateDto,
  step: PblSimulationStepInput,
  facts: { definition: PblProjectDefinitionDto; role: PblProjectRoleDto; binding: PblBindingDto },
): { state: PblSimulationStateDto; ran: true; reached: string[] } => {
  const gate = pblSimulationStepAllowed(step, state.stepBudget);
  if (!gate.allowed) rejected('ROLE_PERMISSION_DENIED', gate.reason ?? 'simulation_step_rejected');
  assertPblOperationAllowed(facts.role, step.operation);
  if (state.binding.definitionDigest !== facts.binding.definitionDigest) {
    rejected('VERSION_CONFLICT', 'pbl_simulation_binding_mismatch');
  }
  const definition = facts.definition;
  if (step.taskId !== null) {
    const task = definition.tasks.find((candidate) => candidate.id === step.taskId);
    if (!task) rejected('NOT_FOUND', 'pbl_task_not_in_definition', { taskId: step.taskId });
    if (step.operation === 'open' || step.operation === 'update') {
      // 开任务必须给出任务允许的席位；更新沿用已承接席位，不能借演练换人。
      assertPblTaskOpenable(
        definition,
        step.taskId,
        step.operation === 'open' ? (step.roleId ?? '') : (step.roleId ?? facts.role.id),
      );
    }
    if (step.operation === 'submit' && step.deliverable !== null) {
      assertPblArtifactKindAllowed(task!, step.deliverable!.artifactKind);
      assertPblDeliverableReferences(definition, step.deliverable!);
      if (step.deliverable!.taskId !== task!.id) invalid('deliverable_task_mismatch');
    }
  } else if (step.operation !== 'acceptEvaluation') {
    invalid('simulation_step_without_task');
  }
  const evidence = pblEvidenceFromStep(step, { role: facts.role });
  // 演练幂等：同 nonce 再来一次不增加预算消耗，也不重复计入（与正式写入同口径）。
  const replayed = state.steps.some(
    (item) =>
      item.source === 'simulation' && item.uid === evidence.uid && item.nonce === evidence.nonce,
  );
  const combined = replayed ? state.steps : [...state.steps, evidence];
  if (step.operation === 'contribute' && step.contribution !== null) {
    assertPblContributionGrounded(step.contribution, combined);
  }
  if (step.operation === 'feedback' && step.feedback !== null) {
    assertPblFeedbackGrounded(step.feedback, combined);
  }
  if (step.operation === 'assess' && step.assessment !== null) {
    assertPblCandidateGrounded(definition, step.assessment, pblExistingArtifactIds(combined));
  }
  if (step.operation === 'acknowledge' && step.contributionNonce !== null) {
    assertPblAcknowledgesExistingContribution(step.contributionNonce, combined);
  }
  if (step.operation === 'acceptEvaluation') {
    assertPblAcceptanceTargetsAssessment(
      {
        assessmentNonce: step.assessmentNonce ?? '',
        acceptedCandidateIds: step.acceptedCandidateIds ?? [],
      },
      combined,
    );
  }
  const view = pblBuildView({
    definition,
    binding: state.binding,
    evidence: combined,
    draft: null,
  });
  return {
    state: {
      ...state,
      steps: combined,
      tasks: view.tasks,
      milestones: view.milestones,
      artifactIds: [...pblExistingArtifactIds(combined)],
      stepBudget: {
        maxSteps: state.stepBudget.maxSteps,
        used: state.stepBudget.used + (replayed ? 0 : 1),
      },
    },
    ran: true,
    reached: view.milestones
      .filter((milestone) => milestone.reached)
      .map((milestone) => milestone.milestoneId),
  };
};

/** 里程碑达成结论的一句话说明（「凭什么达成 / 还缺什么」；不引入新的判定）。 */
export const pblMilestoneSummary = (
  evaluation: PblMilestoneEvaluationDto,
): {
  reached: boolean;
  missingCheckIds: string[];
  candidateCount: number;
  acceptedCandidateCount: number;
} => ({
  reached: evaluation.reached,
  missingCheckIds: evaluation.deterministic
    .filter((outcome) => !outcome.passed)
    .map((outcome) => outcome.checkId),
  candidateCount: evaluation.assessment.candidates.length,
  acceptedCandidateCount: evaluation.assessment.acceptedCandidateIds.length,
});

/** 成员视图的私人内容上限（应用层组包时用于断言：非成员读不到任何正文）。 */
export const pblPrivateContentViewerAllowed = (
  definition: PblProjectDefinitionDto,
  viewerUid: string | null,
): boolean => pblIsMember(definition, viewerUid);
