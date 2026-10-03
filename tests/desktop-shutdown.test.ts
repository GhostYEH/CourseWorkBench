import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('desktop shutdown', () => {
  it('stops the owned service even if saving window geometry fails', async () => {
    const exit = vi.fn();
    const stop = vi.fn(async () => undefined);
    const app = Object.assign(new EventEmitter(), {
      commandLine: { getSwitchValue: () => '' },
      // Leave bootstrap idle; exercise the registered exit handler directly.
      whenReady: () => new Promise<void>(() => undefined),
      exit,
    });
    const diagnostic = vi.fn();
    const modules: Record<string, unknown> = {
      electron: { app },
      'node:fs': {},
      'node:path': { resolve },
      '@sew/study-contracts/ipc-channels.json': {},
      './settings.cjs': { createSettings: () => ({}) },
      './service-lifecycle.cjs': { createServiceLifecycle: () => ({ getService: () => ({}), stop }) },
      './project-coordinator.cjs': {
        createProjectCoordinator: () => ({ waitForGrants: async () => undefined, current: () => null }),
      },
      './window.cjs': {
        createWindowController: () => ({ persistGeometry: () => { throw new Error('ENOSPC'); } }),
      },
      './native-handlers.cjs': {},
    };
    runInNewContext(readFileSync(resolve('apps/desktop/src/main.cjs'), 'utf8'), {
      require: (name: string) => {
        if (!(name in modules)) throw new Error(`Unexpected module: ${name}`);
        return modules[name];
      },
      console: { error: diagnostic },
    });
    const preventDefault = vi.fn();
    app.emit('before-quit', { preventDefault });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith(
      '[desktop] unable to save window geometry before exit', expect.objectContaining({ message: 'ENOSPC' }),
    );
  });
});
