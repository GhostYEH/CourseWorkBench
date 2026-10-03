import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createWindowController } = require('../apps/desktop/src/window.cjs');
const { createSettings } = require('../apps/desktop/src/settings.cjs');

class FakeWindow extends EventEmitter {
  bounds = { x: 1, y: 2, width: 1440, height: 960 };
  destroyed = false;
  maximized = false;
  webContents = Object.assign(new EventEmitter(), {
    id: 10,
    setWindowOpenHandler: vi.fn(),
    session: { webRequest: { onBeforeSendHeaders: vi.fn() } },
  });
  getNormalBounds() { return this.bounds; }
  isDestroyed() { return this.destroyed; }
  isMaximized() { return this.maximized; }
  maximize() { this.maximized = true; }
  show() {}
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('desktop window geometry persistence', () => {
  it('coalesces movement and resize events, and flushes the latest bounds on close', () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), 'sew-window-'));
    try {
      const settings = createSettings({ app: { getPath: () => directory }, safeStorage: {} });
      settings.writeState({ window: null, recentProjects: [{ path: 'keep-project' }], other: 'keep-setting' });
      const persist = vi.spyOn(settings, 'persistWindowGeometry');
      const controller = createWindowController({
        BrowserWindow: FakeWindow, shell: {}, settings, getServiceReady: () => null,
      });
      const window: FakeWindow = controller.create();
      for (let x = 0; x < 20; x += 1) {
        window.bounds.x = x;
        window.emit('move');
        window.emit('resize');
      }
      expect(persist).not.toHaveBeenCalled();
      vi.advanceTimersByTime(250);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(settings.readWindowGeometry().x).toBe(19);

      window.bounds = { x: 42, y: 43, width: 1200, height: 800 };
      window.maximized = true;
      window.emit('resize');
      window.emit('close');
      window.destroyed = true;
      window.emit('closed');
      vi.advanceTimersByTime(1000);
      expect(persist).toHaveBeenCalledTimes(2);
      expect(settings.readState()).toEqual({
        window: { ...window.bounds, maximized: true },
        recentProjects: [{ path: 'keep-project' }], other: 'keep-setting',
      });
      expect(readFileSync(join(directory, 'desktop-state.json'), 'utf8')).toContain('keep-project');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('flushes a pending save explicitly for app shutdown', () => {
    vi.useFakeTimers();
    const settings = { readWindowGeometry: () => null, persistWindowGeometry: vi.fn() };
    const controller = createWindowController({
      BrowserWindow: FakeWindow, shell: {}, settings, getServiceReady: () => null,
    });
    const window: FakeWindow = controller.create();
    window.emit('move');
    controller.persistGeometry();
    expect(settings.persistWindowGeometry).toHaveBeenCalledWith(window);
    vi.advanceTimersByTime(1000);
    expect(settings.persistWindowGeometry).toHaveBeenCalledTimes(1);
  });

  it('continues after geometry writes fail during movement and close', () => {
    vi.useFakeTimers();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const settings = {
      readWindowGeometry: () => null,
      persistWindowGeometry: vi.fn(() => { throw new Error('ENOSPC'); }),
    };
    const controller = createWindowController({
      BrowserWindow: FakeWindow, shell: {}, settings, getServiceReady: () => null,
    });
    const window: FakeWindow = controller.create();
    window.emit('move');
    expect(() => vi.advanceTimersByTime(250)).not.toThrow();
    expect(() => window.emit('close')).not.toThrow();
    expect(() => controller.persistGeometry()).not.toThrow();
    expect(diagnostic).toHaveBeenCalledTimes(3);
  });
});
