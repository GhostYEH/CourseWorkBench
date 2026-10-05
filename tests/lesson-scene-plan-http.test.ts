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

  it('保存场景计划：响应通过合同校验，重发带旧 revision 被拒', async () => {
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

    const stale = await post(saveBody);
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
});
