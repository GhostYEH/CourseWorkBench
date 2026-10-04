import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createServiceLifecycle } = require('../apps/desktop/src/service-lifecycle.cjs');
const { registerNativeHandlers } = require('../apps/desktop/src/native-handlers.cjs');
const channels = require('../packages/study-contracts/ipc-channels.json');

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill() {
    this.exitCode = 0;
    this.emit('exit', 0, null);
    return true;
  }
}

const makeLifecycle = (child: FakeChild, onStatus = vi.fn()) => {
  const spawn = vi.fn(() => child);
  const lifecycle = createServiceLifecycle({
    app: { isPackaged: false, getPath: () => 'user-data' },
    onStatus,
    spawn,
  });
  return { lifecycle, onStatus, spawn };
};

const publishReady = (child: FakeChild) => {
  child.stdout.write(`${JSON.stringify({
    type: 'ready',
    origin: 'http://127.0.0.1:43127',
    port: 43127,
    sessionToken: 'session-secret',
    controlToken: 'control-secret',
    serviceInstanceId: 'service-id',
  })}\n`);
};

afterEach(() => vi.unstubAllGlobals());

describe('desktop local service lifecycle status', () => {
  it('keeps the ready snapshot after startup so hydration can recover a missed event', async () => {
    const child = new FakeChild();
    const { lifecycle, onStatus } = makeLifecycle(child);
    const starting = lifecycle.start('');

    publishReady(child);
    await starting;

    expect(lifecycle.getStatus()).toEqual({ state: 'ready', message: '本地服务已就绪。', port: 43127, revision: 2 });
    expect(lifecycle.getKnownOrigin()).toBe('http://127.0.0.1:43127');
    expect(lifecycle.getReady()).toMatchObject({ sessionToken: 'session-secret', controlToken: 'control-secret' });
    expect(onStatus).toHaveBeenLastCalledWith(lifecycle.getStatus());
  });

  it('keeps a crash snapshot and trusted origin after an unexpected exit', async () => {
    const child = new FakeChild();
    const { lifecycle } = makeLifecycle(child);
    const starting = lifecycle.start('');
    publishReady(child);
    await starting;

    child.emit('exit', 17, null);

    expect(lifecycle.getStatus()).toMatchObject({ state: 'crashed', port: null });
    expect(lifecycle.getStatus().revision).toBeGreaterThan(2);
    expect(lifecycle.getStatus().message).toContain('可重新启动或退出后重开应用');
    expect(lifecycle.getReady()).toBeNull();
    expect(lifecycle.getKnownOrigin()).toBe('http://127.0.0.1:43127');
  });

  it('reports an intentional stop as stopped, not crashed', async () => {
    const child = new FakeChild();
    const { lifecycle } = makeLifecycle(child);
    const starting = lifecycle.start('');
    publishReady(child);
    await starting;

    vi.stubGlobal('fetch', vi.fn(async () => {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      });
      return { json: async () => ({ ok: true, data: null }) };
    }));

    await lifecycle.stop();

    expect(lifecycle.getStatus()).toEqual({ state: 'stopped', message: '本地服务已停止。', port: null, revision: 3 });
  });

  it('does not label a spawn exception as a runtime crash', async () => {
    const child = new FakeChild();
    const { lifecycle } = makeLifecycle(child);
    const starting = lifecycle.start('');
    child.emit('error', new Error('spawn denied'));

    await expect(starting).rejects.toThrow('spawn denied');
    expect(lifecycle.getStatus().state).toBe('starting');
  });

  it('restores current state only to the authenticated local main frame and strips the control token', async () => {
    const webContents = { id: 7 };
    const window = { webContents };
    let status: { state: string; message: string; port: number | null; revision: number } = {
      state: 'ready', message: '本地服务已就绪。', port: 43127, revision: 2,
    };
    let ready: Record<string, unknown> | null = {
      origin: 'http://127.0.0.1:43127',
      port: 43127,
      sessionToken: 'session-secret',
      controlToken: 'control-secret',
      serviceInstanceId: 'service-id',
    };
    const service = {
      getReady: () => ready,
      getKnownOrigin: () => 'http://127.0.0.1:43127',
      getStatus: () => status,
    };
    const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
    registerNativeHandlers({
      ipcMain: {
        handle: (channel: string, handler: (event: unknown) => Promise<unknown>) => handlers.set(channel, handler),
        on: () => {},
      },
      dialog: {},
      channels,
      getWindow: () => window,
      service,
      projects: {},
      settings: {},
    });
    const getState = handlers.get(channels.serviceStatus)!;
    const event = (url: string, parent: unknown = null) => ({
      sender: webContents,
      senderFrame: { url, parent },
    });

    const initial = await getState(event('http://127.0.0.1:43127/workbench')) as {
      status: unknown;
      ready: Record<string, unknown> | null;
    };
    expect(initial.ready).toMatchObject({ sessionToken: 'session-secret', serviceInstanceId: 'service-id' });
    expect(initial.ready).not.toHaveProperty('controlToken');

    ready = null;
    status = { state: 'crashed', message: 'unexpected exit', port: null, revision: 3 };
    const afterCrash = await getState(event('http://127.0.0.1:43127/workbench')) as { status: { state: string }; ready: unknown };
    expect(afterCrash).toEqual({ status, ready: null });
    await expect(getState(event('file:///index.html'))).rejects.toThrow('本地应用');
    await expect(getState(event('http://127.0.0.1:43127/frame', {}))).rejects.toThrow('主框架');
  });
});

describe('desktop 打开归档原文副本', () => {
  const invokeHandlers = (fixture: {
    projectRoot: string;
    serviceReply: () => unknown;
    opened: string[];
    generation?: number;
  }) => {
    const webContents = { id: 11 };
    const window = { webContents };
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
    const grants: number[] = [];
    registerNativeHandlers({
      ipcMain: {
        handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler),
        on: () => {},
      },
      dialog: {},
      channels,
      getWindow: () => window,
      service: {
        getReady: () => ({ origin: 'http://127.0.0.1:43127' }),
        getKnownOrigin: () => 'http://127.0.0.1:43127',
        getStatus: () => ({ state: 'ready' }),
        request: async () => fixture.serviceReply(),
      },
      projects: {
        current: () => ({
          projectId: 'proj_1', generation: fixture.generation ?? 4, displayPath: fixture.projectRoot,
        }),
        scopeOf: () => ({ projectId: 'proj_1', generation: fixture.generation ?? 4 }),
        sameScope: (left: { projectId: string; generation: number }, right: { projectId: string; generation: number }) =>
          left.projectId === right.projectId && left.generation === right.generation,
        beginGrant: () => {
          grants.push(1);
          return () => grants.pop();
        },
      },
      settings: {},
      shell: { openPath: async (target: string) => { fixture.opened.push(target); return ''; } },
    });
    const call = (request: unknown, ...extra: unknown[]) =>
      handlers.get(channels.materialsOpenOriginal)!({ sender: webContents, senderFrame: { url: 'http://127.0.0.1:43127/workbench', parent: null } }, request, ...extra);
    return { call, grants };
  };

  const temporaryProject = (): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sew-original-')));
    mkdirSync(join(root, 'exports', 'originals'), { recursive: true });
    roots.push(root);
    return root;
  };
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it('打开服务返回且仍在项目内的副本', async () => {
    const root = temporaryProject();
    const copy = join(root, 'exports', 'originals', '原文.md');
    writeFileSync(copy, '原文', 'utf8');
    const opened: string[] = [];
    const { call } = invokeHandlers({ projectRoot: root, opened, serviceReply: () => ({ path: copy, displayName: 'source.md', lineStart: 3, lineEnd: 4 }) });

    await expect(call({ scope: { projectId: 'proj_1', generation: 4 }, materialId: 'mat_1', revision: 1, segmentId: 'S002' }))
      .resolves.toEqual({ displayName: 'source.md', lineStart: 3, lineEnd: 4 });
    expect(opened).toEqual([copy]);
  });

  it('拒绝越出项目根、旧代次与畸形入参', async () => {
    const root = temporaryProject();
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'sew-outside-')));
    const outside = join(outsideDir, 'elsewhere.md');
    writeFileSync(outside, '别的项目', 'utf8');
    roots.push(outsideDir);
    const opened: string[] = [];

    const escaping = invokeHandlers({ projectRoot: root, opened, serviceReply: () => ({ path: outside }) });
    await expect(escaping.call({ scope: { projectId: 'proj_1', generation: 4 }, materialId: 'mat_1', revision: 1 }))
      .rejects.toThrow('不在当前项目内');
    expect(opened).toEqual([]);

    const stale = invokeHandlers({ projectRoot: root, opened, serviceReply: () => ({ path: root }), generation: 5 });
    await expect(stale.call({ scope: { projectId: 'proj_1', generation: 4 }, materialId: 'mat_1', revision: 1 }))
      .rejects.toThrow('项目已切换');

    const noScope = invokeHandlers({ projectRoot: root, opened, serviceReply: () => ({ path: root }) });
    await expect(noScope.call({ materialId: 'mat_1', revision: 1 })).rejects.toThrow('项目身份');
    await expect(noScope.call({ scope: { projectId: 'proj_1', generation: 4 }, materialId: '', revision: 1 })).rejects.toThrow('材料标识');
    await expect(noScope.call({ scope: { projectId: 'proj_1', generation: 4 }, materialId: 'mat_1', revision: 0 })).rejects.toThrow('材料版本');
    await expect(noScope.call({ scope: { projectId: 'proj_1', generation: 4 }, materialId: 'mat_1', revision: 1, segmentId: 7 }))
      .rejects.toThrow('段落标识');
    await expect(noScope.call({ scope: { projectId: 'proj_1', generation: 4 }, materialId: 'mat_1', revision: 1 }, 'extra'))
      .rejects.toThrow('只接受一个参数');
    expect(opened).toEqual([]);
  });
});
