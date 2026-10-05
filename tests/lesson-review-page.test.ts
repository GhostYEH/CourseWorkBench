import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { newId, type PlanPayloadDto } from '@sew/study-contracts';
import { StudyStore, ensureProjectLayout } from '@sew/study-storage';

const require = createRequire(import.meta.url);
const { validateBuildInputs } = require('../scripts/freshness.mjs') as {
  validateBuildInputs: (root: string, buildDirectory: string) => unknown;
};

/**
 * 课程审核界面的生产渲染核对。
 *
 * 这里验证的是「页面上出现的按钮与提示确实来自服务端状态」：未审核的草案只给审核按钮
 * 并写明需先审核，审核通过后发布入口才出现，撤回后状态与原因都可读。用真实构建产物与
 * 真实 SSR 响应，不用组件内假数据；但它仍不是浏览器点击记录（见待办 UI-01）。
 */

const seedProject = (directory: string): { projectId: string; lessonId: string; version: number; bundleId: string; statementId: string } => {
  const paths = ensureProjectLayout(directory);
  const projectId = newId<'project'>('proj');
  // 服务按 project.json 认领项目身份；缺这份清单时会另起一个新 projectId，
  // 课程与计划行就落在另一个项目名下，页面自然读不到。
  writeFileSync(paths.manifestFile, JSON.stringify({
    formatVersion: 1,
    projectId,
    displayName: '课程审核界面验收项目',
    createdAt: new Date().toISOString(),
  }), 'utf8');
  const store = StudyStore.open({ file: paths.databaseFile });
  try {
    store.createProject({ projectId, displayName: '课程审核界面验收项目', subject: '数学', dailyMinutes: 60 });
    const material = store.importMaterial({
      projectId,
      displayName: '考纲.md',
      materialType: 'md',
      rawText: '本章要求理解增函数的定义。\n\n第二条范围说明。',
    });
    const proposal = store.createProposal({
      projectId,
      name: '增函数定义',
      concept: '区间内任取 x1 < x2 都有 f(x1) < f(x2)',
      conditions: '同一区间 D 内',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [{ materialId: material.material.materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }],
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
    store.savePlanVersion(projectId, 1, 'confirmed', {
      payloadVersion: 1,
      goal: '掌握本章',
      examDate: null,
      dailyMinutes: 60,
      tasks: [{
        knowledgeId, name: '增函数定义', minutes: 30, acceptance: '',
        evidence: [{ materialId: material.material.materialId, segmentId: 'S001' }],
      }],
      gaps: [],
      basis: '界面回归夹具',
      confirmedTaskKnowledgeIds: [knowledgeId],
    } satisfies PlanPayloadDto);
    const bundle = store.buildLessonBundle(projectId, [{ knowledgeId, text: '增函数的定义', conditions: '同一区间 D 内' }], []);
    const lesson = store.createLessonDraft({
      projectId,
      lessonId: null,
      title: '函数单调性（第 1 课时）',
      bundleId: bundle.bundleId,
      statementIds: bundle.bundle.statements.map((row) => row.statementId),
      questionIds: [],
    });
    return { projectId, lessonId: lesson.lessonId, version: lesson.version, bundleId: bundle.bundleId, statementId: bundle.bundle.statements[0]!.statementId };
  } finally {
    store.close();
  }
};

/** React SSR 会在文本与表达式之间插入注释分隔，去掉后才能按人读到的顺序断言。 */
const renderedText = (html: string): string => html.replace(/<!--\s*-->/g, '');

const hasProductionBuild = existsSync(resolve('apps/learning/.next/BUILD_ID'));
const productionDescribe = hasProductionBuild ? describe.sequential : describe.skip;

productionDescribe('课程审核界面（生产构建 SSR）', () => {
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let origin = '';
  let sessionToken = '';
  let controlToken = '';
  let tempRoot = '';
  let projectDir = '';
  let seeded = { projectId: '', lessonId: '', version: 1, bundleId: '', statementId: '' };
  let generation = 0;

  const request = (path: string, options: RequestInit = {}, headers: Record<string, string> = {}) =>
    fetch(`${origin}${path}`, { ...options, headers: { ...headers, ...(options.headers as Record<string, string> | undefined) } });

  const lessonHtml = async (): Promise<string> => {
    const page = await request('/workbench/lessons', {}, { 'x-sew-session': sessionToken });
    expect(page.status).toBe(200);
    return renderedText(await page.text());
  };

  const command = (body: Record<string, unknown>) => request('/api/study/lessons', {
    method: 'POST',
    body: JSON.stringify({ scope: { projectId: seeded.projectId, generation }, ...body }),
  }, { origin, 'content-type': 'application/json', 'x-sew-session': sessionToken });

  beforeAll(async () => {
    validateBuildInputs(resolve('.'), resolve('apps/learning/.next'));
    tempRoot = mkdtempSync(join(tmpdir(), 'sew-lesson-page-'));
    projectDir = join(tempRoot, 'project');
    mkdirSync(projectDir);
    seeded = seedProject(projectDir);

    child = spawn(process.execPath, [resolve('apps/learning/server.mjs'), '--project-root', ''], {
      cwd: resolve('apps/learning'),
      env: { ...process.env, NODE_ENV: 'production', SEW_DEV: '0', SEW_PROJECT_ROOT: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = await new Promise<{ origin: string; sessionToken: string; controlToken: string }>((resolveReady, rejectReady) => {
      let buffer = '';
      const timer = setTimeout(() => rejectReady(new Error('学习服务未在 30 秒内就绪')), 30_000);
      child!.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          try {
            const value = JSON.parse(line) as { type: string; origin?: string; sessionToken?: string; controlToken?: string; message?: string };
            if (value.type === 'ready') {
              clearTimeout(timer);
              resolveReady({ origin: value.origin!, sessionToken: value.sessionToken!, controlToken: value.controlToken! });
            } else if (value.type === 'error') {
              clearTimeout(timer);
              rejectReady(new Error(value.message ?? '服务启动失败'));
            }
          } catch { /* Next 可能输出非 JSON 的启动日志 */ }
        }
      });
      child!.once('exit', (code) => {
        clearTimeout(timer);
        rejectReady(new Error(`学习服务提前退出（code ${code}）`));
      });
    });
    origin = ready.origin;
    sessionToken = ready.sessionToken;
    controlToken = ready.controlToken;

    const opened = await request('/internal/project', {
      method: 'POST',
      body: JSON.stringify({ action: 'open', path: projectDir }),
    }, { origin, 'content-type': 'application/json', 'x-sew-session': sessionToken, 'x-sew-control': controlToken });
    expect(opened.status).toBe(200);
    const payload = await opened.json() as { data: { session: { generation: number } } };
    generation = payload.data.session.generation;
  }, 40_000);

  afterAll(async () => {
    if (origin && sessionToken && controlToken && child && child.exitCode === null) {
      await request('/internal/shutdown', {
        method: 'POST',
        headers: { origin, 'x-sew-session': sessionToken, 'x-sew-control': controlToken },
      }).catch(() => undefined);
      await Promise.race([
        new Promise<void>((resolveDone) => child!.once('exit', () => resolveDone())),
        new Promise<void>((resolveDone) => setTimeout(resolveDone, 4_000)),
      ]);
      if (child.exitCode === null) child.kill();
    } else if (child && child.exitCode === null) {
      child.kill();
    }
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('未审核的草案只给出审核入口，并说明发布还缺什么', async () => {
    const study = await request('/workbench/study', {}, { 'x-sew-session': sessionToken });
    const studyHtml = await study.text();
    expect(study.status).toBe(200);
    expect(studyHtml).toContain('href="/workbench/lessons"');
    expect(studyHtml).toContain('href="/classroom/lesson-demo-monotonicity-1"');
    expect(studyHtml).not.toContain('/classroom/lesson-001');
    expect(studyHtml).toContain('课程与讲解');
    expect(studyHtml).toContain('固定课堂演示');
    const html = await lessonHtml();
    expect(html).toContain('课程版本');
    expect(html).toContain('未审核');
    expect(html).toContain('审核通过');
    expect(html).toContain('退回');
    expect(html).toContain('需先审核通过才能发布');
    expect(html).not.toContain('发布 v1');
    // 逐场景改写在页面上可达：它以本版本为基线派生新草案，而不是就地改写已发布内容。
    expect(html).toContain('逐场景改写（派生新草案版本）');
    expect(html).toContain('派生新草案');
    // 陈述正文改写入口可达：候选先落待核区，人工通过后才派生新版本；未配置模型时说明原因。
    expect(html).toContain('陈述正文改写');
    expect(html).toContain('生成改写候选');
    // 场景计划编辑器与完整课件生成入口可达：计划可编辑（增删/排序/复制/撤销恢复），
    // 完整课件候选先落待核区、人工通过才写入计划。
    expect(html).toContain('场景计划编辑器');
    expect(html).toContain('完整课件生成');
    expect(html).toContain('生成完整课件候选');
    expect(html).toContain('撤销');
    expect(html).toContain('新增幻灯片');
    // 生成入口按事实提示：本环境没有配置模型连接，按钮必须说明原因而不是假装可用。
    expect(html).toContain('课程草案生成');
    expect(html).toContain('尚未配置模型连接');
    // 课堂讲解用途在界面上可达，但必须选出已发布课程；此时还没有已发布版本。
    expect(html).toContain('调用用途');
    expect(html).toContain('课堂讲解/提示（须已发布并审核）');
  });

  it('审核通过后发布入口出现，发布后状态与撤回原因都可在页面核对', async () => {
    const reviewed = await command({
      action: 'review', lessonId: seeded.lessonId, version: seeded.version, decision: 'approved', note: '按原文核对',
    });
    expect(reviewed.status).toBe(200);
    expect(((await reviewed.json()) as { data: { review: { decision: string } } }).data.review.decision).toBe('approved');
    const afterReview = await lessonHtml();
    expect(afterReview).toContain('已通过');
    expect(afterReview).toContain('发布 v1');
    expect(afterReview).not.toContain('需先审核通过才能发布');

    const published = await command({ action: 'publish', lessonId: seeded.lessonId, version: seeded.version });
    expect(published.status).toBe(200);
    const afterPublish = await lessonHtml();
    expect(afterPublish).toContain('已发布');
    expect(afterPublish).toContain('撤回');

    const withdrawn = await command({ action: 'withdraw', lessonId: seeded.lessonId, reason: '来源待更新，先停用' });
    expect(withdrawn.status).toBe(200);
    const afterWithdraw = await lessonHtml();
    expect(afterWithdraw).toContain('已撤回');
    expect(JSON.stringify(await (await request('/api/study/lessons', {}, { 'x-sew-session': sessionToken })).json()))
      .toContain('来源待更新，先停用');
  });

  it('页面读取不产生任何课程写入', async () => {
    const before = JSON.stringify(await (await request('/api/study/lessons', {}, { 'x-sew-session': sessionToken })).json());
    await lessonHtml();
    await lessonHtml();
    const after = JSON.stringify(await (await request('/api/study/lessons', {}, { 'x-sew-session': sessionToken })).json());
    expect(after).toBe(before);
  });

  it('旧代次请求被拒绝，不能按已切换的项目改写课程', async () => {
    const wrong = await request('/api/study/lessons', {
      method: 'POST',
      body: JSON.stringify({ scope: { projectId: seeded.projectId, generation: generation + 7 }, action: 'publish', lessonId: seeded.lessonId, version: seeded.version }),
    }, { origin, 'content-type': 'application/json', 'x-sew-session': sessionToken });
    expect(wrong.status).toBe(409);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe('PROJECT_GENERATION_STALE');
    // 被拒绝的请求没有改变状态：课程仍是已撤回。
    expect(await lessonHtml()).toContain('已撤回');
  });

  it('教学闭环走真实 HTTP：待核卡片不播、审核后按序播、交还本人期间停播', async () => {
    const classCommand = async (body: Record<string, unknown>) => {
      const response = await request('/api/study/classroom', {
        method: 'POST',
        body: JSON.stringify({ scope: { projectId: seeded.projectId, generation }, ...body }),
      }, { origin, 'content-type': 'application/json', 'x-sew-session': sessionToken });
      return {
        status: response.status,
        json: (await response.json()) as {
          ok: boolean;
          data?: Record<string, unknown>;
          error?: { code: string; message: string };
        },
      };
    };
    const cardOf = (json: { data?: Record<string, unknown> }) =>
      (json.data as { card: { explanationId: string } | null }).card;
    const sessionOf = (json: { data?: Record<string, unknown> }) =>
      (json.data as { session: { sessionId: string; status: string; roundIndex: number } }).session;

    // 重新发布一个可用版本（上一用例已把 v1 撤回）。
    const draft = await command({
      action: 'draft', lessonId: seeded.lessonId, bundleId: seeded.bundleId, title: '函数单调性（重备课时）',
      statementIds: [seeded.statementId], questionIds: [],
    });
    expect(draft.status).toBe(200);
    const draftVersion = ((await draft.json()) as { data: { lesson: { version: number } } }).data.lesson.version;
    expect((await command({ action: 'review', lessonId: seeded.lessonId, version: draftVersion, decision: 'approved', note: '重备核对' })).status).toBe(200);
    expect((await command({ action: 'publish', lessonId: seeded.lessonId, version: draftVersion })).status).toBe(200);

    const html = await lessonHtml();
    expect(html).toContain('教学准备');
    expect(html).toContain('课堂面板');
    expect(html).toContain('当前没有进行中的课堂会话');

    const created = await classCommand({
      action: 'create-card', lessonId: seeded.lessonId, lessonVersion: draftVersion, sceneId: 'scene-1',
      kind: 'explain', text: '先看图像上升趋势，再回到定义里的任意 x1 小于 x2', statementIds: [seeded.statementId],
    });
    expect(created.status).toBe(200);
    const explanationId = cardOf(created.json)!.explanationId;

    const invalidOpen = await classCommand({ action: 'open', lessonId: seeded.lessonId, stageId: null, sceneId: '' });
    expect(invalidOpen.status).toBe(400);
    expect(invalidOpen.json.error?.code).toBe('INVALID_ARGUMENT');
    const unopened = await request('/api/study/classroom', {}, { 'x-sew-session': sessionToken });
    expect(((await unopened.json()) as { data: { state: unknown } }).data.state).toBeNull();

    const opened = await classCommand({ action: 'open', lessonId: seeded.lessonId, stageId: null, sceneId: 'scene-1' });
    expect(opened.status).toBe(200);
    const sessionId = sessionOf(opened.json).sessionId;

    // 待核卡片不进入播放队列。
    const beforeReview = await classCommand({ action: 'play-next', sessionId, requestId: newId('play') });
    expect(beforeReview.status).toBe(200);
    expect(beforeReview.json.data && cardOf(beforeReview.json)).toBeNull();

    expect((await classCommand({ action: 'review-card', explanationId, decision: 'approved', note: '与定义一致' })).status).toBe(200);
    const requestId = newId('play');
    const played = await classCommand({ action: 'play-next', sessionId, requestId });
    expect(cardOf(played.json)!.explanationId).toBe(explanationId);
    // 队列已空：再次播放不会二次播报。
    const replay = await classCommand({ action: 'play-next', sessionId, requestId });
    expect(cardOf(replay.json)?.explanationId).toBe(explanationId);
    expect(replay.json.data).toMatchObject({ deduplicated: true });

    const handback = await classCommand({ action: 'handback', sessionId, reason: '请本人完成第 3 题' });
    expect(sessionOf(handback.json).status).toBe('awaiting_learner');
    const blocked = await classCommand({ action: 'play-next', sessionId, requestId: newId('play') });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error?.code).toBe('CLASSROOM_AWAITING_LEARNER');

    const answered = await classCommand({ action: 'learner-answered', sessionId });
    expect(sessionOf(answered.json).roundIndex).toBe(2);
    const sceneRequestId = newId('scene');
    const advanced = await classCommand({ action: 'advance-scene', sessionId, sceneId: 'scene-2', requestId: sceneRequestId });
    expect(advanced.status).toBe(200);
    expect(advanced.json.data).toMatchObject({ deduplicated: false, session: { currentSceneId: 'scene-2', roundIndex: 3 } });
    const retried = await classCommand({ action: 'advance-scene', sessionId, sceneId: 'scene-2', requestId: sceneRequestId });
    expect(retried.json.data).toMatchObject({ deduplicated: true, session: { currentSceneId: 'scene-2', roundIndex: 3 } });
    const returned = await classCommand({ action: 'advance-scene', sessionId, sceneId: 'scene-1', requestId: newId('scene') });
    expect(returned.json.data).toMatchObject({ session: { currentSceneId: 'scene-1', roundIndex: 4 } });
    const revisited = await classCommand({ action: 'advance-scene', sessionId, sceneId: 'scene-2', requestId: newId('scene') });
    expect(revisited.json.data).toMatchObject({ session: { currentSceneId: 'scene-2', roundIndex: 5 } });
    const closed = await classCommand({ action: 'close', sessionId, status: 'completed', reason: '本节结束' });
    expect(sessionOf(closed.json).status).toBe('completed');

    const state = await request('/api/study/classroom', {}, { 'x-sew-session': sessionToken });
    expect(((await state.json()) as { data: { state: unknown } }).data.state).toBeNull();
  });

  it('多个已发布课时共用一个课堂面板，活动课时撤回后仍可结束会话', async () => {
    const draft = await command({
      action: 'draft', lessonId: null, bundleId: seeded.bundleId, title: '独立的第二课时',
      statementIds: [seeded.statementId], questionIds: [],
    });
    expect(draft.status).toBe(200);
    const lesson = ((await draft.json()) as { data: { lesson: { lessonId: string; version: number } } }).data.lesson;
    expect((await command({ action: 'review', lessonId: lesson.lessonId, version: lesson.version, decision: 'approved', note: '' })).status).toBe(200);
    expect((await command({ action: 'publish', lessonId: lesson.lessonId, version: lesson.version })).status).toBe(200);
    const prepared = await lessonHtml();
    expect(prepared.match(/<h2>课堂面板<\/h2>/g)).toHaveLength(1);
    expect(prepared.match(/<h2>教学准备/g)).toHaveLength(2);
    expect(prepared).toContain(`value="${lesson.lessonId}:v${lesson.version}"`);
    const classCommand = (body: Record<string, unknown>) => request('/api/study/classroom', {
      method: 'POST', body: JSON.stringify({ scope: { projectId: seeded.projectId, generation }, ...body }),
    }, { origin, 'content-type': 'application/json', 'x-sew-session': sessionToken });
    const opened = await classCommand({ action: 'open', lessonId: lesson.lessonId, stageId: null, sceneId: 'scene-2' });
    expect(opened.status).toBe(200);
    const sessionId = ((await opened.json()) as { data: { session: { sessionId: string } } }).data.session.sessionId;
    const active = await lessonHtml();
    expect(active.match(/<h2>课堂面板<\/h2>/g)).toHaveLength(1);
    expect(active).toContain(`<option value="${lesson.lessonId}:v${lesson.version}" selected="">`);
    expect((await command({ action: 'withdraw', lessonId: lesson.lessonId, reason: '停用第二课时' })).status).toBe(200);
    const withdrawn = await lessonHtml();
    expect(withdrawn.match(/<h2>课堂面板<\/h2>/g)).toHaveLength(1);
    expect(withdrawn).toContain(`<option value="${lesson.lessonId}:v${lesson.version}" selected="">`);
    expect((await classCommand({ action: 'close', sessionId, status: 'cancelled', reason: '已撤回课程' })).status).toBe(200);
  });
});
