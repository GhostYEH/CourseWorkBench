import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiResponses, newId, type PlanPayloadDto, type PlanSceneDto } from '@sew/study-contracts';
import { POST as lessonsPost } from '../apps/learning/app/api/study/lessons/route';
import {
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';

/**
 * 审核/计划绑定与请求回执的 HTTP 行为回归（LESSON-02 正确性缺陷）。
 *
 * 固定五类真实用户场景：
 * ① 审核后编辑计划 → 旧审核失效，发布必须复核当前内容；
 * ② 刷新后按旧快照保存 → 用实际加载的 revision 提交，被乐观并发拒绝而不是静默覆盖；
 * ③ 审批基于旧计划的候选 → 不静默覆盖新编辑，需显式覆盖确认；
 * ④ 提交成功但响应丢失 → 同 requestId 重发读回同一回执，不重复推进 revision；
 * ⑤ 进程重开与项目切换 → 回执与计划仍按 requestId/项目边界可读，旧代次写入被拒。
 */

describe('审核/计划绑定与请求回执（HTTP）', () => {
  let root: string;
  let session: Session;
  let bundleId = '';
  let statementId = '';
  let lessonId = '';
  let lessonVersion = 1;
  const scope = () => ({ projectId: session.projectId, generation: session.generation });

  const post = (body: Record<string, unknown>) =>
    lessonsPost(
      new Request('http://127.0.0.1/api/study/lessons', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: scope(), ...body }),
      }),
    );

  const dataOf = async (response: Response): Promise<Record<string, unknown>> =>
    ((await response.json()) as { data: Record<string, unknown> }).data;

  const errorOf = async (
    response: Response,
  ): Promise<{ code: string; details?: Record<string, unknown> }> =>
    ((await response.json()) as { error: { code: string; details?: Record<string, unknown> } })
      .error;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-plan-integrity-'));
    session = openProjectFromDisk(root);
    const projectId = session.projectId;
    const imported = session.store.importMaterial({
      projectId,
      displayName: '考纲.md',
      materialType: 'md',
      rawText: '本章要求理解增函数的定义。\n\n第二条范围说明。',
    });
    const proposal = session.store.createProposal({
      projectId,
      name: '增函数定义',
      concept: '区间内任取 x1 < x2 都有 f(x1) < f(x2)',
      conditions: '同一区间 D 内',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [
        {
          materialId: imported.material.materialId,
          revision: 1,
          segmentId: imported.segments[0]!.segmentId,
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
          evidence: [
            {
              materialId: imported.material.materialId,
              segmentId: imported.segments[0]!.segmentId,
            },
          ],
        },
      ],
      gaps: [],
      basis: '测试计划',
      confirmedTaskKnowledgeIds: [knowledgeId],
    };
    session.store.savePlanVersion(projectId, 1, 'confirmed', payload);
    session.store.startPlanRun(projectId);
    const bundle = session.store.buildLessonBundle(
      projectId,
      [{ knowledgeId, text: '增函数的定义', conditions: '同一区间 D 内' }],
      [],
    );
    bundleId = bundle.bundleId;
    statementId = bundle.bundle.statements[0]!.statementId;
    const lesson = session.store.createLessonDraft({
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
    closeProject();
    rmSync(root, { recursive: true, force: true });
  });

  const scenes = (title = '陈述 1'): PlanSceneDto[] => [
    {
      sceneId: 'scene_slide_a',
      kind: 'slide',
      title,
      statementId,
      questionId: null,
      knowledgeIds: [],
      elements: [],
      note: '',
    },
  ];

  const savePlan = (requestId: string, baseRevision: number, title?: string) =>
    post({
      action: 'save-scene-plan',
      requestId,
      lessonId,
      version: lessonVersion,
      baseRevision,
      scenes: scenes(title),
    });

  it('① 审核后编辑计划：发布被阻断，重新审核当前内容后才放行', async () => {
    const saved = await savePlan('p1', 0);
    expect(saved.status).toBe(200);
    expect((await dataOf(saved)).plan).toMatchObject({ revision: 1 });

    const reviewed = await post({
      action: 'review',
      lessonId,
      version: lessonVersion,
      decision: 'approved',
      note: '按计划审核',
    });
    expect(reviewed.status).toBe(200);
    const review = (await dataOf(reviewed)).review as Record<string, unknown>;
    expect(review.planRevision).toBe(1);

    // 审核之后编辑计划：内容变了。
    const edited = await savePlan('p2', 1, '审核后改写');
    expect(edited.status).toBe(200);

    // 发布必须复核当前内容：旧审核不再背书。
    const blocked = await post({ action: 'publish', lessonId, version: lessonVersion });
    expect(blocked.status).toBe(409);
    const blockedError = await errorOf(blocked);
    expect(blockedError.code).toBe('VERSION_CONFLICT');
    expect(blockedError.details?.['reason']).toBe('review_plan_changed');

    // 重新审核当前内容后发布放行。
    expect(
      (
        await post({
          action: 'review',
          lessonId,
          version: lessonVersion,
          decision: 'approved',
          note: '按新计划复核',
        })
      ).status,
    ).toBe(200);
    expect((await post({ action: 'publish', lessonId, version: lessonVersion })).status).toBe(200);
  });

  it('② 刷新后按旧快照保存：用实际加载的 revision 提交，被拒而不是静默覆盖', async () => {
    expect((await savePlan('s1', 0)).status).toBe(200);
    // 另一处把计划推进到 revision 2。
    expect((await savePlan('s2', 1, '别处的编辑')).status).toBe(200);

    // 刷新后界面仍持旧快照（revision 1），却拿当前 props revision（2）提交：
    // 这里模拟「用新 revision 给旧快照背书」的错误路径被服务端挡住——
    // 服务端只认 baseRevision 与实际存储是否一致，内容冲突不会因 revision 看起来新而放行。
    const staleSnapshot = await savePlan('s3', 2, '旧快照');
    // baseRevision=2 与实际一致，因此这次写入合法（它代表「基于 revision 2 的新编辑」）；
    // 真正危险的是 baseRevision 落后却声称基于最新。下面固定这一条被拒。
    expect(staleSnapshot.status).toBe(200);

    const behind = await savePlan('s4', 1, '落后基线');
    expect(behind.status).toBe(409);
    expect((await errorOf(behind)).details?.['reason']).toBe('plan_revision_stale');
    // 冲突被拒后计划没有被改写。
    expect(
      session.store.getScenePlan(session.projectId, lessonId, lessonVersion)!.scenes[0]!.title,
    ).toBe('旧快照');
  });

  it('③ 审批基于旧计划的候选：不静默覆盖新编辑，确认覆盖后才写入', async () => {
    // 先有候选（基线：无计划）。
    const candidate = session.store.createCoursewareCandidate({
      candidateId: newId<'cw'>('cw'),
      projectId: session.projectId,
      lessonId,
      baseVersion: lessonVersion,
      scenes: scenes('候选场景'),
      instruction: 'x',
    });
    expect(candidate.basePlanRevision).toBe(0);
    // 别处先手工保存了一份计划。
    expect((await savePlan('c1', 0, '手工计划')).status).toBe(200);

    const applyBody = (over: Record<string, unknown> = {}) => ({
      action: 'apply-courseware',
      requestId: 'cw-apply-1',
      candidateId: candidate.candidateId,
      decision: 'approved',
      note: '旧候选',
      expectedPlanRevision: candidate.basePlanRevision,
      ...over,
    });

    // 未确认覆盖：409，且计划与候选都没有被改写。
    const blocked = await post(applyBody());
    expect(blocked.status).toBe(409);
    expect((await errorOf(blocked)).details?.['reason']).toBe('plan_revision_stale');
    expect(session.store.getScenePlan(session.projectId, lessonId, lessonVersion)!.revision).toBe(
      1,
    );
    expect(
      session.store.getCoursewareCandidate(session.projectId, candidate.candidateId)!.status,
    ).toBe('pending');

    // 显式确认覆盖：写入并推进 revision。
    const staleOverride = await post(applyBody({ requestId: 'cw-apply-stale', override: true }));
    expect(staleOverride.status).toBe(409);
    expect((await errorOf(staleOverride)).details?.['receiptState']).toBe('failed');
    expect(
      session.store.getCoursewareCandidate(session.projectId, candidate.candidateId)!.status,
    ).toBe('pending');
    const applied = await post(
      applyBody({
        requestId: 'cw-apply-2',
        override: true,
        expectedPlanRevision: 1,
      }),
    );
    expect(applied.status).toBe(200);
    const appliedData = await dataOf(applied);
    expect(apiResponses.lessonCoursewareApply.safeParse(appliedData).success).toBe(true);
    expect((appliedData.plan as { revision: number }).revision).toBe(2);
    expect((appliedData.candidate as { status: string }).status).toBe('applied');
  });

  it('④ 提交成功但响应丢失：同 requestId 重发读回同一回执，不重复推进 revision', async () => {
    const body = {
      action: 'save-scene-plan',
      requestId: 'lost-response-1',
      lessonId,
      version: lessonVersion,
      baseRevision: 0,
      scenes: scenes(),
    };
    const first = await post(body);
    expect(first.status).toBe(200);
    expect((await dataOf(first)).plan).toMatchObject({ revision: 1 });

    // 客户端没收到响应，原样重发：读回同一结果，revision 不推进。
    const replay = await post(body);
    expect(replay.status).toBe(200);
    const replayData = await dataOf(replay);
    expect(replayData.deduplicated).toBe(true);
    expect(replayData.plan).toMatchObject({ revision: 1 });
    expect(replayData.receipt).toMatchObject({ state: 'completed', requestId: 'lost-response-1' });
    expect(session.store.getScenePlan(session.projectId, lessonId, lessonVersion)!.revision).toBe(
      1,
    );
  });

  it('④b 确定失败可重放：同 requestId 重发得到同一条失败，不变成成功', async () => {
    // 先推进到 revision 1，使一次 baseRevision=0 的保存成为确定的版本冲突。
    expect((await savePlan('f0', 0)).status).toBe(200);
    const failing = {
      action: 'save-scene-plan',
      requestId: 'fail-replay-1',
      lessonId,
      version: lessonVersion,
      baseRevision: 0,
      scenes: scenes(),
    };
    const first = await post(failing);
    expect(first.status).toBe(409);
    expect((await errorOf(first)).details?.['reason']).toBe('plan_revision_stale');
    const receipt = session.store.scenePlanReceipt(
      session.projectId,
      'fail-replay-1',
      'save-scene-plan',
      JSON.stringify({
        lessonId,
        version: lessonVersion,
        baseRevision: 0,
        scenes: failing.scenes,
      }),
    )!;
    expect(receipt.state).toBe('failed');
    expect(receipt.errorCode).toBe('VERSION_CONFLICT');
    expect(receipt.result).toBeNull();

    // 原样重发：仍是同一条失败结论（可查询、可重放），不会悄悄变成成功。
    const replay = await post(failing);
    expect(replay.status).toBe(409);
    expect((await errorOf(replay)).code).toBe('VERSION_CONFLICT');
    expect(session.store.getScenePlan(session.projectId, lessonId, lessonVersion)!.revision).toBe(
      1,
    );
  });

  it('④c 取消与未知结果都真实落回执：取消不写业务、未知不自动重发', async () => {
    // 取消：请求在提交前被取消（signal 已 abort）。
    const cancelled = new AbortController();
    cancelled.abort();
    const cancelResponse = await lessonsPost(
      new Request('http://127.0.0.1/api/study/lessons', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: scope(),
          action: 'save-scene-plan',
          requestId: 'cancel-1',
          lessonId,
          version: lessonVersion,
          baseRevision: 0,
          scenes: scenes(),
        }),
        signal: cancelled.signal,
      }),
    );
    expect(cancelResponse.status).toBe(409);
    const cancelIntent = JSON.stringify({
      lessonId,
      version: lessonVersion,
      baseRevision: 0,
      scenes: scenes(),
    });
    const cancelReceipt = session.store.scenePlanReceipt(
      session.projectId,
      'cancel-1',
      'save-scene-plan',
      cancelIntent,
    )!;
    expect(cancelReceipt.state).toBe('cancelled');
    expect(cancelReceipt.result).toBeNull();
    // 取消没有产生业务写入。
    expect(session.store.getScenePlan(session.projectId, lessonId, lessonVersion)).toBeNull();

    // 未知结果：落一条 unknown 回执，重发同 requestId 必须重放同一结论而不是重新执行。
    session.store.saveScenePlanReceipt({
      projectId: session.projectId,
      requestId: 'unknown-1',
      action: 'save-scene-plan',
      intent: cancelIntent,
      state: 'unknown',
      result: null,
      message: '结果未能确认',
      errorCode: 'INTERNAL',
      errorReason: 'plan_result_unknown',
    });
    const replay = await post({
      action: 'save-scene-plan',
      requestId: 'unknown-1',
      lessonId,
      version: lessonVersion,
      baseRevision: 0,
      scenes: scenes(),
    });
    expect(replay.status).toBe(500);
    expect((await errorOf(replay)).details?.['reason']).toBe('plan_result_unknown');
    // 未知结果没有产生业务写入。
    expect(session.store.getScenePlan(session.projectId, lessonId, lessonVersion)).toBeNull();
  });

  it('⑤ 进程重开与项目切换：回执与计划按 requestId/项目边界可读，旧代次写入被拒', async () => {
    expect((await savePlan('reopen-1', 0)).status).toBe(200);
    const projectId = session.projectId;
    const generation = session.generation;

    // 进程重开（同一项目目录重新打开）。
    closeProject();
    session = openProjectFromDisk(root);
    expect(session.projectId).toBe(projectId);
    // 计划与回执都在权威库中，重开后可读。
    expect(session.store.getScenePlan(projectId, lessonId, lessonVersion)!.revision).toBe(1);
    const receipt = session.store.scenePlanReceipt(
      projectId,
      'reopen-1',
      'save-scene-plan',
      JSON.stringify({
        lessonId,
        version: lessonVersion,
        baseRevision: 0,
        scenes: scenes(),
      }),
    );
    expect(receipt?.state).toBe('completed');

    // 旧代次写入被拒绝：切换后旧页面不能用旧 generation 写当前项目。
    const staleGeneration = await lessonsPost(
      new Request('http://127.0.0.1/api/study/lessons', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: { projectId, generation: generation + 9 },
          action: 'save-scene-plan',
          requestId: 'stale-gen-1',
          lessonId,
          version: lessonVersion,
          baseRevision: 1,
          scenes: scenes(),
        }),
      }),
    );
    expect(staleGeneration.status).toBe(409);
    expect((await errorOf(staleGeneration)).code).toBe('PROJECT_GENERATION_STALE');
    // 被拒的写入没有推进 revision。
    expect(session.store.getScenePlan(projectId, lessonId, lessonVersion)!.revision).toBe(1);
  });

  it('无计划旧课程保持兼容：审核与发布不因缺计划被阻断', async () => {
    const reviewed = await post({
      action: 'review',
      lessonId,
      version: lessonVersion,
      decision: 'approved',
      note: '旧课程无计划',
    });
    expect(reviewed.status).toBe(200);
    const review = (await dataOf(reviewed)).review as Record<string, unknown>;
    expect(review.planRevision).toBeNull();
    expect(review.planDigest).toBeNull();
    expect((await post({ action: 'publish', lessonId, version: lessonVersion })).status).toBe(200);
  });
});
