import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpAccountKV } from '@openmaic/storage';
import { HttpRuntimeStore } from '@openmaic/storage/runtime/http';
import type { RuntimeRecordInit } from '@openmaic/dsl';
import { DELETE as deleteKv, GET as getKv, PUT as putKv } from '../apps/learning/app/api/maic/kv/[...segments]/route';
import {
  DELETE as deleteRuntime,
  GET as getRuntime,
  PATCH as patchRuntime,
  POST as postRuntime,
} from '../apps/learning/app/api/maic/runtime/[...segments]/route';
import { closeProject, getSession, openProjectFromDisk } from '../apps/learning/lib/server/service';
import { ensureFixedLesson } from '../apps/learning/lib/server/classroom-service';
import { SCENE_QUIZ_ID } from '../apps/learning/lib/classroom/reviewed-lesson';

const BASE = 'http://service.local/api/maic';
const roots: string[] = [];
const tempRoot = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'sew-runtime-http-'));
  roots.push(path);
  return path;
};
const context = (segments: string[]) => ({ params: Promise.resolve({ segments }) });

const dispatch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(typeof input === 'string' ? input : input.toString(), init);
  const pathname = new URL(request.url).pathname.slice('/api/maic/'.length);
  const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0] === 'runtime') {
    const routeSegments = segments.slice(1);
    const routeContext = context(routeSegments);
    if (request.method === 'GET') return getRuntime(request, routeContext);
    if (request.method === 'POST') return postRuntime(request, routeContext);
    if (request.method === 'PATCH') return patchRuntime(request, routeContext);
    if (request.method === 'DELETE') return deleteRuntime(request, routeContext);
  }
  if (segments[0] === 'kv') {
    const routeContext = context(segments.slice(1));
    if (request.method === 'GET') return getKv(request, routeContext);
    if (request.method === 'PUT') return putKv(request, routeContext);
    if (request.method === 'DELETE') return deleteKv(request, routeContext);
  }
  return new Response(null, { status: 404 });
};

const headersFor = (scope = getSession()): HeadersInit => scope
  ? { 'x-sew-project-id': scope.projectId, 'x-sew-generation': String(scope.generation) }
  : {};

const runtimeClient = (headers: () => HeadersInit = () => headersFor()): HttpRuntimeStore => new HttpRuntimeStore({
  baseUrl: BASE,
  headers,
  fetch: dispatch as typeof globalThis.fetch,
});

const kvClient = (): HttpAccountKV => new HttpAccountKV({
  baseUrl: BASE,
  headers: () => headersFor(),
  fetch: dispatch as typeof globalThis.fetch,
});

const jsonBody = (value: unknown): string => JSON.stringify(value);

afterEach(() => {
  closeProject();
  const holder = (globalThis as { __sewSession?: { environmentBootstrapSuppressed?: boolean } }).__sewSession;
  if (holder) holder.environmentBootstrapSuppressed = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('published OpenMAIC RuntimeStore/KV HTTP contracts', () => {
  it('SQLite runtime and KV repositories survive process restart and commit tail transitions atomically', () => {
    const root = tempRoot();
    let opened = openProjectFromDisk(root);
    const stamp = new Date().toISOString();
    const init = {
      id: 'runtime-repository-1',
      runtimeDslVersion: '0.1.0',
      kind: 'quizAttempt',
      stageId: 'stage-repository-test',
      learnerKey: 'sew:classroom:owner:v1',
      status: 'active' as const,
      createdAt: stamp,
      updatedAt: stamp,
    };
    opened.store.runtime.createSession(opened.projectId, init);
    opened.store.classroomKV.set(opened.projectId, init.learnerKey, 'runtime.layout', { density: 'compact' });
    const recordInput = {
      id: 'runtime-repository-review',
      sessionId: init.id,
      sceneId: 'quiz-scene',
      createdAt: stamp,
      payload: { payloadVersion: 1, phase: 'reviewed', answers: { q1: 'B' }, results: [] },
    };
    const record = opened.store.runtime.appendRecord(opened.projectId, recordInput, {
      expectedLastSeq: null,
      sessionTransition: { status: 'completed', updatedAt: stamp },
    });
    expect(record.seq).toBe(0);
    expect(opened.store.runtime.getSession(opened.projectId, init.id)?.status).toBe('completed');
    opened.store.runtime.createSession(opened.projectId, { ...init, id: 'runtime-repository-active-2' });
    expect(() => opened.store.runtime.appendRecord(opened.projectId, {
      ...recordInput,
      id: 'runtime-repository-stale',
      sessionId: 'runtime-repository-active-2',
    }, { expectedLastSeq: 0 })).toThrowError(expect.objectContaining({ expectedLastSeq: 0, actualLastSeq: null }));
    closeProject();
    opened = openProjectFromDisk(root);
    expect(opened.store.runtime.listRecords(opened.projectId, init.id)).toEqual([record]);
    expect(opened.store.classroomKV.get(opened.projectId, init.learnerKey, 'runtime.layout')).toEqual({ density: 'compact' });
    expect(opened.store.classroomKV.get(opened.projectId, 'other-learner', 'runtime.layout')).toBeNull();
  });

  it('persists sessions and ordered records, enforces CAS and blocks browser review/completion writes', async () => {
    const session = openProjectFromDisk(tempRoot());
    const ensured = ensureFixedLesson(session);
    const client = runtimeClient();
    const learnerKeyBody = await (await fetchLearnerKey(session)).json() as { ok: boolean; data: { learnerKey: string } };
    const learnerKey = learnerKeyBody.data.learnerKey;
    const created = await client.createSession({
      id: 'runtime-http-quiz-1',
      kind: 'quizAttempt',
      stageId: ensured.stageId,
      learnerKey: 'client-forged-simulation',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(created.learnerKey).toBe(learnerKey);

    const draft: RuntimeRecordInit = {
      id: 'runtime-draft-1',
      sessionId: created.id,
      sceneId: SCENE_QUIZ_ID,
      createdAt: new Date().toISOString(),
      payload: { payloadVersion: 1, phase: 'draft', answers: { question: 'B' } },
    };
    const first = await client.appendRecord(draft, { expectedLastSeq: null });
    expect(first.seq).toBe(0);
    const stale = await dispatch(`${BASE}/runtime/sessions/${created.id}/records`, {
      method: 'POST',
      headers: { ...headersFor(session), 'content-type': 'application/json' },
      body: jsonBody({ ...draft, id: 'runtime-draft-2', expectedLastSeq: null }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json() as { error: { code: string } }).error.code).toBe('RUNTIME_APPEND_CONFLICT');

    const reviewed = await dispatch(`${BASE}/runtime/sessions/${created.id}/records`, {
      method: 'POST',
      headers: { ...headersFor(session), 'content-type': 'application/json' },
      body: jsonBody({
        ...draft,
        id: 'runtime-client-review',
        payload: { payloadVersion: 1, phase: 'reviewed', answers: { question: 'B' }, results: [] },
        expectedLastSeq: 0,
      }),
    });
    expect(reviewed.status).toBe(403);

    const invalidJson = await dispatch(`${BASE}/runtime/sessions/${created.id}/records`, {
      method: 'POST',
      headers: { ...headersFor(session), 'content-type': 'application/json' },
      body: `{"id":"deep","sessionId":"${created.id}","createdAt":"${new Date().toISOString()}","payload":${'['.repeat(66)}0${']'.repeat(66)}}`,
    });
    expect(invalidJson.status).toBe(413);
    expect((await invalidJson.json() as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');

    const completed = await dispatch(`${BASE}/runtime/sessions/${created.id}/status`, {
      method: 'PATCH',
      headers: { ...headersFor(session), 'content-type': 'application/json' },
      body: jsonBody({ status: 'completed', updatedAt: new Date().toISOString(), expectedLastSeq: 0 }),
    });
    expect(completed.status).toBe(403);

    const sessions = await client.listSessions(ensured.stageId, learnerKey);
    expect(sessions.map((item) => item.id)).toContain(created.id);
    expect(await client.listRecords(created.id)).toEqual([first]);

    const wrongLearner = await dispatch(`${BASE}/runtime/stages/${ensured.stageId}/learners/forged/sessions`, {
      headers: headersFor(session),
    });
    expect(wrongLearner.status).toBe(403);
  });

  it('commits server grading, reviewed record, completion and retry receipt in one project transaction', async () => {
    const root = tempRoot();
    let session = openProjectFromDisk(root);
    const ensured = ensureFixedLesson(session);
    const client = runtimeClient();
    const questionId = ensured.bindings.find((binding) => binding.sceneId === SCENE_QUIZ_ID)?.questionId ?? '';
    const runtimeSession = await client.createSession({
      id: 'runtime-composite-quiz',
      kind: 'quizAttempt',
      stageId: ensured.stageId,
      learnerKey: 'client-value-is-ignored',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const submit = () => dispatch(`${BASE}/runtime/submit`, {
      method: 'POST',
      headers: { ...headersFor(session), 'content-type': 'application/json' },
      body: jsonBody({
        scope: { projectId: session.projectId, generation: session.generation },
        sessionId: runtimeSession.id,
        sceneId: SCENE_QUIZ_ID,
        expectedLastSeq: null,
        questionId,
        idempotencyKey: 'quiz-composite-http-1',
        answerText: 'D',
        processText: '按定义比较两点函数值',
      }),
    });
    const first = await submit();
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { data: {
      attempt: { kind: string; masteryAfter: string | null };
      record: { id: string; seq: number; payload: { phase: string; answers: Record<string, unknown>; results: Array<{ correct: boolean | null }> } };
      deduplicated: boolean;
    } };
    expect(firstBody.data.attempt.kind).toBe('real');
    // 演示中仍是本人真实作答，但不改变正式掌握状态。
    expect(firstBody.data.attempt.masteryAfter).toBeNull();
    expect(firstBody.data.record.seq).toBe(0);
    expect(firstBody.data.record.payload.phase).toBe('reviewed');
    expect(Object.values(firstBody.data.record.payload.answers)).toContain('按定义比较两点函数值');
    expect(firstBody.data.record.payload.results[0]?.correct).toBe(false);
    expect(firstBody.data.deduplicated).toBe(false);

    const retry = await submit();
    const retryBody = await retry.json() as { data: { record: { id: string }; deduplicated: boolean } };
    expect(retryBody.data.deduplicated).toBe(true);
    expect(retryBody.data.record.id).toBe(firstBody.data.record.id);
    expect(session.store.listAttempts('real', 'demo')).toHaveLength(1);
    const savedRecords = session.store.runtime.listRecords(session.projectId, runtimeSession.id);
    expect(savedRecords).toHaveLength(1);
    expect(savedRecords[0]?.payload).toEqual(firstBody.data.record.payload);
    expect(session.store.runtime.getSession(session.projectId, runtimeSession.id)?.status).toBe('completed');

    const wrongRetry = await dispatch(`${BASE}/runtime/submit`, {
      method: 'POST',
      headers: { ...headersFor(session), 'content-type': 'application/json' },
      body: jsonBody({
        scope: { projectId: session.projectId, generation: session.generation },
        sessionId: runtimeSession.id,
        sceneId: SCENE_QUIZ_ID,
        expectedLastSeq: null,
        questionId,
        idempotencyKey: 'quiz-composite-http-1',
        answerText: 'different answer',
        processText: 'same receipt cannot be reused',
      }),
    });
    expect(wrongRetry.status).toBe(409);
    const reopen = await dispatch(`${BASE}/runtime/sessions/${runtimeSession.id}/status`, {
      method: 'PATCH',
      headers: { ...headersFor(session), 'content-type': 'application/json' },
      body: jsonBody({ status: 'active', updatedAt: new Date().toISOString() }),
    });
    expect(reopen.status).toBe(403);
    const removeCompleted = await dispatch(`${BASE}/runtime/sessions/${runtimeSession.id}`, {
      method: 'DELETE', headers: headersFor(session),
    });
    expect(removeCompleted.status).toBe(403);
    const removeLearner = await dispatch(`${BASE}/runtime/stages/${ensured.stageId}/learners/${encodeURIComponent('sew:classroom:owner:v1')}`, {
      method: 'DELETE', headers: headersFor(session),
    });
    expect(removeLearner.status).toBe(403);
    expect(session.store.runtime.getSession(session.projectId, runtimeSession.id)?.status).toBe('completed');
    expect(session.store.runtime.listRecords(session.projectId, runtimeSession.id)).toHaveLength(1);
    const afterDeleteRetry = await submit();
    expect(afterDeleteRetry.status).toBe(200);
    expect((await afterDeleteRetry.json()).data.deduplicated).toBe(true);
    const archiveCompleted = await dispatch(`${BASE}/runtime/sessions/${runtimeSession.id}/status`, {
      method: 'PATCH',
      headers: { ...headersFor(session), 'content-type': 'application/json' },
      body: jsonBody({ status: 'archived', updatedAt: new Date().toISOString() }),
    });
    expect(archiveCompleted.status).toBe(403);

    const casSession = await client.createSession({
      id: 'runtime-composite-cas', kind: 'quizAttempt', stageId: ensured.stageId,
      learnerKey: 'ignored', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const crossSessionRetry = await dispatch(`${BASE}/runtime/submit`, {
      method: 'POST',
      headers: { ...headersFor(session), 'content-type': 'application/json' },
      body: jsonBody({
        scope: { projectId: session.projectId, generation: session.generation },
        sessionId: casSession.id, sceneId: SCENE_QUIZ_ID, expectedLastSeq: null,
        questionId, idempotencyKey: 'quiz-composite-http-1', answerText: 'D', processText: '按定义比较两点函数值',
      }),
    });
    expect(crossSessionRetry.status).toBe(409);
    const submitWithCas = (expectedLastSeq: number | null) => dispatch(`${BASE}/runtime/submit`, {
      method: 'POST',
      headers: { ...headersFor(session), 'content-type': 'application/json' },
      body: jsonBody({
        scope: { projectId: session.projectId, generation: session.generation },
        sessionId: casSession.id, sceneId: SCENE_QUIZ_ID, expectedLastSeq, questionId,
        idempotencyKey: 'quiz-composite-cas-rollback', answerText: 'D', processText: 'rollback check',
      }),
    });
    const casConflict = await submitWithCas(7);
    expect(casConflict.status).toBe(409);
    expect(session.store.getAttemptByIdempotencyKey('quiz-composite-cas-rollback')).toBeNull();
    expect(session.store.runtime.listRecords(session.projectId, casSession.id)).toHaveLength(0);
    const casRetry = await submitWithCas(null);
    expect(casRetry.status).toBe(200);
    expect(session.store.getAttemptByIdempotencyKey('quiz-composite-cas-rollback')).not.toBeNull();

    closeProject();
    session = openProjectFromDisk(root);
    expect(session.store.runtime.getSession(session.projectId, runtimeSession.id)?.status).toBe('completed');
    expect(session.store.runtime.listRecords(session.projectId, runtimeSession.id)[0]?.id).toBe(firstBody.data.record.id);
  });

  it('stores account KV values by project and server identity and survives reopening', async () => {
    const root = tempRoot();
    let session = openProjectFromDisk(root);
    const kv = kvClient();
    const tooDeep = await dispatch(`${BASE}/kv/entries/runtime.too-deep`, {
      method: 'PUT',
      headers: { ...headersFor(session), 'content-type': 'application/json' },
      body: `{"value":${'['.repeat(66)}0${']'.repeat(66)}}`,
    });
    expect(tooDeep.status).toBe(413);
    await kv.set('runtime.preference', { density: 'compact' });
    await kv.set('runtime.null', null);
    expect(await kv.get('runtime.preference')).toEqual({ density: 'compact' });
    expect(await kv.keys('runtime.')).toEqual(['runtime.null', 'runtime.preference']);
    closeProject();
    session = openProjectFromDisk(root);
    expect(await kv.get('runtime.preference')).toEqual({ density: 'compact' });
    await kv.remove('runtime.preference');
    expect(await kv.get('runtime.preference')).toBeNull();
  });

  it('rejects asynchronous writes after the project generation changes', async () => {
    const rootA = tempRoot();
    const rootB = tempRoot();
    const sessionA = openProjectFromDisk(rootA);
    const staleClient = runtimeClient(() => headersFor(sessionA));
    const ensured = ensureFixedLesson(sessionA);
    closeProject();
    openProjectFromDisk(rootB);
    const response = await dispatch(`${BASE}/runtime/stages/${ensured.stageId}/learners/${sessionA.projectId}/sessions`, {
      headers: headersFor(sessionA),
    });
    expect(response.status).toBe(409);
    await expect(staleClient.createSession({
      id: 'stale-generation-runtime',
      kind: 'playback',
      stageId: ensured.stageId,
      learnerKey: 'ignored',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })).rejects.toMatchObject({ code: 'PROJECT_GENERATION_STALE' });
  });
});

async function fetchLearnerKey(session: NonNullable<ReturnType<typeof getSession>>): Promise<Response> {
  return dispatch(`${BASE}/runtime/learner-key`, { headers: headersFor(session) });
}
