import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiResponses, newId, type PlanPayloadDto, type PlanSceneDto } from '@sew/study-contracts';
import { POST as lessonsPost } from '../apps/learning/app/api/study/lessons/route';
import { POST as coursewarePost } from '../apps/learning/app/api/study/lessons/courseware/route';
import {
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';

/**
 * 场景计划与完整课件命令的 HTTP 边界（OMA-006、OMA-021、OMA-022）。
 *
 * 固定三件事：① save-scene-plan 走乐观并发与来源复验，响应通过运行时合同校验；
 * ② 未配置模型时 propose-courseware 在发出请求前被阻断；③ apply-courseware 按 requestId 幂等。
 */

describe('场景计划与完整课件 HTTP 边界', () => {
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

  const proposeCourseware = (body: Record<string, unknown>) =>
    coursewarePost(
      new Request('http://127.0.0.1/api/study/lessons/courseware', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: scope(), action: 'propose-courseware', ...body }),
      }),
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-scene-plan-http-'));
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

  const scenes = (): PlanSceneDto[] => [
    {
      sceneId: 'scene_slide_a',
      kind: 'slide',
      title: '陈述 1',
      statementId,
      questionId: null,
      knowledgeIds: [
        session.store.getEvidenceBundle(session.projectId, bundleId)!.bundle.statements[0]!
          .knowledgeId,
      ],
      elements: [],
      note: '',
    },
  ];

  it('保存场景计划：响应通过合同校验，同 requestId 重放，新 requestId 带旧 revision 被拒', async () => {
    const saveBody = {
      action: 'save-scene-plan',
      requestId: 'plan-1',
      lessonId,
      version: lessonVersion,
      baseRevision: 0,
      scenes: scenes(),
    };
    const first = await post(saveBody);
    expect(first.status).toBe(200);
    const firstData = (await first.json()).data;
    expect(apiResponses.lessonScenePlan.safeParse(firstData).success).toBe(true);
    expect(firstData.plan.revision).toBe(1);
    expect(firstData.receipt).toMatchObject({ state: 'completed', requestId: 'plan-1' });

    // 「提交成功但响应丢失」后重发同 requestId：读回同一回执，不重复推进 revision。
    const replay = await post(saveBody);
    expect(replay.status).toBe(200);
    const replayData = (await replay.json()).data;
    expect(replayData.deduplicated).toBe(true);
    expect(replayData.plan.revision).toBe(1);
    expect(session.store.getScenePlan(session.projectId, lessonId, lessonVersion)!.revision).toBe(
      1,
    );

    // 换新 requestId 但带旧 revision：这是一次真正的并发写，必须被乐观并发拒绝。
    const stale = await post({ ...saveBody, requestId: 'plan-1b' });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      'VERSION_CONFLICT',
    );
  });

  it('计划里的知识点由服务端沿用：客户端自报不符即拒绝', async () => {
    const response = await post({
      action: 'save-scene-plan',
      requestId: 'plan-2',
      lessonId,
      version: lessonVersion,
      baseRevision: 0,
      scenes: [{ ...scenes()[0]!, knowledgeIds: ['knowledge_wrong'] }],
    });
    // 知识点自报不符：KNOWLEDGE_SCOPE_INVALID 默认映射为 400（客户端可修正的入参问题）。
    expect(response.status).toBe(400);
  });

  it('未配置模型时完整课件生成在 provider 之前被阻断', async () => {
    const response = await proposeCourseware({
      requestId: 'courseware-1',
      lessonId,
      version: lessonVersion,
      instruction: '先定义后测验',
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'MODEL_NOT_CONFIGURED',
    );
    expect(session.store.listProjectCoursewareCandidates(session.projectId)).toHaveLength(0);
  });

  it('完整课件处置按 requestId 幂等：通过写入计划，重试不重复写入', async () => {
    const candidate = session.store.createCoursewareCandidate({
      candidateId: newId<'cw'>('cw'),
      projectId: session.projectId,
      lessonId,
      baseVersion: lessonVersion,
      scenes: scenes(),
      instruction: 'x',
    });
    const applyBody = {
      action: 'apply-courseware',
      requestId: 'apply-courseware-1',
      candidateId: candidate.candidateId,
      decision: 'approved',
      note: '场景合理',
    };
    const first = await post(applyBody);
    expect(first.status).toBe(200);
    const firstData = (await first.json()).data;
    expect(apiResponses.lessonCoursewareApply.safeParse(firstData).success).toBe(true);
    expect(firstData.plan.revision).toBe(1);
    expect(firstData.candidate.status).toBe('applied');

    const second = await post(applyBody);
    const secondData = (await second.json()).data;
    expect(secondData.deduplicated).toBe(true);
    expect(secondData.plan.revision).toBe(1);
    expect(session.store.listProjectScenePlans(session.projectId)).toHaveLength(1);
  });

  it('保存的计划真正驱动课堂文档：挂接后场景编号与顺序取自计划', async () => {
    // 计划给出两个幻灯片场景（同一陈述的两个角度），编号是计划自己的稳定编号，
    // 与确定性装配的 `scene_slide_<statementId>` 不同——挂接后必须看到计划里的编号与顺序。
    const planScenes: PlanSceneDto[] = [
      {
        sceneId: 'scene_slide_first',
        kind: 'slide',
        title: '先总览',
        statementId,
        questionId: null,
        knowledgeIds: [],
        elements: [],
        note: '',
      },
      {
        sceneId: 'scene_slide_second',
        kind: 'slide',
        title: '后细讲',
        statementId,
        questionId: null,
        knowledgeIds: [],
        elements: [],
        note: '',
      },
    ];
    const saved = await post({
      action: 'save-scene-plan',
      requestId: 'plan-drives-doc',
      lessonId,
      version: lessonVersion,
      baseRevision: 0,
      scenes: planScenes,
    });
    expect(saved.status).toBe(200);

    expect(
      (
        await post({
          action: 'review',
          lessonId,
          version: lessonVersion,
          decision: 'approved',
          note: 'ok',
        })
      ).status,
    ).toBe(200);
    expect((await post({ action: 'publish', lessonId, version: lessonVersion })).status).toBe(200);
    const attached = await post({ action: 'attach-document', lessonId, version: lessonVersion });
    expect(attached.status).toBe(200);
    const data = (await attached.json()).data;
    expect(apiResponses.lessonDocument.safeParse(data).success).toBe(true);
    expect(data.document.sceneCount).toBe(2);
    // 场景编号与顺序就是计划里的，而不是确定性装配的 scene_slide_<statementId>。
    expect(data.document.scenes.map((scene: { sceneId: string }) => scene.sceneId)).toEqual([
      'scene_slide_first',
      'scene_slide_second',
    ]);
  });

  it('互动场景必须绑定本版本已审核定义：自造编号被拒', async () => {
    // 未冻结任何正式互动定义时，自造一个「看起来像互动」的场景会被拒绝。
    const forged = await post({
      action: 'save-scene-plan',
      requestId: 'plan-forged-interactive',
      lessonId,
      version: lessonVersion,
      baseRevision: 0,
      scenes: [
        scenes()[0]!,
        {
          sceneId: 'scene_formal_interaction_parameter',
          kind: 'interactive',
          title: '自造互动',
          statementId: null,
          questionId: null,
          knowledgeIds: [],
          elements: [],
          note: '',
        },
      ],
    });
    expect(forged.status).toBe(409);
    expect(((await forged.json()) as { error: { code: string } }).error.code).toBe(
      'CLASSROOM_SCENE_SOURCE_MISSING',
    );
    expect(session.store.listProjectScenePlans(session.projectId)).toEqual([]);
  });

  it('受限补丁：只读预览逐条判定，通过后写入计划并按 requestId 幂等', async () => {
    // 先保存一次计划，补丁才有作用对象。
    expect(
      (
        await post({
          action: 'save-scene-plan',
          requestId: 'plan-patch-base',
          lessonId,
          version: lessonVersion,
          baseRevision: 0,
          scenes: scenes(),
        })
      ).status,
    ).toBe(200);

    const candidate = session.store.createScenePlanPatchCandidate({
      candidateId: newId<'sp'>('sp'),
      projectId: session.projectId,
      lessonId,
      baseVersion: lessonVersion,
      instruction: '改标题',
      basePlanRevision: 1,
      basePlanDigest: session.store.getScenePlan(session.projectId, lessonId, lessonVersion)!
        .digest,
      ops: [
        { op: 'replace-scene', sceneId: 'scene_slide_a', field: 'title', value: '新标题' },
        {
          op: 'replace-element',
          sceneId: 'scene_slide_a',
          elementId: 'el_missing',
          field: 'text',
          value: 'x',
        },
      ],
    });

    // 只读预览：逐条判定，不写入计划；重复调用结果一致。
    const previewResponse = await post({
      action: 'preview-scene-plan-patch',
      candidateId: candidate.candidateId,
    });
    expect(previewResponse.status).toBe(200);
    const previewData = (await previewResponse.json()).data;
    expect(apiResponses.lessonScenePlanPatchPreview.safeParse(previewData).success).toBe(true);
    expect(previewData.preview.results.map((item: { status: string }) => item.status)).toEqual([
      'applicable',
      'rejected',
    ]);
    expect(session.store.getScenePlan(session.projectId, lessonId, lessonVersion)!.revision).toBe(
      1,
    );

    const applyBody = {
      action: 'apply-scene-plan-patch',
      requestId: 'apply-patch-1',
      candidateId: candidate.candidateId,
      decision: 'approved',
      note: '采用标题修改',
      selectedOpIndexes: [0],
    };
    const applied = await post(applyBody);
    expect(applied.status).toBe(200);
    const appliedData = (await applied.json()).data;
    expect(apiResponses.lessonScenePlanPatchApply.safeParse(appliedData).success).toBe(true);
    expect(appliedData.plan.revision).toBe(2);
    expect(appliedData.plan.scenes[0].title).toBe('新标题');
    expect(appliedData.candidate.status).toBe('applied');

    // 同 requestId 重放：读回同一回执，不重复推进修订。
    const replay = await post(applyBody);
    const replayData = (await replay.json()).data;
    expect(replayData.deduplicated).toBe(true);
    expect(replayData.plan.revision).toBe(2);
    expect(session.store.getScenePlan(session.projectId, lessonId, lessonVersion)!.revision).toBe(
      2,
    );
  });

  it('受限补丁：计划已被别处推进时通过旧候选被拒，显式覆盖才写入', async () => {
    await post({
      action: 'save-scene-plan',
      requestId: 'plan-patch-base-2',
      lessonId,
      version: lessonVersion,
      baseRevision: 0,
      scenes: scenes(),
    });
    const stale = session.store.createScenePlanPatchCandidate({
      candidateId: newId<'sp'>('sp'),
      projectId: session.projectId,
      lessonId,
      baseVersion: lessonVersion,
      instruction: '改标题',
      basePlanRevision: 0,
      basePlanDigest: null,
      ops: [{ op: 'replace-scene', sceneId: 'scene_slide_a', field: 'title', value: '来自旧基线' }],
    });
    // 计划已被推进到修订 1，而候选基线是 0：未覆盖时拒绝。
    const rejected = await post({
      action: 'apply-scene-plan-patch',
      requestId: 'apply-patch-stale',
      candidateId: stale.candidateId,
      decision: 'approved',
      note: '',
    });
    expect(rejected.status).toBe(409);
    expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe(
      'VERSION_CONFLICT',
    );
    expect(
      session.store.getScenePlan(session.projectId, lessonId, lessonVersion)!.scenes[0]!.title,
    ).toBe('陈述 1');

    // 显式覆盖：用当前看到的修订（1）绑定确认后写入。
    const overridden = await post({
      action: 'apply-scene-plan-patch',
      requestId: 'apply-patch-override',
      candidateId: stale.candidateId,
      decision: 'approved',
      note: '确认覆盖',
      override: true,
      expectedPlanRevision: 1,
    });
    expect(overridden.status).toBe(200);
    expect((await overridden.json()).data.plan.scenes[0].title).toBe('来自旧基线');
  });

  it('受限补丁：确认后计划再次推进，旧确认不得静默覆盖更晚的计划（回归）', async () => {
    // revision 1：先保存一次计划，作为候选的确认基线。
    expect(
      (
        await post({
          action: 'save-scene-plan',
          requestId: 'plan-patch-race-base',
          lessonId,
          version: lessonVersion,
          baseRevision: 0,
          scenes: scenes(),
        })
      ).status,
    ).toBe(200);
    const atRev1 = session.store.getScenePlan(session.projectId, lessonId, lessonVersion)!;
    expect(atRev1.revision).toBe(1);
    const candidate = session.store.createScenePlanPatchCandidate({
      candidateId: newId<'sp'>('sp'),
      projectId: session.projectId,
      lessonId,
      baseVersion: lessonVersion,
      instruction: '改标题',
      basePlanRevision: atRev1.revision,
      basePlanDigest: atRev1.digest,
      ops: [{ op: 'replace-scene', sceneId: 'scene_slide_a', field: 'title', value: '旧候选覆盖' }],
    });

    // 并发推进到 revision 2：这是用户当时**没有**确认过的更新。
    expect(
      (
        await post({
          action: 'save-scene-plan',
          requestId: 'plan-patch-race-latest',
          lessonId,
          version: lessonVersion,
          baseRevision: 1,
          scenes: [{ ...scenes()[0]!, title: '并发最新' }],
        })
      ).status,
    ).toBe(200);
    const atRev2 = session.store.getScenePlan(session.projectId, lessonId, lessonVersion)!;
    expect(atRev2.revision).toBe(2);

    // 旧确认（revision 1）携带 override:true 提交：必须拒绝，不能把计划推进到 revision 3。
    const staleConfirm = await post({
      action: 'apply-scene-plan-patch',
      requestId: 'apply-patch-race',
      candidateId: candidate.candidateId,
      decision: 'approved',
      note: '基于旧确认',
      override: true,
      expectedPlanRevision: 1,
    });
    expect(staleConfirm.status).toBe(409);
    expect(((await staleConfirm.json()) as { error: { code: string } }).error.code).toBe(
      'VERSION_CONFLICT',
    );
    // 计划保持用户当时确认后的最新内容，未被旧候选覆盖；候选仍是待核。
    const after = session.store.getScenePlan(session.projectId, lessonId, lessonVersion)!;
    expect(after.revision).toBe(2);
    expect(after.scenes[0]!.title).toBe('并发最新');
    expect(
      session.store.getScenePlanPatchCandidate(session.projectId, candidate.candidateId)!.status,
    ).toBe('pending');
    // 失败回执可查询：同 requestId 重发得到同一结论，不产生业务写入。
    const replay = await post({
      action: 'apply-scene-plan-patch',
      requestId: 'apply-patch-race',
      candidateId: candidate.candidateId,
      decision: 'approved',
      note: '基于旧确认',
      override: true,
      expectedPlanRevision: 1,
    });
    expect(replay.status).toBe(409);
    expect(session.store.getScenePlan(session.projectId, lessonId, lessonVersion)!.revision).toBe(
      2,
    );

    // 重新比较并确认当前 revision（2）后才允许写入。
    const reconfirmed = await post({
      action: 'apply-scene-plan-patch',
      requestId: 'apply-patch-race-2',
      candidateId: candidate.candidateId,
      decision: 'approved',
      note: '重新确认',
      override: true,
      expectedPlanRevision: 2,
    });
    expect(reconfirmed.status).toBe(200);
    const applied = (await reconfirmed.json()).data;
    expect(applied.plan.revision).toBe(3);
    expect(applied.plan.scenes[0]!.title).toBe('旧候选覆盖');
  });

  it('持久编辑草稿：保存/恢复/丢弃，基线过期被拒，保存计划后清草稿', async () => {
    // 先保存一次计划，草稿才有基线。
    await post({
      action: 'save-scene-plan',
      requestId: 'plan-draft-base',
      lessonId,
      version: lessonVersion,
      baseRevision: 0,
      scenes: scenes(),
    });
    const draftScenes = [{ ...scenes()[0]!, title: '草稿标题' }];

    const saved = await post({
      action: 'save-scene-plan-draft',
      requestId: 'draft-1',
      lessonId,
      version: lessonVersion,
      baseRevision: 1,
      scenes: draftScenes,
    });
    expect(saved.status).toBe(200);
    const savedData = (await saved.json()).data;
    expect(apiResponses.lessonScenePlanDraft.safeParse(savedData).success).toBe(true);
    expect(savedData.draft.baseRevision).toBe(1);
    expect(savedData.draft.scenes[0].title).toBe('草稿标题');
    // 草稿不写入权威计划。
    expect(
      session.store.getScenePlan(session.projectId, lessonId, lessonVersion)!.scenes[0]!.title,
    ).toBe('陈述 1');
    // 重新读取仍能恢复（跨端口/重启的等价断言）。
    expect(
      session.store.getScenePlanDraft(session.projectId, lessonId, lessonVersion)!.scenes[0]!.title,
    ).toBe('草稿标题');

    // 基线过期：客户端自报基线 0，但当前计划已是修订 1。
    const staleDraft = await post({
      action: 'save-scene-plan-draft',
      requestId: 'draft-stale',
      lessonId,
      version: lessonVersion,
      baseRevision: 0,
      scenes: draftScenes,
    });
    expect(staleDraft.status).toBe(409);

    // 丢弃草稿。
    const discarded = await post({
      action: 'discard-scene-plan-draft',
      lessonId,
      version: lessonVersion,
    });
    expect(discarded.status).toBe(200);
    expect(
      apiResponses.lessonScenePlanDraftDiscard.safeParse((await discarded.json()).data).success,
    ).toBe(true);
    expect(session.store.getScenePlanDraft(session.projectId, lessonId, lessonVersion)).toBeNull();

    // 保存计划成功路径后清草稿：先存草稿，再保存计划。
    await post({
      action: 'save-scene-plan-draft',
      requestId: 'draft-2',
      lessonId,
      version: lessonVersion,
      baseRevision: 1,
      scenes: draftScenes,
    });
    expect(
      session.store.getScenePlanDraft(session.projectId, lessonId, lessonVersion),
    ).not.toBeNull();
    const savedWithDraft = await post({
      action: 'save-scene-plan',
      requestId: 'plan-save-clears-draft',
      lessonId,
      version: lessonVersion,
      baseRevision: 1,
      scenes: draftScenes,
    });
    expect(savedWithDraft.status).toBe(200);
    expect(session.store.getScenePlanDraft(session.projectId, lessonId, lessonVersion)).toBeNull();
  });

  it('持久编辑草稿：乱序/过期写入被草稿级 CAS 拒绝，最终重开读到最新合法快照（回归）', async () => {
    await post({
      action: 'save-scene-plan',
      requestId: 'plan-draft-race-base',
      lessonId,
      version: lessonVersion,
      baseRevision: 0,
      scenes: scenes(),
    });
    const draftScenes = (title: string) => [{ ...scenes()[0]!, title }];

    // 首次保存：无草稿，不检查草稿级 CAS，得到 draftRevision 1。
    const first = await post({
      action: 'save-scene-plan-draft',
      requestId: 'draft-race-1',
      lessonId,
      version: lessonVersion,
      baseRevision: 1,
      scenes: draftScenes('第一次编辑'),
    });
    expect(first.status).toBe(200);
    const firstDraft = (await first.json()).data.draft;
    expect(firstDraft.draftRevision).toBe(1);

    // 第二窗口（或同一窗口）用已读到的 revision 1 正常推进到 2。
    const second = await post({
      action: 'save-scene-plan-draft',
      requestId: 'draft-race-2',
      lessonId,
      version: lessonVersion,
      baseRevision: 1,
      expectedDraftRevision: 1,
      scenes: draftScenes('第二次编辑'),
    });
    expect(second.status).toBe(200);
    expect((await second.json()).data.draft.draftRevision).toBe(2);

    // 旧请求（仍以为草稿是 revision 1）晚到：必须被拒，不覆盖更新的编辑。
    const outOfOrder = await post({
      action: 'save-scene-plan-draft',
      requestId: 'draft-race-stale',
      lessonId,
      version: lessonVersion,
      baseRevision: 1,
      expectedDraftRevision: 1,
      scenes: draftScenes('过期写入'),
    });
    expect(outOfOrder.status).toBe(409);
    expect(((await outOfOrder.json()) as { error: { code: string } }).error.code).toBe(
      'VERSION_CONFLICT',
    );
    // 独立连接/重开读取：最终草稿是更新的那一份，不是过期写入。
    expect(
      session.store.getScenePlanDraft(session.projectId, lessonId, lessonVersion)!.scenes[0]!.title,
    ).toBe('第二次编辑');

    // 已存在草稿却未声明期望版本：按冲突拒绝而不是静默覆盖。
    const undeclared = await post({
      action: 'save-scene-plan-draft',
      requestId: 'draft-race-undeclared',
      lessonId,
      version: lessonVersion,
      baseRevision: 1,
      scenes: draftScenes('未声明期望'),
    });
    expect(undeclared.status).toBe(409);
    expect(
      session.store.getScenePlanDraft(session.projectId, lessonId, lessonVersion)!.scenes[0]!.title,
    ).toBe('第二次编辑');
  });

  it('受限补丁预览：勾选子集后按当前选择与基线重新计算，区分可应用/选中/应用/拒绝（回归）', async () => {
    await post({
      action: 'save-scene-plan',
      requestId: 'plan-patch-preview-base',
      lessonId,
      version: lessonVersion,
      baseRevision: 0,
      scenes: scenes(),
    });
    const base = session.store.getScenePlan(session.projectId, lessonId, lessonVersion)!;
    // 三条合法操作 + 一条越界（不可应用）。
    const candidate = session.store.createScenePlanPatchCandidate({
      candidateId: newId<'sp'>('sp'),
      projectId: session.projectId,
      lessonId,
      baseVersion: lessonVersion,
      instruction: '多操作',
      basePlanRevision: base.revision,
      basePlanDigest: base.digest,
      ops: [
        { op: 'replace-scene', sceneId: 'scene_slide_a', field: 'title', value: '标题一' },
        { op: 'replace-scene', sceneId: 'scene_slide_a', field: 'note', value: '备注二' },
        { op: 'replace-scene', sceneId: 'scene_slide_a', field: 'title', value: '标题三' },
        { op: 'replace-scene', sceneId: 'scene_missing', field: 'title', value: '越界' },
      ],
    });

    // 未给选择：默认全部可应用操作；applicable=3，rejected=1，applied=3。
    const all = await post({
      action: 'preview-scene-plan-patch',
      candidateId: candidate.candidateId,
    });
    expect(all.status).toBe(200);
    const allPreview = (await all.json()).data.preview;
    expect(allPreview.applicableCount).toBe(3);
    expect(allPreview.selectedCount).toBe(3);
    expect(allPreview.appliedCount).toBe(3);
    expect(allPreview.rejectedCount).toBe(1);
    expect(allPreview.scenes[0].title).toBe('标题三');

    // 仅选第 0 条：applicable 仍为 3（与选择无关），applied=1，结果只反映选中的操作。
    const subset = await post({
      action: 'preview-scene-plan-patch',
      candidateId: candidate.candidateId,
      selectedOpIndexes: [0],
    });
    expect(subset.status).toBe(200);
    const subsetPreview = (await subset.json()).data.preview;
    expect(subsetPreview.applicableCount).toBe(3);
    expect(subsetPreview.selectedCount).toBe(1);
    expect(subsetPreview.appliedCount).toBe(1);
    expect(subsetPreview.rejectedCount).toBe(1);
    expect(subsetPreview.scenes[0].title).toBe('标题一');
    expect(subsetPreview.scenes[0].note).toBe('');

    // 选空：applicable 仍为 3，applied=0，结果计划与基线逐字一致。
    const empty = await post({
      action: 'preview-scene-plan-patch',
      candidateId: candidate.candidateId,
      selectedOpIndexes: [],
    });
    expect(empty.status).toBe(200);
    const emptyPreview = (await empty.json()).data.preview;
    expect(emptyPreview.applicableCount).toBe(3);
    expect(emptyPreview.selectedCount).toBe(0);
    expect(emptyPreview.appliedCount).toBe(0);
    expect(emptyPreview.scenes[0].title).toBe('陈述 1');

    // 选中被拒绝的下标：按合同错误拒绝（避免「选了 A 实际写 B」）。
    const invalid = await post({
      action: 'preview-scene-plan-patch',
      candidateId: candidate.candidateId,
      selectedOpIndexes: [3],
    });
    expect(invalid.status).toBe(400);

    // 只读预览不写入计划。
    expect(session.store.getScenePlan(session.projectId, lessonId, lessonVersion)!.revision).toBe(
      base.revision,
    );

    // 采用所选子集写入计划：结果与预览逐字一致。
    const applied = await post({
      action: 'apply-scene-plan-patch',
      requestId: 'apply-patch-subset',
      candidateId: candidate.candidateId,
      decision: 'approved',
      note: '只采用第一条',
      selectedOpIndexes: [0],
    });
    expect(applied.status).toBe(200);
    const appliedData = (await applied.json()).data;
    expect(appliedData.plan.scenes[0].title).toBe('标题一');
    expect(appliedData.plan.scenes[0].note).toBe('');
  });
});
