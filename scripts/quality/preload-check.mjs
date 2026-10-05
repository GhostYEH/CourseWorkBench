import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

/** Exercise the generated preload in a sandbox and verify the complete IPC contract. */
export const checkPreload = async (root) => {
  const preloadPath = path.join(root, 'apps/desktop/src/preload.cjs');
  const preload = await readFile(preloadPath, 'utf8');
  const expectedChannels = JSON.parse(
    await readFile(path.join(root, 'packages/study-contracts/ipc-channels.json'), 'utf8'),
  );
  const actualRequires = [...preload.matchAll(/\brequire\((['"])(.*?)\1\)/g)].map(
    (match) => match[2],
  );
  assert.deepEqual(
    actualRequires,
    ['electron'],
    'sandbox preload may require only Electron built-ins',
  );

  let exposedName;
  let exposedApi;
  const calls = [];
  const listeners = new Map();
  const removedListeners = [];
  const sandbox = {
    process: { platform: 'test-platform' },
    require(name) {
      assert.equal(name, 'electron', 'sandbox preload attempted a non-Electron require');
      return {
        contextBridge: {
          exposeInMainWorld(name, api) {
            exposedName = name;
            exposedApi = api;
          },
        },
        ipcRenderer: {
          on: (channel, listener) => {
            calls.push(channel);
            listeners.set(channel, listener);
          },
          removeListener: (channel, listener) => {
            removedListeners.push([channel, listener]);
            if (listeners.get(channel) === listener) listeners.delete(channel);
          },
          invoke: (channel) => {
            calls.push(channel);
          },
          send: (channel) => calls.push(channel),
        },
      };
    },
  };
  vm.runInNewContext(preload, sandbox, { filename: preloadPath });
  assert.equal(exposedName, 'sewNative');
  assert.ok(exposedApi && typeof exposedApi === 'object');
  assert.equal(exposedApi.platform, 'test-platform');
  assert.ok(!('ipcRenderer' in exposedApi), 'raw ipcRenderer must not cross contextBridge');

  const apiChannels = [
    ['onServiceReady', expectedChannels.serviceReady],
    ['onServiceStatus', expectedChannels.serviceStatus],
    ['getServiceState', expectedChannels.serviceStatus],
    ['onProjectChanged', expectedChannels.projectOpen],
    ['projectCreate', expectedChannels.projectCreate],
    ['projectOpen', expectedChannels.projectOpen],
    ['projectClose', expectedChannels.projectClose],
    ['projectRecent', expectedChannels.projectRecent],
    ['pickMaterials', expectedChannels.materialsPickFiles],
    ['openMaterialOriginal', expectedChannels.materialsOpenOriginal],
    ['pickExportTarget', expectedChannels.exportsPickTarget],
    ['backupProject', expectedChannels.exportsBackupProject],
    ['restoreProject', expectedChannels.exportsRestoreProject],
    ['readPreferences', expectedChannels.preferencesRead],
    ['savePreferences', expectedChannels.preferencesSave],
    ['configureModel', expectedChannels.modelsConfigure],
    ['testModel', expectedChannels.modelsTest],
    ['minimizeWindow', expectedChannels.windowMinimize],
    ['toggleMaximizeWindow', expectedChannels.windowToggleMaximize],
    ['closeWindow', expectedChannels.windowClose],
  ];
  for (const [method, channel] of apiChannels) {
    assert.ok(
      Object.values(expectedChannels).includes(channel),
      `${method} uses a channel outside the IPC contract`,
    );
    if (method.startsWith('on')) exposedApi[method](() => {});
    else exposedApi[method]();
  }
  assert.deepEqual(
    calls,
    apiChannels.map(([, channel]) => channel),
  );
  for (const method of ['onServiceReady', 'onServiceStatus', 'onProjectChanged']) {
    const channel = apiChannels.find(([name]) => name === method)[1];
    const unsubscribe = exposedApi[method](() => {});
    const listener = listeners.get(channel);
    unsubscribe();
    assert.ok(
      removedListeners.some(
        ([removedChannel, removedListener]) =>
          removedChannel === channel && removedListener === listener,
      ),
      `${method} unsubscribe did not remove its IPC listener`,
    );
  }

  const contractChannels = Object.values(expectedChannels);
  for (const channel of contractChannels) {
    assert.ok(
      calls.includes(channel),
      `IPC 通道 ${channel} 在合同里声明但没有任何 preload 方法使用`,
    );
  }

  return apiChannels.length;
};
