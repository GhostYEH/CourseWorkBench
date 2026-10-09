import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { studyNextStep, type StudyProgress } from '../apps/learning/lib/study-next-step';

const require = createRequire(import.meta.url);
const { createSettings } = require('../apps/desktop/src/settings.cjs');

describe('desktop learning space selection', () => {
  it('keeps a recovery entrance when opening the remembered space fails', async () => {
    let bootstrap: (() => Promise<void>) | undefined;
    const app = Object.assign(new EventEmitter(), {
      commandLine: { getSwitchValue: () => '' },
      whenReady: () => ({
        then: (callback: () => Promise<void>) => {
          bootstrap = callback;
        },
      }),
    });
    const loadURL = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const adopt = vi.fn();
    const rememberProject = vi.fn();
    const start = vi.fn(async () => undefined);
    const window = { loadURL, webContents: { send: vi.fn() } };
    const modules: Record<string, unknown> = {
      electron: { app },
      'node:fs': {},
      'node:path': { resolve },
      '@sew/study-contracts/ipc-channels.json': {},
      './settings.cjs': {
        createSettings: () => ({
          startupProjectRoot: () => 'remembered-space',
          readModelCredentials: () => null,
          rememberProject,
        }),
      },
      './service-lifecycle.cjs': {
        createServiceLifecycle: () => ({
          start,
          getReady: () => ({ origin: 'http://127.0.0.1:12345' }),
          request: async () => {
            throw new Error('PROJECT_FORMAT_UNSUPPORTED');
          },
        }),
      },
      './project-coordinator.cjs': {
        createProjectCoordinator: () => ({ adopt, close, current: () => null }),
      },
      './window.cjs': { createWindowController: () => ({ create: () => window }) },
      './native-handlers.cjs': { registerNativeHandlers: () => undefined },
    };
    runInNewContext(readFileSync(resolve('apps/desktop/src/main.cjs'), 'utf8'), {
      require: (name: string) => {
        if (!(name in modules)) throw new Error(`Unexpected module: ${name}`);
        return modules[name];
      },
      process: { env: {} },
    });
    await bootstrap!();
    expect(start).toHaveBeenCalledWith('remembered-space');
    expect(close).toHaveBeenCalledOnce();
    expect(loadURL).toHaveBeenCalledWith('http://127.0.0.1:12345/no-project?recovery=1');
    expect(adopt).not.toHaveBeenCalled();
    expect(rememberProject).not.toHaveBeenCalled();
  });
  it('uses a stable app-owned space on first launch, then restores existing selected data', () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-study-entry-'));
    try {
      const settings = createSettings({ app: { getPath: () => root }, safeStorage: {} });
      expect(settings.startupProjectRoot()).toBe(join(root, 'study-spaces', '我的备考'));
      const existing = join(root, '已有数学备考');
      mkdirSync(existing);
      writeFileSync(join(existing, 'project.json'), '{}');
      settings.writeState({
        recentProjects: [
          null,
          { path: 'relative-path' },
          { path: join(root, 'deleted') },
          { path: join(existing, 'project.json') },
          { path: existing },
        ],
      });
      expect(settings.startupProjectRoot()).toBe(existing);
      // Reading startup selection neither edits data nor removes recovery history.
      expect(settings.readRecentProjects()).toHaveLength(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('next study action', () => {
  const ready: StudyProgress = {
    hasGoal: true,
    materials: 1,
    pending: 0,
    admitted: 2,
    hasPlan: true,
    hasClassroom: true,
  };
  it('points a fresh learner to goals and then materials, without a directory prerequisite', () => {
    expect(studyNextStep({ ...ready, hasGoal: false }).href).toBe('#study-goal-entry');
    expect(studyNextStep({ ...ready, materials: 0 }).href).toBe('/workbench/materials');
  });
  it('requires usable knowledge even when a historical plan and classroom exist', () => {
    expect(studyNextStep({ ...ready, admitted: 0, pending: 1 }).href).toBe('/workbench/review');
    expect(studyNextStep({ ...ready, admitted: 0 }).href).toBe(
      '/workbench/knowledge?tab=candidates',
    );
  });
  it('does not block usable content on unrelated pending knowledge', () => {
    expect(studyNextStep({ ...ready, pending: 5, hasPlan: false }).href).toBe('/workbench/plan');
    expect(studyNextStep({ ...ready, hasClassroom: false }).action).toBe('准备课程');
    expect(studyNextStep(ready).action).toBe('进入课堂');
  });
});
