import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newId,
  scenePlanPatchOutputSchema,
  type PlanPayloadDto,
  type ScenePlanPatchProposeInput,
} from '@sew/study-contracts';
import { applyScenePlanPatch } from '@sew/study-domain';
import { StudyStore, ensureProjectLayout, projectPaths } from '@sew/study-storage';
import { createModelConnectionRuntime } from '../apps/learning/lib/server/model-connection';
import { generateScenePlanPatch } from '../apps/learning/lib/server/scene-plan-patch-model';

/**
 * 受限 AI 场景计划补丁（LESSON-02 / OMA-023）。
 *
 * 固定四件事：① 合同层把字段收口，越界/未知字段/伪造身份被 schema 直接拒绝；
 * ② 领域层逐条判定可应用性，越界几何、未知场景/元素、脚本正文、未审核图片一律被拒绝；
 * ③ 生成走 guard 产出待核候选，不写入任何计划；④ 同 requestId 重试不再调用 provider。
 */

describe('OMA-023 受限补丁的合同与领域判定', () => {
  const scene = (over: Partial<Record<string, unknown>> = {}) => ({
    sceneId: 'scene_slide_a',
    kind: 'slide' as const,
    title: '陈述 1',
    statementId: 'statement_a',
    questionId: null,
    knowledgeIds: [],
    elements: [
      {
        elementId: 'el_text_a',
        kind: 'text' as const,
        text: '正文',
        assetRef: null,
        left: 10,
        top: 10,
        width: 100,
        height: 50,
        style: { fontSize: 24, color: '#232323', bold: false, italic: false, align: 'left' as const },
      },
    ],
    note: '',
    ...over,
  });

  it('合同层拒绝未在允许集合里的字段与操作', () => {
    expect(
      scenePlanPatchOutputSchema.safeParse({
        ops: [{ op: 'replace-scene', sceneId: 'scene_slide_a', field: 'statementId', value: 'x' }],
      }).success,
    ).toBe(false);
    expect(
      scenePlanPatchOutputSchema.safeParse({
        ops: [{ op: 'set-knowledge', sceneId: 'scene_slide_a', knowledgeIds: ['k1'] }],
      }).success,
    ).toBe(false);
    expect(
      scenePlanPatchOutputSchema.safeParse({
        ops: [
          {
            op: 'replace-element',
            sceneId: 'scene_slide_a',
            elementId: 'el_text_a',
            field: 'text',
            value: 'ok',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('领域层逐条判定：越界几何、未知元素、脚本正文、未审核图片都被拒绝', () => {
    const outcome = applyScenePlanPatch(
      [scene() as never],
      [
        {
          op: 'replace-element',
          sceneId: 'scene_slide_a',
          elementId: 'el_text_a',
          field: 'left',
          value: 99999,
        },
        {
          op: 'replace-element',
          sceneId: 'scene_slide_a',
          elementId: 'el_missing',
          field: 'text',
          value: 'x',
        },
        {
          op: 'replace-element',
          sceneId: 'scene_slide_a',
          elementId: 'el_text_a',
          field: 'text',
          value: '<script>alert(1)</script>',
        },
        {
          op: 'add-element',
          sceneId: 'scene_slide_a',
          element: {
            kind: 'image',
            text: '',
            assetRef: 'unreviewed-asset',
            left: 0,
            top: 0,
            width: 100,
            height: 100,
          },
        },
      ] as never,
      { approvedAssetRefs: new Set(['approved-asset']), nextElementId: () => 'el_text_new' },
    );
    expect(outcome.results.map((item) => item.status)).toEqual([
      'rejected',
      'rejected',
      'rejected',
      'rejected',
    ]);
    expect(outcome.results.map((item) => item.reason)).toEqual([
      'geometry_out_of_range',
      'element_not_in_scene',
      'rich_text_unsafe',
      'asset_ref_not_approved',
    ]);
    // 没有任何可应用操作时，计划逐字保留。
    expect(outcome.scenes).toEqual([scene()]);
  });

  it('领域层应用可应用操作，且不改来源绑定/知识点/场景身份', () => {
    const outcome = applyScenePlanPatch(
      [scene() as never],
      [
        {
          op: 'replace-scene',
          sceneId: 'scene_slide_a',
          field: 'title',
          value: '新的标题',
        },
        {
          op: 'replace-element',
          sceneId: 'scene_slide_a',
          elementId: 'el_text_a',
          field: 'style.bold',
          value: true,
        },
      ] as never,
      { approvedAssetRefs: new Set(), nextElementId: () => 'el_text_new' },
    );
    expect(outcome.results.map((item) => item.status)).toEqual(['applicable', 'applicable']);
    const next = outcome.scenes[0]!;
    expect(next.title).toBe('新的标题');
    expect(next.elements[0]!.style.bold).toBe(true);
    // 来源绑定、知识点与场景身份完全不动。
    expect(next.statementId).toBe('statement_a');
    expect(next.knowledgeIds).toEqual([]);
    expect(next.sceneId).toBe('scene_slide_a');
  });
});

describe('受 guard 约束的受限补丁候选生成（注入假 fetcher）', () => {
  let root: string;
  let store: StudyStore;
  let projectId: string;
  let bundleId = '';
  let statementId = '';
  let lessonId = '';
  let lessonVersion = 1;
  let requests: string[] = [];
  let responder: () => Response | Promise<Response>;

  const okResponder = (content: unknown): Response =>
    new Response(
      JSON.stringify({
        model: 'fixture-model',
        choices: [{ message: { content: JSON.stringify(content) } }],
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
        baseUrl: 'https://scene-patch.test/v1',
        model: 'fixture-model',
        apiKey: 'scene-patch-fixture-key-not-a-secret',
      },
      false,
    );
    return runtime;
  };

  const input = (over: Partial<ScenePlanPatchProposeInput> = {}): ScenePlanPatchProposeInput => ({
    scope: { projectId, generation: 1 },
    action: 'propose-scene-plan-patch',
    requestId: 'req-patch-1',
    lessonId,
    version: lessonVersion,
    instruction: '把标题改得更口语',
    ...over,
  });

  beforeEach(() => {
    requests = [];
    responder = () =>
      okResponder({
        ops: [{ op: 'replace-scene', sceneId: 'scene_slide_a', field: 'title', value: '新标题' }],
      });
    root = mkdtempSync(join(tmpdir(), 'sew-scene-patch-model-'));
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
    const materialId = imported.material.materialId;
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
    const knowledgeId = store.applyReview({
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
    // 补丁只能作用在已存在的计划上：先保存一次确定性计划。
    store.saveScenePlan({
      projectId,
      lessonId,
      lessonVersion,
      bundleId,
      origin: 'deterministic',
      baseRevision: 0,
      scenes: [
        {
          sceneId: 'scene_slide_a',
          kind: 'slide',
          title: '陈述 1',
          statementId,
          questionId: null,
          knowledgeIds: [],
          elements: [],
          note: '',
        },
      ],
    });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  const generate = (over: Partial<ScenePlanPatchProposeInput> = {}) =>
    generateScenePlanPatch({ store, projectId, connection: connection() }, input(over));

  it('正常路径产出待核候选，不写入场景计划', async () => {
    const result = await generate();
    expect(result.candidate).not.toBeNull();
    expect(result.candidate!.status).toBe('pending');
    expect(result.candidate!.ops).toHaveLength(1);
    expect(result.deduplicated).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toContain('scene-patch-fixture-key');
    expect(store.listProjectScenePlanPatchCandidates(projectId)).toHaveLength(1);
    // 计划仍是保存时的修订 1，没有被候选改写。
    expect(store.getScenePlan(projectId, lessonId, lessonVersion)!.revision).toBe(1);
  });

  it('同一 requestId 重试返回既有候选，不再调用 provider', async () => {
    const first = await generate();
    const second = await generate();
    expect(second.deduplicated).toBe(true);
    expect(second.candidate!.candidateId).toBe(first.candidate!.candidateId);
    expect(requests).toHaveLength(1);
    expect(store.listProjectScenePlanPatchCandidates(projectId)).toHaveLength(1);
  });

  it('模型提出全部不可应用的操作时不落候选', async () => {
    responder = () =>
      okResponder({
        ops: [
          {
            op: 'replace-element',
            sceneId: 'scene_slide_a',
            elementId: 'el_missing',
            field: 'text',
            value: 'x',
          },
        ],
      });
    const result = await generate();
    expect(result.candidate).toBeNull();
    expect(store.listProjectScenePlanPatchCandidates(projectId)).toHaveLength(0);
  });

  it('模型输出不是合法 JSON 时不落候选', async () => {
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
    expect(store.listProjectScenePlanPatchCandidates(projectId)).toHaveLength(0);
  });

  it('没有场景计划时在 provider 之前阻断', async () => {
    // 派生同一课程的新草案版本：它还没有任何计划，补丁无处可施。
    const lesson = store.createLessonDraft({
      projectId,
      lessonId,
      title: '函数单调性（新草案）',
      bundleId,
      statementIds: [statementId],
      questionIds: [],
    });
    await expect(
      generateScenePlanPatch(
        { store, projectId, connection: connection() },
        input({ lessonId: lesson.lessonId, version: lesson.version }),
      ),
    ).rejects.toThrow(/记录不存在/);
    expect(requests).toHaveLength(0);
  });
});
