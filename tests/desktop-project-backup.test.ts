import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { registerNativeHandlers } = require('../apps/desktop/src/native-handlers.cjs');
const channels = require('../packages/study-contracts/ipc-channels.json');

const fixture = () => {
  const webContents = { id: 1 };
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
  let scope = { projectId: 'project-a', generation: 1 };
  let grants = 0;
  const dialog = {
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['C:\\backup'] }),
    showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath: 'C:\\new-project' }),
  };
  const request = vi.fn(async (_method: string, _url: string, value: { targetPath: string }) => ({
    destinationRoot: value.targetPath,
  }));
  registerNativeHandlers({
    ipcMain: {
      handle: (
        channel: string,
        handler: (event: unknown, ...args: unknown[]) => Promise<unknown>,
      ) => handlers.set(channel, handler),
      on: () => undefined,
    },
    dialog,
    channels,
    getWindow: () => ({ webContents }),
    service: { getReady: () => ({ origin: 'http://127.0.0.1:43127' }), request },
    projects: {
      current: () => ({ ...scope, displayName: '项目' }),
      scopeOf: () => ({ ...scope }),
      sameScope: (a: typeof scope, b: typeof scope) =>
        a.projectId === b.projectId && a.generation === b.generation,
      beginGrant: () => {
        grants += 1;
        return () => {
          grants -= 1;
        };
      },
    },
    settings: {},
    shell: {},
  });
  return {
    dialog,
    request,
    grants: () => grants,
    switchProject: () => {
      scope = { projectId: 'project-b', generation: 2 };
    },
    call: (method: 'exportsBackupProject' | 'exportsRestoreProject', ...args: unknown[]) =>
      handlers.get(channels[method])!(
        {
          sender: webContents,
          senderFrame: { url: 'http://127.0.0.1:43127/workbench', parent: null },
        },
        ...args,
      ),
  };
};

describe('native project backup selectors and grants', () => {
  it('uses the selected new destination and retains scope during backup', async () => {
    const f = fixture();
    f.request.mockImplementationOnce(async (_method, _url, body) => {
      expect(f.grants()).toBe(1);
      expect(body).toMatchObject({
        action: 'backup',
        scope: { projectId: 'project-a', generation: 1 },
      });
      return { destinationRoot: body.targetPath };
    });
    await expect(f.call('exportsBackupProject')).resolves.toBe('C:\\new-project');
    expect(f.request).toHaveBeenCalledWith(
      'POST',
      '/api/study/backup',
      expect.objectContaining({ targetPath: 'C:\\new-project' }),
      300000,
    );
    expect(f.grants()).toBe(0);
  });

  it('restores to the selected new directory without opening or replacing the current project', async () => {
    const f = fixture();
    await expect(f.call('exportsRestoreProject')).resolves.toBe('C:\\new-project');
    expect(f.request).toHaveBeenCalledWith(
      'POST',
      '/api/study/backup',
      {
        action: 'restore',
        scope: { projectId: 'project-a', generation: 1 },
        backupPath: 'C:\\backup',
        targetPath: 'C:\\new-project',
      },
      300000,
    );
    expect(f.grants()).toBe(0);
  });

  it('does not dispatch when either selector is canceled', async () => {
    const f = fixture();
    f.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(f.call('exportsRestoreProject')).resolves.toBeNull();
    f.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: '' });
    await expect(f.call('exportsBackupProject')).resolves.toBeNull();
    f.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: '' });
    await expect(f.call('exportsRestoreProject')).resolves.toBeNull();
    expect(f.request).not.toHaveBeenCalled();
  });

  it('rejects a project switch while dialogs are open', async () => {
    const f = fixture();
    f.dialog.showSaveDialog.mockImplementationOnce(async () => {
      f.switchProject();
      return { canceled: false, filePath: 'C:\\new-project' };
    });
    await expect(f.call('exportsRestoreProject')).rejects.toThrow('项目已切换');
    expect(f.request).not.toHaveBeenCalled();
  });

  it('accepts a service reply that only differs by path normalization and rejects another directory', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'sew-native-backup-path-'));
    try {
      const published = join(realpathSync(workspace), 'published');
      mkdirSync(published);
      const spelled = join(workspace, '..', basename(workspace), 'published');
      const f = fixture();
      f.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: spelled });
      f.request.mockImplementationOnce(async () => ({ destinationRoot: published }));
      await expect(f.call('exportsBackupProject')).resolves.toBe(spelled);

      const g = fixture();
      g.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: spelled });
      g.request.mockImplementationOnce(async () => ({
        destinationRoot: join(realpathSync(workspace), 'elsewhere'),
      }));
      await expect(g.call('exportsBackupProject')).rejects.toThrow('未确认项目备份结果');
      expect(g.grants()).toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('releases the grant after a service failure and rejects renderer paths', async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error('checksum invalid'));
    await expect(f.call('exportsBackupProject')).rejects.toThrow('checksum invalid');
    expect(f.grants()).toBe(0);
    await expect(f.call('exportsRestoreProject', 'C:\\arbitrary')).rejects.toThrow('不接受参数');
    expect(f.dialog.showOpenDialog).not.toHaveBeenCalled();
  });
});
