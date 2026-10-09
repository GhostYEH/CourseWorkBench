import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { StudyError, type PlanPayloadDto } from '@sew/study-contracts';
import type {
  DirectorCommandDto,
  DirectorStateDto,
} from '../packages/study-contracts/src/director';
import {
  directorCandidateDigest,
  directorCurrentStep,
} from '../packages/study-domain/src/director';
import { commandDirector, readDirector } from '../apps/learning/lib/server/director-service';
import {
  openProjectFromDisk,
  closeProject,
  type Session,
} from '../apps/learning/lib/server/service';
import { attachFormalLessonDocument } from '../apps/learning/lib/server/classroom-service';
import { createModelConnectionRuntime } from '../apps/learning/lib/server/model-connection';
import { modelConnection } from '../apps/learning/lib/server/model-connection';
import { GET, POST } from '../apps/learning/app/api/study/director/route';
import { directorViewSchema } from '../packages/study-contracts/src/director';
import { DirectorPanel } from '../apps/learning/components/director-panel';

const require = createRequire(new URL('../apps/learning/package.json', import.meta.url));
const { createElement } = require('react') as {
  createElement: (component: unknown, props: unknown) => unknown;
};
const { renderToStaticMarkup } = require('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

describe('reviewed single-step classroom Director', () => {
  let root: string;
  let session: Session;
  let sessionId: string;
  let lessonId: string;
  let count: number;
  let connection: ReturnType<typeof createModelConnectionRuntime>;
  let fetcher: ReturnType<typeof vi.fn>;
  const roots: string[] = [];
  const text = '增函数在同一区间内，x1 小于 x2 时满足 f(x1) 小于 f(x2)。';
  const scope = () => ({ projectId: session.projectId, generation: session.generation });
  const input = (
    action: 'start' | 'continue' | 'pause' | 'stop',
    requestId = `command-${++count}`,
  ): DirectorCommandDto => ({ scope: scope(), sessionId, requestId, action });
  const run = (action: 'start' | 'continue' | 'pause' | 'stop', requestId?: string) =>
    commandDirector(session, input(action, requestId), { connection });
  const approve = (state: DirectorStateDto, over: Record<string, unknown> = {}) => {
    const step = directorCurrentStep(state)!;
    return commandDirector(
      session,
      {
        scope: scope(),
        sessionId,
        requestId: `command-${++count}`,
        action: 'review',
        stepId: step.stepId,
        candidateDigest: step.candidate!.digest,
        decision: 'approved',
        semanticReviewed: true,
        note: '核对冻结来源',
        ...over,
      },
      { connection },
    );
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-director-'));
    roots.push(root);
    session = openProjectFromDisk(root);
    count = 0;
    const { store, projectId } = session;
    const imported = store.importMaterial({
      projectId,
      displayName: '考纲.md',
      materialType: 'md',
      rawText: text,
    });
    const proposal = store.createProposal({
      projectId,
      name: '增函数',
      concept: text,
      conditions: '同一区间',
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
    const knowledgeId = store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
    }).knowledgePoint!.knowledgeId;
    store.createRoleProfile('peer', { name: '小问', persona: '爱提问', explanation: 'intuitive' });
    const plan: PlanPayloadDto = {
      payloadVersion: 1,
      goal: '理解增函数',
      examDate: null,
      dailyMinutes: 60,
      tasks: [
        {
          knowledgeId,
          name: '增函数',
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
      basis: '测试',
      confirmedTaskKnowledgeIds: [knowledgeId],
    };
    store.savePlanVersion(projectId, 1, 'confirmed', plan);
    store.startPlanRun(projectId);
    const bundle = store.buildLessonBundle(
      projectId,
      [
        { knowledgeId, text, conditions: '同一区间' },
        { knowledgeId, text: '取值、作差、定号可用于检查单调性。', conditions: '同一区间' },
      ],
      [],
    );
    const lesson = store.createLessonDraft({
      projectId,
      lessonId: null,
      title: '增函数课堂',
      bundleId: bundle.bundleId,
      statementIds: bundle.bundle.statements.map((item) => item.statementId),
      questionIds: [],
    });
    lessonId = lesson.lessonId;
    store.reviewLesson({ projectId, lessonId, version: 1, decision: 'approved', note: '' });
    store.publishLesson({ projectId, lessonId, version: 1 });
    const document = attachFormalLessonDocument(session, lessonId, 1);
    const classroom = store.openClassroomSession({
      projectId,
      lessonId,
      stageId: document.stageId,
      sceneId: document.scenes[0]!.sceneId,
      learnerKey: store.getLocalLearnerBinding(projectId)!.learnerKey,
    });
    sessionId = classroom.sessionId;
    store.setClassroomPeers(projectId, sessionId, { enabled: true, engagement: 'balanced' });
    fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: 'fixture',
            choices: [{ message: { content: `候选讲解：${text}` } }],
            usage: { total_tokens: 30 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    connection = createModelConnectionRuntime({ fetcher, generationMaxCallsPerMinute: 20 });
    connection.configure(
      {
        provider: 'openai-compatible',
        model: 'fixture',
        baseUrl: 'https://director-fixture.test/v1',
        apiKey: 'fixture-secret-never-in-state',
      },
      false,
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeProject();
    for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('persists scene/role queue without dispatch and requires teacher review before delivery', async () => {
    expect(readDirector(session, sessionId)).toBeNull();
    const saved = await run('start');
    expect(saved.steps.map((step) => step.role)).toEqual(['teacher', 'peer', 'teacher', 'peer']);
    expect(fetcher).not.toHaveBeenCalled();
    const generated = await run('continue');
    const step = directorCurrentStep(generated)!;
    expect(generated.state).toBe('awaiting_review');
    expect(step.candidate?.text).toContain(text);
    expect(
      session.store.getExplanation(step.candidate!.explanationId!, session.projectId)?.status,
    ).toBe('draft');
    await expect(run('continue')).rejects.toMatchObject({ code: 'CLASSROOM_LESSON_NOT_REVIEWED' });
    await expect(approve(generated, { semanticReviewed: false })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    const approved = await approve(generated);
    expect(directorCurrentStep(approved)?.state).toBe('approved');
    expect(session.store.classroomState(session.projectId, sessionId).playedIds).toHaveLength(0);
    const delivered = await run('continue');
    expect(delivered.steps[0]?.state).toBe('delivered');
    expect(session.store.classroomState(session.projectId, sessionId).playedIds).toEqual([
      step.candidate!.explanationId,
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(delivered)).not.toContain('fixture-secret');
  });

  it('runs the full two-scene queue with reviewed frozen-content peers, preserving real mastery', async () => {
    await run('start');
    const before = session.store.listKnowledge('formal').map((point) => point.masteryStatus);
    const attempts = session.store.listAttempts('real', 'formal').length;
    let state = readDirector(session, sessionId)!;
    for (let index = 0; index < 30 && state.state !== 'completed'; index += 1) {
      state =
        directorCurrentStep(state)?.state === 'pending_review'
          ? await approve(state)
          : await run('continue');
    }
    expect(state.state).toBe('completed');
    expect(state.steps.every((step) => step.state === 'delivered')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const turns = session.store.listClassroomPeerTurns(session.projectId, sessionId);
    expect(turns).toHaveLength(2);
    expect(
      turns.every(
        (turn) =>
          turn.partition === 'simulation' &&
          turn.actorType === 'peer_ai' &&
          turn.text.includes('冻结内容的模拟同学'),
      ),
    ).toBe(true);
    expect(session.store.listKnowledge('formal').map((point) => point.masteryStatus)).toEqual(
      before,
    );
    expect(session.store.listAttempts('real', 'formal')).toHaveLength(attempts);
    expect(session.store.modelCallUsage(state.runId)).toMatchObject({ calls: 2, tokens: 60 });
  });

  it('deduplicates continue effects and preserves saved queue through reopen', async () => {
    const startInput = input('start', 'original-start');
    const saved = await commandDirector(session, startInput, { connection });
    const continueInput = input('continue', 'original-continue');
    const generated = await commandDirector(session, continueInput, { connection });
    expect(await commandDirector(session, continueInput, { connection })).toEqual(generated);
    closeProject();
    session = openProjectFromDisk(root);
    expect(readDirector(session, sessionId)?.directorId).toBe(saved.directorId);
    expect(
      await commandDirector(session, { ...continueInput, scope: scope() }, { connection }),
    ).toEqual(generated);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('pauses and resumes only with explicit continue; review is bound to exact candidate digest', async () => {
    await run('start');
    const paused = await run('pause');
    expect(paused.state).toBe('paused');
    expect(fetcher).not.toHaveBeenCalled();
    const generated = await run('continue');
    await expect(approve(generated, { candidateDigest: 'a'.repeat(64) })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    const step = directorCurrentStep(generated)!;
    session.store.updateExplanationDraft({
      projectId: session.projectId,
      explanationId: step.candidate!.explanationId!,
      text: '正文已改变，旧审核不能套用。',
    });
    await expect(approve(generated)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('rejects candidate review when document or source authority changes', async () => {
    await run('start');
    const generated = await run('continue');
    session.store.importMaterial({
      projectId: session.projectId,
      displayName: '考纲.md',
      materialType: 'md',
      rawText: '来源已修订，旧知识失效。',
    });
    await expect(approve(generated)).rejects.toThrow(StudyError);
    expect(directorCurrentStep(readDirector(session, sessionId)!)?.state).toBe('pending_review');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('stops an active scoped call and will not re-dispatch an unknown outcome', async () => {
    let entered!: () => void;
    const dispatch = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fetcher.mockImplementation(async (_url: unknown, options: RequestInit) => {
      entered();
      await new Promise<void>((resolve) =>
        options.signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      throw new Error('aborted');
    });
    await run('start');
    const pending = run('continue');
    await dispatch;
    const stopped = await run('stop');
    expect(stopped.state).toBe('stopped');
    expect((await pending).state).toBe('stopped');
    await expect(run('continue')).rejects.toThrow(StudyError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(session.store.modelCallUsage(stopped.runId).tokens).toBeGreaterThan(0);
  });

  it('preserves an explicit pause after late unknown model settlement', async () => {
    let entered!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fetcher.mockImplementation(async (_url: unknown, options: RequestInit) => {
      entered();
      await new Promise<void>((resolve) =>
        options.signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      throw new Error('aborted');
    });
    await run('start');
    const pending = run('continue');
    await dispatched;
    expect((await run('pause')).state).toBe('paused');
    const settled = await pending;
    expect(settled.state).toBe('paused');
    expect(directorCurrentStep(settled)?.state).toBe('unknown');
    expect(readDirector(session, sessionId)?.state).toBe('paused');
    await expect(run('continue')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('restarts as read-only unknown, refusing even an explicit continue of the old task', async () => {
    await run('start');
    fetcher.mockImplementation(async () => {
      closeProject();
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });
    await expect(run('continue')).rejects.toThrow(StudyError);
    session = openProjectFromDisk(root);
    const recovered = readDirector(session, sessionId)!;
    expect(recovered.state).toBe('unknown');
    expect(directorCurrentStep(recovered)?.state).toBe('unknown');
    await expect(run('continue')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const stopped = await run('stop');
    const newTask = await run('start');
    expect(newTask.directorId).not.toBe(stopped.directorId);
    expect(newTask.steps[0]?.generationRequestId).not.toBe(stopped.steps[0]?.generationRequestId);
  });

  it('awaiting the human makes every continue refuse without dispatch', async () => {
    await run('start');
    session.store.handBackToLearner(session.projectId, sessionId, '请本人作答');
    await expect(run('continue')).rejects.toMatchObject({ code: 'CLASSROOM_AWAITING_LEARNER' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(session.store.listAttempts('real', 'formal')).toHaveLength(0);
  });

  it('hands a real quiz scene to the human and never creates a personal answer', async () => {
    const { store, projectId } = session;
    const previous = store.getLessonVersion(lessonId, 1, projectId)!;
    const original = store.getEvidenceBundle(projectId, previous.bundleId)!;
    const question = store.createQuestion({
      stem: '增函数要求什么？',
      answer: 'A',
      solution: '按定义核对',
      knowledgeIds: [original.bundle.statements[0]!.knowledgeId],
      requestedOrigin: 'ai_new',
      originRecord: null,
      assessment: {
        schemaVersion: 1,
        type: 'single',
        options: [
          { value: 'A', label: '函数值增大' },
          { value: 'B', label: '函数值减小' },
        ],
        correctAnswers: ['A'],
        maxScore: 1,
        rubric: '',
        answerVersion: 1,
      },
    });
    const bundle = store.buildLessonBundle(
      projectId,
      original.bundle.statements.map((statement) => ({
        knowledgeId: statement.knowledgeId,
        text: statement.text,
        conditions: statement.conditions,
      })),
      [question.question.questionId],
    );
    const lesson = store.createLessonDraft({
      projectId,
      lessonId: null,
      title: '含本人测验的调度',
      bundleId: bundle.bundleId,
      statementIds: bundle.bundle.statements.map((statement) => statement.statementId),
      questionIds: [question.question.questionId],
    });
    store.reviewLesson({
      projectId,
      lessonId: lesson.lessonId,
      version: 1,
      decision: 'approved',
      note: '',
    });
    store.publishLesson({ projectId, lessonId: lesson.lessonId, version: 1 });
    const document = attachFormalLessonDocument(session, lesson.lessonId, 1);
    store.closeClassroomSession(projectId, sessionId, 'cancelled', '转到测验课');
    sessionId = store.openClassroomSession({
      projectId,
      lessonId: lesson.lessonId,
      stageId: document.stageId,
      sceneId: document.scenes.find((scene) => scene.sceneType === 'quiz')!.sceneId,
      learnerKey: store.getLocalLearnerBinding(projectId)!.learnerKey,
    }).sessionId;
    const state = await run('start');
    expect(state.steps[0]?.role).toBe('learner');
    const waiting = await run('continue');
    expect(waiting.state).toBe('awaiting_learner');
    expect(store.getClassroomSession(sessionId, projectId)?.status).toBe('awaiting_learner');
    await expect(run('continue')).rejects.toMatchObject({ code: 'CLASSROOM_AWAITING_LEARNER' });
    await run('pause');
    store.markLearnerAnswered(projectId, sessionId);
    expect((await run('continue')).steps[0]?.state).toBe('delivered');
    expect((await run('continue')).state).toBe('completed');
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.listAttempts('real', 'formal')).toHaveLength(0);
  });

  it('rolls back playback and receipt when Director state persistence fails', async () => {
    await run('start');
    const generated = await run('continue');
    await approve(generated);
    const state = readDirector(session, sessionId)!;
    vi.spyOn(session.store.classroomKV, 'set').mockImplementationOnce(() => {
      throw new Error('fixture write fault');
    });
    await expect(run('continue')).rejects.toThrow('fixture write fault');
    expect(session.store.classroomState(session.projectId, sessionId).playedIds).toHaveLength(0);
    expect(readDirector(session, sessionId)?.steps[0]?.state).toBe('approved');
    expect(readDirector(session, sessionId)?.receipts.length).toBe(state.receipts.length);
  });

  it('candidate digest includes scene, role, source document and exact text', async () => {
    await run('start');
    const state = await run('continue');
    const step = directorCurrentStep(state)!;
    const candidate = step.candidate!;
    expect(directorCandidateDigest(state, step, candidate.text, candidate.explanationId)).toBe(
      candidate.digest,
    );
    expect(
      directorCandidateDigest(
        { ...state, documentDigest: 'b'.repeat(64) },
        step,
        candidate.text,
        candidate.explanationId,
      ),
    ).not.toBe(candidate.digest);
    expect(
      directorCandidateDigest(
        state,
        { ...step, sceneId: 'changed' },
        candidate.text,
        candidate.explanationId,
      ),
    ).not.toBe(candidate.digest);
    expect(
      directorCandidateDigest(state, step, candidate.text + '变化', candidate.explanationId),
    ).not.toBe(candidate.digest);
  });

  it('HTTP read/control is scoped, strict, no-store and does not generate on GET or start', async () => {
    vi.spyOn(modelConnection, 'status').mockImplementation(connection.status);
    vi.spyOn(modelConnection, 'generate').mockImplementation(connection.generate);
    vi.spyOn(modelConnection, 'revision').mockImplementation(connection.revision);
    const query = new URLSearchParams({
      projectId: session.projectId,
      generation: String(session.generation),
      sessionId,
    });
    const get = await GET(new Request(`http://localhost/api/study/director?${query}`));
    expect(get.status).toBe(200);
    expect(get.headers.get('cache-control')).toBe('no-store');
    expect(directorViewSchema.parse((await get.json()).data).director).toBeNull();
    const post = (body: unknown) =>
      POST(
        new Request('http://localhost/api/study/director', {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        }),
      );
    const saved = await post(input('start'));
    expect(saved.status).toBe(200);
    expect(directorViewSchema.parse((await saved.json()).data).director?.state).toBe('ready');
    expect(fetcher).not.toHaveBeenCalled();
    expect((await post({ ...input('continue'), actorUid: 'forged' })).status).toBe(400);
    expect((await post({ ...input('continue'), apiKey: 'renderer-secret' })).status).toBe(400);
    expect(
      (
        await post({
          ...input('continue'),
          scope: { ...scope(), generation: session.generation + 1 },
        })
      ).status,
    ).toBe(409);
    const generated = await post(input('continue'));
    expect(generated.status).toBe(200);
    expect(directorViewSchema.parse((await generated.json()).data).director?.state).toBe(
      'awaiting_review',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('renders explicit review and frozen simulation labels without triggering a call', async () => {
    const state = await run('start');
    const html = renderToStaticMarkup(
      createElement(DirectorPanel, {
        projectId: session.projectId,
        generation: session.generation,
        sessionId,
        initial: state,
      }),
    );
    expect(html).toContain('逐场景审核调度');
    expect(html).toContain('simulation');
    expect(html).toContain('每次继续执行一项');
    expect(fetcher).not.toHaveBeenCalled();
    const candidate = await run('continue');
    const markup = renderToStaticMarkup(
      createElement(DirectorPanel, {
        projectId: session.projectId,
        generation: session.generation,
        sessionId,
        initial: candidate,
      }),
    );
    expect(markup).toContain('批准候选');
    expect(markup).toContain('核对这段候选');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
