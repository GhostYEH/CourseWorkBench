import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StudyError,
  newId,
  type PlanPayloadDto,
  type StatementRevisionProposeInput,
} from '@sew/study-contracts';
import { revisedStatements } from '@sew/study-domain';
import { StudyStore, ensureProjectLayout, projectPaths } from '@sew/study-storage';
import { createModelConnectionRuntime } from '../apps/learning/lib/server/model-connection';
import { generateStatementRevision } from '../apps/learning/lib/server/lesson-revision-model';

/**
 * 陈述正文改写闭环（LESSON-02）：候选生成 → 来源沿用 → 人工审核 → 派生新草案版本。
 *
 * 固定三件事：① 候选只落待核区，不改写原陈述或任何课程版本；
 * ② 通过才派生新草案版本（来源按知识点已批准证据重新绑定、重新复核准入），旧版本保持原样；
 * ③ 生成与处置都按 requestId 幂等，重试不堆第二条候选、不追加第二个版本。
 */

const expectCode = (action: () => unknown, code: string, reason?: string): void => {
  try {
    action();
  } catch (error) {
    expect((error as StudyError).code).toBe(code);
    if (reason !== undefined) expect((error as StudyError).details?.['reason']).toBe(reason);
    return;
  }
  throw new Error(`预期抛出 ${code}，但调用成功了`);
};

describe('陈述正文改写候选与处置（存储层）', () => {
  let root: string;
  let store: StudyStore;
  let projectId: string;
  let materialId: string;
  let knowledgeId: string;
  let bundleId = '';
  let statementId = '';
  let lessonId = '';
  let lessonVersion = 1;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-statement-revision-'));
    ensureProjectLayout(root);
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    projectId = newId<'project'>('proj');
    store.createProject({ projectId, displayName: '数学', subject: '数学', dailyMinutes: 60 });
    const imported = store.importMaterial({
      projectId,
      displayName: '考纲.md',
      materialType: 'md',
      rawText: '本章要求理解增函数的定义。\n\n第二条范围说明。',
    });
    materialId = imported.material.materialId;
    const proposal = store.createProposal({
      projectId,
      name: '增函数定义',
      concept: '区间内任取 x1 < x2 都有 f(x1) < f(x2)',
      conditions: '同一区间 D 内',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [{ materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'user',
    });
    knowledgeId = store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
    }).knowledgePoint!.knowledgeId;
    const payload: PlanPayloadDto = {
      payloadVersion: 1,
      goal: '掌握本章',
      examDate: null,
      dailyMinutes: 60,
      tasks: [
        {
          knowledgeId,
          name: '增函数定义',
          minutes: 30,
          acceptance: '',
          evidence: [{ materialId, segmentId: 'S001' }],
        },
      ],
      gaps: [],
      basis: '测试计划',
      confirmedTaskKnowledgeIds: [knowledgeId],
    };
    store.savePlanVersion(projectId, 1, 'confirmed', payload);
    store.startPlanRun(projectId);
    const bundle = store.buildLessonBundle(
      projectId,
      [{ knowledgeId, text: '增函数的定义', conditions: '同一区间 D 内' }],
      [],
    );
    bundleId = bundle.bundleId;
    statementId = bundle.bundle.statements[0]!.statementId;
    const lesson = store.createLessonDraft({
      projectId,
      lessonId: null,
      title: '函数单调性',
      bundleId,
      statementIds: [statementId],
      questionIds: [],
    });
    lessonId = lesson.lessonId;
    lessonVersion = lesson.version;
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  const propose = (over: Partial<Parameters<typeof store.createStatementRevision>[0]> = {}) =>
    store.createStatementRevision({
      candidateId: newId<'rev'>('rev'),
      projectId,
      lessonId,
      baseVersion: lessonVersion,
      statementId,
      knowledgeId,
      proposedText: '若对区间 D 内任意 x1 < x2 都有 f(x1) < f(x2)，则称 f 在 D 上单调递增。',
      proposedConditions: '同一区间 D 内',
      evidence: store.getEvidenceBundle(projectId, bundleId)!.bundle.statements[0]!.evidence,
      instruction: '表述更完整',
      ...over,
    });

  it('候选只落待核区：不改写原陈述，也不新增课程版本', () => {
    const lessonsBefore = store.listLessonVersions(lessonId, projectId).length;
    const candidate = propose();
    expect(candidate.status).toBe('pending');
    expect(candidate.origin).toBe('model_generated');
    expect(candidate.knowledgeId).toBe(knowledgeId);
    expect(store.getStatementRevision(projectId, candidate.candidateId)?.status).toBe('pending');
    // 原证据包与课程版本数不变。
    expect(store.listLessonVersions(lessonId, projectId)).toHaveLength(lessonsBefore);
    expect(store.getEvidenceBundle(projectId, bundleId)!.bundle.statements[0]!.text).toBe(
      '增函数的定义',
    );
  });

  it('人工通过才派生新草案版本，来源沿用、旧版本与旧证据包保持原样', () => {
    const candidate = propose();
    const result = store.applyStatementRevision({
      projectId,
      candidateId: candidate.candidateId,
      decision: 'approved',
      note: '与教材一致',
      reviewedBy: 'tester',
    });
    expect(result.candidate.status).toBe('applied');
    expect(result.candidate.reviewedBy).toBe('tester');
    expect(result.lesson).not.toBeNull();
    expect(result.lesson!.version).toBe(lessonVersion + 1);
    expect(result.lesson!.status).toBe('draft');
    // 新版本用新证据包，陈述编号随正文变化，知识点不变。
    expect(result.lesson!.bundleId).not.toBe(bundleId);
    const newStatementId = store.getEvidenceBundle(projectId, result.lesson!.bundleId)!.bundle
      .statements[0]!.statementId;
    expect(newStatementId).not.toBe(statementId);
    const newStatement = store.getEvidenceBundle(projectId, result.lesson!.bundleId)!.bundle
      .statements[0]!;
    expect(newStatement.knowledgeId).toBe(knowledgeId);
    expect(newStatement.evidence).toEqual(
      store.getEvidenceBundle(projectId, bundleId)!.bundle.statements[0]!.evidence,
    );
    // 旧版本仍是草案，未被改写。
    expect(store.getLessonVersion(lessonId, lessonVersion, projectId)!.status).toBe('draft');
  });

  it('拒绝只留档，不产生新版本', () => {
    const candidate = propose();
    const result = store.applyStatementRevision({
      projectId,
      candidateId: candidate.candidateId,
      decision: 'rejected',
      note: '偏离原意',
      reviewedBy: 'tester',
    });
    expect(result.candidate.status).toBe('rejected');
    expect(result.lesson).toBeNull();
    expect(store.listLessonVersions(lessonId, projectId)).toHaveLength(1);
  });

  it('同一候选不能处置两次，避免派生两个版本', () => {
    const candidate = propose();
    store.applyStatementRevision({
      projectId,
      candidateId: candidate.candidateId,
      decision: 'approved',
      note: '',
      reviewedBy: 't',
    });
    expectCode(
      () =>
        store.applyStatementRevision({
          projectId,
          candidateId: candidate.candidateId,
          decision: 'approved',
          note: '',
          reviewedBy: 't',
        }),
      'STEP_ALREADY_COMMITTED',
      'revision_already_decided',
    );
  });

  it('基线版本已发布时不允许再改写', () => {
    const candidate = propose();
    store.reviewLesson({
      projectId,
      lessonId,
      version: lessonVersion,
      decision: 'approved',
      note: 'ok',
    });
    store.publishLesson({ projectId, lessonId, version: lessonVersion });
    expectCode(
      () =>
        store.applyStatementRevision({
          projectId,
          candidateId: candidate.candidateId,
          decision: 'approved',
          note: '',
          reviewedBy: 't',
        }),
      'STEP_ALREADY_COMMITTED',
      'revision_base_not_draft',
    );
  });

  it('候选正文与基线一致时拒绝派生', () => {
    const candidate = propose({ proposedText: '增函数的定义' });
    expectCode(
      () =>
        store.applyStatementRevision({
          projectId,
          candidateId: candidate.candidateId,
          decision: 'approved',
          note: '',
          reviewedBy: 't',
        }),
      'INVALID_ARGUMENT',
      'statement_revision_unchanged',
    );
  });

  it('带 requestId 的课程草案派生按意图幂等，重试不追加第二个版本', () => {
    const intent = JSON.stringify({ title: 'x', statementIds: [statementId] });
    store.saveLessonDraftReceipt(projectId, 'draft-1', intent, lessonId, lessonVersion);
    expect(store.lessonDraftReceipt(projectId, 'draft-1', intent)).toEqual({
      lessonId,
      version: lessonVersion,
    });
    expectCode(
      () => store.lessonDraftReceipt(projectId, 'draft-1', JSON.stringify({ title: 'y' })),
      'VERSION_CONFLICT',
      'draft_nonce_reused',
    );
  });

  it('改写候选的生成与处置收据按意图幂等，意图不一致即拒绝复用', () => {
    store.saveStatementRevisionReceipt(projectId, 'req-1', 'propose', 'intent-a', { ok: true });
    expect(
      store.statementRevisionReceipt(projectId, 'req-1', 'propose', 'intent-a')?.result,
    ).toEqual({ ok: true });
    expectCode(
      () => store.statementRevisionReceipt(projectId, 'req-1', 'propose', 'intent-b'),
      'VERSION_CONFLICT',
      'revision_nonce_reused',
    );
  });

  it('revisedStatements 逐字保留其余陈述，只替换目标正文', () => {
    const bundle = store.getEvidenceBundle(projectId, bundleId)!.bundle;
    const revised = revisedStatements(bundle, {
      statementId,
      text: '改写后的陈述',
      conditions: '',
    });
    expect(revised).toHaveLength(bundle.statements.length);
    expect(revised[0]).toEqual({ knowledgeId, text: '改写后的陈述', conditions: '' });
  });

  it('通过改写只替换目标场景，不回加基线已排除的场景', () => {
    // 在同一证据包里再冻结一条陈述，然后把基线版本缩到只含第一条（模拟逐场景勾选派生）。
    const second = store.buildLessonBundle(
      projectId,
      [
        { knowledgeId, text: '增函数的定义', conditions: '同一区间 D 内' },
        { knowledgeId, text: '单调性由区间与任意两点决定', conditions: '同一区间 D 内' },
      ],
      [],
    );
    const subset = store.createLessonDraft({
      projectId,
      lessonId: null,
      title: '只含第一场景',
      bundleId: second.bundleId,
      statementIds: [second.bundle.statements[0]!.statementId],
      questionIds: [],
    });
    expect(subset.statementIds).toHaveLength(1);
    const candidate = store.createStatementRevision({
      candidateId: newId<'rev'>('rev'),
      projectId,
      lessonId: subset.lessonId,
      baseVersion: subset.version,
      statementId: second.bundle.statements[0]!.statementId,
      knowledgeId,
      proposedText: '若对区间 D 内任意 x1 < x2 都有 f(x1) < f(x2)，则称 f 在 D 上单调递增。',
      proposedConditions: '同一区间 D 内',
      evidence: second.bundle.statements[0]!.evidence,
      instruction: '更完整',
    });
    const applied = store.applyStatementRevision({
      projectId,
      candidateId: candidate.candidateId,
      decision: 'approved',
      note: '通过',
      reviewedBy: 't',
    });
    // 新版本仍只有一个场景：被基线排除的第二条没有被加回来。
    expect(applied.lesson!.statementIds).toHaveLength(1);
    expect(applied.lesson!.statementIds[0]).not.toBe(second.bundle.statements[0]!.statementId);
    const newBundle = store.getEvidenceBundle(projectId, applied.lesson!.bundleId)!.bundle;
    expect(
      newBundle.statements.some((entry) => entry.statementId === applied.lesson!.statementIds[0]),
    ).toBe(true);
  });

  it('候选指向本版本未选中的陈述时拒绝处置，不派生版本', () => {
    const second = store.buildLessonBundle(
      projectId,
      [
        { knowledgeId, text: '增函数的定义', conditions: '同一区间 D 内' },
        { knowledgeId, text: '单调性由区间与任意两点决定', conditions: '同一区间 D 内' },
      ],
      [],
    );
    const subset = store.createLessonDraft({
      projectId,
      lessonId: null,
      title: '只含第一场景',
      bundleId: second.bundleId,
      statementIds: [second.bundle.statements[0]!.statementId],
      questionIds: [],
    });
    // 候选针对包内第二条陈述，但它不在该版本选中集合里。
    const candidate = store.createStatementRevision({
      candidateId: newId<'rev'>('rev'),
      projectId,
      lessonId: subset.lessonId,
      baseVersion: subset.version,
      statementId: second.bundle.statements[1]!.statementId,
      knowledgeId,
      proposedText: '被排除场景的改写正文',
      proposedConditions: '',
      evidence: second.bundle.statements[1]!.evidence,
      instruction: '改写',
    });
    expectCode(
      () =>
        store.applyStatementRevision({
          projectId,
          candidateId: candidate.candidateId,
          decision: 'approved',
          note: '',
          reviewedBy: 't',
        }),
      'INVALID_ARGUMENT',
      'revision_statement_not_in_version',
    );
    expect(store.listLessonVersions(subset.lessonId, projectId)).toHaveLength(1);
  });
});

describe('受 guard 约束的陈述改写候选生成（注入假 fetcher）', () => {
  let root: string;
  let store: StudyStore;
  let projectId: string;
  let materialId: string;
  let knowledgeId: string;
  let bundleId = '';
  let statementId = '';
  let lessonId = '';
  let lessonVersion = 1;
  let requests: string[] = [];
  let responder: () => Response;

  const okResponder = (): Response =>
    new Response(
      JSON.stringify({
        model: 'fixture-model',
        choices: [{ message: { content: JSON.stringify({ text: '改写后的正文，含义不变。' }) } }],
        usage: { total_tokens: 42 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  const connection = () => {
    const runtime = createModelConnectionRuntime({
      fetcher: async (_url, init) => {
        requests.push(typeof init?.body === 'string' ? init.body : '');
        return responder();
      },
    });
    runtime.configure(
      {
        provider: 'openai-compatible',
        baseUrl: 'https://revision.test/v1',
        model: 'fixture-model',
        apiKey: 'revision-fixture-key-not-a-secret',
      },
      false,
    );
    return runtime;
  };

  const input = (
    over: Partial<StatementRevisionProposeInput> = {},
  ): StatementRevisionProposeInput => ({
    scope: { projectId, generation: 1 },
    action: 'propose-statement-revision',
    requestId: 'req-fixed-1',
    lessonId,
    version: lessonVersion,
    statementId,
    instruction: '表述更口语',
    ...over,
  });

  beforeEach(() => {
    requests = [];
    responder = okResponder;
    root = mkdtempSync(join(tmpdir(), 'sew-statement-revision-model-'));
    ensureProjectLayout(root);
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    projectId = newId<'project'>('proj');
    store.createProject({ projectId, displayName: '数学', subject: '数学', dailyMinutes: 60 });
    const imported = store.importMaterial({
      projectId,
      displayName: '考纲.md',
      materialType: 'md',
      rawText: '本章要求理解增函数的定义。\n\n第二条范围说明。',
    });
    materialId = imported.material.materialId;
    const proposal = store.createProposal({
      projectId,
      name: '增函数定义',
      concept: '区间内任取 x1 < x2 都有 f(x1) < f(x2)',
      conditions: '同一区间 D 内',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [{ materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'user',
    });
    knowledgeId = store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
    }).knowledgePoint!.knowledgeId;
    const payload: PlanPayloadDto = {
      payloadVersion: 1,
      goal: '掌握本章',
      examDate: null,
      dailyMinutes: 60,
      tasks: [
        {
          knowledgeId,
          name: '增函数定义',
          minutes: 30,
          acceptance: '',
          evidence: [{ materialId, segmentId: 'S001' }],
        },
      ],
      gaps: [],
      basis: '测试计划',
      confirmedTaskKnowledgeIds: [knowledgeId],
    };
    store.savePlanVersion(projectId, 1, 'confirmed', payload);
    store.startPlanRun(projectId);
    const bundle = store.buildLessonBundle(
      projectId,
      [{ knowledgeId, text: '增函数的定义', conditions: '同一区间 D 内' }],
      [],
    );
    bundleId = bundle.bundleId;
    statementId = bundle.bundle.statements[0]!.statementId;
    const lesson = store.createLessonDraft({
      projectId,
      lessonId: null,
      title: '函数单调性',
      bundleId,
      statementIds: [statementId],
      questionIds: [],
    });
    lessonId = lesson.lessonId;
    lessonVersion = lesson.version;
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  const generate = (over: Partial<StatementRevisionProposeInput> = {}) =>
    generateStatementRevision({ store, projectId, connection: connection() }, input(over));

  it('正常路径产出待核候选，不写入课程版本', async () => {
    const lessonsBefore = store.listLessonVersions(lessonId, projectId).length;
    const result = await generate();
    expect(result.candidate).not.toBeNull();
    expect(result.candidate!.status).toBe('pending');
    expect(result.candidate!.knowledgeId).toBe(knowledgeId);
    expect(result.deduplicated).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toContain('revision-fixture-key');
    expect(store.listLessonVersions(lessonId, projectId)).toHaveLength(lessonsBefore);
    expect(store.listProjectStatementRevisions(projectId)).toHaveLength(1);
  });

  it('同一 requestId 重试返回既有候选，不再调用 provider、不堆第二条候选', async () => {
    const first = await generate();
    const second = await generate();
    expect(second.deduplicated).toBe(true);
    expect(second.candidate!.candidateId).toBe(first.candidate!.candidateId);
    expect(requests).toHaveLength(1);
    expect(store.listProjectStatementRevisions(projectId)).toHaveLength(1);
  });

  it('没有 run 时在 provider 之前阻断', async () => {
    store.updateRunState(store.getLatestRun()!.runId, 'completed');
    await expect(generate()).rejects.toThrow(/任务已终止/);
    expect(requests).toHaveLength(0);
  });

  it('未配置模型连接时给出明确原因，且不发出请求', async () => {
    const unconfigured = createModelConnectionRuntime({
      fetcher: async () => {
        throw new Error('不应被调用');
      },
    });
    await expect(
      generateStatementRevision({ store, projectId, connection: unconfigured }, input()),
    ).rejects.toThrow(/尚未配置模型连接/);
    expect(requests).toHaveLength(0);
  });

  it('候选指向本版本未选中的陈述时拒绝生成，不发请求', async () => {
    // 本版本只选中一条陈述；任何不在选中集合内的 statementId 都应在 provider 之前被拒。
    await expect(generate({ statementId: 'stmt_not_in_version' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { reason: 'revision_statement_not_in_version' },
    });
    expect(requests).toHaveLength(0);
  });

  it('模型输出不是合法 JSON 时不落候选，只记失败', async () => {
    responder = () =>
      new Response(
        JSON.stringify({
          model: 'fixture-model',
          choices: [{ message: { content: '不是 JSON' } }],
          usage: { total_tokens: 7 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const result = await generate();
    expect(result.candidate).toBeNull();
    expect(store.listProjectStatementRevisions(projectId)).toHaveLength(0);
  });

  it('基线版本已发布时拒绝生成候选', async () => {
    store.reviewLesson({
      projectId,
      lessonId,
      version: lessonVersion,
      decision: 'approved',
      note: 'ok',
    });
    store.publishLesson({ projectId, lessonId, version: lessonVersion });
    await expect(generate()).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});
