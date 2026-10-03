import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
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
