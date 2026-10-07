import { describe, expect, it } from 'vitest';
import { isStudyError } from '@sew/study-contracts';
import {
  assertPblAcceptanceTargetsAssessment,
  assertPblBindingMatchesFrozen,
  assertPblCandidateGrounded,
  assertPblCommandScope,
  assertPblContributionGrounded,
  assertPblDefinitionCoherent,
  assertPblDefinitionFrozen,
  assertPblFeedbackGrounded,
  assertPblRecordGroundedInDefinition,
  assertPblSimulationCannotWriteFormal,
  openPblSimulation,
  pblAcceptanceRecordFrom,
  pblAcknowledgeRecordFrom,
  pblArtifactIdFromRecord,
  pblAssessmentRecordFrom,
  pblCollaboratorRole,
  pblCommandActorRole,
  pblContributionRecordFrom,
  pblDeliverableRecordFrom,
  pblDraftFrom,
  pblEvidenceFromRecords,
  pblExistingArtifactIds,
  pblFeedbackRecordFrom,
  pblHash,
  pblLearnerRole,
  pblMilestoneEvaluations,
  pblMilestoneSummary,
  pblProjectSceneId,
  pblRoleByUid,
  pblSimulationStepAllowed,
  pblTaskProgressRecordFrom,
  pblTaskViews,
  publicPblProjectDefinition,
  publicPblProjectState,
  runPblDeterministicCheck,
  runPblSimulationStep,
} from '../packages/study-domain/src/formal-interaction-pbl';
import type { PblEvidence } from '../packages/study-domain/src/formal-interaction-pbl';
import {
  pblAssessCommandSchema,
  pblCommandSchema,
  pblFrozenSchema,
  pblRecordSchema,
  pblSimulationStepSchemaChecked,
  pblTaskCommandSchema,
} from '../packages/study-contracts/src/formal-interaction-pbl';
import type { PblServerFacts } from '../packages/study-domain/src/formal-interaction-pbl';
import type {
  PblBindingDto,
  PblCommand,
  PblDeliverableDraftDto,
  PblDeliverablePayloadInput,
  PblDeliverableRecordDto,
  PblFrozenDto,
  PblProjectDefinitionDto,
  PblRecordDto,
  PblSimulationStateDto,
  PblSimulationStepInput,
} from '../packages/study-contracts/src/formal-interaction-pbl';

const uid = (suffix: string): string => `uid_00000000-0000-4000-8000-0000000000${suffix}`;
const LEARNER = uid('0a');
const LEARNER_B = uid('0b');
const MENTOR = uid('01');
const PEER = uid('02');
const FOREIGN = uid('0f');
const UNREGISTERED = uid('09');
const STATEMENT = 'stmt_school_canteen';
const SCOPE = { projectId: 'proj_1', generation: 1 };
const NOW = '2026-10-07T08:00:00.000Z';
const LATER = '2026-10-07T09:00:00.000Z';

/** 三时段回收记录正文（满足阶段任务的长度检查）。 */
const SURVEY_TEXT =
  '周一十二点、十二点半、十三点三个时段的回收台分类记录：米饭约四成原样倒掉，叶菜约三成，荤菜约一成半，蛋奶几乎无剩余。';
/** 提案正文（同时含「成本」与「流程」两个检查片段）。 */
const PROPOSAL_TEXT =
  '提案：按班级回收量重算采购成本（省下约 8%），并把补餐窗口后移十分钟以理顺供餐流程；两周后复核对账。';
/** 只回应成本、没回应流程的半份提案。 */
const HALF_PROPOSAL_TEXT = '提案第一版：按采购量重算成本，估计可省八个百分点，明细见附件台账。';

/**
 * 真实 PBL 项目（OMA-046）：校园食堂浪费调研与提案。
 *
 * 检查覆盖全部五种判定式：长度、包含、形态提交、贡献认领、里程碑前序。
 */
const definition = (): PblProjectDefinitionDto => ({
  id: 'pbl_canteen',
  title: '校园食堂浪费调研与提案',
  statementIds: [STATEMENT],
  authenticContext: {
    audience: '学校后勤处与食堂运营方',
    problem: '食堂午餐每日约两成食材被丢弃，没人说得清丢在哪一步。',
    constraints: ['两周周期', '不干扰正常教学', '只使用学校公开台账'],
  },
  background: '学生组队走进食堂后厨与回收台，用两周时间定位浪费环节并向后勤处提交可执行提案。',
  goals: [
    {
      id: 'goal_find',
      statement: '定位浪费最大的两个环节',
      successDescription: '提交带数据支撑的环节清单',
    },
    { id: 'goal_adopt', statement: '提案被后勤处采纳', successDescription: '拿到书面采纳意见' },
  ],
  projectChecks: [],
  roles: [
    {
      id: 'seat_a',
      name: '学生负责人',
      kind: 'learner',
      responsibilities: ['完成各阶段交付物'],
      memberUid: LEARNER,
    },
    {
      id: 'seat_b',
      name: '学生组员',
      kind: 'learner',
      responsibilities: ['协助数据采集'],
      memberUid: LEARNER_B,
    },
    {
      id: 'mentor',
      name: '导师',
      kind: 'mentor',
      responsibilities: ['审阅交付并给出反馈'],
      memberUid: MENTOR,
    },
    {
      id: 'peer',
      name: 'AI 同学',
      kind: 'peer_ai',
      responsibilities: ['提供参考建议'],
      memberUid: PEER,
    },
  ],
  tasks: [
    {
      id: 'task_survey',
      title: '浪费数据采集',
      phase: '调研',
      statementIds: [STATEMENT],
      outcome: '一份覆盖至少三个回收时段的分类记录表',
      artifactKinds: ['report', 'dataset'],
      roleIds: ['seat_a', 'seat_b'],
      milestoneIds: ['ms_data'],
      checks: [
        {
          id: 'check_survey_length',
          kind: 'deliverable_min_length',
          label: '记录表正文不少于 40 字',
          expectation: '正文长度至少 40 字',
          minChars: 40,
          artifactKind: 'report',
        },
      ],
    },
    {
      id: 'task_proposal',
      title: '向后勤处提交提案',
      phase: '提案',
      statementIds: [STATEMENT],
      outcome: '提案报告被提交，成本与流程两条建议都写到',
      artifactKinds: ['slides', 'report'],
      roleIds: ['seat_a'],
      milestoneIds: ['ms_adopt'],
      checks: [
        {
          id: 'check_proposal_terms',
          kind: 'deliverable_contains',
          label: '提案含「成本」与「流程」',
          expectation: '正文同时出现两个关键片段',
          fragments: ['成本', '流程'],
          artifactKind: 'slides',
        },
      ],
    },
  ],
  milestones: [
    {
      id: 'ms_data',
      title: '数据齐备',
      statementIds: [STATEMENT],
      order: 1,
      taskIds: ['task_survey'],
      rubricIds: ['rubric_data'],
      checks: [
        {
          id: 'check_data_submitted',
          kind: 'deliverable_submitted',
          label: '至少一份本人报告',
          expectation: '存在一份报告形态的本人交付',
          artifactKind: 'report',
        },
        {
          id: 'check_data_ack',
          kind: 'contribution_acknowledged',
          label: '至少认领一条 AI 建议',
          expectation: '本人显式认领一条 AI 贡献',
          minAcknowledged: 1,
        },
      ],
    },
    {
      id: 'ms_adopt',
      title: '提案被采纳',
      statementIds: [STATEMENT],
      order: 2,
      taskIds: ['task_proposal'],
      rubricIds: ['rubric_proposal'],
      checks: [
        {
          id: 'check_adopt_prereq',
          kind: 'milestone_reached',
          label: '先完成数据齐备',
          expectation: '里程碑「数据齐备」已达成',
          milestoneId: 'ms_data',
        },
        {
          id: 'check_adopt_slides',
          kind: 'deliverable_submitted',
          label: '提案版已提交',
          expectation: '存在一份演示形态的本人交付',
          artifactKind: 'slides',
        },
      ],
    },
  ],
  rubrics: [
    {
      id: 'rubric_data',
      criterion: '数据采集是否覆盖三个时段且分类一致',
      levels: [
        { level: 'exemplary', descriptor: '三时段齐备且分类可复核' },
        { level: 'adequate', descriptor: '两时段齐备' },
        { level: 'developing', descriptor: '单时段或分类缺失' },
      ],
    },
    {
      id: 'rubric_proposal',
      criterion: '提案是否同时回应成本与流程',
      levels: [
        { level: 'exemplary', descriptor: '两条建议均落到执行动作' },
        { level: 'adequate', descriptor: '一条建议可执行' },
        { level: 'developing', descriptor: '均停留在口号' },
      ],
    },
  ],
  cadenceDays: 7,
});

const frozenOf = (project: PblProjectDefinitionDto): PblFrozenDto => {
  assertPblDefinitionCoherent(project);
  return {
    version: 1,
    projectId: SCOPE.projectId,
    lessonId: 'lesson_canteen',
    lessonVersion: 1,
    bundleDigest: 'bundle_digest',
    reviewedBy: 'reviewer_1',
    reviewNote: '对照来源逐条核对情境、角色、检查与评分依据',
    definition: project,
  };
};

const bindingOf = (frozen: PblFrozenDto): PblBindingDto => ({
  version: 1,
  stageId: 'stage_pbl_v1',
  definitionId: frozen.definition.id,
  documentDigest: 'doc_digest',
  definitionDigest: pblHash(frozen.definition),
});

/** 真人成员的服务端事实（uid/时间/席位都由应用层给出）。 */
const learnerFacts = (project: PblProjectDefinitionDto, memberUid: string): PblServerFacts => ({
  uid: memberUid,
  createdAt: NOW,
  role: pblLearnerRole(project, memberUid),
});

const collaboratorFacts = (
  project: PblProjectDefinitionDto,
  memberUid: string,
): PblServerFacts => ({
  uid: memberUid,
  createdAt: NOW,
  role: pblCollaboratorRole(project, memberUid),
});

const errorOf = (run: () => unknown): { code: string; reason?: string } => {
  try {
    run();
  } catch (error) {
    if (isStudyError(error)) {
      return { code: error.code, reason: error.details?.reason as string | undefined };
    }
    throw error;
  }
  throw new Error('未抛出 StudyError');
};

const surveyPayload = (artifactText = SURVEY_TEXT): PblDeliverablePayloadInput => ({
  taskId: 'task_survey',
  milestoneId: null,
  artifactKind: 'report',
  artifactTitle: '回收台三时段记录表',
  artifactText,
  assetRefs: ['asset_photo_1'],
  goalIds: ['goal_find'],
});

const proposalPayload = (artifactText = PROPOSAL_TEXT): PblDeliverablePayloadInput => ({
  taskId: 'task_proposal',
  milestoneId: null,
  artifactKind: 'slides',
  artifactTitle: '食堂浪费提案',
  artifactText,
  assetRefs: [],
  goalIds: ['goal_adopt'],
});

/**
 * 测试夹具：一份冻结定义 + 绑定 + 一组「写命令 → 正式记录 → 校验证据」的窄包装。
 * 正式路径的写入全部经过领域构造函数，与真实服务层的调用顺序一致。
 */
const harness = (project: PblProjectDefinitionDto = definition()) => {
  const frozen = frozenOf(project);
  const binding = bindingOf(frozen);

  const submit = (nonce: string, payload: PblDeliverablePayloadInput): PblDeliverableRecordDto =>
    pblDeliverableRecordFrom(
      {
        operation: 'submit',
        scope: SCOPE,
        binding,
        actorUid: LEARNER,
        deliverable: payload,
        nonce,
      },
      learnerFacts(frozen.definition, LEARNER),
    );

  const contribute = (
    nonce: string,
    basis: PblDeliverableRecordDto,
    content = '建议把倒掉的牛奶按班级再拆一层。',
  ): PblRecordDto =>
    pblContributionRecordFrom(
      {
        operation: 'contribute',
        scope: SCOPE,
        binding,
        actorUid: PEER,
        contribution: {
          roleId: 'peer',
          taskId: basis.taskId,
          milestoneId: null,
          content,
          basisArtifactIds: [pblArtifactIdFromRecord(basis)],
        },
        nonce,
      },
      collaboratorFacts(frozen.definition, PEER),
    );

  const acknowledge = (nonce: string, contributionNonce: string): PblRecordDto =>
    pblAcknowledgeRecordFrom(
      {
        operation: 'acknowledge',
        scope: SCOPE,
        binding,
        actorUid: LEARNER,
        contributionNonce,
        note: '已按建议补齐班级维度并重查数据。',
        nonce,
      },
      learnerFacts(frozen.definition, LEARNER),
    );

  const task = (input: {
    nonce: string;
    intent: 'open' | 'update';
    taskId: string;
    roleId: string | null;
    reportedStatus: 'in_progress' | 'submitted' | 'needs_revision';
    report: string;
    createdAt?: string;
  }): PblRecordDto => {
    const command: Extract<PblCommand, { operation: 'task' }> = {
      operation: 'task',
      intent: input.intent,
      scope: SCOPE,
      binding,
      actorUid: LEARNER,
      taskId: input.taskId,
      roleId: input.roleId,
      reportedStatus: input.reportedStatus,
      report: input.report,
      nonce: input.nonce,
    };
    const facts = {
      ...learnerFacts(frozen.definition, LEARNER),
      createdAt: input.createdAt ?? NOW,
    };
    return pblTaskProgressRecordFrom(
      command,
      facts,
      input.intent === 'open' ? 'in_progress' : input.reportedStatus,
    );
  };

  const assess = (input: {
    nonce: string;
    milestoneId: string;
    rubricId: string;
    candidateId: string;
    basis: string[];
    judgement?: 'exemplary' | 'adequate' | 'developing';
  }): PblRecordDto =>
    pblAssessmentRecordFrom(
      {
        operation: 'assess',
        scope: SCOPE,
        binding,
        actorUid: MENTOR,
        assessment: {
          milestoneId: input.milestoneId,
          roleId: 'mentor',
          goalIds: ['goal_find'],
          candidates: [
            {
              candidateId: input.candidateId,
              rubricId: input.rubricId,
              judgement: input.judgement ?? 'adequate',
              rationale: '导师候选：数据覆盖两时段，分类可复核。',
              basisArtifactIds: input.basis,
            },
          ],
        },
        nonce: input.nonce,
      },
      collaboratorFacts(frozen.definition, MENTOR),
    );

  const accept = (nonce: string, assessment: PblRecordDto, candidateIds: string[]): PblRecordDto =>
    pblAcceptanceRecordFrom(
      {
        operation: 'acceptEvaluation',
        scope: SCOPE,
        binding,
        actorUid: LEARNER,
        assessmentNonce: assessment.nonce,
        acceptedCandidateIds: candidateIds,
        nonce,
      },
      learnerFacts(frozen.definition, LEARNER),
      assessment as PblAssessmentRecordType,
    );

  const load = (records: readonly PblRecordDto[]): PblEvidence[] =>
    pblEvidenceFromRecords(frozen.definition, records, binding).evidence;

  return {
    project: frozen.definition,
    frozen,
    binding,
    submit,
    contribute,
    acknowledge,
    task,
    assess,
    accept,
    load,
  };
};

type PblAssessmentRecordType =
  import('../packages/study-contracts/src/formal-interaction-pbl').PblAssessmentRecordDto;

const oneSubmission = (
  text?: string,
): { record: PblDeliverableRecordDto; evidence: PblEvidence[] } => {
  const env = harness();
  const record = env.submit('sub-fix', surveyPayload(text));
  return {
    record,
    evidence: env.load([
      record,
      env.task({
        nonce: 'task-fix',
        intent: 'open',
        taskId: 'task_survey',
        roleId: 'seat_a',
        reportedStatus: 'in_progress',
        report: '今天收三个时段的盘子。',
      }),
    ]),
  };
};

/** 共享夹具：base 交付 + AI 贡献，供 OMA-048 一节复用。 */
const evaluationFixture = () => {
  const env = harness();
  const base = env.submit('sub-ev', surveyPayload());
  const contribution = env.contribute('con-ev', base);
  const evidence = env.load([base]);
  const artifactId = pblArtifactIdFromRecord(base);
  return { env, base, contribution, evidence, artifactId };
};

describe('PBL 定义冻结、自洽与公开投影（OMA-046 / OMA-048）', () => {
  it('真实项目定义自洽才能冻结，绑定指纹与场景编号都由定义派生', () => {
    const project = definition();
    expect(() => assertPblDefinitionCoherent(project)).not.toThrow();
    const frozen = frozenOf(project);
    const binding = bindingOf(frozen);
    expect(() => assertPblBindingMatchesFrozen(frozen, binding)).not.toThrow();
    expect(pblProjectSceneId(project.id)).toBe('scene_formal_interaction_pbl_pbl_canteen');
    expect(errorOf(() => assertPblDefinitionFrozen(null))).toEqual({
      code: 'CLASSROOM_SCENE_SOURCE_MISSING',
      reason: 'pbl_definition_not_frozen',
    });
    // 严格形状：多一个键就通不过冻结合同。
    expect(pblFrozenSchema.safeParse({ ...frozen, reviewNoteExtra: 'x' }).success).toBe(false);
    // 落库正文被改坏（引用落空）时，读取路径把「参数不合法」升格为内部错误，不伪装成用户输入问题。
    const broken = {
      ...frozen,
      definition: { ...project, roles: project.roles.filter((role) => role.kind === 'learner') },
    };
    expect(errorOf(() => assertPblDefinitionFrozen(broken))).toEqual({
      code: 'INTERNAL',
      reason: 'pbl_frozen_definition_incoherent',
    });
  });

  it('定义拼贴与悬空引用逐条被拒：AI 不能领任务、前序不能指更晚、评分依据必须存在', () => {
    const noLearner = definition();
    noLearner.roles = noLearner.roles.filter((role) => role.kind !== 'learner');
    expect(errorOf(() => assertPblDefinitionCoherent(noLearner)).reason).toBe(
      'pbl_requires_learner_role',
    );

    const aiClaims = definition();
    aiClaims.tasks[0]!.roleIds = ['seat_a', 'peer'];
    expect(errorOf(() => assertPblDefinitionCoherent(aiClaims)).reason).toBe(
      'ai_role_cannot_claim_task',
    );

    const dupOrder = definition();
    dupOrder.milestones[1] = { ...dupOrder.milestones[1]!, order: 1 };
    expect(errorOf(() => assertPblDefinitionCoherent(dupOrder)).reason).toBe(
      'duplicate_milestone_order',
    );

    const cyclic = definition();
    cyclic.milestones[0]!.checks = [
      ...cyclic.milestones[0]!.checks,
      {
        id: 'check_cycle',
        kind: 'milestone_reached',
        label: '先完成提案',
        expectation: '指向序号更大的里程碑，构成环',
        milestoneId: 'ms_adopt',
      },
    ];
    expect(errorOf(() => assertPblDefinitionCoherent(cyclic)).reason).toBe(
      'milestone_dependency_not_earlier',
    );

    const selfReference = definition();
    selfReference.milestones[0]!.checks = [
      ...selfReference.milestones[0]!.checks,
      {
        id: 'check_self',
        kind: 'milestone_reached',
        label: '自己等自己',
        expectation: 'e',
        milestoneId: 'ms_data',
      },
    ];
    expect(errorOf(() => assertPblDefinitionCoherent(selfReference)).reason).toBe(
      'milestone_self_reference',
    );

    const danglingRubric = definition();
    danglingRubric.milestones[0]!.rubricIds = ['rubric_ghost'];
    expect(errorOf(() => assertPblDefinitionCoherent(danglingRubric)).reason).toBe(
      'unknown_rubric_in_milestone',
    );

    const danglingTask = definition();
    danglingTask.milestones[1]!.taskIds = ['task_ghost'];
    expect(errorOf(() => assertPblDefinitionCoherent(danglingTask)).reason).toBe(
      'unknown_task_in_milestone',
    );

    const sharedCheckId = definition();
    sharedCheckId.milestones[1]!.checks = [
      ...sharedCheckId.milestones[1]!.checks,
      {
        id: 'check_survey_length',
        kind: 'deliverable_submitted',
        label: '与阶段检查重名',
        expectation: '跨阶段重名会让结论指向错误的检查',
        artifactKind: null,
      },
    ];
    expect(errorOf(() => assertPblDefinitionCoherent(sharedCheckId)).reason).toBe(
      'duplicate_check_ids',
    );

    const ackWithoutAi = definition();
    ackWithoutAi.roles = ackWithoutAi.roles.filter((role) => role.kind === 'learner');
    expect(errorOf(() => assertPblDefinitionCoherent(ackWithoutAi)).reason).toBe(
      'acknowledge_check_without_ai_role',
    );

    const blankFragment = definition();
    blankFragment.tasks[1]!.checks = [
      {
        id: 'check_blank',
        kind: 'deliverable_contains',
        label: '包含空白片段',
        expectation: '空白片段永远匹配得上，等于没有检查',
        fragments: ['   '],
        artifactKind: 'slides',
      },
    ];
    expect(errorOf(() => assertPblDefinitionCoherent(blankFragment)).reason).toBe(
      'empty_check_fragment',
    );

    const unboundSeat = definition();
    unboundSeat.roles[0] = { ...unboundSeat.roles[0]!, memberUid: null };
    expect(errorOf(() => assertPblDefinitionCoherent(unboundSeat)).reason).toBe(
      'learner_role_without_member',
    );
  });

  it('公开投影去掉评分依据与 rubric 引用，面向成员的内容逐字保留', () => {
    const project = definition();
    const projection = publicPblProjectDefinition(project);
    const json = JSON.stringify(projection);
    expect(json).not.toContain('rubric');
    expect(json).not.toContain('criterion');
    expect(json).not.toContain('数据采集是否覆盖三个时段');
    expect(projection.tasks[0]!.outcome).toBe(project.tasks[0]!.outcome);
    expect(projection.tasks[0]!.checks).toEqual(project.tasks[0]!.checks);
    expect(projection.milestones[0]!.checks).toEqual(project.milestones[0]!.checks);
    expect(projection.authenticContext.problem).toBe(project.authenticContext.problem);
    expect(projection.roles.map((role) => role.id)).toEqual(['seat_a', 'seat_b', 'mentor', 'peer']);
    // 判定条件本身是公开的（成员要知道要交付什么），但评分依据不是。
    expect(JSON.stringify(projection.milestones)).toContain('deliverable_submitted');
  });

  it(`共享投影不含私人产物、草稿、评语与采纳；本人视图才有正文`, () => {
    const env = harness();
    const submission = env.submit('sub-private', {
      ...surveyPayload(),
      artifactTitle: '回收台三时段记录表',
      artifactText: '绝密正文：周三倒掉的牛奶共十七盒。',
    });
    const contribution = env.contribute('con-private', submission, '建议按蛋奶单独立一栏计数。');
    const assessment = env.assess({
      nonce: 'assess-private',
      milestoneId: 'ms_data',
      rubricId: 'rubric_data',
      candidateId: 'cand-private',
      basis: [pblArtifactIdFromRecord(submission)],
    });
    const draft: PblDeliverableDraftDto = pblDraftFrom(
      {
        binding: env.binding,
        nonce: 'draft-private',
        draft: { ...surveyPayload('草稿中：周四补一排数据'), artifactText: '' },
      },
      { ...learnerFacts(env.project, LEARNER), createdAt: LATER },
    );
    const evidence = env.load([submission, contribution, assessment]);
    const tasks = pblTaskViews(env.project, evidence, draft);
    const milestones = pblMilestoneEvaluations(env.project, evidence);
    expect(tasks[0]!.ownDraftTitle).toBe('回收台三时段记录表');
    const shared = publicPblProjectState({
      definition: env.project,
      binding: env.binding,
      tasks,
      milestones,
    });
    const json = JSON.stringify(shared);
    expect(json).not.toContain('绝密正文');
    expect(json).not.toContain('回收台三时段记录表');
    expect(json).not.toContain('导师候选');
    expect(json).not.toContain('建议按蛋奶单独立一栏计数');
    expect(json).not.toContain('rubric');
    expect(json).not.toContain('cand-private');
    // 计数与确定性结论仍然是可共享的信息。
    expect(shared.tasks[0]).toMatchObject({
      ownSubmissionCount: 1,
      aiContributionCount: 1,
      ownDraftTitle: null,
    });
  });
});

describe('PBL 阶段任务、里程碑与本人交付 / AI 贡献分开（OMA-047）', () => {
  it('开任务只改状态不改判定：任务状态由记录推导，重启重读逐字一致', () => {
    const env = harness();
    const opened = env.task({
      nonce: 'task-open-1',
      intent: 'open',
      taskId: 'task_survey',
      roleId: 'seat_a',
      reportedStatus: 'in_progress',
      report: '今天收三个时段的盘子。',
    });
    const evidence = env.load([opened]);
    expect(pblTaskViews(env.project, evidence, null)[0]).toMatchObject({
      status: 'in_progress',
      claimedByRoleId: 'seat_a',
      claimedByUid: LEARNER,
      ownSubmissionCount: 0,
    });
    // 同一批落库记录再读一次（等价于重启进程后重新读取）。
    expect(JSON.stringify(pblTaskViews(env.project, env.load([opened]), null))).toBe(
      JSON.stringify(pblTaskViews(env.project, evidence, null)),
    );
  });

  it('交付达标即 verified；正文太短或片段不全只是 submitted', () => {
    const env = harness();
    const full = env.submit('sub-full', surveyPayload());
    expect(pblTaskViews(env.project, env.load([full]), null)[0]!.status).toBe('verified');
    // 正文不足 40 字（长度检查不通过）→ 有交付但未达标。
    const short = env.submit('sub-short', surveyPayload('只记了一个时段。'));
    const shortViews = pblTaskViews(env.project, env.load([short]), null);
    expect(shortViews[0]!.status).toBe('submitted');
    expect(shortViews[0]!.deterministic[0]).toMatchObject({
      checkId: 'check_survey_length',
      passed: false,
    });
    expect(shortViews[0]!.ownSubmissionCount).toBe(1);
    // 提案只有成本没有流程 → contains 检查指出缺哪个片段。
    const half = env.submit('sub-half', proposalPayload(HALF_PROPOSAL_TEXT));
    const halfViews = pblTaskViews(env.project, env.load([half]), null);
    expect(halfViews[1]!.status).toBe('submitted');
    expect(halfViews[1]!.deterministic[0]).toMatchObject({
      kind: 'deliverable_contains',
      passed: false,
    });
    expect(halfViews[1]!.deterministic[0]!.detail).toContain('missing_fragment:流程');
    expect(
      pblTaskViews(env.project, env.load([full, half]), null).map((task) => task.status),
    ).toEqual(['verified', 'submitted']);
  });

  it('AI 贡献单独标记：未认领不进本人交付计数，认领只加自己的计数', () => {
    const env = harness();
    const base = env.submit('sub-count', surveyPayload());
    const contribution = env.contribute('con-count', base);
    const withoutAck = pblTaskViews(env.project, env.load([base, contribution]), null);
    expect(withoutAck[0]).toMatchObject({
      ownSubmissionCount: 1,
      aiContributionCount: 1,
      acknowledgedContributionCount: 0,
      status: 'verified',
    });
    const withAck = pblTaskViews(
      env.project,
      env.load([base, contribution, env.acknowledge('ack-count', 'con-count')]),
      null,
    );
    expect(withAck[0]).toMatchObject({ aiContributionCount: 1, acknowledgedContributionCount: 1 });
    // 认领不复制出一份「本人交付」。
    expect(withAck[0]!.ownSubmissionCount).toBe(1);
    // 悬空认领（指向不存在的贡献）不落库失败，但绝不增加计数，也通不过检查。
    const ghost = env.acknowledge('ack-ghost', 'con-none');
    const ghostViews = pblTaskViews(env.project, env.load([base, contribution, ghost]), null);
    expect(ghostViews[0]!.acknowledgedContributionCount).toBe(0);
    const ghostMilestones = pblMilestoneEvaluations(
      env.project,
      env.load([base, contribution, ghost]),
    );
    expect(ghostMilestones[0]!.deterministic[1]).toMatchObject({
      checkId: 'check_data_ack',
      passed: false,
    });
    expect(ghostMilestones[0]!.reached).toBe(false);
  });

  it('里程碑只在确定性检查全过才达成；前序未达成时后续拿不到依据', () => {
    const env = harness();
    const base = env.submit('sub-ms', surveyPayload());
    const contribution = env.contribute('con-ms', base);
    const acked = env.acknowledge('ack-ms', 'con-ms');
    const slides = env.submit('sub-ms-slides', proposalPayload());

    // 只有交付、没认领：数据里程碑差一条检查，提案里程碑因前序未达成也过不去。
    const stage1 = pblMilestoneEvaluations(env.project, env.load([base, contribution]));
    expect(stage1.map((entry) => entry.reached)).toEqual([false, false]);
    expect(stage1[0]!.deterministic.map((outcome) => outcome.passed)).toEqual([true, false]);
    expect(stage1[1]!.deterministic.map((outcome) => outcome.passed)).toEqual([false, false]);
    expect(pblMilestoneSummary(stage1[0]!)).toMatchObject({
      reached: false,
      missingCheckIds: ['check_data_ack'],
    });

    // 补上认领：前序达成，但提案版还没交。
    const stage2 = pblMilestoneEvaluations(env.project, env.load([base, contribution, acked]));
    expect(stage2.map((entry) => entry.reached)).toEqual([true, false]);
    expect(stage2[1]!.deterministic[0]).toMatchObject({ kind: 'milestone_reached', passed: true });
    expect(stage2[1]!.deterministic[1]).toMatchObject({ passed: false, detail: 'no_deliverable' });

    // 交出提案版：两个里程碑都达成，且提案报告的形态不算数（要 slides）。
    const stage3 = pblMilestoneEvaluations(
      env.project,
      env.load([base, contribution, acked, slides]),
    );
    expect(stage3.map((entry) => entry.reached)).toEqual([true, true]);
    expect(pblMilestoneSummary(stage3[1]!)).toMatchObject({ reached: true, missingCheckIds: [] });
    // 达成依据可回溯到真实产物。
    expect(stage3[0]!.deterministic[0]!.evidenceArtifactIds).toEqual([
      pblArtifactIdFromRecord(base),
    ]);
  });

  it('非成员、AI 席位、跨项目与过期代次都在门径处拒；席位动作与审核动作分开', () => {
    const env = harness();
    expect(errorOf(() => pblLearnerRole(env.project, FOREIGN))).toEqual({
      code: 'ROLE_PERMISSION_DENIED',
      reason: 'not_project_member',
    });
    expect(errorOf(() => pblRoleByUid(env.project, UNREGISTERED))).toEqual({
      code: 'ROLE_PERMISSION_DENIED',
      reason: 'not_project_member',
    });
    const aiSubmit: PblCommand = {
      operation: 'submit',
      scope: SCOPE,
      binding: env.binding,
      actorUid: PEER,
      deliverable: surveyPayload(),
      nonce: 'ai-submit',
    };
    expect(errorOf(() => pblCommandActorRole(env.project, aiSubmit))).toEqual({
      code: 'ROLE_PERMISSION_DENIED',
      reason: 'learner_seat_required',
    });
    const mentorTask: PblCommand = {
      operation: 'task',
      intent: 'open',
      scope: SCOPE,
      binding: env.binding,
      actorUid: MENTOR,
      taskId: 'task_survey',
      roleId: 'mentor',
      reportedStatus: 'in_progress',
      report: '导师替学生开任务',
      nonce: 'mentor-open',
    };
    expect(errorOf(() => pblCommandActorRole(env.project, mentorTask)).reason).toBe(
      'learner_seat_required',
    );
    // 本人不能冒充 AI 出候选。
    const learnerAssess: PblCommand = {
      operation: 'assess',
      scope: SCOPE,
      binding: env.binding,
      actorUid: LEARNER,
      assessment: { milestoneId: 'ms_data', roleId: 'seat_a', goalIds: [], candidates: [] },
      nonce: 'self-assess',
    };
    expect(errorOf(() => pblCommandActorRole(env.project, learnerAssess)).reason).toBe(
      'ai_seat_required',
    );
    expect(
      errorOf(() => assertPblCommandScope(SCOPE, { projectId: 'other', generation: 1 })).reason,
    ).toBe('pbl_project_mismatch');
    expect(
      errorOf(() => assertPblCommandScope(SCOPE, { projectId: SCOPE.projectId, generation: 2 }))
        .reason,
    ).toBe('pbl_generation_mismatch');
    expect(
      errorOf(() =>
        pblCommandActorRole(env.project, {
          operation: 'simulate',
          scope: SCOPE,
          binding: env.binding,
          viewerUid: LEARNER,
          maxSteps: 3,
        }),
      ).reason,
    ).toBe('pbl_operation_is_not_a_seat_action');
  });

  it('落库正文被改写时复核拒读：AI 冒充本人交付、指向幽灵任务都不能参与判定', () => {
    const env = harness();
    const base = env.submit('sub-tamper', surveyPayload());
    // 把一条 AI 贡献的 actorType 改成 human_learner（形状仍是交付以外的字段）：读回即拒。
    const forged: PblRecordDto = {
      ...pblContributionRecordFrom(
        {
          operation: 'contribute',
          scope: SCOPE,
          binding: env.binding,
          actorUid: PEER,
          contribution: {
            roleId: 'peer',
            taskId: 'task_survey',
            milestoneId: null,
            content: '伪造尝试',
            basisArtifactIds: [pblArtifactIdFromRecord(base)],
          },
          nonce: 'con-tamper',
        },
        collaboratorFacts(env.project, PEER),
      ),
      actorType: 'human_learner',
    } as unknown as PblRecordDto;
    expect(errorOf(() => assertPblRecordGroundedInDefinition(env.project, forged))).toEqual({
      code: 'INTERNAL',
      reason: 'pbl_record_not_grounded',
    });
    // 交付指向定义里没有的任务：合同形状合法，定义复核拒。
    const orphan = env.submit('sub-orphan', { ...surveyPayload(), taskId: 'task_ghost' });
    expect(pblRecordSchema.safeParse(orphan).success).toBe(true);
    expect(errorOf(() => env.load([orphan]))).toEqual({
      code: 'INTERNAL',
      reason: 'pbl_record_not_grounded',
    });
    // 绑定摘要对不上的记录（别的项目挪过来的）不参与判定。
    const foreignBinding: PblBindingDto = {
      ...env.binding,
      definitionDigest: 'other_project_digest',
    };
    expect(
      errorOf(() =>
        pblEvidenceFromRecords(env.project, [{ ...base, binding: foreignBinding }], env.binding),
      ).reason,
    ).toBe('pbl_record_binding_mismatch');
  });

  it('同 nonce 同内容重试只算一次记录；不同内容复用 nonce 通不过形状与复核', () => {
    const env = harness();
    const first = env.submit('sub-dedup', surveyPayload());
    const replay: PblRecordDto = { ...first, createdAt: LATER };
    // 引擎按「来源 + 作者 + 幂等键」吸收重复，重试不把「交付 1 次」读成 2 次。
    expect(pblTaskViews(env.project, env.load([first, replay]), null)[0]!.ownSubmissionCount).toBe(
      1,
    );
    // 不同内容复用同一 nonce：收据编号随正文变化 → 写入层（按 nonce 唯一键）拒；
    // 在纯函数层可验证的是「两条不同正文不会共享同一张收据」。
    const hijacked: PblRecordDto = { ...first, artifactText: '换了正文，复用同一条 nonce' };
    expect(pblHash(first)).not.toBe(pblHash(hijacked));
  });

  it('未冻结与过期绑定都停在门口：项目 ID 换了、定义换了都不能沿用旧绑定', () => {
    const env = harness();
    expect(() => assertPblBindingMatchesFrozen(env.frozen, env.binding)).not.toThrow();
    expect(
      errorOf(() =>
        assertPblBindingMatchesFrozen(env.frozen, { ...env.binding, definitionDigest: 'deadbeef' }),
      ).reason,
    ).toBe('pbl_binding_stale');
    // 内容变了（加一条项目级检查）→ 指纹变，旧绑定过期。
    const evolved = { ...env.project, projectChecks: [env.project.tasks[0]!.checks[0]!] };
    const evolvedFrozen = { ...env.frozen, definition: evolved };
    expect(errorOf(() => assertPblBindingMatchesFrozen(evolvedFrozen, env.binding)).reason).toBe(
      'pbl_binding_stale',
    );
    // definitionId 与定义不一致：挪到别的项目上。
    expect(
      errorOf(() =>
        assertPblBindingMatchesFrozen(env.frozen, { ...env.binding, definitionId: 'pbl_other' }),
      ).reason,
    ).toBe('pbl_binding_definition_mismatch');
  });

  it('草稿允许正文为空且不改变状态，提交必须非空（形状在合同层把关）', () => {
    const env = harness();
    const draft = pblDraftFrom(
      { binding: env.binding, nonce: 'draft-1', draft: { ...surveyPayload(), artifactText: '' } },
      learnerFacts(env.project, LEARNER),
    );
    const viewsWithDraft = pblTaskViews(env.project, [], draft);
    expect(viewsWithDraft[0]).toMatchObject({
      status: 'available',
      ownDraftTitle: '回收台三时段记录表',
      ownSubmissionCount: 0,
    });
    // 空正文的提交通不过交付载荷形状（min(1)），不是「服务端宽容接受」。
    expect(
      pblCommandSchema.safeParse({
        operation: 'submit',
        scope: SCOPE,
        binding: env.binding,
        actorUid: LEARNER,
        deliverable: { ...surveyPayload(), artifactText: '' },
        nonce: 'empty-submit',
      }).success,
    ).toBe(false);
  });
});

describe('PBL 导师指导、评价候选与确定性检查分开（OMA-048）', () => {
  it('反馈每条意见都必须挂在真实交付上：凭空依据与悬空意见都被拒', () => {
    const fixture = evaluationFixture();
    const grounded = {
      taskId: 'task_survey',
      milestoneId: null,
      basisArtifactIds: [fixture.artifactId],
      points: [
        {
          artifactId: fixture.artifactId,
          observation: '第三时段缺班级维度',
          suggestion: '按班级补一行',
        },
      ],
    };
    expect(() => assertPblFeedbackGrounded(grounded, fixture.evidence)).not.toThrow();
    expect(
      errorOf(() =>
        assertPblFeedbackGrounded(
          { ...grounded, basisArtifactIds: ['pbl_art_ghost'] },
          fixture.evidence,
        ),
      ).reason,
    ).toBe('feedback_basis_not_a_real_artifact');
    expect(
      errorOf(() =>
        assertPblFeedbackGrounded(
          {
            ...grounded,
            points: [{ artifactId: 'pbl_art_other', observation: '无依据', suggestion: '无依据' }],
          },
          fixture.evidence,
        ),
      ).reason,
    ).toBe('feedback_point_without_basis');
    const record = pblFeedbackRecordFrom(
      {
        operation: 'feedback',
        scope: SCOPE,
        binding: fixture.env.binding,
        actorUid: MENTOR,
        feedback: grounded,
        nonce: 'fb-ev',
      },
      collaboratorFacts(fixture.env.project, MENTOR),
    );
    expect(record.actorType).toBe('teacher_ai');
    expect(fixture.env.load([fixture.base, record])).toHaveLength(2);
    // 反馈不参与判定：有反馈没认领时，里程碑依旧未达成。
    const milestones = pblMilestoneEvaluations(
      fixture.env.project,
      fixture.env.load([fixture.base, record]),
    );
    expect(milestones[0]!.reached).toBe(false);
  });

  it('评价候选只能引用真实交付与属于该里程碑的评分依据', () => {
    const fixture = evaluationFixture();
    const artifacts = pblExistingArtifactIds(fixture.evidence);
    const payload = (
      milestoneId: string,
      rubricId: string,
      basis: string[] = [fixture.artifactId],
    ) => ({
      milestoneId,
      roleId: 'mentor',
      goalIds: ['goal_find'],
      candidates: [
        {
          candidateId: `cand-${milestoneId}-${rubricId}`,
          rubricId,
          judgement: 'adequate' as const,
          rationale: '导师候选：覆盖两时段。',
          basisArtifactIds: basis,
        },
      ],
    });
    expect(() =>
      assertPblCandidateGrounded(fixture.env.project, payload('ms_data', 'rubric_data'), artifacts),
    ).not.toThrow();
    expect(
      errorOf(() =>
        assertPblCandidateGrounded(
          fixture.env.project,
          payload('ms_data', 'rubric_ghost'),
          artifacts,
        ),
      ).reason,
    ).toBe('assessment_rubric_not_in_definition');
    // rubric_proposal 属于 ms_adopt，拿它评 ms_data 就是跨里程碑拼贴。
    expect(
      errorOf(() =>
        assertPblCandidateGrounded(
          fixture.env.project,
          payload('ms_data', 'rubric_proposal'),
          artifacts,
        ),
      ).reason,
    ).toBe('assessment_rubric_not_for_milestone');
    expect(
      errorOf(() =>
        assertPblCandidateGrounded(
          fixture.env.project,
          payload('ms_data', 'rubric_data', ['pbl_art_nobody']),
          artifacts,
        ),
      ).reason,
    ).toBe('assessment_basis_not_a_real_artifact');
    expect(
      errorOf(() =>
        assertPblCandidateGrounded(
          fixture.env.project,
          { ...payload('ms_ghost', 'rubric_data'), milestoneId: 'ms_ghost' },
          artifacts,
        ),
      ).code,
    ).toBe('NOT_FOUND');
    expect(
      errorOf(() =>
        assertPblCandidateGrounded(
          fixture.env.project,
          { ...payload('ms_data', 'rubric_data'), goalIds: ['goal_ghost'] },
          artifacts,
        ),
      ).reason,
    ).toBe('unknown_goal_reference');
  });

  it('候选与人工采纳都不改变里程碑达成：reached 只随确定性检查翻转', () => {
    const fixture = evaluationFixture();
    const env = fixture.env;
    const assessment = env.assess({
      nonce: 'assess-both',
      milestoneId: 'ms_data',
      rubricId: 'rubric_data',
      candidateId: 'cand-both',
      basis: [fixture.artifactId],
      judgement: 'exemplary',
    });
    const acceptance = env.accept('accept-both', assessment, ['cand-both']);
    // 只交付未认领：导师怎么评、本人怎么采纳都不算达成。
    const before = pblMilestoneEvaluations(
      env.project,
      env.load([fixture.base, assessment, acceptance]),
    )[0]!;
    expect(before.reached).toBe(false);
    expect(before.assessment.candidates).toHaveLength(1);
    expect(before.assessment.acceptedCandidateIds).toEqual(['cand-both']);
    expect(pblMilestoneSummary(before)).toMatchObject({
      reached: false,
      candidateCount: 1,
      acceptedCandidateCount: 1,
    });
    // 补上认领 → 达成；评语一个字都没变，结论只随检查改变。
    const after = pblMilestoneEvaluations(
      env.project,
      env.load([
        fixture.base,
        fixture.contribution,
        env.acknowledge('ack-both', 'con-ev'),
        assessment,
        acceptance,
      ]),
    )[0]!;
    expect(after.reached).toBe(true);
    expect(after.assessment.acceptedCandidateIds).toEqual(['cand-both']);
    // 采纳不会反向改写评价记录本身（候选与采纳是两条记录）。
    expect(
      (assessment as { acceptedCandidateIds?: string[] }).acceptedCandidateIds,
    ).toBeUndefined();
  });

  it('采纳只能指向存在的评价记录与其中的候选；AI 不能替本人采纳', () => {
    const fixture = evaluationFixture();
    const env = fixture.env;
    expect(
      errorOf(() =>
        assertPblAcceptanceTargetsAssessment(
          { assessmentNonce: 'missing', acceptedCandidateIds: ['x'] },
          fixture.evidence,
        ),
      ),
    ).toEqual({ code: 'NOT_FOUND', reason: 'pbl_assessment_not_found' });
    const assessment = env.assess({
      nonce: 'assess-acc',
      milestoneId: 'ms_data',
      rubricId: 'rubric_data',
      candidateId: 'cand-acc',
      basis: [fixture.artifactId],
    });
    const evidence = env.load([assessment]);
    expect(
      errorOf(() =>
        assertPblAcceptanceTargetsAssessment(
          { assessmentNonce: assessment.nonce, acceptedCandidateIds: ['ghost-cand'] },
          evidence,
        ),
      ).reason,
    ).toBe('assessment_candidate_not_found');
    expect(() =>
      assertPblAcceptanceTargetsAssessment(
        { assessmentNonce: assessment.nonce, acceptedCandidateIds: ['cand-acc'] },
        evidence,
      ),
    ).not.toThrow();
    expect(
      errorOf(() =>
        pblAcceptanceRecordFrom(
          {
            operation: 'acceptEvaluation',
            scope: SCOPE,
            binding: env.binding,
            actorUid: MENTOR,
            assessmentNonce: assessment.nonce,
            acceptedCandidateIds: ['cand-acc'],
            nonce: 'acc-mentor',
          },
          collaboratorFacts(env.project, MENTOR),
          assessment as PblAssessmentRecordType,
        ),
      ),
    ).toEqual({ code: 'ROLE_PERMISSION_DENIED', reason: 'only_learner_accepts_evaluation' });
  });

  it('AI 贡献必须依据同任务的真实交付：引用别的阶段的产物不算有依据', () => {
    const fixture = evaluationFixture();
    const env = fixture.env;
    const slides = env.submit('sub-cross', proposalPayload());
    const all = env.load([fixture.base, slides]);
    expect(() =>
      assertPblContributionGrounded(
        { taskId: 'task_survey', basisArtifactIds: [pblArtifactIdFromRecord(fixture.base)] },
        all,
      ),
    ).not.toThrow();
    expect(
      errorOf(() =>
        assertPblContributionGrounded(
          { taskId: 'task_proposal', basisArtifactIds: [pblArtifactIdFromRecord(fixture.base)] },
          all,
        ),
      ).reason,
    ).toBe('contribution_basis_not_a_real_artifact');
    expect(
      errorOf(() =>
        assertPblContributionGrounded({ taskId: 'task_survey', basisArtifactIds: [] }, all),
      ).reason,
    ).toBe('contribution_without_basis');
  });

  it('候选形状没有 passed/score，判定结论与 verified 都不接受客户端实例', () => {
    const fixture = evaluationFixture();
    expect(
      pblAssessCommandSchema.safeParse({
        operation: 'assess',
        scope: SCOPE,
        binding: fixture.env.binding,
        actorUid: MENTOR,
        assessment: {
          milestoneId: 'ms_data',
          roleId: 'mentor',
          goalIds: [],
          candidates: [
            {
              candidateId: 'x',
              rubricId: 'rubric_data',
              judgement: 'adequate',
              rationale: 'r',
              basisArtifactIds: [fixture.artifactId],
              passed: true,
            },
          ],
        },
        nonce: 'n',
      }).success,
    ).toBe(false);
    // 任务更新不能申报 verified：达成由检查决定。
    expect(
      pblTaskCommandSchema.safeParse({
        operation: 'task',
        intent: 'update',
        scope: SCOPE,
        binding: fixture.env.binding,
        actorUid: LEARNER,
        taskId: 'task_survey',
        roleId: null,
        reportedStatus: 'verified',
        report: '我自己说完成了',
        nonce: 'n',
      }).success,
    ).toBe(false);
    // 命令通不到自报身份。
    expect(
      pblCommandSchema.safeParse({
        ...{
          operation: 'submit',
          scope: SCOPE,
          binding: fixture.env.binding,
          actorUid: LEARNER,
          deliverable: surveyPayload(),
          nonce: 'n',
        },
        actorType: 'peer_ai',
      }).success,
    ).toBe(false);
    // 记录里没有「导师说通过」的字段。
    expect(
      pblRecordSchema.safeParse({
        ...fixture.base,
        kind: 'assessment',
        milestoneId: 'ms_data',
        candidates: [],
      }).success,
    ).toBe(false);
  });

  it('五种确定性检查都实际运行；未知判定式拒绝而不是静默跳过', () => {
    const single = oneSubmission();
    const deliverables = single.evidence.filter((item) => item.operation === 'submit');
    const context = {
      deliverables,
      contributions: [],
      acknowledgedNonces: new Set<string>(),
      reachedMilestoneIds: new Set(['other']),
    };
    expect(
      runPblDeterministicCheck(
        {
          id: 'c1',
          kind: 'deliverable_submitted',
          label: 'l',
          expectation: 'e',
          artifactKind: 'report',
        },
        context,
      ),
    ).toMatchObject({ passed: true });
    expect(
      runPblDeterministicCheck(
        {
          id: 'c1b',
          kind: 'deliverable_submitted',
          label: 'l',
          expectation: 'e',
          artifactKind: 'slides',
        },
        context,
      ),
    ).toMatchObject({ passed: false, detail: 'no_deliverable' });
    expect(
      runPblDeterministicCheck(
        {
          id: 'c2',
          kind: 'deliverable_contains',
          label: 'l',
          expectation: 'e',
          fragments: ['米饭'],
          artifactKind: 'report',
        },
        context,
      ).passed,
    ).toBe(true);
    expect(
      runPblDeterministicCheck(
        {
          id: 'c3',
          kind: 'deliverable_min_length',
          label: 'l',
          expectation: 'e',
          minChars: 99999,
          artifactKind: null,
        },
        context,
      ).passed,
    ).toBe(false);
    expect(
      runPblDeterministicCheck(
        { id: 'c4', kind: 'milestone_reached', label: 'l', expectation: 'e', milestoneId: 'other' },
        context,
      ),
    ).toMatchObject({ passed: true });
    expect(
      errorOf(() =>
        runPblDeterministicCheck(
          { id: 'c5', kind: 'telepathy', label: 'l', expectation: 'e' } as unknown as Parameters<
            typeof runPblDeterministicCheck
          >[0],
          context,
        ),
      ).reason,
    ).toBe('unsupported_pbl_check_kind');
  });
});

describe('PBL 模拟器、开任务与任务更新实际运行（OMA-049）', () => {
  const project = definition();
  const frozen = frozenOf(project);
  const binding = bindingOf(frozen);
  const learnerSeat = pblLearnerRole(frozen.definition, LEARNER);
  const openState = (): PblSimulationStateDto =>
    openPblSimulation(frozen, binding, { maxSteps: 10 });

  const stepInput = (
    overrides: Partial<PblSimulationStepInput> &
      Pick<PblSimulationStepInput, 'operation' | 'taskId'>,
  ): PblSimulationStepInput => ({
    scope: SCOPE,
    binding,
    actorUid: LEARNER,
    nonce: `sim-${Math.random().toString(36).slice(2, 8)}`,
    roleId: null,
    milestoneId: null,
    reportedStatus: null,
    deliverable: null,
    contribution: null,
    contributionNonce: null,
    feedback: null,
    assessment: null,
    assessmentNonce: null,
    acceptedCandidateIds: null,
    artifactIds: null,
    note: '演练',
    ...overrides,
  });

  const asLearner = { definition: frozen.definition, role: learnerSeat, binding };
  const asMentor = {
    definition: frozen.definition,
    role: pblCollaboratorRole(frozen.definition, MENTOR),
    binding,
  };
  const asPeer = {
    definition: frozen.definition,
    role: pblCollaboratorRole(frozen.definition, PEER),
    binding,
  };

  it('打开模拟器即真跑：初始所有里程碑未达成，投影里没有评分依据与私人正文', () => {
    const state = openState();
    expect(state).toMatchObject({ simulated: true, recordScope: 'demo' });
    expect(state.tasks).toHaveLength(2);
    expect(state.tasks.map((task) => task.status)).toEqual(['available', 'available']);
    expect(state.milestones.map((entry) => entry.reached)).toEqual([false, false]);
    // 未达成不是空白：每条检查都给出了失败原因。
    expect(state.milestones[0]!.deterministic.map((outcome) => outcome.detail)).toEqual([
      'no_deliverable',
      'acknowledged:0<1=true',
    ]);
    const json = JSON.stringify(state);
    expect(json).not.toContain('rubric');
    expect(json).not.toContain('criterion');
    expect(state.allowedOperations).toContain('open');
    expect(state.allowedOperations).not.toContain('review');
  });

  it('开任务→交付→贡献→认领：每一步都实际改变状态，交付与 AI 贡献分开计', () => {
    let state = openState();
    const opened = runPblSimulationStep(
      state,
      stepInput({
        operation: 'open',
        taskId: 'task_survey',
        roleId: 'seat_a',
        reportedStatus: 'in_progress',
        nonce: 'sim-open',
      }),
      asLearner,
    );
    state = opened.state;
    expect(state.tasks[0]!.status).toBe('in_progress');
    expect(state.stepBudget.used).toBe(1);

    const submitted = runPblSimulationStep(
      state,
      stepInput({
        operation: 'submit',
        taskId: 'task_survey',
        deliverable: surveyPayload(),
        nonce: 'sim-submit',
      }),
      asLearner,
    );
    state = submitted.state;
    // 阶段长度检查已过 → verified；里程碑仍差认领。
    expect(state.tasks[0]!.status).toBe('verified');
    expect(state.tasks[0]).toMatchObject({ ownSubmissionCount: 1, aiContributionCount: 0 });
    expect(state.artifactIds).toHaveLength(1);
    expect(submitted.reached).toEqual([]);
    const artifactId = state.artifactIds[0]!;

    const contributed = runPblSimulationStep(
      state,
      stepInput({
        operation: 'contribute',
        actorUid: PEER,
        taskId: 'task_survey',
        contribution: {
          roleId: 'peer',
          taskId: 'task_survey',
          milestoneId: null,
          content: '演练：建议补班级维度。',
          basisArtifactIds: [artifactId],
        },
        nonce: 'sim-con',
      }),
      asPeer,
    );
    state = contributed.state;
    expect(state.tasks[0]).toMatchObject({
      ownSubmissionCount: 1,
      aiContributionCount: 1,
      acknowledgedContributionCount: 0,
    });

    const acknowledged = runPblSimulationStep(
      state,
      stepInput({
        operation: 'acknowledge',
        taskId: 'task_survey',
        contributionNonce: 'sim-con',
        nonce: 'sim-ack',
      }),
      asLearner,
    );
    expect(acknowledged.state.tasks[0]).toMatchObject({
      aiContributionCount: 1,
      acknowledgedContributionCount: 1,
    });
    expect(acknowledged.reached).toEqual(['ms_data']);
    // 认领没有复制出一份本人交付。
    expect(acknowledged.state.tasks[0]!.ownSubmissionCount).toBe(1);
  });

  it('提案版交付让第二个里程碑达成；报告形态顶替不了它', () => {
    let state = openState();
    const base = runPblSimulationStep(
      state,
      stepInput({
        operation: 'submit',
        taskId: 'task_survey',
        deliverable: surveyPayload(),
        nonce: 'chain-submit',
      }),
      asLearner,
    );
    state = base.state;
    const con = runPblSimulationStep(
      state,
      stepInput({
        operation: 'contribute',
        actorUid: PEER,
        taskId: 'task_survey',
        contribution: {
          roleId: 'peer',
          taskId: 'task_survey',
          milestoneId: null,
          content: '演练：拆班级。',
          basisArtifactIds: [state.artifactIds[0]!],
        },
        nonce: 'chain-con',
      }),
      asPeer,
    );
    state = con.state;
    const ack = runPblSimulationStep(
      state,
      stepInput({
        operation: 'acknowledge',
        taskId: 'task_survey',
        contributionNonce: 'chain-con',
        nonce: 'chain-ack',
      }),
      asLearner,
    );
    state = ack.state;
    expect(state.milestones.map((entry) => entry.reached)).toEqual([true, false]);
    // 再交一份报告（不是 slides）→ 提案里程碑仍不过。
    const wrongKind = runPblSimulationStep(
      state,
      stepInput({
        operation: 'submit',
        taskId: 'task_proposal',
        deliverable: { ...proposalPayload(), artifactKind: 'report' },
        nonce: 'chain-wrong',
      }),
      asLearner,
    );
    expect(wrongKind.state.milestones.map((entry) => entry.reached)).toEqual([true, false]);
    const slides = runPblSimulationStep(
      wrongKind.state,
      stepInput({
        operation: 'submit',
        taskId: 'task_proposal',
        deliverable: proposalPayload(),
        nonce: 'chain-slides',
      }),
      asLearner,
    );
    expect(slides.state.milestones.map((entry) => entry.reached)).toEqual([true, true]);
    expect(slides.reached).toEqual(['ms_data', 'ms_adopt']);
  });

  it('模拟器逐次守权限：导师不能替本人交付，本人不能冒充 AI 出候选', () => {
    const state = openState();
    expect(
      errorOf(() =>
        runPblSimulationStep(
          state,
          stepInput({
            operation: 'submit',
            actorUid: MENTOR,
            taskId: 'task_survey',
            deliverable: surveyPayload(),
            nonce: 'sim-forge-1',
          }),
          asMentor,
        ),
      ),
    ).toEqual({ code: 'ROLE_PERMISSION_DENIED', reason: 'pbl_seat_cannot_run_operation' });
    expect(
      errorOf(() =>
        runPblSimulationStep(
          state,
          stepInput({
            operation: 'assess',
            taskId: 'task_survey',
            assessment: {
              milestoneId: 'ms_data',
              roleId: 'seat_a',
              goalIds: [],
              candidates: [
                {
                  candidateId: 'c',
                  rubricId: 'rubric_data',
                  judgement: 'adequate',
                  rationale: 'r',
                  basisArtifactIds: ['pbl_art_x'],
                },
              ],
            },
            nonce: 'sim-forge-2',
          }),
          asLearner,
        ),
      ).reason,
    ).toBe('pbl_seat_cannot_run_operation');
    expect(
      errorOf(() =>
        runPblSimulationStep(
          state,
          stepInput({
            operation: 'open',
            taskId: 'task_survey',
            roleId: 'peer',
            reportedStatus: 'in_progress',
            nonce: 'sim-forge-3',
          }),
          asLearner,
        ),
      ).reason,
    ).toBe('role_not_allowed_for_task');
    // 未登记的协作席位连席位都取不到（非成员）。
    expect(errorOf(() => pblCollaboratorRole(frozen.definition, UNREGISTERED))).toEqual({
      code: 'ROLE_PERMISSION_DENIED',
      reason: 'not_project_member',
    });
  });

  it('模拟器不写正式记录：演练证据变不成记录，正式写入按分区拒', () => {
    const submitted = runPblSimulationStep(
      openState(),
      stepInput({
        operation: 'submit',
        taskId: 'task_survey',
        deliverable: surveyPayload(),
        nonce: 'sim-demo',
      }),
      asLearner,
    );
    const demoEvidence = submitted.state.steps[0]!;
    expect(demoEvidence).toMatchObject({ source: 'simulation', recordScope: 'demo' });
    expect(errorOf(() => assertPblSimulationCannotWriteFormal(demoEvidence))).toEqual({
      code: 'SIMULATION_WRITE_FORBIDDEN',
      reason: 'pbl_simulation_step',
    });
    // demo 分区的正文根本通不过记录合同（recordScope 是 formal 字面量）。
    const env = harness();
    const formal = env.submit('mix-attempt', surveyPayload());
    expect(pblRecordSchema.safeParse({ ...formal, recordScope: 'demo' }).success).toBe(false);
  });

  it('同 nonce 重放只推进一次；预算用完即拒（演练不是无限写入器）', () => {
    const limited = { ...openState(), stepBudget: { maxSteps: 2, used: 0 } };
    const firstStep = stepInput({
      operation: 'open',
      taskId: 'task_survey',
      roleId: 'seat_a',
      reportedStatus: 'in_progress',
      nonce: 'same',
    });
    const first = runPblSimulationStep(limited, firstStep, asLearner);
    expect(first.state.stepBudget.used).toBe(1);
    const replay = runPblSimulationStep(
      first.state,
      { ...firstStep, note: '网络重试同一条' },
      asLearner,
    );
    expect(replay.state.stepBudget.used).toBe(1);
    expect(replay.state.steps).toHaveLength(1);
    const second = runPblSimulationStep(
      replay.state,
      stepInput({
        operation: 'update',
        taskId: 'task_survey',
        reportedStatus: 'submitted',
        nonce: 'second',
      }),
      asLearner,
    );
    expect(second.state.stepBudget.used).toBe(2);
    expect(
      errorOf(() =>
        runPblSimulationStep(
          second.state,
          stepInput({
            operation: 'update',
            taskId: 'task_survey',
            reportedStatus: 'needs_revision',
            nonce: 'third',
          }),
          asLearner,
        ),
      ),
    ).toEqual({ code: 'ROLE_PERMISSION_DENIED', reason: 'simulation_step_budget_exhausted' });
    expect(
      pblSimulationStepAllowed({ operation: 'submit' }, { maxSteps: 2, used: 2 }).remaining,
    ).toBe(0);
  });

  it('单步载荷形状：动作只能带自己的正文；未注册动作与缺载荷直接拒', () => {
    expect(
      pblSimulationStepSchemaChecked.safeParse(
        stepInput({
          operation: 'submit',
          taskId: 'task_survey',
          deliverable: surveyPayload(),
          contribution: {
            roleId: 'peer',
            taskId: 'task_survey',
            milestoneId: null,
            content: '夹带',
            basisArtifactIds: ['pbl_art_x'],
          },
          nonce: 's',
        }),
      ).success,
    ).toBe(false);
    expect(
      pblSimulationStepSchemaChecked.safeParse(
        stepInput({ operation: 'submit', taskId: 'task_survey', nonce: 's' }),
      ).success,
    ).toBe(false);
    expect(
      pblSimulationStepSchemaChecked.safeParse(
        stepInput({ operation: 'open', taskId: 'task_survey', nonce: 's' }),
      ).success,
    ).toBe(false);
    expect(
      pblSimulationStepSchemaChecked.safeParse(
        stepInput({ operation: 'review' as never, taskId: 'task_survey', nonce: 's' }),
      ).success,
    ).toBe(false);
    expect(
      pblSimulationStepAllowed({ operation: 'review' }, { maxSteps: 3, used: 0 }),
    ).toMatchObject({
      allowed: false,
      reason: 'operation_not_simulatable',
    });
    // 越界绑定：演练也不能挪到另一个定义上。
    const otherBinding: PblBindingDto = {
      ...binding,
      definitionId: 'pbl_other',
      definitionDigest: 'x'.repeat(64),
    };
    expect(
      errorOf(() =>
        runPblSimulationStep(
          openPblSimulation(frozen, otherBinding, { maxSteps: 3 }),
          stepInput({
            operation: 'open',
            taskId: 'task_survey',
            roleId: 'seat_a',
            reportedStatus: 'in_progress',
            nonce: 'b',
          }),
          asLearner,
        ),
      ).reason,
    ).toBe('pbl_binding_stale');
  });

  it('演练里的反馈与评价同样要依据真实产物；无依据评语在模拟器里也被拒', () => {
    let state = runPblSimulationStep(
      openState(),
      stepInput({
        operation: 'submit',
        taskId: 'task_survey',
        deliverable: surveyPayload(),
        nonce: 'fb-submit',
      }),
      asLearner,
    ).state;
    const artifactId = state.artifactIds[0]!;
    expect(
      errorOf(() =>
        runPblSimulationStep(
          state,
          stepInput({
            operation: 'feedback',
            actorUid: MENTOR,
            taskId: 'task_survey',
            feedback: {
              taskId: 'task_survey',
              milestoneId: null,
              basisArtifactIds: ['pbl_art_invented'],
              points: [{ artifactId: 'pbl_art_invented', observation: '凭空', suggestion: '评语' }],
            },
            nonce: 'fb-bad',
          }),
          asMentor,
        ),
      ).reason,
    ).toBe('feedback_basis_not_a_real_artifact');
    const feedbacked = runPblSimulationStep(
      state,
      stepInput({
        operation: 'feedback',
        actorUid: MENTOR,
        taskId: 'task_survey',
        feedback: {
          taskId: 'task_survey',
          milestoneId: null,
          basisArtifactIds: [artifactId],
          points: [{ artifactId, observation: '演练：缺第三时段', suggestion: '演练：补一行' }],
        },
        nonce: 'fb-good',
      }),
      asMentor,
    );
    state = feedbacked.state;
    expect(state.stepBudget.used).toBe(2);
    const assessed = runPblSimulationStep(
      state,
      stepInput({
        operation: 'assess',
        actorUid: MENTOR,
        taskId: 'task_survey',
        assessment: {
          milestoneId: 'ms_data',
          roleId: 'mentor',
          goalIds: [],
          candidates: [
            {
              candidateId: 'sim-cand',
              rubricId: 'rubric_data',
              judgement: 'exemplary',
              rationale: '演练评语',
              basisArtifactIds: [artifactId],
            },
          ],
        },
        nonce: 'fb-assess',
      }),
      asMentor,
    );
    state = assessed.state;
    // 候选出现，但 reached 仍取决于确定性检查（未认领）。
    expect(state.milestones[0]!.assessment.candidates).toHaveLength(1);
    expect(state.milestones[0]!.reached).toBe(false);
    expect(assessed.reached).toEqual([]);
    const accepted = runPblSimulationStep(
      state,
      stepInput({
        operation: 'acceptEvaluation',
        taskId: null,
        assessmentNonce: 'fb-assess',
        acceptedCandidateIds: ['sim-cand'],
        nonce: 'fb-accept',
      }),
      asLearner,
    );
    // 采纳改变的是 assessment 线上的呈现，reached 一个字都没动。
    expect(accepted.state.milestones[0]!.assessment.acceptedCandidateIds).toEqual(['sim-cand']);
    expect(accepted.state.milestones[0]!.reached).toBe(false);
    expect(
      errorOf(() =>
        runPblSimulationStep(
          state,
          stepInput({
            operation: 'acceptEvaluation',
            taskId: null,
            assessmentNonce: 'ghost',
            acceptedCandidateIds: ['sim-cand'],
            nonce: 'fb-bad-accept',
          }),
          asLearner,
        ),
      ).code,
    ).toBe('NOT_FOUND');
  });
});

describe('PBL 命令合同的输入信任边界', () => {
  const binding: PblBindingDto = {
    version: 1,
    stageId: 'stage_pbl_v1',
    definitionId: 'pbl_canteen',
    documentDigest: 'doc',
    definitionDigest: 'digest',
  };
  const submitCommand = {
    operation: 'submit',
    scope: SCOPE,
    binding,
    actorUid: LEARNER,
    deliverable: surveyPayload(),
    nonce: 'n',
  };

  it('带不上 actorType / recordScope / 演示分区，未核对不能冻结', () => {
    expect(pblCommandSchema.safeParse({ ...submitCommand, actorType: 'peer_ai' }).success).toBe(
      false,
    );
    expect(pblCommandSchema.safeParse({ ...submitCommand, recordScope: 'demo' }).success).toBe(
      false,
    );
    expect(pblCommandSchema.safeParse({ ...submitCommand, result: '通过' }).success).toBe(false);
    expect(
      pblCommandSchema.safeParse({
        operation: 'review',
        scope: SCOPE,
        binding,
        lessonId: 'l',
        lessonVersion: 1,
        semanticReviewed: false,
        reviewNote: '没逐条核对也想冻结',
        definition: definition(),
      }).success,
    ).toBe(false);
    // 冻结命令里没有「权限位」可填：权限由席位种类派生。
    expect(
      pblCommandSchema.safeParse({
        operation: 'review',
        scope: SCOPE,
        binding,
        lessonId: 'l',
        lessonVersion: 1,
        semanticReviewed: true,
        reviewNote: '已核对',
        definition: definition(),
        permissions: { canReachMilestone: true },
      }).success,
    ).toBe(false);
  });

  it('simulate 命令只有开关性质字段，没有任何可落库正文', () => {
    const parsed = pblCommandSchema.safeParse({
      operation: 'simulate',
      scope: SCOPE,
      binding,
      viewerUid: LEARNER,
      maxSteps: 5,
    });
    expect(parsed.success).toBe(true);
    const keys = Object.keys(parsed.data as object).sort();
    expect(keys).toEqual(['binding', 'maxSteps', 'operation', 'scope', 'viewerUid']);
    expect(JSON.stringify(parsed.data)).not.toContain('artifactText');
  });

  it('他人 UID 与越权字段在写入命令里不是合法输入（strict object 拒未知键）', () => {
    expect(pblCommandSchema.safeParse({ ...submitCommand, uid: PEER }).success).toBe(false);
    // acknowledge 只能由真人成员发：actorUid 给 AI 席位时形状仍合法，但入口守卫拒。
    const env = harness();
    expect(
      errorOf(() =>
        pblCommandActorRole(env.project, {
          operation: 'acknowledge',
          scope: SCOPE,
          binding: env.binding,
          actorUid: PEER,
          contributionNonce: 'con-x',
          note: 'AI 自行宣布本人已认领',
          nonce: 'n',
        }),
      ).reason,
    ).toBe('learner_seat_required');
  });
});
