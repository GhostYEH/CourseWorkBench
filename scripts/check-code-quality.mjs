import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(process.execPath, ['scripts/generate-preload.mjs', '--check']);

async function collectSources(directory, extensions) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.next', 'dist', 'release'].includes(entry.name)) return [];
      return collectSources(entryPath, extensions);
    }
    return entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension)) ? [entryPath] : [];
  }));
  return paths.flat();
}

const sourceFiles = [
  ...(await collectSources(path.join(root, 'apps/desktop/src'), ['.cjs', '.mjs'])),
  ...(await collectSources(path.join(root, 'scripts'), ['.mjs', '.cjs'])),
  path.join(root, 'apps/learning/server.mjs'),
];
for (const file of sourceFiles) {
  run(process.execPath, ['--check', file]);
}

const preloadPath = path.join(root, 'apps/desktop/src/preload.cjs');
const preload = await readFile(preloadPath, 'utf8');
const expectedChannels = JSON.parse(
  await readFile(path.join(root, 'packages/study-contracts/ipc-channels.json'), 'utf8'),
);
const actualRequires = [...preload.matchAll(/\brequire\((['"])(.*?)\1\)/g)].map((match) => match[2]);
assert.deepEqual(actualRequires, ['electron'], 'sandbox preload may require only Electron built-ins');

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
        invoke: (channel) => { calls.push(channel); },
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
  ['readPreferences', expectedChannels.preferencesRead],
  ['savePreferences', expectedChannels.preferencesSave],
  ['configureModel', expectedChannels.modelsConfigure],
  ['testModel', expectedChannels.modelsTest],
  ['minimizeWindow', expectedChannels.windowMinimize],
  ['toggleMaximizeWindow', expectedChannels.windowToggleMaximize],
  ['closeWindow', expectedChannels.windowClose],
];
for (const [method, channel] of apiChannels) {
  assert.ok(Object.values(expectedChannels).includes(channel), `${method} uses a channel outside the IPC contract`);
  if (method.startsWith('on')) exposedApi[method](() => {});
  else exposedApi[method]();
}
assert.deepEqual(calls, apiChannels.map(([, channel]) => channel));
for (const method of ['onServiceReady', 'onServiceStatus', 'onProjectChanged']) {
  const channel = apiChannels.find(([name]) => name === method)[1];
  const unsubscribe = exposedApi[method](() => {});
  const listener = listeners.get(channel);
  unsubscribe();
  assert.ok(removedListeners.some(([removedChannel, removedListener]) => removedChannel === channel && removedListener === listener),
    `${method} unsubscribe did not remove its IPC listener`);
}

// ——————————————————————— 可执行边界检查（N9） ———————————————————————
// 说明：这里不是完整 ESLint/Prettier 替代，只做「可执行、零依赖」的语义边界回归：
// 1) 分层依赖方向；2) JSON 解析集中化；3) IPC 通道声明与使用同步。

const relPath = (file) => path.relative(root, file).split(path.sep).join('/');

const importSpecifiers = (source) => [
  ...[...source.matchAll(/\bfrom\s+(['"])(.*?)\1/g)].map((match) => match[2]),
  ...[...source.matchAll(/\brequire\((['"])(.*?)\1\)/g)].map((match) => match[2]),
  ...[...source.matchAll(/\bimport\((['"])(.*?)\1\)/g)].map((match) => match[2]),
];

const LAYER_RULES = [
  {
    prefix: 'packages/study-contracts/',
    label: 'study-contracts 只保存共享类型，不得反向依赖领域/存储或框架',
    forbid: ['@sew/study-domain', '@sew/study-storage', 'electron', 'react', 'react-dom', 'next', 'zustand', 'node:fs', 'node:sqlite'],
  },
  {
    prefix: 'packages/study-domain/',
    label: 'study-domain 只做判断，不得依赖框架、存储或文件系统 IO',
    forbid: ['@sew/study-storage', 'electron', 'react', 'react-dom', 'next', 'zustand', 'node:fs', 'node:sqlite'],
  },
  {
    prefix: 'packages/study-storage/',
    label: 'study-storage 不得依赖 Electron/React/Next 或应用层',
    forbid: ['electron', 'react', 'react-dom', 'next', 'zustand', '/apps/'],
  },
  {
    prefix: 'apps/desktop/src/',
    label: 'Electron 主进程不得打开数据库或依赖领域/存储包',
    forbid: ['@sew/study-storage', '@sew/study-domain'],
  },
];

const layerFiles = [
  ...(await collectSources(path.join(root, 'packages'), ['.ts'])),
  ...(await collectSources(path.join(root, 'apps/desktop/src'), ['.cjs'])),
];
for (const file of layerFiles) {
  const rel = relPath(file);
  const rule = LAYER_RULES.find((candidate) => rel.startsWith(candidate.prefix));
  if (!rule) continue;
  const source = await readFile(file, 'utf8');
  for (const specifier of importSpecifiers(source)) {
    const hit = rule.forbid.find((banned) =>
      banned.startsWith('/') ? specifier.includes(banned) : specifier === banned || specifier.startsWith(`${banned}/`),
    );
    assert.ok(!hit, `${rel} 违反了分层约束（${rule.label}）：import/require "${specifier}"`);
  }
}

// JSON 解析必须集中：这些是经校验或属于受控握手/工具链的唯一允许点。
const JSON_PARSE_ALLOWLIST = new Set([
  // 多选答案是跨 HTTP 的 JSON 文本，在评分入口解析后立即做严格 schema 校验。
  'packages/study-domain/src/assessment.ts',
  'packages/study-storage/src/json-codec.ts',
  'packages/study-storage/src/project-layout.ts',
  'apps/learning/lib/attempt-submission.ts',
  // 课堂多选草稿恢复：JSON 解码后校验选项值，拒绝损坏数据。
  'apps/learning/lib/quiz-answer.ts',
  // Model output is decoded at this single boundary and validated as a grading proposal.
  'apps/learning/lib/server/attempt-grading-model.ts',
  // 同一模式：错因/复习候选的模型正文只在这里解码，随后立刻用严格 schema 校验。
  'apps/learning/lib/server/feedback-model.ts',
  'apps/learning/lib/server/global-preferences.ts',
  // User identity files are decoded only here, then validated by the strict shared schema.
  'apps/learning/lib/server/learner-profile.ts',
  'apps/learning/lib/server/model-connection.ts',
  'apps/desktop/src/service-lifecycle.cjs',
  'apps/desktop/src/settings.cjs',
]);
const appSources = [
  ...(await collectSources(path.join(root, 'packages'), ['.ts'])),
  ...(await collectSources(path.join(root, 'apps/learning'), ['.ts', '.tsx'])),
  ...(await collectSources(path.join(root, 'apps/desktop/src'), ['.cjs'])),
].filter((file) => !relPath(file).includes('/dist/'));
for (const file of appSources) {
  const rel = relPath(file);
  const source = await readFile(file, 'utf8');
  if (!/\bJSON\.parse\s*\(/.test(source)) continue;
  assert.ok(
    JSON_PARSE_ALLOWLIST.has(rel),
    `${rel} 直接使用了 JSON.parse；请改用 json-codec 或先经 schema 校验，并把它加入允许清单`,
  );
}

// IPC 通道声明与使用同步：ipc-channels.json 的每个通道都必须被 preload 白名单使用。
const contractChannels = Object.values(expectedChannels);
for (const channel of contractChannels) {
  assert.ok(
    calls.includes(channel),
    `IPC 通道 ${channel} 在合同里声明但没有任何 preload 方法使用`,
  );
}

console.log(`Code quality checks passed (${apiChannels.length} whitelisted preload methods).`);
