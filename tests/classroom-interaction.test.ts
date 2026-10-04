import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GET, POST } from '../apps/learning/app/api/maic/interaction/route';
import { POST as runtimePost, DELETE as runtimeDelete, PATCH as runtimePatch } from '../apps/learning/app/api/maic/runtime/[...segments]/route';
import { interactiveSrcDoc } from '../apps/learning/components/openmaic-adaptation/InteractiveSceneView';
import { ensureFixedLesson } from '../apps/learning/lib/server/classroom-service';
import { closeProject, openProjectFromDisk, type Session } from '../apps/learning/lib/server/service';
import { SCENE_INTERACTIVE_ID, SCENE_QUIZ_ID } from '../apps/learning/lib/classroom/reviewed-lesson';
import { interactionStateSchema } from '@sew/study-contracts';
import { INTERACTION_SESSION_KIND, INTERACTION_SESSION_PREFIX } from '../apps/learning/lib/server/interaction-service';

describe('explicit personal experiment submission', () => {
  let root: string;
  let session: Session;
  let stageId: string;
  const scope = () => ({ projectId: session.projectId, generation: session.generation });
  const headers = () => ({ 'content-type': 'application/json', 'x-sew-project-id': session.projectId, 'x-sew-generation': String(session.generation) });
  const input = () => ({ scope: scope(), stageId, sceneId: SCENE_INTERACTIVE_ID, a: -1.2, prediction: 'decreasing', explanation: 'a 为负，x 增加时函数值下降。' });
  const post = (body: unknown = input()) => POST(new Request('http://service.local/api/maic/interaction', { method: 'POST', headers: headers(), body: JSON.stringify(body) }));
  const get = () => GET(new Request(`http://service.local/api/maic/interaction?stageId=${stageId}&sceneId=${SCENE_INTERACTIVE_ID}`, { headers: headers() }));
  const data = async (response: Response) => {
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const envelope = await response.json() as { data: unknown };
    return interactionStateSchema.parse(envelope.data);
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-interaction-'));
    session = openProjectFromDisk(root);
    stageId = ensureFixedLesson(session).stageId;
  });
  afterEach(() => {
    closeProject();
    const holder = (globalThis as { __sewSession?: { environmentBootstrapSuppressed?: boolean } }).__sewSession;
    if (holder) holder.environmentBootstrapSuppressed = false;
    rmSync(root, { recursive: true, force: true });
  });

  it('GET creates no runtime; explicit submission derives direction, deduplicates, and survives reopen without attempts/mastery', async () => {
    expect(await data(await get())).toEqual({ lastSubmission: null, count: 0, deduplicated: false });
    expect(session.store.runtime.listSessions(session.projectId, stageId, 'sew:classroom:owner:v1')).toHaveLength(0);
    const saved = await data(await post());
    expect(saved.lastSubmission?.payload).toMatchObject({ actorType: 'human_learner', recordScope: 'demo', a: -1.2, direction: 'decreasing' });
    const repeat = await data(await post());
    expect(repeat).toEqual({ ...saved, deduplicated: true });
    const zero = await data(await post({ ...input(), a: 0, prediction: 'increasing' }));
    expect(zero.count).toBe(2);
    expect(zero.lastSubmission?.payload.direction).toBe('constant');
    expect((await data(await post({ ...input(), a: 2 }))).lastSubmission?.payload.direction).toBe('increasing');
    expect(session.store.listAttempts('real', 'demo')).toHaveLength(0);
    expect(session.store.listKnowledge('demo').every((point) => point.masteryStatus === 'untested')).toBe(true);
    closeProject();
    session = openProjectFromDisk(root);
    const reopened = await data(await get());
    expect(reopened.count).toBe(3);
    expect(reopened.lastSubmission?.payload.a).toBe(2);
    expect((await data(await post())).lastSubmission?.id).toBe(saved.lastSubmission?.id);
    expect((await data(await get())).count).toBe(3);
  });

  it('rejects forged authority fields, invalid step/range, wrong scene, mismatched header scope and stale generation', async () => {
    for (const forged of [{ actorType: 'ai_peer' }, { direction: 'increasing' }, { masteryAfter: 'mastered' }, { a: 3.1 }, { a: 0.15 }, { explanation: 'x'.repeat(2001) }, { sceneId: SCENE_QUIZ_ID }, { scope: { ...scope(), projectId: 'another' } }]) {
      expect((await post({ ...input(), ...forged })).status).toBeGreaterThanOrEqual(400);
    }
    const request = new Request('http://service.local/api/maic/interaction', { method: 'POST', headers: headers(), body: JSON.stringify(input()) });
    closeProject(); session = openProjectFromDisk(root);
    expect((await POST(request)).status).toBe(409);
    expect((await data(await get())).count).toBe(0);
  });

  it('source revision invalidation blocks both saved read and retries, preserving the original receipt', async () => {
    const saved = await data(await post());
    const material = session.store.listMaterials('demo')[0]!;
    session.store.importMaterial({ projectId: session.projectId, displayName: material.displayName, materialType: material.materialType, readableLocation: material.readableLocation ?? undefined, rawText: '新版材料已替换原定义。', recordScope: 'demo' });
    expect((await get()).status).toBeGreaterThanOrEqual(400);
    expect((await post()).status).toBeGreaterThanOrEqual(400);
    const runtime = session.store.runtime.listSessions(session.projectId, stageId, 'sew:classroom:owner:v1')[0]!;
    expect(session.store.runtime.listRecords(session.projectId, runtime.id)).toHaveLength(1);
    expect(session.store.runtime.listRecords(session.projectId, runtime.id)[0]?.id).toBe(saved.lastSubmission?.id);
  });

  it('project switch rejects old project requests and isolates persisted personal observations', async () => {
    const saved = await data(await post());
    const previousRequest = new Request(`http://service.local/api/maic/interaction?stageId=${stageId}&sceneId=${SCENE_INTERACTIVE_ID}`, { headers: headers() });
    closeProject();
    session = openProjectFromDisk(join(root, 'another-project'));
    stageId = ensureFixedLesson(session).stageId;
    expect((await GET(previousRequest)).status).toBe(409);
    expect((await data(await get())).count).toBe(0);
    closeProject(); session = openProjectFromDisk(root);
    expect((await data(await get())).lastSubmission?.id).toBe(saved.lastSubmission?.id);
  });

  it('runtime API cannot forge, append, archive or erase reserved observations', async () => {
    const now = new Date().toISOString();
    const call = (method: string, segments: string[], body?: unknown) => {
      const request = new Request(`http://service.local/api/maic/runtime/${segments.join('/')}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const context = { params: Promise.resolve({ segments }) };
      return method === 'POST' ? runtimePost(request, context) : method === 'PATCH' ? runtimePatch(request, context) : runtimeDelete(request, context);
    };
    const sessionBody = { id: 'client-session', kind: INTERACTION_SESSION_KIND, stageId, learnerKey: 'client', status: 'active', createdAt: now, updatedAt: now };
    expect((await call('POST', ['sessions'], sessionBody)).status).toBe(403);
    expect((await call('POST', ['sessions'], { ...sessionBody, id: INTERACTION_SESSION_PREFIX + 'forged', kind: 'custom' })).status).toBe(403);
    await post();
    const owned = session.store.runtime.listSessions(session.projectId, stageId, 'sew:classroom:owner:v1')[0]!;
    expect((await call('POST', ['sessions', owned.id, 'records'], { id: 'forged', sessionId: owned.id, sceneId: SCENE_INTERACTIVE_ID, createdAt: now, payload: { direction: 'constant' } })).status).toBe(403);
    expect((await call('PATCH', ['sessions', owned.id, 'status'], { status: 'archived', updatedAt: now })).status).toBe(403);
    for (const path of [['sessions', owned.id], ['stages', stageId, 'learners', owned.learnerKey], ['stages', stageId], ['runtime']]) expect((await call('DELETE', path)).status).toBe(403);
    expect((await data(await get())).count).toBe(1);
  });

  it('refuses malformed persisted observations instead of treating them as saved learner facts', async () => {
    await post();
    const owned = session.store.runtime.listSessions(session.projectId, stageId, 'sew:classroom:owner:v1')[0]!;
    session.store.runtime.appendRecord(session.projectId, { id: 'corrupted', sessionId: owned.id, sceneId: SCENE_INTERACTIVE_ID, createdAt: new Date().toISOString(), payload: { payloadVersion: 1, actorType: 'ai_peer' } });
    expect((await get()).status).toBe(500);
    expect((await post()).status).toBe(500);
  });

  it('injects bounded resource and script error capture before the first synchronous widget script', () => {
    const html = '<!doctype html><html><head><script>throw new Error("early")</script></head><body></body></html>';
    const injected = interactiveSrcDoc(html, 'test-instance');
    expect(injected.indexOf("window.addEventListener('error'")).toBeLessThan(injected.indexOf('throw new Error'));
    expect(injected).toContain('slice(0,1200)');
    expect(injected).toContain('q.length>50');
    expect(injected).toContain("},true)");
    expect(interactiveSrcDoc('<script>throw 1</script>', 'fallback').startsWith('<script>(function()')).toBe(true);
  });
});
