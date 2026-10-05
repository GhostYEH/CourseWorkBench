import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpDocumentStore, HttpDocumentStoreError } from '@openmaic/storage/document/http';
import { classroomDocumentDigest, stripQuizAnswers } from '@sew/study-domain';
import { DELETE, GET, PUT } from '../apps/learning/app/api/maic/documents/[[...segments]]/route';
import {
  closeProject,
  getSession,
  openProjectFromDisk,
} from '../apps/learning/lib/server/service';
import {
  ensureFixedLesson,
  loadRenderableDocument,
  reviewedLesson,
} from '../apps/learning/lib/server/classroom-service';
import {
  SCENE_QUIZ_ID,
  SCENE_SLIDE_ID,
} from '../apps/learning/lib/classroom/reviewed-lesson';

/**
 * 真实课堂文档链（CLASS-01a / STORE-01 前置）。
 *
 * 用上游 `@openmaic/storage` 的 `HttpDocumentStore` 客户端直接驱动本项目的路由处理，
 * 因此验证的是上游合同实现本身：路径、错误码、版本语义与返回形状都由真实客户端解析。
 */

const BASE = 'http://service.local/api/maic';

const dispatch = async (input: string, init?: RequestInit): Promise<Response> => {
  const url = new URL(input);
  const segments = url.pathname
    .slice('/api/maic/documents'.length)
    .split('/')
    .filter((part) => part.length > 0)
    .map(decodeURIComponent);
  const context = { params: Promise.resolve({ segments }) };
  const request = new Request(input, init);
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method === 'GET') return GET(request, context);
  if (method === 'PUT') return PUT(request, context);
  if (method === 'DELETE') return DELETE(request, context);
  throw new Error(`未覆盖的方法 ${method}`);
};

const withActiveScope = (init?: RequestInit): RequestInit => {
  const headers = new Headers(init?.headers);
  const session = getSession();
  if (session) {
    headers.set('x-sew-project-id', session.projectId);
    headers.set('x-sew-generation', String(session.generation));
  }
  return { ...init, headers };
};

const dispatchScoped = (input: string, init?: RequestInit): Promise<Response> =>
  dispatch(input, withActiveScope(init));

/** Single-chunk stream body, so a Request carries exactly the given bytes. */
const streamBody = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

const openStore = () =>
  new HttpDocumentStore({
    baseUrl: BASE,
    headers: (): HeadersInit => {
      const session = getSession();
      return session
        ? { 'x-sew-project-id': session.projectId, 'x-sew-generation': String(session.generation) }
        : {};
    },
    fetch: ((input: string | URL, init?: RequestInit) =>
      dispatch(typeof input === 'string' ? input : input.toString(), init)) as typeof globalThis.fetch,
  });

describe('真实课堂文档链', () => {
  let rootA: string;
  let rootB: string;

  beforeEach(() => {
    rootA = mkdtempSync(join(tmpdir(), 'sew-doc-a-'));
    rootB = mkdtempSync(join(tmpdir(), 'sew-doc-b-'));
  });

  afterEach(() => {
    closeProject();
    // closeProject 会把「环境引导已抑制」置为已用；本文件的用例集结束后必须还原，
    // 否则同一 worker 里后续依赖环境引导的套件会读到上一个文件留下的状态。
    const holder = (globalThis as { __sewSession?: { environmentBootstrapSuppressed?: boolean } }).__sewSession;
    if (holder) holder.environmentBootstrapSuppressed = false;
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  it('审核课件沿真实准入链落库，文档指纹与来源绑定一致', () => {
    const session = openProjectFromDisk(rootA);
    const ensured = ensureFixedLesson(session);

    expect(ensured.stageId).toBe(reviewedLesson.stageId);
    expect(ensured.sceneCount).toBe(3);
    expect(ensured.digest).toBe(classroomDocumentDigest(reviewedLesson.document));
    expect(ensured.bindings.map((binding) => binding.sceneId).sort()).toEqual(
      [SCENE_SLIDE_ID, SCENE_QUIZ_ID, 'scene-interactive-parameter'].sort(),
    );

    const quizBinding = ensured.bindings.find((binding) => binding.sceneId === SCENE_QUIZ_ID);
    expect(quizBinding?.questionId).toBeTruthy();
    // 演示编者审核须通过演示准入，但不能进入正式知识范围。
    const knowledgeId = quizBinding?.knowledgeIds[0];
    expect(knowledgeId).toBeTruthy();
    expect(session.store.checkAdmission([knowledgeId ?? '']).allowed).toBe(false);
    expect(session.store.checkAdmission([knowledgeId ?? ''], 'demo').allowed).toBe(true);

    // 幂等：再次 provision 不产生第二份材料版本或第二道题。
    const materialsBefore = session.store.listMaterials('demo').length;
    const questionsBefore = session.store.listQuestions('demo').length;
    ensureFixedLesson(session);
    expect(session.store.listMaterials('demo').length).toBe(materialsBefore);
    expect(session.store.listQuestions('demo').length).toBe(questionsBefore);
  });

  it('上游 DocumentStore 客户端可读回文档，且渲染文档不含判分答案', async () => {
    const session = openProjectFromDisk(rootA);
    const ensured = ensureFixedLesson(session);
    const store = openStore();

    const document = await store.loadDocument(reviewedLesson.stageId);
    expect(document).not.toBeNull();
    expect(document?.stage.id).toBe(reviewedLesson.stageId);
    // The upstream contract keeps an optional app-owned outline on the complete
    // document. It is opaque to this route and must not be projected away.
    const expectedOutline = 'outline' in reviewedLesson.document ? reviewedLesson.document.outline : undefined;
    expect(document?.outline).toEqual(expectedOutline);
    expect(document?.scenes.map((scene) => scene.id).sort()).toEqual(
      ensured.bindings.map((binding) => binding.sceneId).sort(),
    );

    const quiz = document?.scenes.find((scene) => scene.id === SCENE_QUIZ_ID);
    const questions = (quiz?.content as { questions?: Array<Record<string, unknown>> }).questions ?? [];
    expect(questions[0]?.['answer']).toBeUndefined();
    expect(questions[0]?.['analysis']).toBeUndefined();
    expect(questions[0]?.['question']).toBeTruthy();
    expect(Array.isArray(questions[0]?.['options'])).toBe(true);

    // 同一文档的服务端原稿确实带答案，说明「去答案」发生在服务边界而不是编造内容。
    const stored = session.store.getClassroomDocument(session.projectId, reviewedLesson.stageId);
    const raw = (stored?.document as { scenes: Array<Record<string, unknown>> }).scenes.find(
      (scene) => scene['id'] === SCENE_QUIZ_ID,
    );
    const rawQuestions = (raw?.['content'] as { questions: Array<Record<string, unknown>> }).questions;
    expect(rawQuestions[0]?.['answer']).toEqual(['B']);
    const strippedAgain = stripQuizAnswers(stored?.document);
    expect(JSON.stringify(strippedAgain.document)).not.toContain('"answer"');
  });

  it('列表、单场景读取与未知文档符合合同语义', async () => {
    const session = openProjectFromDisk(rootA);
    ensureFixedLesson(session);
    const store = openStore();

    const summaries = await store.listDocuments();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.id).toBe(reviewedLesson.stageId);
    expect(summaries[0]?.sceneCount).toBe(3);

    const scene = await store.getScene(reviewedLesson.stageId, SCENE_SLIDE_ID);
    expect(scene?.id).toBe(SCENE_SLIDE_ID);
    expect((scene?.content as { canvas?: unknown }).canvas).toBeTruthy();

    expect(await store.loadDocument('stage-not-here')).toBeNull();
    expect(await store.getScene(reviewedLesson.stageId, 'scene-not-here')).toBeNull();
  });

  it('渲染端改写文档被拒绝：只有登记过的审核课件可以写入', async () => {
    const session = openProjectFromDisk(rootA);
    ensureFixedLesson(session);
    const store = openStore();

    const tampered = structuredClone(reviewedLesson.document);
    const slide = tampered.scenes.find((scene) => scene.id === SCENE_QUIZ_ID);
    (slide as { content: { questions: Array<{ question: string }> } }).content.questions[0]!.question =
      '被改写过的题干';

    await expect(store.saveDocument(tampered as never)).rejects.toMatchObject({
      code: 'CLASSROOM_LESSON_NOT_REVIEWED',
      status: 403,
    });

    // 自洽但未登记的 stage 同样不能写入当前项目（服务端拒绝，而不是客户端形状检查）。
    const rogue = structuredClone(reviewedLesson.document);
    rogue.stage = { ...rogue.stage, id: 'stage-rogue' };
    rogue.scenes = rogue.scenes.map((scene) => ({ ...scene, stageId: 'stage-rogue' }));
    const rogueFailure = (await store
      .saveDocument(rogue as never)
      .catch((error: unknown) => error)) as HttpDocumentStoreError;
    expect(rogueFailure).toBeInstanceOf(HttpDocumentStoreError);
    expect(rogueFailure.code).toBe('CLASSROOM_LESSON_NOT_REVIEWED');
    expect(rogueFailure.status).toBe(403);

    // 原稿本身可以重复写入（幂等）：客户端 saveDocument 无返回值，按落库结果校验。
    await expect(store.saveDocument(reviewedLesson.document as never)).resolves.toBeUndefined();
    const stored = session.store.getClassroomDocument(session.projectId, reviewedLesson.stageId);
    expect(stored?.digest).toBe(classroomDocumentDigest(reviewedLesson.document));
  });

  it('outline 是完整文档中的不透明快照，但改动 outline 仍须通过整份受审指纹', async () => {
    const session = openProjectFromDisk(rootA);
    ensureFixedLesson(session);
    const store = openStore();

    const document = await store.loadDocument(reviewedLesson.stageId);
    if (!document) throw new Error('Reviewed document was not loaded');
    const withUnreviewedOutline = {
      ...document,
      outline: { entries: [{ id: 'unreviewed-entry', title: '未审核生成内容' }] },
    };
    await expect(store.saveDocument(withUnreviewedOutline)).rejects.toMatchObject({
      code: 'CLASSROOM_LESSON_NOT_REVIEWED',
      status: 403,
    });

    // A denied outline write cannot alter the authoritative course or its source digest.
    const stored = session.store.getClassroomDocument(session.projectId, reviewedLesson.stageId);
    expect(stored?.digest).toBe(classroomDocumentDigest(reviewedLesson.document));
    expect(stored?.document).not.toHaveProperty('outline');
  });

  it('高于当前应用支持的 DSL 版本被显式拒绝', async () => {
    const session = openProjectFromDisk(rootA);
    ensureFixedLesson(session);
    const store = openStore();

    const future = { ...structuredClone(reviewedLesson.document), dslVersion: '99.0.0' };
    const failure = (await store.saveDocument(future as never).catch((error: unknown) => error)) as {
      name?: string;
      kind?: string;
      storedVersion?: string;
      stageId?: string;
    };
    // 合同子路径不导出 DocumentVersionError 类，这里按真实客户端产出的错误身份断言。
    expect(failure.name).toBe('DocumentVersionError');
    expect(failure.kind).toBe('future');
    expect(failure.storedVersion).toBe('99.0.0');
    expect(failure.stageId).toBe(reviewedLesson.stageId);
    // 拒绝写入后当前项目仍是原课件。
    const stored = session.store.getClassroomDocument(session.projectId, reviewedLesson.stageId);
    expect(stored?.digest).toBe(classroomDocumentDigest(reviewedLesson.document));
  });

  it('文档按项目分区：另一个项目读不到、也改不了前一个项目的课堂', async () => {
    const sessionA = openProjectFromDisk(rootA);
    ensureFixedLesson(sessionA);
    // 打开项目 B 会关闭 A 的数据库连接，需要的身份先取出来。
    const questionIdA = sessionA.store
      .listClassroomSceneSources(sessionA.projectId, reviewedLesson.stageId)
      .get(SCENE_QUIZ_ID)?.questionId;
    const store = openStore();
    expect(await store.loadDocument(reviewedLesson.stageId)).not.toBeNull();

    const sessionB = openProjectFromDisk(rootB);
    expect(sessionB.projectId).not.toBe(sessionA.projectId);
    expect(await store.loadDocument(reviewedLesson.stageId)).toBeNull();
    expect(await store.listDocuments()).toEqual([]);

    // 文档接口不能借写入隐式初始化课堂；项目 B 必须先走显式登记流程。
    await expect(store.saveDocument(reviewedLesson.document as never)).rejects.toMatchObject({
      code: 'DOCUMENT_NOT_FOUND',
      status: 404,
    });
    expect(sessionB.store.listClassroomDocuments(sessionB.projectId)).toEqual([]);
    expect(questionIdA).toBeTruthy();
  });

  it('拒绝缺少或过期项目范围的文档请求', async () => {
    const sessionA = openProjectFromDisk(rootA);
    ensureFixedLesson(sessionA);

    const missingScope = await dispatch(`${BASE}/documents`);
    expect(missingScope.status).toBe(400);
    expect(((await missingScope.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');

    const staleHeaders = {
      'x-sew-project-id': sessionA.projectId,
      'x-sew-generation': String(sessionA.generation),
    };
    const sessionB = openProjectFromDisk(rootB);
    const staleRead = await dispatch(`${BASE}/documents`, { headers: staleHeaders });
    expect(staleRead.status).toBe(409);
    expect(((await staleRead.json()) as { error: { code: string } }).error.code).toBe('PROJECT_GENERATION_STALE');

    const pathLikeScope = await dispatch(`${BASE}/documents`, {
      headers: {
        'x-sew-project-id': 'C:\\Users\\Alice Example\\private-project',
        'x-sew-generation': String(sessionB.generation),
      },
    });
    expect(pathLikeScope.status).toBe(409);
    expect(await pathLikeScope.text()).not.toContain('Alice Example');

    const staleClient = new HttpDocumentStore({
      baseUrl: BASE,
      headers: () => staleHeaders,
      fetch: ((input: string | URL, init?: RequestInit) =>
        dispatch(typeof input === 'string' ? input : input.toString(), init)) as typeof globalThis.fetch,
    });
    await expect(staleClient.saveDocument(reviewedLesson.document as never)).rejects.toMatchObject({
      code: 'PROJECT_GENERATION_STALE',
      status: 409,
    });
    expect(sessionB.store.listClassroomDocuments(sessionB.projectId)).toEqual([]);
  });

  it('读取请求体期间项目切换时拒绝写入，且不影响新项目', async () => {
    const sessionA = openProjectFromDisk(rootA);
    const headers = {
      'content-type': 'application/json',
      'x-sew-project-id': sessionA.projectId,
      'x-sew-generation': String(sessionA.generation),
    };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        openProjectFromDisk(rootB);
        controller.enqueue(new TextEncoder().encode(JSON.stringify(reviewedLesson.document)));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const request = new Request(`${BASE}/documents/${reviewedLesson.stageId}`, {
      method: 'PUT',
      headers,
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const response = await PUT(request, {
      params: Promise.resolve({ segments: [reviewedLesson.stageId] }),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('PROJECT_GENERATION_STALE');
    expect(getSession()?.store.listClassroomDocuments(getSession()!.projectId)).toEqual([]);
  });

  it('null 与 primitive JSON body 按 VALIDATION_FAILED 返回 400', async () => {
    const session = openProjectFromDisk(rootA);
    const headers = {
      'content-type': 'application/json',
      'x-sew-project-id': session.projectId,
      'x-sew-generation': String(session.generation),
    };
    for (const body of ['null', '7', '"text"']) {
      const response = await dispatch(`${BASE}/documents/${reviewedLesson.stageId}`, {
        method: 'PUT', headers, body,
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
    }
    expect(session.store.listClassroomDocuments(session.projectId)).toEqual([]);
  });

  it('非法 UTF-8 字节在解码阶段就按 VALIDATION_FAILED 拒绝，不改动已登记课件', async () => {
    const session = openProjectFromDisk(rootA);
    ensureFixedLesson(session);
    const headers = {
      'content-type': 'application/json',
      'x-sew-project-id': session.projectId,
      'x-sew-generation': String(session.generation),
    };
    const prefix = new TextEncoder().encode('{"note":"课件');
    const damaged: Array<[string, Uint8Array]> = [
      ['非法起始字节', new Uint8Array([...prefix, 0xff])],
      ['被截断的多字节序列', new TextEncoder().encode('{"note":"中').slice(0, -1)],
      ['用三字节形式编码的代理项', new Uint8Array([0xed, 0xa0, 0x80])],
    ];
    for (const [label, bytes] of damaged) {
      const response = await dispatch(`${BASE}/documents/${reviewedLesson.stageId}`, {
        method: 'PUT', headers, body: streamBody(bytes), duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      const payload = (await response.json()) as {
        error: { code: string; message: string; details?: Record<string, unknown> };
      };
      expect(response.status, label).toBe(400);
      expect(payload.error.code, label).toBe('VALIDATION_FAILED');
      expect(payload.error.details?.reason, label).toBe('invalid_utf8');
      // 损坏字节不能被替换成 U+FFFD 后继续处理，正文也不允许回显给客户端。
      expect(JSON.stringify(payload), label).not.toContain('\ufffd');
      expect(JSON.stringify(payload), label).not.toContain('note');
    }
    const stored = session.store.getClassroomDocument(session.projectId, reviewedLesson.stageId);
    expect(stored?.digest).toBe(classroomDocumentDigest(reviewedLesson.document));
  });

  it('真实 HttpDocumentStore 送出损坏字节时按合同报错且服务端没有写入', async () => {
    const session = openProjectFromDisk(rootA);
    ensureFixedLesson(session);
    const store = new HttpDocumentStore({
      baseUrl: BASE,
      headers: (): HeadersInit => ({
        'x-sew-project-id': session.projectId,
        'x-sew-generation': String(session.generation),
      }),
      fetch: ((input: string | URL, init?: RequestInit) => {
        const bytes = new TextEncoder().encode(String(init?.body ?? '{}'));
        // 破坏正文内部某个多字节字符的后续字节：非致命解码只会把它换成 U+FFFD，
        // 旧实现仍能 parse 出「合法 JSON」并一路走到审核守卫（403）；严格解码必须先拒绝。
        const wide = bytes.findIndex((byte, index) => byte > 0x7f && index + 2 < bytes.length);
        expect(wide).toBeGreaterThan(-1);
        const damaged = Uint8Array.from(bytes);
        damaged[wide + 1] = 0xff;
        return dispatch(
          typeof input === 'string' ? input : input.toString(),
          { ...init, body: streamBody(damaged), duplex: 'half' } as RequestInit & {
            duplex: 'half';
          },
        );
      }) as typeof globalThis.fetch,
    });

    const failure = (await store
      .saveDocument(reviewedLesson.document as never)
      .catch((error: unknown) => error)) as HttpDocumentStoreError;
    expect(failure).toBeInstanceOf(HttpDocumentStoreError);
    expect(failure.code).toBe('VALIDATION_FAILED');
    expect(failure.status).toBe(400);
    expect(session.store.getClassroomDocument(session.projectId, reviewedLesson.stageId)?.digest).toBe(
      classroomDocumentDigest(reviewedLesson.document),
    );
  });

  it('有效正文按 1 字节分片送达仍被接受，严格解码只看整份字节流', async () => {
    const session = openProjectFromDisk(rootA);
    ensureFixedLesson(session);
    const bytes = new TextEncoder().encode(JSON.stringify(reviewedLesson.document));
    // 正向控制：严格解码看的是重新拼好的整份字节流，不能逐片解码。多字节字符被切在
    // 片界上时仍必须接受，否则这条链上的每个中文课件正文都会被误拒。
    expect([...bytes].some((byte) => byte > 0x7f)).toBe(true);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + 1));
        offset += 1;
      },
    }, { highWaterMark: 0 });
    const response = await PUT(
      new Request(`${BASE}/documents/${reviewedLesson.stageId}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-sew-project-id': session.projectId,
          'x-sew-generation': String(session.generation),
        },
        body: stream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
      { params: Promise.resolve({ segments: [reviewedLesson.stageId] }) },
    );
    expect(response.status).toBe(204);
    expect(session.store.getClassroomDocument(session.projectId, reviewedLesson.stageId)?.digest).toBe(
      classroomDocumentDigest(reviewedLesson.document),
    );
  });

  it('无 Content-Length 且声明偏小的超限流会立即取消，不再读取后续分块', async () => {
    const session = openProjectFromDisk(rootA);
    const chunks = [
      new Uint8Array(16 * 1024 * 1024),
      new Uint8Array(16 * 1024 * 1024),
      new Uint8Array(1),
      new Uint8Array(1),
    ];
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[pulls];
        pulls += 1;
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const request = new Request(`${BASE}/documents/${reviewedLesson.stageId}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'content-length': '1',
        'x-sew-project-id': session.projectId,
        'x-sew-generation': String(session.generation),
      },
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const response = await PUT(request, {
      params: Promise.resolve({ segments: [reviewedLesson.stageId] }),
    });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(pulls).toBe(3);
    expect(cancelled).toBe(true);
  });

  it('未登记场景与畸形路径返回合同里的身份与状态码', async () => {
    const session = openProjectFromDisk(rootA);
    ensureFixedLesson(session);
    const response = await dispatchScoped(`${BASE}/documents/${reviewedLesson.stageId}/scenes/scene-ghost`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; details?: Record<string, unknown> } };
    expect(body.error.code).toBe('SCENE_NOT_FOUND');
    // 场景缺失必须报 sceneId，不能把场景 id 塞进 stageId 字段。
    expect(body.error.details).toMatchObject({ stageId: reviewedLesson.stageId, sceneId: 'scene-ghost' });

    const unroutable = await dispatchScoped(`${BASE}/documents/${reviewedLesson.stageId}/whiteboards/wb-1`);
    expect(unroutable.status).toBe(404);
    expect(((await unroutable.json()) as { error: { code: string } }).error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('带 __proto__ 键的改写文档不会被稳定序列化静默丢键而绕过审核守卫', async () => {
    const session = openProjectFromDisk(rootA);
    ensureFixedLesson(session);
    const store = openStore();

    // JSON.parse 会创建自有 __proto__ 键；若稳定序列化把它当原型赋值就会丢掉，
    // 于是「多带一个键的文档」与干净文档同指纹，守卫被绕过。
    const smuggled = JSON.parse(
      `${JSON.stringify(reviewedLesson.document).slice(0, -1)},"__proto__":{"injected":true}}`,
    );
    expect(Object.keys(smuggled)).toContain('__proto__');
    expect(classroomDocumentDigest(smuggled)).not.toBe(
      classroomDocumentDigest(reviewedLesson.document),
    );

    const refusal = (await store
      .saveDocument(smuggled as never)
      .catch((error: unknown) => error)) as HttpDocumentStoreError;
    expect(refusal).toBeInstanceOf(HttpDocumentStoreError);
    expect(refusal.code).toBe('CLASSROOM_LESSON_NOT_REVIEWED');

    // 单个场景同样不能夹带额外键。
    const sceneWithExtra = JSON.parse(
      `${JSON.stringify(reviewedLesson.document.scenes[0]).slice(0, -1)},"__proto__":{"x":1}}`,
    );
    const sceneRefusal = await dispatchScoped(
      `${BASE}/documents/${reviewedLesson.stageId}/scenes/${SCENE_SLIDE_ID}`,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sceneWithExtra) },
    );
    expect(sceneRefusal.status).toBe(403);
    // 落库文档仍然是登记的那一份。
    const stored = session.store.getClassroomDocument(session.projectId, reviewedLesson.stageId);
    expect(stored?.digest).toBe(classroomDocumentDigest(reviewedLesson.document));
  });

  it('putStage 与 putScene 走真实客户端时确实落到已登记内容，不返回假成功', async () => {
    const session = openProjectFromDisk(rootA);
    ensureFixedLesson(session);
    const store = openStore();

    await expect(store.putStage(reviewedLesson.stageId, reviewedLesson.document.stage as never)).resolves.toBeUndefined();
    const stageResponse = await dispatchScoped(`${BASE}/documents/${reviewedLesson.stageId}/stage`);
    expect(stageResponse.status).toBe(200);
    const servedStage = (await stageResponse.json()) as { id: string; name: string };
    expect(servedStage.id).toBe(reviewedLesson.stageId);

    // 非登记 stage 必须被拒，而不是静默 204。
    const rogueStage = { ...reviewedLesson.document.stage, name: '被改写的课堂名' };
    const refusal = await dispatchScoped(`${BASE}/documents/${reviewedLesson.stageId}/stage`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rogueStage),
    });
    expect(refusal.status).toBe(403);

    await expect(
      store.putScene(reviewedLesson.stageId, reviewedLesson.document.scenes[1] as never),
    ).resolves.toBeUndefined();
    const stored = session.store.getClassroomDocument(session.projectId, reviewedLesson.stageId);
    expect(stored?.digest).toBe(classroomDocumentDigest(reviewedLesson.document));
    const served = await store.getScene(reviewedLesson.stageId, reviewedLesson.document.scenes[1]!.id);
    expect(served?.id).toBe(reviewedLesson.document.scenes[1]!.id);
  });

  it('删除课堂文档后仍可重新落库；删除单个场景被拒绝', async () => {
    const session = openProjectFromDisk(rootA);
    ensureFixedLesson(session);
    const store = openStore();

    await store.deleteDocument(reviewedLesson.stageId);
    expect(await store.loadDocument(reviewedLesson.stageId)).toBeNull();
    expect(session.store.getClassroomDocument(session.projectId, reviewedLesson.stageId)).toBeNull();

    ensureFixedLesson(session);
    const refusal = await dispatchScoped(
      `${BASE}/documents/${reviewedLesson.stageId}/scenes/${SCENE_SLIDE_ID}`,
      { method: 'DELETE' },
    );
    expect(refusal.status).toBe(403);

    const renderable = loadRenderableDocument(session, reviewedLesson.stageId);
    expect(renderable?.sceneCount).toBe(3);
  });
});
