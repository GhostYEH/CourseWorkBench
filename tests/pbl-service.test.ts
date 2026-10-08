import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PblBindingDto, PblProjectDefinitionDto } from '@sew/study-contracts';
import { pblProjectStateSchema } from '@sew/study-contracts';
import {
  classroomDocumentDigest,
  pblArtifactIdFromRecord,
  pblHash,
  pblProjectSceneId,
} from '@sew/study-domain';
import { buildFormalLessonDocument } from '../apps/learning/lib/classroom/formal-lesson-document';
import {
  commandPblProject,
  loadPblProject,
  pblAiMemberUid,
  readPblContext,
  reviewPblDefinition,
  savePblGeneratedRecord,
  simulatePbl,
} from '../apps/learning/lib/server/pbl-service';
import {
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';

const roots: string[] = [];
const lessonStatement = '陈述：函数值随自变量增加';
const otherUid = 'uid_10000000-0000-4000-8000-000000000002';
const definitionFor = (
  uid: string,
  statementId: string,
  multipleTasks = false,
): PblProjectDefinitionDto => ({
  id: 'pbl_function_inquiry',
  title: '函数变化调查',
  statementIds: [statementId],
  authenticContext: {
    audience: '校内数学社',
    problem: '解释数量变化',
    constraints: ['只使用已审核材料'],
  },
  background: '学生根据已审核证据设计一份可复核的调查记录。',
  goals: [{ id: 'goal_explain', statement: '解释变化', successDescription: '交付有证据的报告' }],
  projectChecks: [],
  roles: [
    {
      id: 'learner',
      name: '学生',
      kind: 'learner',
      responsibilities: ['完成调查'],
      memberUid: uid,
    },
    {
      id: 'peer_ai',
      name: 'AI同学',
      kind: 'peer_ai',
      responsibilities: ['基于本人产物建议'],
      memberUid: null,
    },
  ],
  tasks: [
    {
      id: 'task_report',
      title: '调查记录',
      statementIds: [statementId],
      phase: '调查',
      outcome: '形成可复核的报告',
      artifactKinds: ['report'],
      roleIds: ['learner'],
      milestoneIds: ['milestone_report'],
      checks: [],
    },
    ...(multipleTasks
      ? [
          {
            id: 'task_compare',
            title: '对比记录',
            statementIds: [statementId],
            phase: '调查',
            outcome: '形成可复核的对比',
            artifactKinds: ['report' as const],
            roleIds: ['learner'],
            milestoneIds: ['milestone_report'],
            checks: [],
          },
        ]
      : []),
  ],
  milestones: [
    {
      id: 'milestone_report',
      title: '报告完成',
      statementIds: [statementId],
      order: 1,
      checks: [
        {
          id: 'check_report',
          kind: 'deliverable_submitted',
          label: '报告已提交',
          expectation: '有本人报告',
          artifactKind: 'report',
        },
      ],
      rubricIds: ['rubric_report'],
      taskIds: multipleTasks ? ['task_report', 'task_compare'] : ['task_report'],
    },
  ],
  rubrics: [
    {
      id: 'rubric_report',
      criterion: '证据是否完整',
      levels: [
        { level: 'exemplary', descriptor: '来源清楚且完整' },
        { level: 'adequate', descriptor: '主要来源清楚' },
        { level: 'developing', descriptor: '缺少来源' },
      ],
    },
  ],
  cadenceDays: 7,
});

const fixture = ({ multipleTasks = false }: { multipleTasks?: boolean } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'sew-pbl-service-'));
  roots.push(root);
  let session = openProjectFromDisk(root);
  const projectId = session.projectId;
  const imported = session.store.importMaterial({
    projectId,
    displayName: '正式材料',
    materialType: 'txt',
    rawText: `${lessonStatement}。同一区间内自变量增大，函数值同步增大。`,
  });
  const proposal = session.store.createProposal({
    projectId,
    name: '函数变化',
    concept: '函数值随自变量增大',
    conditions: '同一区间',
    scopeStatus: 'in_syllabus',
    prerequisites: [],
    evidence: [
      {
        materialId: imported.material.materialId,
        revision: 1,
        segmentId: 'S001',
        use: 'concept_basis',
      },
    ],
    acceptance: '',
    priority: 'medium',
    proposedBy: 'user',
  });
  const knowledgeId = session.store.applyReview({
    proposalId: proposal.proposalId,
    decision: 'approved',
    expectedRevision: proposal.revision,
    semanticReviewed: true,
  }).knowledgePoint!.knowledgeId;
  session.store.savePlanVersion(projectId, 1, 'confirmed', {
    payloadVersion: 1,
    goal: '解释函数变化',
    examDate: null,
    dailyMinutes: 30,
    tasks: [
      {
        knowledgeId,
        name: '函数变化',
        minutes: 20,
        acceptance: '',
        evidence: [{ materialId: imported.material.materialId, segmentId: 'S001' }],
      },
    ],
    gaps: [],
    basis: '核验来源',
    confirmedTaskKnowledgeIds: [knowledgeId],
  });
  const bundle = session.store.buildLessonBundle(
    projectId,
    [{ knowledgeId, text: lessonStatement, conditions: '同一区间' }],
    [],
  );
  const lesson = session.store.createLessonDraft({
    projectId,
    lessonId: null,
    title: '函数变化调查课',
    bundleId: bundle.bundleId,
    statementIds: bundle.bundle.statements.map((statement) => statement.statementId),
    questionIds: [],
  });
  const definition = definitionFor(session.learnerUid, lesson.statementIds[0]!, multipleTasks);
  const draftBinding: PblBindingDto = {
    version: 1,
    stageId: `stage_formal_${lesson.lessonId}_v1`,
    definitionId: definition.id,
    documentDigest: 'unpublished_document',
    definitionDigest: pblHash(definition),
  };
  const frozen = reviewPblDefinition(session, {
    scope: { projectId, generation: session.generation },
    binding: draftBinding,
    operation: 'review',
    lessonId: lesson.lessonId,
    lessonVersion: 1,
    semanticReviewed: true,
    reviewNote: '已对照准入来源逐条复核项目定义。',
    definition,
  });
  session.store.reviewLesson({
    projectId,
    lessonId: lesson.lessonId,
    version: 1,
    decision: 'approved',
    note: '核对正式材料',
  });
  session.store.publishLesson({ projectId, lessonId: lesson.lessonId, version: 1 });
  const built = buildFormalLessonDocument({
    bundle: bundle.bundle,
    bundleDigest: bundle.digest,
    lessonId: lesson.lessonId,
    lessonVersion: 1,
    title: lesson.title,
    frozenAt: bundle.frozenAt,
    statementIds: lesson.statementIds,
    questionIds: [],
    pblDefinition: frozen,
  });
  const docDigest = classroomDocumentDigest(built.document);
  session.store.saveClassroomDocument({
    projectId,
    lessonId: lesson.lessonId,
    stageId: built.stageId,
    dslVersion: built.dslVersion,
    document: built.document,
    digest: docDigest,
    sceneCount: built.scenes.length,
    scenes: built.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      knowledgeIds: scene.knowledgeIds,
      questionId: scene.questionId,
    })),
    reviewedBy: 'local_user',
    reviewNote: '核对正式课堂',
    recordScope: 'formal',
  });
  session.store.attachLessonDocument({
    projectId,
    lessonId: lesson.lessonId,
    version: 1,
    stageId: built.stageId,
    documentDigest: docDigest,
  });
  const binding: PblBindingDto = {
    version: 1,
    stageId: built.stageId,
    definitionId: frozen.definition.id,
    documentDigest: docDigest,
    definitionDigest: pblHash(frozen.definition),
  };
  const reopen = (): Session => {
    closeProject();
    session = openProjectFromDisk(root);
    return session;
  };
  return {
    get session() {
      return session;
    },
    projectId,
    lesson,
    bundle,
    frozen,
    binding,
    reopen,
  };
};

const scopeFor = (session: Session) => ({
  projectId: session.projectId,
  generation: session.generation,
});
const openTask = (f: ReturnType<typeof fixture>, nonce = 'open-task') =>
  commandPblProject(f.session, {
    operation: 'task',
    scope: scopeFor(f.session),
    binding: f.binding,
    actorUid: f.session.learnerUid,
    intent: 'open',
    taskId: 'task_report',
    roleId: 'learner',
    reportedStatus: 'in_progress',
    report: '开始调查。',
    nonce,
  });
const submit = (
  f: ReturnType<typeof fixture>,
  nonce = 'submit-report',
  artifactText = '根据审核材料完成了调查报告。',
) =>
  commandPblProject(f.session, {
    operation: 'submit',
    scope: scopeFor(f.session),
    binding: f.binding,
    actorUid: f.session.learnerUid,
    deliverable: {
      taskId: 'task_report',
      milestoneId: 'milestone_report',
      artifactKind: 'report',
      artifactTitle: '调查报告',
      artifactText,
      assetRefs: [],
      goalIds: ['goal_explain'],
    },
    nonce,
  });

afterEach(() => {
  closeProject();
  const holder = (globalThis as { __sewSession?: { environmentBootstrapSuppressed?: boolean } })
    .__sewSession;
  if (holder) holder.environmentBootstrapSuppressed = false;
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('PBL authoritative RuntimeStore persistence', () => {
  it('freezes the reviewed definition, opens the personal task, commits a grounded deliverable and replays after SQLite restart', () => {
    const f = fixture();
    expect(f.frozen.definition.roles.find((role) => role.id === 'peer_ai')?.memberUid).toBe(
      pblAiMemberUid({
        projectId: f.projectId,
        lessonId: f.lesson.lessonId,
        version: 1,
        roleId: 'peer_ai',
      }),
    );
    expect(
      pblAiMemberUid({
        projectId: f.projectId,
        lessonId: f.lesson.lessonId,
        version: 1,
        roleId: 'peer_ai',
      }),
    ).toMatch(/^uid_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(() => submit(f)).toThrowError(
      expect.objectContaining({ code: 'ROLE_PERMISSION_DENIED' }),
    );
    expect(() =>
      commandPblProject(f.session, {
        operation: 'task',
        scope: scopeFor(f.session),
        binding: { ...f.binding, documentDigest: 'old_document' },
        actorUid: f.session.learnerUid,
        intent: 'open',
        taskId: 'task_report',
        roleId: 'learner',
        reportedStatus: 'in_progress',
        report: '旧绑定不应生效。',
        nonce: 'stale-binding',
      }),
    ).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    expect(() =>
      loadPblProject(
        { ...f.session, learnerUid: otherUid } as Session,
        f.binding.stageId,
        f.frozen.definition.id,
      ),
    ).toThrowError(expect.objectContaining({ code: 'INTERNAL' }));
    const opened = openTask(f);
    expect(opened).toMatchObject({
      count: 0,
      tasks: [{ taskId: 'task_report', status: 'in_progress' }],
    });
    const draftCommand = {
      operation: 'draft' as const,
      scope: scopeFor(f.session),
      binding: f.binding,
      actorUid: f.session.learnerUid,
      nonce: 'draft-report',
      draft: {
        taskId: 'task_report',
        milestoneId: 'milestone_report',
        artifactKind: 'report' as const,
        artifactTitle: '报告草稿',
        artifactText: '',
        assetRefs: [],
        goalIds: ['goal_explain'],
      },
    };
    expect(commandPblProject(f.session, draftCommand)).toMatchObject({
      ownDraft: { artifactTitle: '报告草稿' },
      count: 0,
    });
    f.reopen();
    expect(
      commandPblProject(f.session, { ...draftCommand, scope: scopeFor(f.session) }),
    ).toMatchObject({ deduplicated: true, count: 0 });
    const saved = submit(f);
    expect(saved).toMatchObject({
      count: 1,
      ownSubmissions: [{ payload: { uid: f.session.learnerUid, kind: 'deliverable' } }],
    });
    const before = f.session.store.runtime.listSessions(
      f.projectId,
      f.binding.stageId,
      f.session.learnerUid,
    );
    expect(before.filter((row) => row.kind === 'pblRecords')).toHaveLength(1);
    f.reopen();
    const restored = readPblContext(f.session, f.binding.stageId, f.frozen.definition.id);
    expect(restored.state.ownSubmissions).toHaveLength(1);
    expect(JSON.stringify(restored.state)).not.toContain('rubric_report');
    expect(
      commandPblProject(f.session, {
        operation: 'submit',
        scope: scopeFor(f.session),
        binding: f.binding,
        actorUid: f.session.learnerUid,
        deliverable: {
          taskId: 'task_report',
          milestoneId: 'milestone_report',
          artifactKind: 'report',
          artifactTitle: '调查报告',
          artifactText: '根据审核材料完成了调查报告。',
          assetRefs: [],
          goalIds: ['goal_explain'],
        },
        nonce: 'submit-report',
      }),
    ).toMatchObject({ count: 1, deduplicated: true });
    expect(() => submit(f, 'submit-report', '改变内容后复用 nonce。')).toThrowError(
      expect.objectContaining({ code: 'VERSION_CONFLICT' }),
    );
    expect(() =>
      commandPblProject(f.session, {
        operation: 'submit',
        scope: scopeFor(f.session),
        binding: f.binding,
        actorUid: otherUid,
        deliverable: {
          taskId: 'task_report',
          milestoneId: 'milestone_report',
          artifactKind: 'report',
          artifactTitle: '冒名报告',
          artifactText: '不能冒充其他人。',
          assetRefs: [],
          goalIds: ['goal_explain'],
        },
        nonce: 'spoof-submit',
      }),
    ).toThrowError(expect.objectContaining({ code: 'ROLE_PERMISSION_DENIED' }));
  });

  it('keeps AI records bound to derived seats and owner data private while simulations never touch formal receipts', () => {
    const f = fixture();
    openTask(f);
    const ownerState = pblProjectStateSchema.parse(submit(f));
    const deliverable = ownerState.ownSubmissions[0]!.payload;
    if (deliverable.kind !== 'deliverable') throw new Error('fixture deliverable is missing');
    const generatedInput: Parameters<typeof savePblGeneratedRecord>[1] = {
      binding: f.binding,
      actorUid: f.session.learnerUid,
      roleId: 'peer_ai',
      nonce: 'ai-contribution-1',
      payload: {
        kind: 'contribution',
        contribution: {
          roleId: 'peer_ai',
          taskId: 'task_report',
          milestoneId: 'milestone_report',
          content: '建议补充对比时段。',
          basisArtifactIds: [pblArtifactIdFromRecord(deliverable)],
        },
      },
    };
    const generated = savePblGeneratedRecord(f.session, generatedInput);
    expect(generated.contributions).toHaveLength(1);
    expect(generated.contributions[0]?.payload).toMatchObject({
      uid: f.frozen.definition.roles[1]?.memberUid,
      actorType: 'peer_ai',
    });
    expect(savePblGeneratedRecord(f.session, generatedInput)).toMatchObject({
      deduplicated: true,
      count: 1,
    });
    const claimed = pblProjectStateSchema.parse(
      commandPblProject(f.session, {
        operation: 'acknowledge',
        scope: scopeFor(f.session),
        binding: f.binding,
        actorUid: f.session.learnerUid,
        contributionNonce: 'ai-contribution-1',
        note: '已核实并吸收建议。',
        nonce: 'claim-ai-contribution',
      }),
    );
    expect(claimed.acknowledgedContributionNonces).toEqual(['ai-contribution-1']);
    expect(claimed.contributions[0]?.payload).toMatchObject({
      acknowledgedByUid: null,
      acknowledgedAt: null,
    });
    f.reopen();
    const claimReadback = readPblContext(
      f.session,
      f.binding.stageId,
      f.frozen.definition.id,
    ).state;
    expect(claimReadback.acknowledgedContributionNonces).toEqual(['ai-contribution-1']);
    expect(claimReadback.contributions[0]?.payload).toMatchObject({
      acknowledgedByUid: null,
      acknowledgedAt: null,
    });
    const runtimeSessionId = f.session.store.runtime
      .listSessions(f.projectId, f.binding.stageId, f.session.learnerUid)
      .find((row) => row.kind === 'pblRecords')!.id;
    const beforeCount = f.session.store.runtime.listRecords(f.projectId, runtimeSessionId).length;
    const stepBase = {
      scope: scopeFor(f.session),
      binding: f.binding,
      actorUid: f.session.learnerUid,
      milestoneId: null,
      contribution: null,
      contributionNonce: null,
      feedback: null,
      assessment: null,
      assessmentNonce: null,
      acceptedCandidateIds: null,
      artifactIds: null,
      note: '',
    };
    const simulation = simulatePbl(f.session, {
      scope: scopeFor(f.session),
      binding: f.binding,
      maxSteps: 2,
      steps: [
        {
          ...stepBase,
          operation: 'open',
          nonce: 'sim-open',
          taskId: 'task_report',
          roleId: 'learner',
          reportedStatus: 'in_progress',
          deliverable: null,
        },
        {
          ...stepBase,
          operation: 'submit',
          nonce: 'sim-submit',
          taskId: 'task_report',
          roleId: null,
          reportedStatus: null,
          deliverable: {
            taskId: 'task_report',
            milestoneId: 'milestone_report',
            artifactKind: 'report',
            artifactTitle: '模拟报告',
            artifactText: '只供演练使用的报告。',
            assetRefs: [],
            goalIds: ['goal_explain'],
          },
        },
      ],
    });
    expect(simulation).toMatchObject({
      simulated: true,
      recordScope: 'demo',
      stepBudget: { used: 2 },
    });
    expect(f.session.store.runtime.listRecords(f.projectId, runtimeSessionId)).toHaveLength(
      beforeCount,
    );
  });

  it('restores the latest durable draft independently for each task after SQLite restart', () => {
    const f = fixture({ multipleTasks: true });
    openTask(f);
    commandPblProject(f.session, {
      operation: 'task',
      scope: scopeFor(f.session),
      binding: f.binding,
      actorUid: f.session.learnerUid,
      intent: 'open',
      taskId: 'task_compare',
      roleId: 'learner',
      reportedStatus: 'in_progress',
      report: '开始对比。',
      nonce: 'open-compare',
    });
    const makeDraft = (taskId: string, title: string, nonce: string) =>
      commandPblProject(f.session, {
        operation: 'draft',
        scope: scopeFor(f.session),
        binding: f.binding,
        actorUid: f.session.learnerUid,
        nonce,
        draft: {
          taskId,
          milestoneId: 'milestone_report',
          artifactKind: 'report',
          artifactTitle: title,
          artifactText: '',
          assetRefs: [],
          goalIds: ['goal_explain'],
        },
      });
    makeDraft('task_report', '调查草稿 v1', 'draft-report-v1');
    makeDraft('task_compare', '对比草稿', 'draft-compare');
    makeDraft('task_report', '调查草稿 v2', 'draft-report-v2');
    f.reopen();
    const state = readPblContext(f.session, f.binding.stageId, f.frozen.definition.id).state;
    expect(state.ownDraft).toMatchObject({ taskId: 'task_report', artifactTitle: '调查草稿 v2' });
    expect(state.ownDrafts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: 'task_report', artifactTitle: '调查草稿 v2' }),
        expect.objectContaining({ taskId: 'task_compare', artifactTitle: '对比草稿' }),
      ]),
    );
    expect(state.ownDrafts).toHaveLength(2);
    expect(state.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: 'task_report', ownDraftTitle: '调查草稿 v2' }),
        expect.objectContaining({ taskId: 'task_compare', ownDraftTitle: '对比草稿' }),
      ]),
    );
  });

  it('rejects spoofed review identities and draft references outside the admitted formal source', () => {
    const f = fixture();
    const invalid = definitionFor(otherUid, f.lesson.statementIds[0]!);
    expect(() =>
      reviewPblDefinition(f.session, {
        scope: scopeFor(f.session),
        binding: f.binding,
        operation: 'review',
        lessonId: f.lesson.lessonId,
        lessonVersion: 1,
        semanticReviewed: true,
        reviewNote: '逐条核对',
        definition: invalid,
      }),
    ).toThrowError(expect.objectContaining({ code: 'ROLE_PERMISSION_DENIED' }));
    expect(() =>
      commandPblProject(f.session, {
        operation: 'review',
        scope: scopeFor(f.session),
        binding: f.binding,
        lessonId: f.lesson.lessonId,
        lessonVersion: 1,
        semanticReviewed: true,
        reviewNote: '逐条核对',
        definition: { ...f.frozen.definition, statementIds: ['statement_foreign'] },
      }),
    ).toThrow();
  });

  it('requires every referenced asset to be a real formal asset bound to this exact PBL scene', () => {
    const f = fixture();
    openTask(f);
    const payload = {
      taskId: 'task_report',
      milestoneId: 'milestone_report',
      artifactKind: 'report' as const,
      artifactTitle: '带资源的调查报告',
      artifactText: '资源必须已登记并绑定到本场景。',
      assetRefs: ['asset_unbound'],
      goalIds: ['goal_explain'],
    };
    expect(() =>
      commandPblProject(f.session, {
        operation: 'submit',
        scope: scopeFor(f.session),
        binding: f.binding,
        actorUid: f.session.learnerUid,
        deliverable: payload,
        nonce: 'unbound-asset',
      }),
    ).toThrowError(expect.objectContaining({ code: 'CLASSROOM_SCENE_SOURCE_MISSING' }));
    f.session.store.putClassroomAsset(
      f.projectId,
      'asset_unbound',
      'image/png',
      { path: 'private' },
      Uint8Array.of(1),
    );
    f.session.store.putClassroomAssetBinding(
      f.projectId,
      f.binding.stageId,
      'scene_wrong',
      'asset',
      'asset_unbound',
    );
    expect(() =>
      commandPblProject(f.session, {
        operation: 'submit',
        scope: scopeFor(f.session),
        binding: f.binding,
        actorUid: f.session.learnerUid,
        deliverable: payload,
        nonce: 'wrong-scene-asset',
      }),
    ).toThrowError(expect.objectContaining({ code: 'CLASSROOM_SCENE_SOURCE_MISSING' }));
    f.session.store.putClassroomAssetBinding(
      f.projectId,
      f.binding.stageId,
      pblProjectSceneId(f.frozen.definition.id),
      'asset',
      'asset_unbound',
    );
    expect(
      commandPblProject(f.session, {
        operation: 'submit',
        scope: scopeFor(f.session),
        binding: f.binding,
        actorUid: f.session.learnerUid,
        deliverable: payload,
        nonce: 'bound-asset',
      }),
    ).toMatchObject({ count: 1 });
    expect(
      JSON.stringify(readPblContext(f.session, f.binding.stageId, f.frozen.definition.id).state),
    ).not.toContain('private');
  });
});
