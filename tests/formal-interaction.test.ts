import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formalInteractionCommandSchema,
  formalInteractionStateSchema,
  type FormalInteractionCommand,
} from '@sew/study-contracts';
import { createNodeSqliteDriver, projectPaths } from '@sew/study-storage';
import {
  formalInteractionDefinitionSessionId,
  formalInteractionHash,
  formalInteractionObservationSessionId,
  publicFormalInteractionDefinition,
} from '@sew/study-domain';
import {
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';
import {
  commandFormalInteraction,
  loadFormalInteraction,
} from '../apps/learning/lib/server/formal-interaction-service';
import {
  attachFormalLessonDocument,
  loadRenderableDocument,
} from '../apps/learning/lib/server/classroom-service';
import { readFormalInteractionDefinitions } from '../apps/learning/lib/server/formal-interaction-definition-store';
import { GET, POST } from '../apps/learning/app/api/study/formal-interactions/route';
import { POST as runtimePost } from '../apps/learning/app/api/maic/runtime/[...segments]/route';
import {
  InteractiveSceneView,
  interactiveSrcDoc,
} from '../apps/learning/components/openmaic-adaptation/InteractiveSceneView';
import { FormalInteractiveSceneView } from '../apps/learning/components/openmaic-adaptation/FormalInteractiveSceneView';
import {
  createOrderingItemsCache,
  restoreOrderingOrder,
} from '../apps/learning/lib/formal-ordering';

describe('正式参数/概念关系的来源冻结与本人提交', () => {
  let directory: string;
  let session: Session;
  let lessonId: string;
  let statementId: string;
  let materialId: string;
  const scope = () => ({ projectId: session.projectId, generation: session.generation });
  const headers = () => ({
    'x-sew-project-id': session.projectId,
    'x-sew-generation': String(session.generation),
    'content-type': 'application/json',
  });
  const review = (): FormalInteractionCommand => ({
    operation: 'review',
    scope: scope(),
    lessonId,
    lessonVersion: 1,
    semanticReviewed: true,
    reviewNote: '对照原文，函数公式及增函数与正斜率关系均获支持',
    definitions: [
      {
        id: 'parameter',
        kind: 'parameter',
        title: '参数实验',
        statementIds: [statementId],
        formula: 'linear',
        min: -3,
        max: 3,
        step: 0.1,
        intercept: 2,
        predictionRequired: true,
      },
      {
        id: 'relation',
        kind: 'concept_relation',
        title: '概念关系',
        statementIds: [statementId],
        nodes: [
          { id: 'n1', label: '正斜率' },
          { id: 'n2', label: '增函数' },
          { id: 'n3', label: '减函数' },
        ],
        edges: [{ id: 'e1', from: 'n1', to: 'n2', label: '对应' }],
      },
    ],
  });
  const publish = () => {
    commandFormalInteraction(session, review());
    session.store.reviewLesson({
      projectId: session.projectId,
      lessonId,
      version: 1,
      decision: 'approved',
      note: '逐项核对内容与互动',
    });
    session.store.publishLesson({ projectId: session.projectId, lessonId, version: 1 });
    return attachFormalLessonDocument(session, lessonId, 1);
  };
  const state = (kind: string) =>
    loadFormalInteraction(
      session,
      `stage_formal_${lessonId}_v1`,
      `scene_formal_interaction_${kind}`,
    );
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sew-formal-interaction-'));
    session = openProjectFromDisk(directory);
    const material = session.store.importMaterial({
      projectId: session.projectId,
      displayName: '来源.md',
      materialType: 'md',
      rawText:
        '函数 f(x)=ax+2；a 大于零时为增函数，小于零时为减函数。实验取 a 从 -3 到 3，步长 0.1。',
    });
    materialId = material.material.materialId;
    const proposed = session.store.createProposal({
      projectId: session.projectId,
      name: '线性函数',
      concept: 'f(x)=ax+2，a>0 为增函数',
      conditions: '实数域',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [{ materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'user',
    });
    const knowledgeId = session.store.applyReview({
      proposalId: proposed.proposalId,
      decision: 'approved',
      expectedRevision: proposed.revision,
      semanticReviewed: true,
    }).knowledgePoint!.knowledgeId;
    session.store.savePlanVersion(session.projectId, 1, 'confirmed', {
      payloadVersion: 1,
      goal: '学习线性函数',
      examDate: null,
      dailyMinutes: 30,
      tasks: [
        {
          knowledgeId,
          name: '线性函数',
          minutes: 30,
          acceptance: '',
          evidence: [{ materialId, segmentId: 'S001' }],
        },
      ],
      gaps: [],
      basis: '人工确认',
      confirmedTaskKnowledgeIds: [knowledgeId],
    });
    const bundle = session.store.buildLessonBundle(
      session.projectId,
      [
        {
          knowledgeId,
          text: '函数 f(x)=ax+2；正斜率对应增函数，负斜率对应减函数；a 从 -3 到 3，步长 0.1。',
          conditions: '实数域',
        },
      ],
      [],
    );
    statementId = bundle.bundle.statements[0]!.statementId;
    lessonId = session.store.createLessonDraft({
      projectId: session.projectId,
      lessonId: null,
      title: '线性函数',
      bundleId: bundle.bundleId,
      statementIds: [statementId],
      questionIds: [],
    }).lessonId;
  });
  afterEach(() => {
    closeProject();
    rmSync(directory, { recursive: true, force: true });
  });

  it('人工冻结后真实课堂装配两个正式互动，公共定义及DSL隐藏关系目标', () => {
    const info = publish();
    expect(info.scenes.filter((s) => s.sceneType === 'interactive')).toHaveLength(2);
    const relation = state('relation');
    expect(formalInteractionStateSchema.safeParse(relation).success).toBe(true);
    expect(
      relation.definition.kind === 'concept_relation' ? relation.definition.edges[0] : null,
    ).toEqual({ id: 'e1', from: 'n1', label: '对应' });
    const document = loadRenderableDocument(session, info.stageId)!;
    expect(JSON.stringify(document.document)).not.toContain('"to":"n2"');
    const element = InteractiveSceneView({
      stageId: info.stageId,
      sceneId: 'scene_formal_interaction_parameter',
      scope: scope(),
      content: { type: 'interactive', html: '' },
    });
    expect(element.type).toBe(FormalInteractiveSceneView);
  });
  it('草稿重开恢复、本人提交服务核验、同请求重试幂等且不同内容复用nonce拒绝', () => {
    publish();
    const initial = state('parameter');
    const draft: FormalInteractionCommand = {
      operation: 'draft',
      scope: scope(),
      binding: initial.binding,
      nonce: 'draft1',
      values: { kind: 'parameter', a: 2, x: 3, prediction: 8, explanation: '从图上观察' },
    };
    commandFormalInteraction(session, draft);
    closeProject();
    session = openProjectFromDisk(directory);
    expect(state('parameter').draft?.payload.values).toEqual(draft.values);
    const submit = { ...draft, scope: scope(), operation: 'submit' as const, nonce: 'submit1' };
    const saved = commandFormalInteraction(session, submit);
    expect('lastSubmission' in saved && saved.lastSubmission?.payload.result).toBe(8);
    const again = commandFormalInteraction(session, submit);
    expect('deduplicated' in again && again.deduplicated).toBe(true);
    expect(state('parameter').count).toBe(1);
    expect(() =>
      commandFormalInteraction(session, {
        ...submit,
        values: { kind: 'parameter', a: 1, x: 3, prediction: 3, explanation: '' },
      }),
    ).toThrow();
    expect(session.store.listAttempts()).toHaveLength(0);
  });
  it('关系由服务核验，错误关系后可新nonce重试，伪造correct及越界参数拒绝', () => {
    publish();
    const relation = state('relation');
    const command: FormalInteractionCommand = {
      operation: 'submit',
      scope: scope(),
      binding: relation.binding,
      nonce: 'wrong',
      values: { kind: 'concept_relation', edgeId: 'e1', to: 'n3', explanation: '' },
    };
    const wrong = commandFormalInteraction(session, command);
    expect('lastSubmission' in wrong && wrong.lastSubmission?.payload.result).toContain('不一致');
    const right = commandFormalInteraction(session, {
      ...command,
      nonce: 'right',
      values: { kind: 'concept_relation', edgeId: 'e1', to: 'n2', explanation: '' },
    });
    expect('count' in right && right.count).toBe(2);
    expect(formalInteractionCommandSchema.safeParse({ ...command, correct: true }).success).toBe(
      false,
    );
    expect(() =>
      commandFormalInteraction(session, {
        ...command,
        binding: state('parameter').binding,
        values: { kind: 'parameter', a: 3.1, x: 1, prediction: null, explanation: '' },
      }),
    ).toThrow();
    expect(() =>
      commandFormalInteraction(session, { ...command, binding: state('parameter').binding }),
    ).toThrow();
  });
  it('发布后不得添加定义、来源失效时读取与提交阻断、草稿绑定版本拒绝跨场景', () => {
    publish();
    const initial = state('parameter');
    expect(() => commandFormalInteraction(session, review())).toThrow();
    const submit: FormalInteractionCommand = {
      operation: 'submit',
      scope: scope(),
      binding: initial.binding,
      nonce: 'one',
      values: { kind: 'parameter', a: 1, x: 1, prediction: 3, explanation: '' },
    };
    expect(() =>
      commandFormalInteraction(session, {
        ...submit,
        binding: { ...initial.binding, definitionDigest: 'wrong' },
      }),
    ).toThrow();
    session.store.importMaterial({
      projectId: session.projectId,
      displayName: '来源.md',
      materialType: 'md',
      rawText: '更新为另一份材料，不再支持原文。',
    });
    expect(() => state('parameter')).toThrow();
    expect(() => commandFormalInteraction(session, submit)).toThrow();
  });
  it('HTTP明确读写正式定义与本人记录，输入信任边界严格', async () => {
    const reviewed = await POST(
      new Request('http://localhost/api/study/formal-interactions', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(review()),
      }),
    );
    expect(reviewed.status).toBe(200);
    session.store.reviewLesson({
      projectId: session.projectId,
      lessonId,
      version: 1,
      decision: 'approved',
      note: '核对',
    });
    session.store.publishLesson({ projectId: session.projectId, lessonId, version: 1 });
    const info = attachFormalLessonDocument(session, lessonId, 1);
    const read = await GET(
      new Request(
        `http://localhost/api/study/formal-interactions?stageId=${info.stageId}&sceneId=scene_formal_interaction_parameter`,
        { headers: headers() },
      ),
    );
    expect(read.status).toBe(200);
    const submitBody = {
      operation: 'submit',
      scope: scope(),
      binding: state('parameter').binding,
      nonce: 'http-submission',
      values: { kind: 'parameter', a: 2, x: 2, prediction: 6, explanation: 'HTTP本人提交' },
    };
    // 本版本要求先给预测：缺预测的提交必须在服务端被拒，而不是被当成「没填就算了」。
    const missingPrediction = await POST(
      new Request('http://localhost/api/study/formal-interactions', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          ...submitBody,
          nonce: 'no-prediction',
          values: { kind: 'parameter', a: 2, x: 2, prediction: null, explanation: '未填预测' },
        }),
      }),
    );
    expect(missingPrediction.status).toBe(400);
    const submitted = await POST(
      new Request('http://localhost/api/study/formal-interactions', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(submitBody),
      }),
    );
    expect(submitted.status).toBe(200);
    expect(state('parameter').lastSubmission?.payload.result).toBe(6);
    // 预测与实测一致由服务端判定并记录，但它不是掌握结论。
    expect(state('parameter').lastSubmission?.payload.predictionMatched).toBe(true);
    const retried = await POST(
      new Request('http://localhost/api/study/formal-interactions', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(submitBody),
      }),
    );
    const retryEnvelope: unknown = await retried.json();
    expect(retryEnvelope).toMatchObject({ ok: true, data: { count: 1, deduplicated: true } });
    const stale = await POST(
      new Request('http://localhost/api/study/formal-interactions', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          ...submitBody,
          scope: { ...scope(), generation: session.generation + 1 },
        }),
      }),
    );
    expect(stale.status).toBe(409);
    const privateDefinition = await GET(
      new Request(
        `http://localhost/api/study/formal-interactions?lessonId=${lessonId}&lessonVersion=1`,
        { headers: headers() },
      ),
    );
    expect(privateDefinition.status).toBe(200);
    const malformed = await POST(
      new Request('http://localhost/api/study/formal-interactions', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ ...review(), actorType: 'human_learner' }),
      }),
    );
    expect(malformed.status).toBe(400);
    const protectedSession = await runtimePost(
      new Request('http://localhost/api/maic/runtime/sessions', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          id: 'sew-formal-interaction-forged',
          kind: 'custom',
          stageId: info.stageId,
          status: 'active',
          learnerKey: session.learnerUid,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      }),
      { params: Promise.resolve({ segments: ['sessions'] }) },
    );
    expect(protectedSession.status).toBe(403);
  });
  it('预测字段：草稿可留空、提交必须给出、服务端判定是否一致，且定义冻结后不可改要求', () => {
    publish();
    const initial = state('parameter');
    // 草稿阶段允许先不写预测：预测是「提交前的独立判断」，不是草稿的必填项。
    commandFormalInteraction(session, {
      operation: 'draft',
      scope: scope(),
      binding: initial.binding,
      nonce: 'p-draft',
      values: { kind: 'parameter', a: 1, x: 2, prediction: null, explanation: '先记参数' },
    });
    expect(state('parameter').draft?.payload.values).toMatchObject({ prediction: null });
    // 本版本 predictionRequired=true：提交缺预测必须被拒。
    expect(() =>
      commandFormalInteraction(session, {
        operation: 'submit',
        scope: scope(),
        binding: initial.binding,
        nonce: 'p-missing',
        values: { kind: 'parameter', a: 1, x: 2, prediction: null, explanation: '未填预测' },
      }),
    ).toThrow();
    // 预测与实测一致 → 记录为 true；不一致 → false。两者都不更新掌握。
    const hit = commandFormalInteraction(session, {
      operation: 'submit',
      scope: scope(),
      binding: initial.binding,
      nonce: 'p-hit',
      values: { kind: 'parameter', a: 2, x: 3, prediction: 8, explanation: '先猜 8' },
    });
    expect('lastSubmission' in hit && hit.lastSubmission?.payload.predictionMatched).toBe(true);
    const miss = commandFormalInteraction(session, {
      operation: 'submit',
      scope: scope(),
      binding: initial.binding,
      nonce: 'p-miss',
      values: { kind: 'parameter', a: 2, x: 3, prediction: 99, explanation: '先猜 99' },
    });
    expect('lastSubmission' in miss && miss.lastSubmission?.payload.predictionMatched).toBe(false);
    expect(session.store.listAttempts()).toHaveLength(0);
    // 定义冻结后不能把「要求预测」改掉：同一版本再冻一份不同的定义会被拒。
    expect(() =>
      commandFormalInteraction(session, {
        operation: 'review',
        scope: scope(),
        lessonId,
        lessonVersion: 1,
        semanticReviewed: true,
        reviewNote: '试图取消预测要求',
        definitions: [
          {
            id: 'parameter',
            kind: 'parameter',
            title: '参数实验',
            statementIds: [statementId],
            formula: 'linear',
            min: -3,
            max: 3,
            step: 0.1,
            intercept: 2,
            predictionRequired: false,
          },
          {
            id: 'relation',
            kind: 'concept_relation',
            title: '概念关系',
            statementIds: [statementId],
            nodes: [
              { id: 'n1', label: '正斜率' },
              { id: 'n2', label: '增函数' },
              { id: 'n3', label: '减函数' },
            ],
            edges: [{ id: 'e1', from: 'n1', to: 'n2', label: '对应' }],
          },
        ],
      }),
    ).toThrow();
  });

  it('参数实验支持第二种公式（二次）：结果由服务端按冻结公式核验，公开投影保留公式种类', () => {
    // 只冻结一个二次参数实验，验证服务端按 formula 计算，而不是写死线性。
    commandFormalInteraction(session, {
      operation: 'review',
      scope: scope(),
      lessonId,
      lessonVersion: 1,
      semanticReviewed: true,
      reviewNote: '对照原文核对二次函数公式',
      definitions: [
        {
          id: 'quadratic',
          kind: 'parameter',
          title: '二次函数参数实验',
          statementIds: [statementId],
          formula: 'quadratic',
          min: -3,
          max: 3,
          step: 1,
          intercept: 1,
          predictionRequired: false,
        },
      ],
    });
    session.store.reviewLesson({
      projectId: session.projectId,
      lessonId,
      version: 1,
      decision: 'approved',
      note: '逐项核对',
    });
    session.store.publishLesson({ projectId: session.projectId, lessonId, version: 1 });
    const info = attachFormalLessonDocument(session, lessonId, 1);
    const quadratic = loadFormalInteraction(
      session,
      info.stageId,
      'scene_formal_interaction_quadratic',
    );
    expect(quadratic.definition.kind).toBe('parameter');
    expect(quadratic.definition.kind === 'parameter' ? quadratic.definition.formula : null).toBe(
      'quadratic',
    );
    // a=2, x=3, b=1 → 2*9+1 = 19，而不是线性 2*3+1=7。
    const hit = commandFormalInteraction(session, {
      operation: 'submit',
      scope: scope(),
      binding: quadratic.binding,
      nonce: 'quad-hit',
      values: { kind: 'parameter', a: 2, x: 3, prediction: 19, explanation: '先猜 19' },
    });
    expect('lastSubmission' in hit && hit.lastSubmission?.payload.result).toBe(19);
    expect('lastSubmission' in hit && hit.lastSubmission?.payload.predictionMatched).toBe(true);
    // 公开投影与共享快照都保留公式种类，另一方才能复现同一实验。
    expect(JSON.stringify(quadratic.definition)).toContain('"formula":"quadratic"');
    // 共享快照走同一映射，必须同样保留 formula，否则对方按线性复现会算错结果。
    const room = session.store.createLocalClassroomRoom(
      { projectId: session.projectId, lessonId, lessonVersion: 1, requestId: 'room-quadratic' },
      session.learnerUid,
      {
        interactionDefinitions:
          readFormalInteractionDefinitions(session, lessonId, 1)?.frozen ?? null,
      },
    );
    const snapshot = session.store.readClassroomRoomSnapshot(
      session.projectId,
      room.room.roomId,
      session.learnerUid,
    )!;
    const shared = snapshot.scenes.filter((scene) => scene.type === 'interactive');
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({
      type: 'interactive',
      interaction: { kind: 'parameter', formula: 'quadratic' },
    });
    expect(JSON.stringify(snapshot)).toContain('"formula":"quadratic"');
    expect(session.store.listAttempts()).toHaveLength(0);
  });

  it('房间公共投影只带公开互动定义：不含关系正确目标、评分规则与本人观察', () => {
    publish();
    // 本人先做一次互动并提交，制造「私人观察」。
    const initial = state('parameter');
    commandFormalInteraction(session, {
      operation: 'submit',
      scope: scope(),
      binding: initial.binding,
      nonce: 'private-observation',
      values: { kind: 'parameter', a: 2, x: 3, prediction: 8, explanation: '本人私有解释内容' },
    });
    // 房间创建由应用层传入已完整复验的冻结互动定义（与 HTTP 路由同一条路径）。
    const room = session.store.createLocalClassroomRoom(
      { projectId: session.projectId, lessonId, lessonVersion: 1, requestId: 'room-share' },
      session.learnerUid,
      {
        interactionDefinitions:
          readFormalInteractionDefinitions(session, lessonId, 1)?.frozen ?? null,
      },
    );
    const snapshot = session.store.readClassroomRoomSnapshot(
      session.projectId,
      room.room.roomId,
      session.learnerUid,
    )!;
    const interactive = snapshot.scenes.filter((scene) => scene.type === 'interactive');
    expect(interactive).toHaveLength(2);
    const parameter = interactive.find(
      (scene) => scene.type === 'interactive' && scene.interaction.kind === 'parameter',
    );
    expect(parameter).toMatchObject({
      type: 'interactive',
      interaction: {
        kind: 'parameter',
        min: -3,
        max: 3,
        step: 0.1,
        intercept: 2,
        predictionRequired: true,
      },
    });
    const relation = interactive.find(
      (scene) => scene.type === 'interactive' && scene.interaction.kind === 'concept_relation',
    );
    expect(
      relation &&
        relation.type === 'interactive' &&
        relation.interaction.kind === 'concept_relation'
        ? relation.interaction.edges
        : null,
    ).toEqual([{ id: 'e1', from: 'n1', label: '对应' }]);
    const json = JSON.stringify(snapshot);
    // 正确目标、评分结论、本人解释与场景自带 HTML 都不进共享快照。
    expect(json).not.toContain('"to":"n2"');
    expect(json).not.toContain('关系核验一致');
    expect(json).not.toContain('本人私有解释内容');
    expect(json).not.toContain('<!doctype html>');
  });

  it('定义摘要绑定的是原始存储内容：以后给 schema 加默认值也不会让历史观察分区漂移', () => {
    publish();
    const initial = state('parameter');
    commandFormalInteraction(session, {
      operation: 'submit',
      scope: scope(),
      binding: initial.binding,
      nonce: 'digest-obs',
      values: { kind: 'parameter', a: 2, x: 3, prediction: 8, explanation: '记录摘要' },
    });
    const definitionSession = formalInteractionDefinitionSessionId(lessonId, 1);
    const db = createNodeSqliteDriver().open(projectPaths(directory).databaseFile);
    const definitionRaw = (
      db
        .prepare(
          'SELECT payload_json FROM classroom_runtime_records WHERE session_id = ? ORDER BY seq LIMIT 1',
        )
        .get(definitionSession) as { payload_json: string }
    ).payload_json;
    db.close();
    // binding.definitionDigest 必须等于「存下来的那份 JSON」的哈希。
    // 若它等于 schema 解析结果的哈希，将来任何一次加字段都会让这个摘要变化，
    // 从而使所有历史互动观察都指向一个读不到的分区。
    expect(initial.binding.definitionDigest).toBe(formalInteractionHash(JSON.parse(definitionRaw)));
  });

  it('升级前写入、缺 prediction/predictionMatched 的旧观察记录仍可读', () => {
    publish();
    const initial = state('parameter');
    commandFormalInteraction(session, {
      operation: 'submit',
      scope: scope(),
      binding: initial.binding,
      nonce: 'legacy-obs',
      values: { kind: 'parameter', a: 2, x: 3, prediction: 8, explanation: '升级前提交' },
    });
    const observationSession = formalInteractionObservationSessionId(
      session.projectId,
      session.learnerUid,
      initial.binding,
    );
    // 旧代码写入时，payload 与 record_id 都基于「没有这两个字段」的同一份对象；
    // 因此要同时改写两者，而不是只改 payload（那会造出现实中不存在的 id/payload 不一致）。
    const db = createNodeSqliteDriver().open(projectPaths(directory).databaseFile);
    const rows = db
      .prepare(
        'SELECT seq, payload_json FROM classroom_runtime_records WHERE session_id = ? ORDER BY seq',
      )
      .all(observationSession) as Array<{ seq: number; payload_json: string }>;
    expect(rows.length).toBe(1);
    for (const row of rows) {
      const copy = JSON.parse(row.payload_json) as Record<string, unknown>;
      delete copy['predictionMatched'];
      const values = { ...(copy['values'] as Record<string, unknown>) };
      delete values['prediction'];
      copy['values'] = values;
      const stripped = JSON.stringify(copy);
      db.prepare(
        'UPDATE classroom_runtime_records SET payload_json = ?, record_id = ? WHERE session_id = ? AND seq = ?',
      ).run(
        stripped,
        `formal-observation-${formalInteractionHash(JSON.parse(stripped))}`,
        observationSession,
        row.seq,
      );
    }
    db.close();
    closeProject();
    session = openProjectFromDisk(directory);

    // 旧记录仍能读回，且补齐后的语义如实：升级前没有预测字段 → null，实测结果照旧读回。
    const restored = state('parameter');
    expect(restored.lastSubmission?.payload.values).toMatchObject({ a: 2, x: 3, prediction: null });
    expect(restored.lastSubmission?.payload.predictionMatched).toBeNull();
    expect(restored.lastSubmission?.payload.result).toBe(8);
    expect(restored.count).toBe(1);
  });

  it('iframe桥为组件观察注入实例nonce且沙箱消息不作为服务判定', () => {
    expect(
      interactiveSrcDoc(
        "<script>parent.postMessage({type: 'widget-observation', a:1},'*')</script>",
        'nonce-123',
      ),
    ).toContain('instanceId: "nonce-123"');
  });

  it('排序互动：正确顺序只在服务端，公开投影不含正确顺序，本人排序由服务端核验', () => {
    const author = createOrderingItemsCache();
    const authored = author('正斜率\n增函数');
    const correctOrder = authored.correctOrder;
    expect(authored.items.every((item) => /^item_[0-9a-f-]{36}$/.test(item.id))).toBe(true);
    const orderingReview: FormalInteractionCommand = {
      operation: 'review',
      scope: scope(),
      lessonId,
      lessonVersion: 1,
      semanticReviewed: true,
      reviewNote: '对照原文核对排序依据',
      definitions: [
        {
          id: 'ordering',
          kind: 'ordering',
          title: '概念排序',
          statementIds: [statementId],
          ...authored,
        },
      ],
    };
    commandFormalInteraction(session, orderingReview);
    // 冻结成功而响应丢失：作者重试同一输入，真实服务接受完全相同的定义。
    const replay = commandFormalInteraction(session, {
      ...orderingReview,
      definitions: [
        {
          ...orderingReview.definitions[0]!,
          kind: 'ordering',
          ...author('正斜率\n增函数'),
        },
      ],
    });
    expect('definitions' in replay && replay.definitions[0]).toEqual(orderingReview.definitions[0]);
    session.store.reviewLesson({
      projectId: session.projectId,
      lessonId,
      version: 1,
      decision: 'approved',
      note: '逐项核对',
    });
    session.store.publishLesson({ projectId: session.projectId, lessonId, version: 1 });
    const info = attachFormalLessonDocument(session, lessonId, 1);
    const state = loadFormalInteraction(session, info.stageId, 'scene_formal_interaction_ordering');
    expect(formalInteractionStateSchema.safeParse(state).success).toBe(true);
    // 公开投影只给候选条目，不带正确顺序。
    expect(state.definition.kind).toBe('ordering');
    expect(JSON.stringify(state.definition)).not.toContain('correctOrder');
    const frozenDefinition = readFormalInteractionDefinitions(session, lessonId, 1)!.frozen
      .definitions[0]!;
    if (frozenDefinition.kind !== 'ordering') throw new Error('expected ordering');
    // 公开候选呈现不依赖正确答案；即使答案改变，公开排列仍保持相同。
    expect(
      publicFormalInteractionDefinition({
        ...frozenDefinition,
        correctOrder: [...correctOrder].reverse(),
      }),
    ).toEqual(publicFormalInteractionDefinition(frozenDefinition));
    // 公开文档里也不能出现正确顺序。
    const document = loadRenderableDocument(session, info.stageId)!;
    expect(JSON.stringify(document.document)).not.toContain('correctOrder');

    const binding = state.binding;
    // 初次展示没有本人答案；不能把默认候选排列直接算作已完成排序。
    const untouched = restoreOrderingOrder(null);
    expect(untouched).toEqual([]);
    expect(() =>
      commandFormalInteraction(session, {
        operation: 'submit',
        scope: scope(),
        binding,
        nonce: 'ord-untouched',
        values: { kind: 'ordering', order: untouched, explanation: '' },
      }),
    ).toThrow();
    // 错误顺序：服务端核验为不一致。
    const wrong = commandFormalInteraction(session, {
      operation: 'submit',
      scope: scope(),
      binding,
      nonce: 'ord-wrong',
      values: { kind: 'ordering', order: [...correctOrder].reverse(), explanation: '' },
    });
    expect('lastSubmission' in wrong && wrong.lastSubmission?.payload.result).toContain('不一致');
    // 正确顺序：核验一致。
    const right = commandFormalInteraction(session, {
      operation: 'submit',
      scope: scope(),
      binding,
      nonce: 'ord-right',
      values: { kind: 'ordering', order: correctOrder, explanation: '先有斜率，再有单调性' },
    });
    expect('lastSubmission' in right && right.lastSubmission?.payload.result).toContain('一致');
    const restored = loadFormalInteraction(
      session,
      info.stageId,
      'scene_formal_interaction_ordering',
    );
    const values = restored.lastSubmission?.payload.values;
    expect(restoreOrderingOrder(values?.kind === 'ordering' ? values.order : null)).toEqual(
      correctOrder,
    );
    // 排序不一致的提交不产生判分或掌握记录。
    expect(session.store.listAttempts()).toHaveLength(0);
    // 非法排列（缺项/重复）被拒。
    expect(() =>
      commandFormalInteraction(session, {
        operation: 'submit',
        scope: scope(),
        binding,
        nonce: 'ord-invalid',
        values: { kind: 'ordering', order: correctOrder.slice(0, 1), explanation: '' },
      }),
    ).toThrow();

    // 房间公共投影也只带候选条目，不含正确顺序。
    const room = session.store.createLocalClassroomRoom(
      { projectId: session.projectId, lessonId, lessonVersion: 1, requestId: 'room-ordering' },
      session.learnerUid,
      {
        interactionDefinitions:
          readFormalInteractionDefinitions(session, lessonId, 1)?.frozen ?? null,
      },
    );
    const snapshot = session.store.readClassroomRoomSnapshot(
      session.projectId,
      room.room.roomId,
      session.learnerUid,
    )!;
    const projected = snapshot.scenes.filter((scene) => scene.type === 'interactive');
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      type: 'interactive',
      interaction: {
        kind: 'ordering',
        items: state.definition.kind === 'ordering' ? state.definition.items : [],
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('correctOrder');
  });

  it.each(['wrong-match', 'missing-required'] as const)(
    '恢复复核预测记录 %s，即使重算记录摘要也不能绕过服务核验',
    (reason) => {
      publish();
      const initial = state('parameter');
      commandFormalInteraction(session, {
        operation: 'submit',
        scope: scope(),
        binding: initial.binding,
        nonce: 'prediction-tamper',
        values: { kind: 'parameter', a: 2, x: 3, prediction: 8, explanation: '本人预测' },
      });
      const observationSession = formalInteractionObservationSessionId(
        session.projectId,
        session.learnerUid,
        initial.binding,
      );
      const db = createNodeSqliteDriver().open(projectPaths(directory).databaseFile);
      const row = db
        .prepare('SELECT payload_json FROM classroom_runtime_records WHERE session_id = ?')
        .get(observationSession) as { payload_json: string };
      const payload = JSON.parse(row.payload_json);
      if (reason === 'wrong-match') payload.predictionMatched = false;
      else {
        payload.values.prediction = null;
        payload.predictionMatched = null;
      }
      db.prepare(
        'UPDATE classroom_runtime_records SET payload_json = ?, record_id = ? WHERE session_id = ?',
      ).run(
        JSON.stringify(payload),
        `formal-observation-${formalInteractionHash(payload)}`,
        observationSession,
      );
      db.close();
      expect(() => state('parameter')).toThrow();
      expect(session.store.listAttempts()).toEqual([]);
    },
  );
});
