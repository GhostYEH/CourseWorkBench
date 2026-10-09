import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StudyError } from '@sew/study-contracts';
import { StudyStore, ensureProjectLayout } from '@sew/study-storage';
import { fail } from '../apps/learning/lib/server/http';
import { HttpAssetStore } from '@openmaic/storage/asset/http';

const require = createRequire(import.meta.url);
const { validateBuildInputs } = require('../scripts/freshness.mjs') as {
  validateBuildInputs: (root: string, buildDirectory: string) => unknown;
};
interface RendererRequestDetails {
  webContentsId: number;
  url: string;
  resourceType: string;
  frame?: { parent: object | null } | null;
}
const { shouldAttachRendererSession, rendererRequestHeaders } =
  require('../apps/desktop/src/http-boundary.cjs') as {
    shouldAttachRendererSession: (
      details: RendererRequestDetails,
      windowId: number,
      origin: string,
    ) => boolean;
    rendererRequestHeaders: (
      details: RendererRequestDetails,
      windowId: number,
      origin: string | undefined,
      token: string | undefined,
      headers: Record<string, string>,
    ) => Record<string, string>;
  };

describe('Electron renderer HTTP credential boundary', () => {
  const origin = 'http://127.0.0.1:43123';
  const base = { webContentsId: 10, url: `${origin}/workbench`, resourceType: 'mainFrame' };

  it('attaches only for the bound webContents and exact-origin main frame', () => {
    expect(shouldAttachRendererSession(base, 10, origin)).toBe(true);
    expect(shouldAttachRendererSession({ ...base, webContentsId: 11 }, 10, origin)).toBe(false);
    expect(
      shouldAttachRendererSession({ ...base, url: `${origin}.evil.test/workbench` }, 10, origin),
    ).toBe(false);
    expect(
      shouldAttachRendererSession({ ...base, url: 'https://example.test/workbench' }, 10, origin),
    ).toBe(false);
  });

  it('does not attach credentials to subframes or requests without proven main-frame identity', () => {
    expect(
      shouldAttachRendererSession(
        { ...base, resourceType: 'subFrame', frame: { parent: {} } },
        10,
        origin,
      ),
    ).toBe(false);
    expect(
      shouldAttachRendererSession({ ...base, resourceType: 'xhr', frame: null }, 10, origin),
    ).toBe(false);
    expect(
      shouldAttachRendererSession(
        { ...base, resourceType: 'mainFrame', frame: { parent: {} } },
        10,
        origin,
      ),
    ).toBe(false);
  });

  it('injects only the renderer session header and never the control credential', () => {
    const original = { accept: 'text/html' };
    const topFrameHeaders = rendererRequestHeaders(base, 10, origin, 'session-secret', original);
    expect(topFrameHeaders).toMatchObject({
      accept: 'text/html',
      'x-sew-session': 'session-secret',
    });
    expect(topFrameHeaders).not.toHaveProperty('x-sew-control');
    const iframeHeaders = rendererRequestHeaders(
      { ...base, resourceType: 'subFrame', frame: { parent: {} } },
      10,
      origin,
      'session-secret',
      original,
    );
    expect(iframeHeaders).toBe(original);
  });
});

describe('learning HTTP error boundary', () => {
  it.each([
    'C:\\Users\\Jane Doe\\project\\db.sqlite',
    '\\\\file server\\share name\\db.sqlite',
    '/Users/Jane Doe/project/db.sqlite',
  ])('does not expose the suffix of a path containing spaces: %s', async (path) => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = fail(
        new StudyError('NOT_FOUND', { path, nested: { diagnostic: `Cannot open (${path})` } }),
      );
      const body = await response.json();
      expect(body).toMatchObject({
        error: {
          details: {
            path: '[本地路径已隐藏]',
            nested: { diagnostic: '[本地路径已隐藏]' },
          },
        },
      });
      expect(JSON.stringify(body)).not.toContain('db.sqlite');
    } finally {
      diagnostic.mockRestore();
    }
  });
  it('redacts absolute paths from public error details and keeps the original server diagnostic', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = fail(
        new StudyError('NOT_FOUND', { path: 'C:\\Users\\yao\\private\\source.txt' }),
      );
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toMatchObject({
        ok: false,
        error: { code: 'NOT_FOUND', details: { path: '[本地路径已隐藏]' } },
      });
      expect(JSON.stringify(body)).not.toContain('C:\\Users\\yao');
      expect(diagnostic).toHaveBeenCalledWith(
        '[learning-http] request failed',
        expect.objectContaining({ details: { path: 'C:\\Users\\yao\\private\\source.txt' } }),
      );
    } finally {
      diagnostic.mockRestore();
    }
  });
});

const seedProjectWithQuestion = (root: string, projectId: string, subject: string): void => {
  const paths = ensureProjectLayout(root);
  writeFileSync(
    paths.manifestFile,
    JSON.stringify({
      formatVersion: 1,
      projectId,
      displayName: 'HTTP 边界验收项目',
      createdAt: new Date().toISOString(),
    }),
    'utf8',
  );
  const store = StudyStore.open({ file: paths.databaseFile });
  try {
    store.createProject({ projectId, displayName: 'HTTP 边界验收项目', subject });
    const { material, segments } = store.importMaterial({
      projectId,
      displayName: 'fixture.md',
      materialType: 'md',
      rawText: '测试知识点的定义与性质。\n\n可以通过示例检验该性质。',
    });
    const proposal = store.createProposal({
      projectId,
      name: '测试知识点',
      concept: '测试知识点的定义与性质',
      conditions: '',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [
        {
          materialId: material.materialId,
          revision: 1,
          segmentId: segments[0]!.segmentId,
          use: 'concept_basis',
        },
      ],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'user',
    });
    const knowledge = store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
    }).knowledgePoint!;
    store.createQuestion({
      stem: '测试题目',
      answer: '受保护的标准答案',
      solution: '受保护的解析',
      knowledgeIds: [knowledge.knowledgeId],
      requestedOrigin: 'ai_new',
      originRecord: null,
    });
  } finally {
    store.close();
  }
};

const hasProductionBuild = existsSync(resolve('apps/learning/.next/BUILD_ID'));
const productionDescribe = hasProductionBuild ? describe.sequential : describe.skip;
productionDescribe('production learning HTTP boundary (requires pnpm build:learning)', () => {
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let origin = '';
  let sessionToken = '';
  let controlToken = '';
  let tempRoot = '';
  let projectA = '';
  let projectB = '';
  let invalidProject = '';

  const request = (path: string, options: RequestInit = {}, headers: Record<string, string> = {}) =>
    fetch(`${origin}${path}`, {
      ...options,
      headers: { ...headers, ...(options.headers as Record<string, string> | undefined) },
    });

  beforeAll(async () => {
    validateBuildInputs(resolve('.'), resolve('apps/learning/.next'));
    tempRoot = mkdtempSync(join(tmpdir(), 'sew-desktop-http-'));
    projectA = join(tempRoot, 'project-a');
    projectB = join(tempRoot, 'project-b');
    invalidProject = join(tempRoot, 'invalid-project');
    mkdirSync(projectA);
    mkdirSync(projectB);
    mkdirSync(invalidProject);
    writeFileSync(
      join(invalidProject, 'project.json'),
      JSON.stringify({ formatVersion: 999 }),
      'utf8',
    );
    seedProjectWithQuestion(projectB, 'project-b-http-fixture', '物理');

    child = spawn(process.execPath, [resolve('apps/learning/server.mjs'), '--project-root', ''], {
      cwd: resolve('apps/learning'),
      env: { ...process.env, NODE_ENV: 'production', SEW_DEV: '0', SEW_PROJECT_ROOT: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = await new Promise<{ origin: string; sessionToken: string; controlToken: string }>(
      (resolveReady, reject) => {
        let stdoutBuffer = '';
        const timer = setTimeout(
          () => reject(new Error('learning HTTP service did not become ready')),
          30000,
        );
        child!.stdout.on('data', (chunk: Buffer) => {
          stdoutBuffer += chunk.toString('utf8');
          const lines = stdoutBuffer.split('\n');
          stdoutBuffer = lines.pop() ?? '';
          for (const line of lines) {
            try {
              const value = JSON.parse(line);
              if (value.type === 'ready') {
                clearTimeout(timer);
                resolveReady(value);
              } else if (value.type === 'error') {
                clearTimeout(timer);
                reject(new Error(value.message));
              }
            } catch {
              /* Next may write non-JSON startup output. */
            }
          }
        });
        child!.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`learning service exited before ready (${code})`));
        });
        child!.stderr.on('data', () => undefined);
      },
    );
    origin = ready.origin;
    sessionToken = ready.sessionToken;
    controlToken = ready.controlToken;
  }, 35000);

  afterAll(async () => {
    if (origin && sessionToken && controlToken && child && child.exitCode === null) {
      await request('/internal/shutdown', {
        method: 'POST',
        headers: { origin, 'x-sew-session': sessionToken, 'x-sew-control': controlToken },
      }).catch(() => undefined);
      await Promise.race([
        new Promise<void>((resolveDone) => child!.once('exit', () => resolveDone())),
        new Promise<void>((resolveDone) => setTimeout(resolveDone, 4000)),
      ]);
      if (child.exitCode === null) child.kill();
    } else if (child && child.exitCode === null) {
      child.kill();
    }
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('protects production SSR and main-only HTTP routes with separate credentials', async () => {
    const anonymousPage = await request('/workbench');
    expect(anonymousPage.status).toBe(401);
    expect(await anonymousPage.json()).toMatchObject({
      ok: false,
      error: { code: 'SESSION_REQUIRED' },
    });

    const anonymousHealth = await request('/api/health');
    expect(anonymousHealth.status).toBe(401);
    expect(await anonymousHealth.json()).toMatchObject({
      ok: false,
      error: { code: 'SESSION_REQUIRED' },
    });
    const anonymousInternalHealth = await request('/internal/health');
    expect(anonymousInternalHealth.status).toBe(401);
    expect(await anonymousInternalHealth.json()).toMatchObject({
      ok: false,
      error: { code: 'SESSION_REQUIRED' },
    });
    const sessionInternalHealth = await request(
      '/internal/health',
      {},
      { 'x-sew-session': sessionToken },
    );
    expect(sessionInternalHealth.status).toBe(200);
    expect(await sessionInternalHealth.json()).toMatchObject({ ok: true, data: { ready: true } });

    const rendererInternal = await request('/internal/project', {
      method: 'POST',
      body: JSON.stringify({ action: 'close' }),
      headers: { origin, 'content-type': 'application/json', 'x-sew-session': sessionToken },
    });
    expect(rendererInternal.status).toBe(401);
    expect(await rendererInternal.json()).toMatchObject({
      ok: false,
      error: { code: 'CONTROL_REQUIRED' },
    });

    for (const encodedPath of ['/%69nternal/project', '/api/study/%62ackup']) {
      const encodedRequest = await request(encodedPath, {
        method: 'POST',
        body: JSON.stringify(
          encodedPath.includes('backup')
            ? {
                scope: { projectId: 'anything', generation: 1 },
                targetPath: join(tempRoot, 'encoded.db'),
              }
            : { action: 'close' },
        ),
        headers: { origin, 'content-type': 'application/json', 'x-sew-session': sessionToken },
      });
      expect(encodedRequest.status).toBe(401);
      expect(await encodedRequest.json()).toMatchObject({
        ok: false,
        error: { code: 'CONTROL_REQUIRED' },
      });
    }
    const encodedSeparator = await request(
      '/%252finternal/project',
      {},
      { 'x-sew-session': sessionToken },
    );
    expect(encodedSeparator.status).toBe(400);
    expect(await encodedSeparator.json()).toMatchObject({
      ok: false,
      error: { code: 'PATH_NOT_ALLOWED' },
    });

    const rendererBackup = await request('/api/study/backup', {
      method: 'POST',
      body: JSON.stringify({
        scope: { projectId: 'anything', generation: 1 },
        targetPath: join(tempRoot, 'arbitrary.db'),
      }),
      headers: { origin, 'content-type': 'application/json', 'x-sew-session': sessionToken },
    });
    expect(rendererBackup.status).toBe(401);
    expect(await rendererBackup.json()).toMatchObject({
      ok: false,
      error: { code: 'CONTROL_REQUIRED' },
    });

    const wrongOrigin = await request('/internal/project', {
      method: 'POST',
      body: JSON.stringify({ action: 'open', path: projectA }),
      headers: {
        origin: 'http://127.0.0.1.evil.test',
        'content-type': 'application/json',
        'x-sew-session': sessionToken,
        'x-sew-control': controlToken,
      },
    });
    expect(wrongOrigin.status).toBe(403);
    expect(await wrongOrigin.json()).toMatchObject({
      ok: false,
      error: { code: 'ORIGIN_NOT_ALLOWED' },
    });

    const wrongHost = await new Promise<{ status: number; body: string }>(
      (resolveResponse, reject) => {
        const parsedOrigin = new URL(origin);
        const req = httpRequest(
          {
            hostname: parsedOrigin.hostname,
            port: Number(parsedOrigin.port),
            path: '/workbench',
            headers: { host: '127.0.0.1.evil.test', 'x-sew-session': sessionToken },
          },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
              body += chunk;
            });
            response.on('end', () => resolveResponse({ status: response.statusCode ?? 0, body }));
          },
        );
        req.on('error', reject);
        req.end();
      },
    );
    expect(wrongHost.status).toBe(403);
    expect(JSON.parse(wrongHost.body)).toMatchObject({
      ok: false,
      error: { code: 'HOST_NOT_ALLOWED' },
    });

    const authorizedPage = await request('/workbench', {}, { 'x-sew-session': sessionToken });
    expect(authorizedPage.status).toBe(200);
    expect(authorizedPage.headers.get('content-type')).toContain('text/html');
    expect(await authorizedPage.text()).toContain('学科备考工作台');
  }, 35000);

  it('opens only the exact external Pro route without a desktop session, and never as a prefix', async () => {
    // 精确路径 `/api/pro/external` 不要求桌面 session（由 bearer token 认证）；缺 token 时返回 403，
    // 而不是 401 SESSION_REQUIRED——证明它确实绕过了 session 边界、进入了业务认证。
    const externalNoToken = await request('/api/pro/external', {
      method: 'POST',
      body: JSON.stringify({ action: 'list', requestId: 'boundary-1' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(externalNoToken.status).toBe(403);
    expect(await externalNoToken.json()).toMatchObject({
      ok: false,
      error: { code: 'PROJECT_NOT_AUTHORIZED' },
    });

    // 近似路径与父路径仍要求桌面 session：外部放行不能放宽成前缀。
    for (const path of ['/api/pro', '/api/pro/external/extra', '/api/pro/externality']) {
      const guarded = await request(path, {
        method: 'POST',
        body: JSON.stringify({ action: 'list', requestId: 'boundary-2' }),
        headers: { origin, 'content-type': 'application/json' },
      });
      expect(guarded.status).toBe(401);
      expect(await guarded.json()).toMatchObject({
        ok: false,
        error: { code: 'SESSION_REQUIRED' },
      });
    }

    // token 管理入口仍要求桌面 session。
    const tokenManage = await request('/api/study/pro/tokens', {
      method: 'POST',
      body: JSON.stringify({ action: 'list', scope: { projectId: 'x', generation: 1 } }),
      headers: { origin, 'content-type': 'application/json' },
    });
    expect(tokenManage.status).toBe(401);
    expect(await tokenManage.json()).toMatchObject({
      ok: false,
      error: { code: 'SESSION_REQUIRED' },
    });
  }, 35000);

  it('uses service generations across close/reopen and retains the old session after a failed open', async () => {
    const trusted = {
      origin,
      'content-type': 'application/json',
      'x-sew-session': sessionToken,
      'x-sew-control': controlToken,
    };
    const open = async (path: string) =>
      request('/internal/project', {
        method: 'POST',
        headers: trusted,
        body: JSON.stringify({ action: 'open', path }),
      });
    const firstResponse = await open(projectA);
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as {
      ok: true;
      data: { session: { generation: number; projectId: string } };
    };
    const gen1 = first.data.session.generation;

    const closeResponse = await request('/internal/project', {
      method: 'POST',
      headers: trusted,
      body: JSON.stringify({ action: 'close' }),
    });
    expect(closeResponse.status).toBe(200);
    const secondResponse = await open(projectB);
    expect(secondResponse.status).toBe(200);
    const second = (await secondResponse.json()) as {
      ok: true;
      data: { session: { generation: number; projectId: string } };
    };
    const gen2 = second.data.session.generation;
    expect(gen2).toBeGreaterThan(gen1);

    const closeSecond = await request('/internal/project', {
      method: 'POST',
      headers: trusted,
      body: JSON.stringify({ action: 'close' }),
    });
    expect(closeSecond.status).toBe(200);
    const reopenSecond = await open(projectB);
    expect(reopenSecond.status).toBe(200);
    const reopened = (await reopenSecond.json()) as {
      ok: true;
      data: { session: { generation: number; projectId: string } };
    };
    expect(reopened.data.session.projectId).toBe(second.data.session.projectId);
    expect(reopened.data.session.generation).toBeGreaterThan(gen2);

    const stalePatch = await request('/api/study/project', {
      method: 'PATCH',
      body: JSON.stringify({
        scope: { projectId: second.data.session.projectId, generation: gen2 },
        subject: '不应写入',
      }),
      headers: { origin, 'content-type': 'application/json', 'x-sew-session': sessionToken },
    });
    expect(stalePatch.status).toBe(409);
    expect(await stalePatch.json()).toMatchObject({
      ok: false,
      error: { code: 'PROJECT_GENERATION_STALE' },
    });
    const externalMaterial = join(tempRoot, 'selected-before-project-switch.txt');
    writeFileSync(externalMaterial, '受控材料，必须由当前项目授权', 'utf8');
    const authorize = (scope: { projectId: string; generation: number } | undefined) =>
      request('/internal/project', {
        method: 'POST',
        headers: trusted,
        body: JSON.stringify({ action: 'authorize', scope, paths: [externalMaterial] }),
      });
    expect((await authorize(undefined)).status).toBe(400);
    const staleGrant = await authorize(second.data.session);
    expect(staleGrant.status).toBe(409);
    expect(await staleGrant.json()).toMatchObject({
      ok: false,
      error: { code: 'PROJECT_GENERATION_STALE' },
    });
    const importExternal = () =>
      request('/api/study/materials', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', 'x-sew-session': sessionToken },
        body: JSON.stringify({
          scope: reopened.data.session,
          mode: 'file',
          type: 'txt',
          displayName: '受控材料',
          sourcePath: externalMaterial,
        }),
      });
    const ungrantedImport = await importExternal();
    expect(ungrantedImport.status).toBeGreaterThanOrEqual(400);
    expect(await ungrantedImport.json()).toMatchObject({
      ok: false,
      error: { code: 'PROJECT_NOT_AUTHORIZED' },
    });
    expect((await authorize(reopened.data.session)).status).toBe(200);
    expect((await importExternal()).status).toBe(200);
    const currentState = await request('/api/study/state', {}, { 'x-sew-session': sessionToken });
    expect(currentState.status).toBe(200);
    expect(await currentState.json()).toMatchObject({
      ok: true,
      data: { project: { subject: '物理' } },
    });

    const teachingWithoutScope = await request('/api/study/preferences', {
      method: 'PUT',
      body: JSON.stringify({
        teaching: {
          version: 1,
          learningMode: 'beginner',
          explanation: 'intuitive',
          hintDepth: 'light',
          exerciseBalance: 'balanced',
          selfExplanation: false,
          everydayExamples: 'moderate',
          extraPreference: '',
        },
      }),
      headers: { origin, 'content-type': 'application/json', 'x-sew-session': sessionToken },
    });
    expect(teachingWithoutScope.status).toBe(400);
    expect(await teachingWithoutScope.json()).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    });

    const questionList = await request(
      '/api/study/questions',
      {},
      { 'x-sew-session': sessionToken },
    );
    expect(questionList.status).toBe(200);
    const listed = (await questionList.json()) as {
      ok: true;
      data: { questions: Array<Record<string, unknown>> };
    };
    expect(listed.data.questions).toHaveLength(1);
    expect(listed.data.questions[0]).not.toHaveProperty('answer');
    expect(listed.data.questions[0]).not.toHaveProperty('solution');

    const questionId = String(listed.data.questions[0]?.questionId);
    const detailWithoutAnswer = await request(
      `/api/study/questions/${encodeURIComponent(questionId)}?includeAnswer=false`,
      {},
      { 'x-sew-session': sessionToken },
    );
    expect(detailWithoutAnswer.status).toBe(200);
    const detailBody = (await detailWithoutAnswer.json()) as {
      ok: true;
      data: { question: Record<string, unknown> };
    };
    expect(detailBody.data.question).toMatchObject({ stem: '测试题目' });
    expect(detailBody.data.question).not.toHaveProperty('answer');
    expect(detailBody.data.question).not.toHaveProperty('solution');

    const failed = await open(invalidProject);
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(await failed.json()).toMatchObject({ ok: false, error: expect.any(Object) });
    const active = await request(
      '/internal/project',
      {},
      { 'x-sew-session': sessionToken, 'x-sew-control': controlToken },
    );
    expect(active.status).toBe(200);
    expect(await active.json()).toMatchObject({
      ok: true,
      data: {
        projectId: reopened.data.session.projectId,
        generation: reopened.data.session.generation,
      },
    });
  }, 15000);

  it('answers malformed URLs with a stable 400 and keeps serving (缺陷「畸形 URL 导致请求不确定」)', async () => {
    // 原始 HTTP 请求才能发出 fetch 会规范化的畸形路径（`//%` 会让 new URL() 抛错）。
    const rawRequest = (path: string, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; body: string }>((resolveResponse, reject) => {
        const parsedOrigin = new URL(origin);
        const req = httpRequest(
          { hostname: parsedOrigin.hostname, port: Number(parsedOrigin.port), path, headers },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
              body += chunk;
            });
            response.on('end', () => resolveResponse({ status: response.statusCode ?? 0, body }));
          },
        );
        req.on('error', reject);
        req.end();
      });

    // 匿名畸形路径：在任何身份判断之前就稳定失败，不崩溃、不返回 401。
    const anonymousMalformed = await rawRequest('//%');
    expect(anonymousMalformed.status).toBe(400);
    expect(JSON.parse(anonymousMalformed.body)).toMatchObject({
      ok: false,
      error: { code: 'MALFORMED_URL' },
    });

    // 带会话的畸形路径同样返回 400，连接正常结束。
    const sessionMalformed = await rawRequest('//%', { 'x-sew-session': sessionToken });
    expect(sessionMalformed.status).toBe(400);
    expect(JSON.parse(sessionMalformed.body)).toMatchObject({
      ok: false,
      error: { code: 'MALFORMED_URL' },
    });

    // 服务继续可用：健康端点仍正常响应。
    const healthAfter = await request('/internal/health', {}, { 'x-sew-session': sessionToken });
    expect(healthAfter.status).toBe(200);
    expect(await healthAfter.json()).toMatchObject({ ok: true, data: { ready: true } });
  }, 15000);

  it('production asset bytes survive reopen and remain bound to the authenticated project generation', async () => {
    const trusted = {
      origin,
      'content-type': 'application/json',
      'x-sew-session': sessionToken,
      'x-sew-control': controlToken,
    };
    const open = async (path: string) => {
      const response = await request('/internal/project', {
        method: 'POST',
        headers: trusted,
        body: JSON.stringify({ action: 'open', path }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: { session: { projectId: string; generation: number } };
      };
      return body.data.session;
    };
    const headersFor = (scope: { projectId: string; generation: number }) => ({
      origin,
      'x-sew-session': sessionToken,
      'x-sew-project-id': scope.projectId,
      'x-sew-generation': String(scope.generation),
    });
    const first = await open(projectA);
    const client = new HttpAssetStore({
      baseUrl: `${origin}/api/maic`,
      headers: () => headersFor(first),
    });
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    try {
      const id = await client.put(new Blob([bytes], { type: 'image/png' }), {
        contentType: 'image/png',
        source: 'HTTP boundary fixture',
      });
      const path = `/api/maic/assets/${encodeURIComponent(id)}/content`;
      const anonymous = await request(path);
      expect(anonymous.status).toBe(401);
      expect((await request(path, {}, { 'x-sew-session': sessionToken })).status).toBe(400);
      const head = await request(path, { method: 'HEAD' }, headersFor(first));
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
      expect(head.headers.get('x-asset-revision')).toBe('1');
      expect(head.headers.get('content-length')).toBe(String(bytes.length));
      expect(head.headers.get('etag')).toBeNull();
      expect(head.headers.get('last-modified')).toBeNull();
      expect(head.headers.get('cache-control')).toContain('no-store');
      const second = await open(projectB);
      expect((await request(path, {}, headersFor(first))).status).toBe(409);
      expect((await request(path, {}, headersFor(second))).status).toBe(404);
      const reopened = await open(projectA);
      const restored = await request(path, {}, headersFor(reopened));
      expect(restored.status).toBe(200);
      expect(new Uint8Array(await restored.arrayBuffer())).toEqual(bytes);
      expect(restored.headers.get('content-type')).toBe('image/png');
      const unsafe = `/api/maic/assets/${encodeURIComponent('a/../../project.json')}/content`;
      // The service rejects encoded separators before Next dispatches any route.
      const blockedPath = await request(unsafe, {}, headersFor(reopened));
      expect(blockedPath.status).toBe(400);
      expect(await blockedPath.json()).toMatchObject({ error: { code: 'PATH_NOT_ALLOWED' } });
      const missingHead = await request(
        '/api/maic/assets/unknown/content',
        { method: 'HEAD' },
        headersFor(reopened),
      );
      expect(missingHead.status).toBe(404);
      expect(missingHead.headers.get('x-error-code')).toBe('ASSET_NOT_FOUND');
      expect(await missingHead.text()).toBe('');
      expect(
        (await request(`${path}?principal=another-project`, {}, headersFor(reopened))).status,
      ).toBe(400);
      expect(
        (await request(path, { method: 'PUT', body: 'stale' }, headersFor(first))).status,
      ).toBe(409);
      expect(
        (
          await request(
            `/api/maic/assets/${encodeURIComponent(id)}`,
            { method: 'DELETE' },
            headersFor(reopened),
          )
        ).status,
      ).toBe(204);
      expect((await request(path, {}, headersFor(reopened))).status).toBe(404);
    } finally {
      await client.close();
    }
  }, 15000);

  it('production classroom reads are scoped and importing the demo needs explicit confirmation', async () => {
    const trusted = {
      origin,
      'content-type': 'application/json',
      'x-sew-session': sessionToken,
      'x-sew-control': controlToken,
    };
    const opened = await request('/internal/project', {
      method: 'POST',
      headers: trusted,
      body: JSON.stringify({ action: 'open', path: projectA }),
    });
    const current = (await opened.json()) as {
      data: { session: { projectId: string; generation: number } };
    };
    const scope = current.data.session;
    const headers = {
      origin,
      'content-type': 'application/json',
      'x-sew-session': sessionToken,
      'x-sew-project-id': scope.projectId,
      'x-sew-generation': String(scope.generation),
    };
    const stateBefore = await request('/api/study/state', {}, headers).then((r) => r.json());
    const page = await request('/classroom/lesson-demo-monotonicity-1', {}, headers);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('确认将演示材料');
    const stateAfter = await request('/api/study/state', {}, headers).then((r) => r.json());
    expect(stateAfter.data.counts).toEqual(stateBefore.data.counts);
    expect(
      (
        await request('/api/maic/demo', {
          method: 'POST',
          headers,
          body: JSON.stringify({ scope }),
        })
      ).status,
    ).toBe(400);
    const imported = await request('/api/maic/demo', {
      method: 'POST',
      headers,
      body: JSON.stringify({ scope, confirmDemoImport: true }),
    });
    expect(imported.status).toBe(200);
    const { data } = (await imported.json()) as { data: { stageId: string } };
    const documentUrl = `/api/maic/documents/${data.stageId}`;
    const document = await request(documentUrl, {}, headers);
    expect(document.status).toBe(200);
    const doc = (await document.json()) as {
      scenes: Array<{ type: string; content: { questions?: Array<Record<string, unknown>> } }>;
    };
    expect(doc.scenes.find((s) => s.type === 'quiz')?.content.questions?.[0]).not.toHaveProperty(
      'answer',
    );
    expect((await request(documentUrl, {}, { 'x-sew-session': sessionToken })).status).toBe(400);
    const reopened = await request('/internal/project', {
      method: 'POST',
      headers: trusted,
      body: JSON.stringify({ action: 'open', path: projectA }),
    });
    expect(reopened.status).toBe(200);
    const stale = await request(documentUrl, { method: 'DELETE', headers });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'PROJECT_GENERATION_STALE' } });
  }, 15000);

  it('production backup and restore preserve project state and reject a corrupt container without changing the current session', async () => {
    const trusted = {
      origin,
      'content-type': 'application/json',
      'x-sew-session': sessionToken,
      'x-sew-control': controlToken,
    };
    const open = async (path: string) => {
      const response = await request('/internal/project', {
        method: 'POST',
        headers: trusted,
        body: JSON.stringify({ action: 'open', path }),
      });
      expect(response.status).toBe(200);
      return (await response.json()).data.session as { projectId: string; generation: number };
    };
    const scope = await open(projectB);
    const backupPath = join(tempRoot, 'complete-backup');
    const targetPath = join(tempRoot, 'restored-project');
    const backup = await request('/api/study/backup', {
      method: 'POST',
      headers: trusted,
      body: JSON.stringify({ action: 'backup', scope, targetPath: backupPath }),
    });
    expect(backup.status).toBe(200);
    expect(await backup.json()).toMatchObject({
      ok: true,
      data: {
        projectId: scope.projectId,
        destinationRoot: backupPath,
        fileCount: expect.any(Number),
      },
    });
    expect(JSON.parse(readFileSync(join(backupPath, 'backup.json'), 'utf8'))).toMatchObject({
      containerVersion: 1,
      project: { projectId: scope.projectId },
    });
    const restoreBody = { action: 'restore', scope, backupPath, targetPath };
    const restored = await request('/api/study/backup', {
      method: 'POST',
      headers: trusted,
      body: JSON.stringify(restoreBody),
    });
    expect(restored.status).toBe(200);
    const current = await request('/internal/project', {}, trusted).then((response) =>
      response.json(),
    );
    expect(current.data).toMatchObject(scope);
    const reopened = await open(targetPath);
    expect(reopened.projectId).toBe(scope.projectId);
    expect(reopened.generation).not.toBe(scope.generation);
    const questions = await request(
      '/api/study/questions',
      {},
      { 'x-sew-session': sessionToken },
    ).then((response) => response.json());
    expect(questions.data.questions[0]).toMatchObject({ stem: '测试题目' });
    const existing = await request('/api/study/backup', {
      method: 'POST',
      headers: trusted,
      body: JSON.stringify({ ...restoreBody, scope: reopened }),
    });
    expect(existing.status).toBe(400);
    expect(await existing.json()).toMatchObject({
      error: { details: { reason: 'destination_exists' } },
    });
    writeFileSync(join(backupPath, 'project', 'project.json'), 'corrupt');
    const invalidTarget = join(tempRoot, 'invalid-restore');
    const invalid = await request('/api/study/backup', {
      method: 'POST',
      headers: trusted,
      body: JSON.stringify({ ...restoreBody, scope: reopened, targetPath: invalidTarget }),
    });
    expect(invalid.status).toBe(400);
    expect(existsSync(invalidTarget)).toBe(false);
    expect(
      (await request('/internal/project', {}, trusted).then((response) => response.json())).data,
    ).toMatchObject(reopened);
  }, 20000);
});
