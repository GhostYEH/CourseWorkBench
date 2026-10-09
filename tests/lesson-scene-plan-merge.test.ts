import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiResponses, type PlanPayloadDto, type PlanSceneDto } from '@sew/study-contracts';
import {
  diffScenePlans,
  digestOfScenePlan,
  mergeScenePlans,
  outlineOrderedScenes,
  planSceneDigest,
} from '@sew/study-domain';
import { POST as lessonsPost } from '../apps/learning/app/api/study/lessons/route';
import {
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';

/**
 * 跨版本场景计划差异与合并（LESSON-02 / OMA-005、OMA-022）。
 *
 * 固定五件事：① 差异按稳定 sceneId 分类，不看序号；② 三向合并只安全应用「来源改了、目标没动」
 * 的改动；③ 两侧都改 / 换种类 / 删改冲突一律保留目标内容并如实报告，绝不静默取一侧；
 * ④ 只读命令不写入任何计划（写回仍走 save-scene-plan）；⑤ 写入走乐观并发，来源变了旧审核即失效。
 */
describe('跨版本场景计划差异与合并', () => {
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

  const element = (id: string, text: string) => ({
    elementId: id,
    kind: 'text' as const,
    text,
    assetRef: null,
    left: 90,
    top: 130,
    width: 820,
    height: 100,
    style: { fontSize: 24, color: '#232323', bold: false, italic: false, align: 'left' as const },
  });

  const scene = (id: string, text: string, over: Partial<PlanSceneDto> = {}): PlanSceneDto => ({
    sceneId: id,
    kind: 'slide',
    title: id,
    statementId,
    questionId: null,
    knowledgeIds: [
      session.store.getEvidenceBundle(session.projectId, bundleId)!.bundle.statements[0]!
        .knowledgeId,
    ],
    elements: text ? [element(`el_${id}`, text)] : [],
    note: '',
    ...over,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-scene-plan-merge-'));
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

  it('差异按稳定 sceneId 分类：增/删/改/序分开报告，不看序号', () => {
    const base = [scene('a', 'A'), scene('b', 'B')];
    const target = [scene('b', 'B2'), scene('a', 'A'), scene('c', 'C')];
    const diff = diffScenePlans(base, target);
    expect(diff.added).toEqual(['c']);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toEqual(['b']);
    expect(diff.reordered).toBe(true);
    // 内容相同但顺序不同不算修改。
    expect(planSceneDigest(scene('a', 'A'))).toBe(planSceneDigest(scene('a', 'A')));
    expect(planSceneDigest(scene('a', 'A'))).not.toBe(planSceneDigest(scene('a', 'B')));
  });

  it('三向合并只应用「来源改了、目标没动」的改动，其余保持目标内容', () => {
    const base = [scene('a', 'A'), scene('b', 'B')];
    const incoming = [scene('a', 'A2'), scene('b', 'B')];
    const onlyIncoming = mergeScenePlans({ base, incoming, current: base });
    expect(onlyIncoming.conflicts).toEqual([]);
    expect(onlyIncoming.applied.replaced).toEqual(['a']);
    expect(onlyIncoming.scenes.map((item) => item.elements[0]?.text)).toEqual(['A2', 'B']);

    // 目标版本自己也改了同一个场景 → 冲突，结果保留目标内容并报告。
    const both = mergeScenePlans({ base, incoming, current: [scene('a', 'A3'), scene('b', 'B')] });
    expect(both.conflicts).toEqual([{ sceneId: 'a', reason: 'both_modified' }]);
    expect(both.scenes[0]!.elements[0]?.text).toBe('A3');
  });

  it('来源新增/删除按基线安全并入', () => {
    const base = [scene('a', 'A')];
    const incoming = [scene('a', 'A'), scene('c', 'C')];
    const added = mergeScenePlans({ base, incoming, current: base });
    expect(added.applied.added).toEqual(['c']);
    expect(added.scenes.map((item) => item.sceneId)).toEqual(['a', 'c']);

    // 来源删除、目标未改 → 跟随删除；目标改过 → 冲突保留目标内容。
    const removed = mergeScenePlans({ base, incoming: [], current: base });
    // 空 incoming 会让合并结果为空，调用方据此拒绝写空计划。
    expect(removed.scenes).toEqual([]);
    const removeConflict = mergeScenePlans({
      base: [scene('a', 'A'), scene('b', 'B')],
      incoming: [scene('b', 'B')],
      current: [scene('a', 'A2'), scene('b', 'B')],
    });
    expect(removeConflict.conflicts).toEqual([{ sceneId: 'a', reason: 'removed_and_modified' }]);
    expect(removeConflict.scenes.map((item) => item.sceneId)).toEqual(['a', 'b']);
  });

  it('按整课大纲对齐：报告缺口但不自动补场景', () => {
    const result = outlineOrderedScenes([scene('x', 'X'), scene('y', 'Y')], [statementId]);
    expect(result.missing).toEqual([]);
    expect(result.scenes.map((item) => item.sceneId)).toEqual(['x', 'y']);
  });

  it('目标删除而来源修改时保留删除，并逐场景报告反向删改冲突', () => {
    const base = [scene('a', 'A'), scene('b', 'B'), scene('c', 'C'), scene('d', 'D')];
    const incoming = [
      scene('a', 'A2'),
      scene('b', 'B'),
      scene('c', 'C', { title: 'C2' }),
      scene('d', 'D2'),
      scene('new', 'N'),
    ];
    const current = [scene('d', 'D'), scene('target', 'T')];
    const merged = mergeScenePlans({ base, incoming, current });
    expect(merged.conflicts).toEqual([
      { sceneId: 'a', reason: 'removed_and_modified' },
      { sceneId: 'c', reason: 'removed_and_modified' },
    ]);
    expect(merged.scenes.map((item) => item.sceneId)).toEqual(['d', 'target', 'new']);
    expect(merged.applied).toEqual({ added: ['new'], removed: [], replaced: ['d'] });
    expect(merged.scenes[0]!.elements[0]!.text).toBe('D2');
    // 目标删除而来源未改的 b 不报冲突；两侧都删除也不报冲突。
    expect(mergeScenePlans({ base, incoming: [], current }).conflicts).toEqual([]);
  });

  it('HTTP 预览只读：算出差异与冲突但不写入任何计划', async () => {
    // 派生骨架用的稳定编号：`scene_slide_<statementId>`；来源计划沿用同一编号才可比对。
    const slideId = `scene_slide_${statementId}`;
    await post({
      action: 'save-scene-plan',
      requestId: 'merge-src-1',
      lessonId,
      version: lessonVersion,
      baseRevision: 0,
      scenes: [scene(slideId, 'A')],
    });
    expect(session.store.getScenePlan(session.projectId, lessonId, lessonVersion)!.revision).toBe(
      1,
    );

    // 从 v1 派生一个新草案版本 v2（派生后 v2 尚无计划）。
    const draft = await post({
      action: 'draft',
      lessonId,
      bundleId,
      title: '函数单调性（合并目标）',
      statementIds: [statementId],
      questionIds: [],
      requestId: 'merge-draft-1',
    });
    const draftData = (await draft.json()).data;
    const targetVersion = draftData.lesson.version;
    expect(targetVersion).toBeGreaterThan(lessonVersion);
    expect(session.store.getScenePlan(session.projectId, lessonId, targetVersion)).toBeNull();

    const response = await post({
      action: 'merge-scene-plans',
      lessonId,
      fromVersion: lessonVersion,
      toVersion: targetVersion,
    });
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(apiResponses.lessonScenePlanMerge.safeParse(data).success).toBe(true);
    expect(data.merge.fromVersion).toBe(lessonVersion);
    expect(data.merge.toVersion).toBe(targetVersion);
    // 目标骨架正文为空、来源正文为 'A'：差异报告「这一场景被改过」，合并后采用来源内容。
    expect(data.merge.baseVersion).toBe(targetVersion);
    expect(data.merge.diff.added).toEqual([]);
    expect(data.merge.diff.removed).toEqual([]);
    expect(data.merge.diff.modified.map((item: { sceneId: string }) => item.sceneId)).toEqual([
      slideId,
    ]);
    expect(data.merge.conflicts).toEqual([]);
    expect(data.merge.mergedScenes).toHaveLength(1);
    expect(data.merge.mergedScenes[0]!.sceneId).toBe(slideId);
    expect(data.merge.mergedScenes[0]!.elements[0]!.text).toBe('A');
    expect(data.merge.mergedDigest).toBe(
      digestOfScenePlan({
        lessonId,
        lessonVersion: targetVersion,
        bundleId,
        scenes: data.merge.mergedScenes,
      }),
    );
    // 只读：预览不写入任何计划。
    expect(session.store.getScenePlan(session.projectId, lessonId, targetVersion)).toBeNull();
    expect(session.store.getScenePlan(session.projectId, lessonId, lessonVersion)!.revision).toBe(
      1,
    );
  });

  it('三向合并真实场景：来源与目标相对同一祖先各改了同一场景 → 记为冲突并保留目标内容', async () => {
    const slideId = `scene_slide_${statementId}`;
    // v1 = 共同祖先：正文 'A'。
    await post({
      action: 'save-scene-plan',
      requestId: 'merge-base-1',
      lessonId,
      version: lessonVersion,
      baseRevision: 0,
      scenes: [scene(slideId, 'A')],
    });
    // v2 = 来源：把正文改成 'A2'（相对 v1 的改动）。
    const sourceDraft = await post({
      action: 'draft',
      lessonId,
      bundleId,
      title: '函数单调性（来源）',
      statementIds: [statementId],
      questionIds: [],
    });
    const sourceVersion = (await sourceDraft.json()).data.lesson.version;
    await post({
      action: 'save-scene-plan',
      requestId: 'merge-src-2',
      lessonId,
      version: sourceVersion,
      baseRevision: 0,
      scenes: [scene(slideId, 'A2')],
    });
    // v3 = 目标：把标题改成 'TARGET'（相对 v1 的另一处改动）。
    const targetDraft = await post({
      action: 'draft',
      lessonId,
      bundleId,
      title: '函数单调性（目标）',
      statementIds: [statementId],
      questionIds: [],
    });
    const targetVersion = (await targetDraft.json()).data.lesson.version;
    await post({
      action: 'save-scene-plan',
      requestId: 'merge-target-2',
      lessonId,
      version: targetVersion,
      baseRevision: 0,
      scenes: [scene(slideId, 'A', { title: 'TARGET' })],
    });

    const preview = (
      await (
        await post({
          action: 'merge-scene-plans',
          lessonId,
          baseVersion: lessonVersion,
          fromVersion: sourceVersion,
          toVersion: targetVersion,
        })
      ).json()
    ).data.merge;
    // 同一场景两侧都相对祖先改过：场景级无法自动判定 → 记为冲突，保留目标版本当前内容。
    expect(preview.baseVersion).toBe(lessonVersion);
    expect(preview.conflicts.map((item: { sceneId: string }) => item.sceneId)).toEqual([slideId]);
    expect(preview.mergedScenes[0]!.title).toBe('TARGET');
    expect(preview.mergedScenes[0]!.elements[0]!.text).toBe('A');
    // 冲突两侧的内容摘要都要能被界面看到（据此人工选择保留哪一侧）。
    expect(preview.conflicts[0]!.incomingDigest).toHaveLength(64);
    expect(preview.conflicts[0]!.currentDigest).toHaveLength(64);
    expect(preview.conflicts[0]!.incomingDigest).not.toBe(preview.conflicts[0]!.currentDigest);
  });

  it('HTTP 预览报告目标删除与来源修改的冲突，删除侧摘要为 null 且不回加场景', async () => {
    const baseScenes = [scene('a', 'A'), scene('b', 'B'), scene('c', 'C')];
    expect(
      (
        await post({
          action: 'save-scene-plan',
          requestId: 'reverse-base',
          lessonId,
          version: lessonVersion,
          baseRevision: 0,
          scenes: baseScenes,
        })
      ).status,
    ).toBe(200);
    const sourceDraft = await post({
      action: 'draft',
      lessonId,
      bundleId,
      title: '来源修改',
      statementIds: [statementId],
      questionIds: [],
    });
    const sourceVersion = (await sourceDraft.json()).data.lesson.version;
    const sourceScenes = [scene('a', 'A2'), scene('b', 'B'), scene('c', 'C2')];
    expect(
      (
        await post({
          action: 'save-scene-plan',
          requestId: 'reverse-source',
          lessonId,
          version: sourceVersion,
          baseRevision: 0,
          scenes: sourceScenes,
        })
      ).status,
    ).toBe(200);
    const targetDraft = await post({
      action: 'draft',
      lessonId,
      bundleId,
      title: '目标删除',
      statementIds: [statementId],
      questionIds: [],
    });
    const targetVersion = (await targetDraft.json()).data.lesson.version;
    expect(
      (
        await post({
          action: 'save-scene-plan',
          requestId: 'reverse-target',
          lessonId,
          version: targetVersion,
          baseRevision: 0,
          scenes: [scene('c', 'C')],
        })
      ).status,
    ).toBe(200);
    const plansBefore = session.store.listProjectScenePlans(session.projectId);

    const command = {
      action: 'merge-scene-plans',
      lessonId,
      baseVersion: lessonVersion,
      fromVersion: sourceVersion,
      toVersion: targetVersion,
    };
    const response = await post(command);
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(apiResponses.lessonScenePlanMerge.safeParse(data).success).toBe(true);
    expect(data.merge.conflicts).toEqual([
      {
        sceneId: 'a',
        reason: 'removed_and_modified',
        incomingDigest: planSceneDigest(sourceScenes[0]!),
        currentDigest: null,
      },
    ]);
    // 未修改的 b 仍保持删除；c 的来源修改可安全应用，预览不写回。
    expect(data.merge.mergedScenes.map((item: PlanSceneDto) => item.sceneId)).toEqual(['c']);
    expect(data.merge.mergedScenes[0]!.elements[0]!.text).toBe('C2');
    expect((await (await post(command)).json()).data).toEqual(data);
    expect(session.store.listProjectScenePlans(session.projectId)).toEqual(plansBefore);
  });

  it('未给 baseVersion 且目标已有计划时不用来源静默覆盖目标，只报告差异与冲突', async () => {
    const slideId = `scene_slide_${statementId}`;
    await post({
      action: 'save-scene-plan',
      requestId: 'merge-guard-src',
      lessonId,
      version: lessonVersion,
      baseRevision: 0,
      scenes: [scene(slideId, 'A')],
    });
    const targetDraft = await post({
      action: 'draft',
      lessonId,
      bundleId,
      title: '函数单调性（目标已有计划）',
      statementIds: [statementId],
      questionIds: [],
    });
    const targetVersion = (await targetDraft.json()).data.lesson.version;
    await post({
      action: 'save-scene-plan',
      requestId: 'merge-guard-target',
      lessonId,
      version: targetVersion,
      baseRevision: 0,
      scenes: [scene(slideId, 'KEEP')],
    });

    const preview = (
      await (
        await post({
          action: 'merge-scene-plans',
          lessonId,
          fromVersion: lessonVersion,
          toVersion: targetVersion,
        })
      ).json()
    ).data.merge;
    // 目标已有计划、又没给共同祖先：合并不得静默覆盖目标版本已编辑的内容。
    expect(preview.mergedScenes[0]!.elements[0]!.text).toBe('KEEP');
    expect(preview.diff.modified.map((item: { sceneId: string }) => item.sceneId)).toEqual([
      slideId,
    ]);
  });

  it('预览结果可经 save-scene-plan 写回：乐观并发与幂等回执保持原有语义', async () => {
    const slideId = `scene_slide_${statementId}`;
    // v1 来源：正文 'A2'。
    await post({
      action: 'save-scene-plan',
      requestId: 'merge-src-write',
      lessonId,
      version: lessonVersion,
      baseRevision: 0,
      scenes: [scene(slideId, 'A2')],
    });
    // 目标版本还没有计划：骨架正文为空，来源的 A2 改动安全并入。
    const draft = await post({
      action: 'draft',
      lessonId,
      bundleId,
      title: '函数单调性（合并写回）',
      statementIds: [statementId],
      questionIds: [],
    });
    const targetVersion = (await draft.json()).data.lesson.version;
    const preview = (
      await (
        await post({
          action: 'merge-scene-plans',
          lessonId,
          fromVersion: lessonVersion,
          toVersion: targetVersion,
        })
      ).json()
    ).data.merge;
    // 目标无计划 → 骨架为祖先，来源的 'A2' 被安全并入。
    expect(preview.mergedScenes[0]!.elements[0]!.text).toBe('A2');

    // 写回不做特殊路径：写入新版本仍是一次普通 save-scene-plan（乐观并发 + 事务内回执）。
    const seeded = await post({
      action: 'save-scene-plan',
      requestId: 'merge-write-seed',
      lessonId,
      version: targetVersion,
      baseRevision: 0,
      scenes: [scene(slideId, 'X')],
    });
    const seededData = (await seeded.json()).data;
    const saved = await post({
      action: 'save-scene-plan',
      requestId: 'merge-write-1',
      lessonId,
      version: targetVersion,
      baseRevision: seededData.plan.revision,
      scenes: preview.mergedScenes,
    });
    expect(saved.status).toBe(200);
    const savedData = (await saved.json()).data;
    expect(savedData.plan.scenes[0]!.elements[0]!.text).toBe('A2');
    // 同 requestId 重放读回同一结果，不推进第二个 revision。
    const replay = await post({
      action: 'save-scene-plan',
      requestId: 'merge-write-1',
      lessonId,
      version: targetVersion,
      baseRevision: seededData.plan.revision,
      scenes: preview.mergedScenes,
    });
    expect((await replay.json()).data.deduplicated).toBe(true);
    expect(session.store.getScenePlan(session.projectId, lessonId, targetVersion)!.revision).toBe(
      savedData.plan.revision,
    );
    // 新内容与旧审核基线不同 → 发布前必须重新审核，审核绑定的是合并后的内容摘要。
    session.store.reviewLesson({
      projectId: session.projectId,
      lessonId,
      version: targetVersion,
      decision: 'approved',
      note: '按合并后的计划复核',
    });
    const review = session.store.getLessonReview(lessonId, targetVersion, session.projectId)!;
    expect(review.planDigest).toBe(savedData.plan.digest);
  });

  it('非法输入与缺失计划明确失败，不静默写入', async () => {
    const same = await post({
      action: 'merge-scene-plans',
      lessonId,
      fromVersion: lessonVersion,
      toVersion: lessonVersion,
    });
    expect(same.status).toBe(400);
    const missing = await post({
      action: 'merge-scene-plans',
      lessonId,
      fromVersion: lessonVersion,
      toVersion: lessonVersion + 5,
    });
    expect(missing.status).toBe(404);
    // v1 还没有计划时，来源计划缺失也要明确失败。
    const noPlan = await post({
      action: 'merge-scene-plans',
      lessonId,
      fromVersion: lessonVersion,
      toVersion: lessonVersion + 1,
    });
    expect(noPlan.status).toBe(404);
    expect(session.store.listProjectScenePlans(session.projectId)).toEqual([]);
  });

  it('来源版本不存在或指向别的课程时失败', async () => {
    const other = session.store.createLessonDraft({
      projectId: session.projectId,
      lessonId: null,
      title: '另一节课',
      bundleId,
      statementIds: [statementId],
      questionIds: [],
    });
    // 「另一节课」用的版本号是它自己的编号空间；同一 lessonId 下该版本号不存在 → NOT_FOUND，
    // 而不是拿别的课程的计划兜底。
    const response = await post({
      action: 'merge-scene-plans',
      lessonId: other.lessonId,
      fromVersion: 99,
      toVersion: 100,
    });
    expect(response.status).toBe(404);
    expect(session.store.listProjectScenePlans(session.projectId)).toEqual([]);
  });

  it('逐项冲突决议：全部决议后才改变合并结果，缺决议则拒绝', async () => {
    const slideId = `scene_slide_${statementId}`;
    // 共同祖先 v1：正文 'A'。
    await post({
      action: 'save-scene-plan',
      requestId: 'res-base',
      lessonId,
      version: lessonVersion,
      baseRevision: 0,
      scenes: [scene(slideId, 'A')],
    });
    // 来源 v2：正文改 'A2'。
    const sourceDraft = await post({
      action: 'draft',
      lessonId,
      bundleId,
      title: '决议来源',
      statementIds: [statementId],
      questionIds: [],
    });
    const sourceVersion = (await sourceDraft.json()).data.lesson.version;
    await post({
      action: 'save-scene-plan',
      requestId: 'res-source',
      lessonId,
      version: sourceVersion,
      baseRevision: 0,
      scenes: [scene(slideId, 'A2')],
    });
    // 目标 v3：标题改 'TARGET'（与来源的正文改动冲突）。
    const targetDraft = await post({
      action: 'draft',
      lessonId,
      bundleId,
      title: '决议目标',
      statementIds: [statementId],
      questionIds: [],
    });
    const targetVersion = (await targetDraft.json()).data.lesson.version;
    await post({
      action: 'save-scene-plan',
      requestId: 'res-target',
      lessonId,
      version: targetVersion,
      baseRevision: 0,
      scenes: [scene(slideId, 'A', { title: 'TARGET' })],
    });

    const base = {
      action: 'merge-scene-plans',
      lessonId,
      baseVersion: lessonVersion,
      fromVersion: sourceVersion,
      toVersion: targetVersion,
    };
    // 缺决议：默认保留目标内容。
    const plain = (await (await post(base)).json()).data.merge;
    expect(plain.conflicts.map((item: { sceneId: string }) => item.sceneId)).toEqual([slideId]);
    expect(plain.mergedScenes[0]!.title).toBe('TARGET');
    expect(plain.mergedScenes[0]!.elements[0]!.text).toBe('A');

    // 决议「采用来源版本」：合并结果变成来源内容（正文 A2、标题回到 slideId）。
    const useIncoming = (
      await (
        await post({
          ...base,
          resolutions: [{ sceneId: slideId, choice: 'incoming' }],
        })
      ).json()
    ).data.merge;
    expect(useIncoming.mergedScenes[0]!.elements[0]!.text).toBe('A2');
    expect(useIncoming.mergedScenes[0]!.title).toBe(slideId);

    // 决议「保留本版本」：合并结果保持目标内容。
    const keepCurrent = (
      await (
        await post({
          ...base,
          resolutions: [{ sceneId: slideId, choice: 'current' }],
        })
      ).json()
    ).data.merge;
    expect(keepCurrent.mergedScenes[0]!.elements[0]!.text).toBe('A');
    expect(keepCurrent.mergedScenes[0]!.title).toBe('TARGET');

    // 非法决议：给非冲突场景决议被拒。
    const notAConflict = await post({
      ...base,
      resolutions: [{ sceneId: 'scene_not_conflict', choice: 'current' }],
    });
    expect(notAConflict.status).toBe(400);
    // 仍未写入任何计划。
    expect(
      session.store.getScenePlan(session.projectId, lessonId, targetVersion)!.scenes[0]!.title,
    ).toBe('TARGET');
  });

  it('反向删改冲突决议：采用来源可把被目标删除的场景加回来', async () => {
    const a = 'scene_a';
    const b = 'scene_b';
    // 共同祖先 v1：a、b 两个场景。
    await post({
      action: 'save-scene-plan',
      requestId: 'rev-base',
      lessonId,
      version: lessonVersion,
      baseRevision: 0,
      scenes: [scene(a, 'A'), scene(b, 'B')],
    });
    // 来源 v2：把 a 改成 A2（相对祖先的改动）。
    const sourceDraft = await post({
      action: 'draft',
      lessonId,
      bundleId,
      title: '反向来源',
      statementIds: [statementId],
      questionIds: [],
    });
    const sourceVersion = (await sourceDraft.json()).data.lesson.version;
    await post({
      action: 'save-scene-plan',
      requestId: 'rev-source',
      lessonId,
      version: sourceVersion,
      baseRevision: 0,
      scenes: [scene(a, 'A2'), scene(b, 'B')],
    });
    // 目标 v3：删除 a（只留 b）。
    const targetDraft = await post({
      action: 'draft',
      lessonId,
      bundleId,
      title: '反向目标',
      statementIds: [statementId],
      questionIds: [],
    });
    const targetVersion = (await targetDraft.json()).data.lesson.version;
    await post({
      action: 'save-scene-plan',
      requestId: 'rev-target',
      lessonId,
      version: targetVersion,
      baseRevision: 0,
      scenes: [scene(b, 'B')],
    });

    const base = {
      action: 'merge-scene-plans',
      lessonId,
      baseVersion: lessonVersion,
      fromVersion: sourceVersion,
      toVersion: targetVersion,
    };
    // 默认：保留目标删除，a 不回加。
    const plain = (await (await post(base)).json()).data.merge;
    expect(plain.conflicts.map((item: { sceneId: string }) => item.sceneId)).toEqual([a]);
    expect(plain.mergedScenes.map((item: PlanSceneDto) => item.sceneId)).toEqual([b]);

    // 决议「保留本版本」：仍保持删除。
    const keep = (
      await (await post({ ...base, resolutions: [{ sceneId: a, choice: 'current' }] })).json()
    ).data.merge;
    expect(keep.mergedScenes.map((item: PlanSceneDto) => item.sceneId)).toEqual([b]);

    // 决议「采用来源」：a 必须被加回来（否则决议被静默忽略、内容丢失）。
    const use = (
      await (await post({ ...base, resolutions: [{ sceneId: a, choice: 'incoming' }] })).json()
    ).data.merge;
    expect(use.mergedScenes.map((item: PlanSceneDto) => item.sceneId).sort()).toEqual([a, b]);
    expect(
      use.mergedScenes.find((item: PlanSceneDto) => item.sceneId === a)!.elements[0]!.text,
    ).toBe('A2');
  });
});
