#!/usr/bin/env node
/**
 * PACK-01 directory-package launch verification.
 *
 * Launches the real packaged Electron executable (therefore the packaged
 * src/main.cjs), observes its main-frame renderer over loopback CDP, checks the
 * rendered production SSR and anonymous SSR rejection, and closes the window
 * through the existing preload capability. It records status only; never
 * persists service credentials or CDP messages.
 *
 * Run after electron-builder --dir, from a copy of the unpacked directory at a
 * path containing Chinese characters and spaces:
 *   node scripts/verify-packaged-desktop.mjs --app-dir "C:\\...\\学科备考 测试\\win-unpacked"
 */

import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { runtimePackageMetadata, sha256File, verifyServiceManifest } from './freshness.mjs';

const nextRequire = createRequire(join(fileURLToPath(new URL('..', import.meta.url)), 'apps', 'learning', 'package.json'));
const WebSocket = nextRequire('next/dist/compiled/ws');
const desktopRequire = createRequire(join(fileURLToPath(new URL('..', import.meta.url)), 'apps', 'desktop', 'package.json'));
const electronBuilderPackage = desktopRequire.resolve('electron-builder/package.json');
const asar = createRequire(electronBuilderPackage)('@electron/asar');

const parseArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const sourceAppDir = resolve(parseArg('--app-dir') || join(
  fileURLToPath(new URL('..', import.meta.url)),
  'apps', 'desktop', 'release', 'win-unpacked',
));
const tempBase = resolve(tmpdir());
const tempDir = mkdtempSync(join(tempBase, '学科备考 PACK01 验证-'));
const appDir = join(tempDir, '目录包 中文 路径');
const executable = join(appDir, '学科备考工作台.exe');
const packagedNode = join(appDir, 'resources', 'node', 'runtime', 'node.exe');
const packagedServer = join(appDir, 'resources', 'learning', 'server.mjs');
const packagedServiceRoot = join(appDir, 'resources', 'learning');
const reportFile = resolve(parseArg('--report') || join(
  fileURLToPath(new URL('..', import.meta.url)),
  'apps', 'desktop', 'release', `pack01-verification-${new Date().toISOString().replaceAll(':', '-')}.json`,
));
const appDataDir = join(tempDir, 'Roaming');
const localAppDataDir = join(tempDir, 'Local');
const userDataDir = join(tempDir, '应用用户数据');
const tempMarker = tempDir.slice(tempDir.lastIndexOf('-') + 1).toLowerCase();
mkdirSync(appDataDir, { recursive: true });
mkdirSync(localAppDataDir, { recursive: true });
mkdirSync(userDataDir, { recursive: true });

const checks = [];
let child;
let spawnError;
let socket;
let stderrChunks = [];
let processStarted = false;
let rendererSeen = false;
let isolatedProfileVerified = false;
let cleanNodeEnvironmentApplied = false;
let serviceReadyVerified = false;
let chromiumProfileArgVerified = false;
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};
const assertFile = (file, name) => record(name, existsSync(file), file);

const desktopSourceFiles = () => {
  const sourceDir = join(fileURLToPath(new URL('..', import.meta.url)), 'apps', 'desktop', 'src');
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith('.cjs')) files.push(full);
    }
  };
  visit(sourceDir);
  return files.sort();
};

const verifyAsarSources = (asarFile) => {
  const sourceRoot = join(fileURLToPath(new URL('..', import.meta.url)), 'apps', 'desktop');
  const results = [];
  for (const sourceFile of desktopSourceFiles()) {
    const relativePath = relative(sourceRoot, sourceFile).split(sep).join('/');
    try {
      const packed = asar.extractFile(asarFile, relativePath);
      const sourceHash = sha256File(sourceFile);
      const packedHash = createHash('sha256').update(packed).digest('hex');
      results.push({ path: relativePath, ok: sourceHash === packedHash });
    } catch {
      results.push({ path: relativePath, ok: false });
    }
  }
  try {
    const sourcePackage = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'));
    const packedPackage = JSON.parse(asar.extractFile(asarFile, 'package.json').toString('utf8'));
    results.push({ path: 'package.json (runtime metadata)',
      ok: isDeepStrictEqual(packedPackage, runtimePackageMetadata(sourcePackage)) });
  } catch {
    results.push({ path: 'package.json (runtime metadata)', ok: false });
  }
  const failed = results.filter((item) => !item.ok);
  record('app.asar 内桌面 CJS 与 package.json 匹配当前源码', failed.length === 0,
    failed.length ? failed.map((item) => item.path).join(', ')
      : `${results.length - 1} CJS SHA-256 matched; runtime package metadata matched`);
  return failed.length === 0;
};

const copyTree = (source, target) => {
  mkdirSync(target, { recursive: true });
  let files = 0;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) files += copyTree(from, to);
    else if (entry.isFile() || (entry.isSymbolicLink() && statSync(from).isFile())) {
      copyFileSync(from, to);
      files += 1;
    } else {
      throw new Error(`目录包复制遇到不支持的条目：${from}`);
    }
  }
  return files;
};

const getFreePort = async () => new Promise((resolvePromise, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolvePromise(address.port));
  });
});

const chromiumProfileArguments = (parentPid) => {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const query = `$profileArgs = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parentPid}" | ForEach-Object {
  $commandLine = [string]$_.CommandLine
  $match = [regex]::Match($commandLine, '(?:^|\\s)--user-data-dir=(?:"([^"]+)"|([^\\s]+))')
  if ($match.Success) {
    $value = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value))
  }
}
ConvertTo-Json -InputObject @($profileArgs) -Compress`;
  const lines = execFileSync(powershell, ['-NoProfile', '-Command', query], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const parsed = JSON.parse(lines.trim() || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed])
    .filter((value) => typeof value === 'string')
    .map((value) => Buffer.from(value, 'base64').toString('utf8'));
};

const normalizedPath = (value) => resolve(value).replaceAll('/', '\\').toLowerCase();

const isWithin = (root, candidate) => {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const waitFor = async (fn, timeoutMs, label) => {
  const end = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`${label} timeout${lastError ? `: ${lastError.message}` : ''}`);
};

const cdp = async (method, params = {}) => {
  const id = ++cdp.id;
  const responsePromise = new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cdp.pending.delete(id);
      reject(new Error(`CDP timeout: ${method} (readyState ${socket?.readyState}, received ${cdp.received})`));
    }, 10000);
    cdp.pending.set(id, { resolve: resolvePromise, reject, timer });
  });
  socket.send(JSON.stringify({ id, method, params }));
  const response = await responsePromise;
  if (response.error) throw new Error(`CDP ${method}: ${response.error.message}`);
  return response.result;
};
cdp.id = 0;
cdp.pending = new Map();
cdp.received = 0;
cdp.parseDropped = 0;

const evaluate = async (expression) => {
  const result = await cdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error('renderer evaluation failed');
  return result.result?.value;
};

const cleanup = async () => {
  let childStopped = !child || child.exitCode !== null;
  try {
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  } catch (error) {
    record('关闭 CDP 连接', false, error instanceof Error ? error.message : 'unknown error');
  }
  const abs = resolve(tempDir);
  const tempPrefix = tempBase.endsWith(sep) ? tempBase : `${tempBase}${sep}`;
  try {
    if (child && child.exitCode === null && child.pid) {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        await Promise.race([
          new Promise((resolvePromise) => {
            killer.once('exit', resolvePromise);
            killer.once('error', resolvePromise);
          }),
          new Promise((resolvePromise) => setTimeout(resolvePromise, 5000)),
        ]);
      } else {
        try { child.kill('SIGTERM'); } catch { /* already exited */ }
      }
      if (child.exitCode === null) {
        await Promise.race([
          new Promise((resolvePromise) => child.once('exit', resolvePromise)),
          new Promise((resolvePromise) => setTimeout(resolvePromise, 5000)),
        ]);
      }
      childStopped = child.exitCode !== null;
      if (!childStopped) {
        record('强制清理进程退出', false, '进程在 taskkill/退出等待上限后仍存活');
      }
    }
  } catch (error) {
    record('清理 Electron 进程', false, error instanceof Error ? error.message : 'unknown error');
    childStopped = !child || child.exitCode !== null;
  }
  try {
    if (!childStopped) {
      record('清理本次隔离临时目录', false, 'Electron 进程仍存活，为避免删除其正在使用的 profile 已保留');
    } else if (abs.startsWith(tempPrefix) && abs.includes('学科备考 PACK01 验证-')) {
      rmSync(abs, { recursive: true, force: true });
      record('清理本次隔离临时目录', true, '已删除临时目录及 profile');
    } else {
      record('清理本次隔离临时目录', false, '临时目录路径保护校验失败，已保留');
    }
  } catch (error) {
    record('清理本次隔离临时目录', false, error instanceof Error ? error.message : 'unknown error');
  }
  try {
    mkdirSync(dirname(reportFile), { recursive: true });
    writeFileSync(reportFile, `${JSON.stringify({
      date: new Date().toISOString(),
      mode: 'electron-builder --win --x64 --dir',
      sourceAppDir,
      appDir,
      pathContainsChineseAndSpaces: /[^\x00-\x7F]/.test(appDir) && appDir.includes(' '),
      launchedActualPackagedExecutable: processStarted,
      isolatedAppData: isolatedProfileVerified,
      cleanNodeEnvironment: cleanNodeEnvironmentApplied,
      serviceReady: serviceReadyVerified,
      rendererSeen,
      chromiumProfileArg: chromiumProfileArgVerified,
      cdpReceived: cdp.received,
      cdpParseDropped: cdp.parseDropped,
      cdpError: cdp.lastError || null,
      checks,
    }, null, 2)}\n`, 'utf8');
    console.log(`Verification report: ${reportFile}`);
  } catch (error) {
    process.exitCode = 1;
    console.error(`Unable to write verification report ${reportFile}: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
};

try {
  assertFile(join(sourceAppDir, '学科备考工作台.exe'), 'electron-builder 目录包输入存在');
  const copiedFiles = copyTree(sourceAppDir, appDir);
  record('目录包已复制到中文空格隔离路径', copiedFiles > 0, `${copiedFiles} files`);
  assertFile(executable, '目录包 Electron 主程序存在');
  assertFile(packagedNode, '目录包随包 Node 存在');
  assertFile(packagedServer, '目录包本地服务入口存在');
  const asarFile = join(appDir, 'resources', 'app.asar');
  assertFile(asarFile, 'Electron app.asar 存在');
  if (existsSync(asarFile)) verifyAsarSources(asarFile);
  try {
    const serviceManifest = verifyServiceManifest(fileURLToPath(new URL('..', import.meta.url)), packagedServiceRoot);
    record('目录包服务与 bundle manifest/当前构建输入一致', true,
      `${serviceManifest.files.length} 包内文件已按 SHA-256 核对`);
  } catch (error) {
    record('目录包服务与 bundle manifest/当前构建输入一致', false,
      error instanceof Error ? error.message : String(error));
  }
  const serviceRequire = createRequire(packagedServer);
  for (const dependency of ['next', 'react', '@swc/helpers/_/_interop_require_default']) {
    try {
      const resolvedDependency = realpathSync(serviceRequire.resolve(dependency));
      record(`目录包依赖可解析 ${dependency}`,
        isWithin(packagedServiceRoot, resolvedDependency),
        isWithin(packagedServiceRoot, resolvedDependency)
          ? resolvedDependency
          : `resolved outside packaged service: ${resolvedDependency}`);
    } catch (error) {
      record(`目录包依赖可解析 ${dependency}`, false,
        `cannot resolve from ${packagedServiceRoot}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  const nativeProbeSource = `
const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');
const { readFileSync } = require('node:fs');
const serviceRoot = process.cwd();
const serviceRequire = createRequire(join(serviceRoot, 'server.mjs'));
const sharpPath = serviceRequire.resolve('sharp');
const sharp = serviceRequire('sharp');
const sharpRequire = createRequire(sharpPath);
const semverPath = sharpRequire.resolve('semver');
const semverVersion = JSON.parse(readFileSync(join(dirname(semverPath), 'package.json'), 'utf8')).version;
sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .png().toBuffer().then((png) => {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    const validPng = signature.every((byte, index) => png[index] === byte);
    process.stdout.write(JSON.stringify({
      validPng,
      pngBytes: png.length,
      sharpPath,
      sharpWithinService: sharpPath.startsWith(serviceRoot),
      semver: semverVersion,
      semverPath,
    }));
    if (!validPng || png.length <= signature.length || !sharpPath.startsWith(serviceRoot) || semverVersion !== '7.8.5') process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(String(error && error.message ? error.message : error));
    process.exitCode = 1;
  });
`;
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const nativeProbe = spawnSync(packagedNode, ['-e', nativeProbeSource], {
    cwd: packagedServiceRoot,
    env: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      PATH: `${systemRoot}\\System32;${systemRoot}`,
      TEMP: tempDir,
      TMP: tempDir,
      NODE_PATH: '',
      NODE_OPTIONS: '',
    },
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  let nativeProbeOk = nativeProbe.status === 0 && !nativeProbe.error;
  let nativeProbeDetail = nativeProbe.stderr?.trim() || `exit ${nativeProbe.status ?? 'null'}`;
  if (nativeProbeOk) {
    try {
      const result = JSON.parse(nativeProbe.stdout);
      nativeProbeOk = result.validPng === true && result.pngBytes > 8 && result.sharpWithinService === true &&
        result.semver === '7.8.5' && isWithin(packagedServiceRoot, realpathSync(result.sharpPath)) &&
        isWithin(packagedServiceRoot, realpathSync(result.semverPath));
      nativeProbeDetail = nativeProbeOk
        ? `包内 sharp 以 semver ${result.semver} 编码 ${result.pngBytes} byte PNG`
        : 'native 编码、包内解析路径、semver 版本或 PNG 签名检查失败';
    } catch {
      nativeProbeOk = false;
      nativeProbeDetail = 'sharp probe 未返回有效 JSON';
    }
  } else if (nativeProbe.error) {
    nativeProbeDetail = `${nativeProbe.error.name}: ${nativeProbe.error.message}`;
  }
  record('随包 Node 隔离环境加载 sharp 并编码 1x1 PNG', nativeProbeOk, nativeProbeDetail);
  record('应用路径含中文和空格', /[^\x00-\x7F]/.test(appDir) && appDir.includes(' '), appDir);
  if (process.exitCode) throw new Error('包资源布局或新鲜度检查失败');

  const debugPort = await getFreePort();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.SEW_NODE_BINARY;
  delete env.SEW_PROJECT_ROOT;
  env.APPDATA = appDataDir;
  env.LOCALAPPDATA = localAppDataDir;
  env.PATH = `${process.env.SystemRoot || 'C:\\Windows'}\\System32;${process.env.SystemRoot || 'C:\\Windows'}`;
  env.NODE_ENV = 'production';
  cleanNodeEnvironmentApplied = !env.NODE_OPTIONS && !env.NODE_PATH && !env.SEW_NODE_BINARY &&
    !env.SEW_PROJECT_ROOT && !env.ELECTRON_RUN_AS_NODE;

  child = spawn(executable, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
  ], {
    cwd: appDir,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.once('spawn', () => { processStarted = true; });
  child.once('error', (error) => {
    spawnError = error;
    stderrChunks.push(`spawn error: ${error.message}`);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderrChunks.push(String(chunk)));
  await waitFor(() => {
    if (spawnError) throw spawnError;
    return processStarted;
  }, 10000, 'Electron process spawn');
  if (!processStarted) throw new Error(`Electron spawn failed: ${stderrChunks.join('').slice(-1000)}`);
  record('主进程由实际目录包 exe 启动', processStarted, '未注入替代主进程或服务');
  record('隔离 profile 和 Node 环境', cleanNodeEnvironmentApplied,
    '显式 user-data-dir/APPDATA/LOCALAPPDATA 指向 temp；PATH 仅含 Windows 系统目录');

  const debuggerBase = `http://127.0.0.1:${debugPort}`;
  const targets = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Electron exited ${child.exitCode}: ${stderrChunks.join('').slice(-1000)}`);
    const response = await fetch(`${debuggerBase}/json/list`);
    if (!response.ok) return null;
    const list = await response.json();
    return list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl &&
      /^http:\/\/127\.0\.0\.1:\d+\/(no-project|workbench)(?:[/?#]|$)/.test(target.url));
  }, 45000, 'Electron renderer');
  rendererSeen = true;
  record('真实 Electron 窗口到达页面', true, `target ${targets.url}`);
  console.log(`CDP target: ${targets.webSocketDebuggerUrl}`);
  const loadedUrl = new URL(targets.url);
  const initialSsr = await fetch(loadedUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  const initialSsrBody = await initialSsr.text();
  serviceReadyVerified = loadedUrl.hostname === '127.0.0.1' && initialSsr.status === 401 && initialSsrBody.includes('SESSION_REQUIRED');
  record('主服务已 ready 且匿名 SSR 返回认证拒绝', serviceReadyVerified,
    `HTTP ${initialSsr.status}; ${loadedUrl.origin}`);
  const profileArgs = chromiumProfileArguments(child.pid);
  chromiumProfileArgVerified = tempMarker.length >= 5 && profileArgs.length > 0 &&
    profileArgs.every((value) => normalizedPath(value) === normalizedPath(userDataDir));
  record('Electron Chromium 子进程使用隔离 user-data-dir', chromiumProfileArgVerified,
    chromiumProfileArgVerified
      ? `${profileArgs.length} 个子进程的 --user-data-dir 与预期路径精确一致`
      : `profile 参数数量 ${profileArgs.length}; 存在缺失或与预期路径不一致`);

  socket = new WebSocket(targets.webSocketDebuggerUrl);
  socket.on('error', () => {
    cdp.lastError = 'websocket error event';
    for (const pending of cdp.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(cdp.lastError));
    }
    cdp.pending.clear();
  });
  socket.on('close', () => {
    cdp.lastError = 'websocket closed';
    for (const pending of cdp.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(cdp.lastError));
    }
    cdp.pending.clear();
  });
  socket.on('message', (data, isBinary) => {
    cdp.received += 1;
    let message;
    try { message = JSON.parse(data.toString('utf8')); } catch {
      cdp.parseDropped += 1;
      cdp.lastFrameBinary = isBinary;
      return;
    }
    if (!message.id) return;
    const pending = cdp.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    cdp.pending.delete(message.id);
    pending.resolve(message);
  });
  await waitFor(() => socket.readyState === WebSocket.OPEN, 10000, 'CDP connection');
  await cdp('Runtime.enable');
  await cdp('Page.enable');

  const pageInfo = await waitFor(async () => {
    const value = await evaluate(`({
      href: location.href,
      readyState: document.readyState,
      body: document.body ? document.body.innerText.slice(0, 1200) : '',
      hasNative: Boolean(window.sewNative),
      hasNode: typeof process !== 'undefined' || typeof require !== 'undefined'
    })`);
    return value?.readyState === 'complete' && value.body ? value : null;
  }, 45000, 'production SSR renderer');

  const parsedUrl = new URL(pageInfo.href);
  const port = Number(parsedUrl.port);
  record('真实主窗口加载 loopback 服务页面', parsedUrl.hostname === '127.0.0.1' && port > 0,
    `${parsedUrl.origin}${parsedUrl.pathname}`);
  record('SSR 页面已渲染', pageInfo.body.length > 0 && !pageInfo.body.includes('NEXT_NOT_FOUND'),
    `body chars ${pageInfo.body.length}`);
  record('页面显示预期工作台/无项目状态',
    /工作台|学习空间|选择项目|新建项目|项目/.test(pageInfo.body),
    '正文包含当前无项目首屏标识');
  record('真实 sandbox preload 已注入', pageInfo.hasNative, 'window.sewNative 可用');
  record('渲染页没有 Node 全局', !pageInfo.hasNode, 'process/require 不可见');

  const health = await evaluate(`fetch('/internal/health').then(async (response) => {
    const value = await response.json();
    return { status: response.status, ready: value?.data?.ready === true, dev: value?.data?.dev === true };
  })`);
  record('主窗口会话可访问生产 health',
    health?.status === 200 && health.ready && !health.dev,
    `HTTP ${health?.status}; ready ${Boolean(health?.ready)}; dev ${Boolean(health?.dev)}`);

  const anonymous = await fetch(`${parsedUrl.origin}/workbench`, { redirect: 'manual' });
  const anonBody = await anonymous.text();
  record('匿名生产 SSR 请求被拒', anonymous.status === 401 && anonBody.includes('SESSION_REQUIRED'),
    `HTTP ${anonymous.status}`);

  const closeInfo = await evaluate(`(() => {
    const methods = ['closeWindow', 'onServiceReady', 'projectOpen'];
    const present = methods.every((name) => typeof window.sewNative?.[name] === 'function');
    if (present) window.sewNative.closeWindow();
    return present;
  })()`);
  record('通过现有 preload 能力请求关闭窗口', closeInfo === true, '未添加测试 IPC 或权限旁路');
  const exitResult = await waitFor(() => child.exitCode !== null ? { code: child.exitCode } : null, 15000, 'Electron shutdown');
  const exitCode = exitResult.code;
  record('退出时主进程完成服务清理并退出', exitCode === 0, `Electron exit ${exitCode}`);

  const remaining = await fetch(`${parsedUrl.origin}/internal/health`, { signal: AbortSignal.timeout(1500) })
    .then(() => true, () => false);
  record('Electron 退出后本地服务端口关闭', !remaining, remaining ? '服务仍能连接' : '连接失败');
  const appStateInIsolatedProfile = existsSync(join(userDataDir, 'desktop-state.json'));
  isolatedProfileVerified = chromiumProfileArgVerified && appStateInIsolatedProfile;
  record('desktop-state.json 写入隔离 profile', appStateInIsolatedProfile,
    appStateInIsolatedProfile ? '应用状态文件位于本次临时 user-data-dir' : '隔离目录未生成 desktop-state.json');
} catch (error) {
  record('运行时启动试验', false, error instanceof Error ? error.message : '未知错误');
  if (stderrChunks.length) console.error(`Electron stderr: ${stderrChunks.join('').slice(-2000)}`);
} finally {
  await cleanup();
}

if (process.exitCode !== 1) {
  console.log(`PASS packaged desktop directory smoke (${checks.filter((item) => item.ok).length}/${checks.length})`);
}
