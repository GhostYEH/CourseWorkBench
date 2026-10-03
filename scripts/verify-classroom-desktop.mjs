#!/usr/bin/env node
/** Real packaged UI, native folder picker, mouse submission and app restart.
 * This exercises the development machine with a clean PATH/profile; it is not
 * a substitute for installation in a separate clean Windows environment.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { compareInventory, SERVICE_MANIFEST, verifyServiceManifest } from './freshness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const nativeOnly = process.argv.includes('--native-only');
const installedApp = arg('--installed-app');
const appDir = resolve(installedApp || arg('--app-dir') || join(root, 'apps/desktop/release/win-unpacked'));
const executable = join(appDir, '学科备考工作台.exe');
const tempRoot = realpathSync(tmpdir());
const workspace = mkdtempSync(join(tempRoot, '学科备考 M0 UI-'));
const projectDir = resolve(arg('--project-dir') || join(workspace, '本人课堂 中文 项目'));
const alternateProjectDir = join(workspace, '切换目标 中文 项目');
const profileDir = join(workspace, '隔离用户数据');
const reportFile = resolve(arg('--report') || join(root, 'apps/desktop/release',
  `m0-classroom-ui-${new Date().toISOString().replaceAll(':', '-')}.json`));
const WebSocket = createRequire(installedApp ? join(appDir, 'resources/learning/server.mjs') : join(root, 'apps/learning/package.json'))('next/dist/compiled/ws');
const checks = [];
let child;
let socket;
let pending = new Map();
let nextId = 0;
let contexts = new Map();
let origin;
let lastStderr = '';
const record = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'ok' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(name);
};
const waitFor = async (fn, name, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`Timed out: ${name}`);
};
const freePort = () => new Promise((done, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    server.close(() => port ? done(port) : reject(new Error('No debug port')));
  });
});
const cdp = (method, params = {}, sessionId) => new Promise((done, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
  pending.set(id, { done, reject, timer });
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const evaluate = async (expression) => {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error('Renderer evaluation failed');
  return result.result?.value;
};
const connect = async () => {
  const port = await freePort();
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'SEW_NODE_BINARY', 'SEW_PROJECT_ROOT']) delete env[name];
  const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
  Object.assign(env, { PATH: `${windowsRoot}\\System32;${windowsRoot}`,
    APPDATA: join(workspace, 'Roaming'), LOCALAPPDATA: join(workspace, 'Local'), NODE_ENV: 'production' });
  child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--no-first-run'], {
    cwd: appDir, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let launchError;
  child.once('error', (error) => { launchError = error; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data) => { lastStderr = (lastStderr + data).slice(-2000); });
  const target = await waitFor(async () => {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Packaged app exited ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await response.json();
      return list.find((item) => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url));
    } catch { return null; }
  }, 'packaged renderer', 45000);
  origin = new URL(target.url).origin;
  socket = new WebSocket(target.webSocketDebuggerUrl);
  pending = new Map();
  contexts = new Map();
  socket.on('message', (data) => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.method === 'Runtime.executionContextCreated') {
      const context = message.params.context;
      if (context.auxData?.isDefault) contexts.set(context.auxData.frameId, context.id);
    } else if (message.method === 'Runtime.executionContextsCleared') contexts.clear();
    else if (message.method === 'Runtime.executionContextDestroyed') {
      for (const [frameId, contextId] of contexts) if (contextId === message.params.executionContextId) contexts.delete(frameId);
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(`CDP error: ${message.error.message}`));
    else entry.done(message.result);
  });
  const rejectPending = () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('CDP closed')); }
    pending.clear();
  };
  socket.on('close', rejectPending);
  socket.on('error', rejectPending);
  await waitFor(() => socket.readyState === WebSocket.OPEN, 'CDP socket');
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await waitFor(() => evaluate('typeof window.sewNative?.projectOpen === "function"'), 'sandbox preload');
};
const selectProject = async (selectedDirectory = projectDir) => {
  await evaluate(`(() => {
    window.__m0Project = null; window.__m0ProjectFailed = false;
    window.sewNative.projectOpen().then(value => { window.__m0Project = value; }, () => { window.__m0ProjectFailed = true; });
    return true;
  })()`);
  const pickerScript = join(root, 'scripts/select-native-project.ps1');
  const selection = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', pickerScript, '-OwnerProcessId', String(child.pid), '-Folder', selectedDirectory],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  selection.stdout.on('data', (data) => { output += data; });
  selection.stderr.on('data', (data) => { output += data; });
  const selected = await new Promise((done, reject) => {
    const timer = setTimeout(() => { selection.kill(); reject(new Error('Native picker automation timed out')); }, 35000);
    selection.once('error', (error) => { clearTimeout(timer); reject(error); });
    selection.once('exit', (code) => { clearTimeout(timer); done(code === 0); });
  });
  if (!selected) throw new Error(`Native picker automation failed: ${output.slice(-1000)}`);
  const project = await waitFor(async () => {
    const value = await evaluate('({project: window.__m0Project, failed: window.__m0ProjectFailed})');
    if (value?.failed) throw new Error('Native projectOpen was rejected');
    return value?.project;
  }, 'native project authorization');
  record('真实 Windows 选择器授权中文空格项目', project.projectId && project.generation > 0 && project.displayPath === selectedDirectory);
  return project;
};
const navigateClassroom = async () => {
  await cdp('Page.navigate', { url: `${origin}/classroom/lesson-demo-monotonicity-1` });
  await waitFor(() => evaluate('document.readyState === "complete" && (document.querySelector("[data-demo-import]") || document.querySelector("[data-scene]")) !== null'), 'classroom page');
};
const mouseClick = async (selector) => {
  const point = await waitFor(() => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.disabled) return null;
    el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect();
    return r.width && r.height ? {x:r.x+r.width/2,y:r.y+r.height/2} : null;
  })()`), `click target ${selector}`);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
};
const attempts = () => evaluate(`fetch('/api/study/attempts?kind=real&recordScope=demo').then(async r => {
  const value=await r.json(); if(!r.ok||!value.ok) throw new Error('attempt read failed');
  return value.data.attempts;
})`);
const closeApp = async () => {
  const oldOrigin = origin;
  await evaluate('(() => { window.sewNative.closeWindow(); return true; })()');
  await waitFor(() => child.exitCode !== null, 'normal app shutdown', 20000);
  record('关闭实际应用并完成退出清理', child.exitCode === 0);
  const alive = await fetch(`${oldOrigin}/internal/health`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
  record('应用退出后自有服务端口关闭', !alive);
  socket.close();
};

try {
  if (process.platform !== 'win32') throw new Error('This native UI test requires Windows');
  if (!existsSync(executable)) throw new Error('Packaged executable is missing');
  if (existsSync(projectDir) && readdirSync(projectDir).length) throw new Error('Verification requires a new empty project folder');
  if (!nativeOnly) {
    const serviceDir = join(appDir, 'resources/learning');
    if (installedApp) {
      const manifest = JSON.parse(readFileSync(join(serviceDir, SERVICE_MANIFEST), 'utf8'));
      if (!Array.isArray(manifest.files) || !manifest.files.every(entry => Array.isArray(entry) && entry.length === 2 && entry.every(item => typeof item === 'string'))) throw new Error('Invalid installed file inventory');
      const comparison = compareInventory(serviceDir, manifest.files);
      record('已安装课堂资源与随包清单一致', comparison.ok, manifest.buildId);
    } else {
      const manifest = verifyServiceManifest(root, serviceDir);
      record('课堂 UI 测试包匹配当前源码', Boolean(manifest.buildId), manifest.buildId);
    }
  }
  for (const directory of [projectDir, alternateProjectDir, profileDir, join(workspace, 'Roaming'), join(workspace, 'Local')]) mkdirSync(directory, { recursive: true });
  await connect();
  const firstProject = await selectProject();
  if (!nativeOnly) {
    await navigateClassroom();
    if (await evaluate('Boolean(document.querySelector("[data-demo-import]"))')) await mouseClick('[data-demo-import]');
    await waitFor(() => evaluate('Boolean(document.querySelector("[data-scene=slide] img")?.naturalWidth)'), 'actual classroom image', 45000);
    record('实际包课堂渲染图片与字体', await evaluate(`(() => {
      const image=document.querySelector('[data-scene=slide] img');
      return image?.naturalWidth>0 && [...document.fonts].some(font=>font.family.includes('SEW KaTeX Main')&&font.status==='loaded');
    })()`));
    await mouseClick('[data-scene-id="scene-quiz-single"]');
    await mouseClick('input[type="radio"][value="B"]');
    const answerProcess = '按定义，任取 x1<x2 时应有 f(x1)<f(x2)。';
    await mouseClick('[data-scene="quiz"] textarea');
    await cdp('Input.insertText', { text: answerProcess });
    await cdp('Network.enable');
    await cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await mouseClick('[data-attempt-submit]');
    await waitFor(() => evaluate('Boolean(document.querySelector("[data-scene=quiz] [role=alert]")) && document.querySelector("[data-attempt-submit]")?.disabled === false'), 'offline submission visibly failed');
    await cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    record('实际离线提交明确失败', await evaluate('Boolean(document.querySelector("[data-scene=quiz] [role=alert]"))'));
    // Wait through the draft debounce and a reconnect interval before manual retry.
    const reconnectDeadline = Date.now() + 1500;
    while (Date.now() < reconnectDeadline) {
      if ((await attempts()).length !== 0) throw new Error('Failed offline submission was replayed without manual retry');
      await new Promise(done => setTimeout(done, 300));
    }
    record('恢复连接后失败提交未自动写入本人记录', true);
    await mouseClick('[data-attempt-submit]');
    const submitted = await waitFor(async () => {
      const rows = await attempts();
      return rows.length === 1 && rows[0].answerText === 'B' ? rows[0] : null;
    }, 'server graded human attempt');
    record('鼠标作答由服务判分并保存唯一本人记录', submitted.actorType === 'human_learner' && submitted.kind === 'real');
    await closeApp();
    await connect();
    const reopened = await selectProject();
    record('整应用重启后重新授权同一项目', reopened.projectId === firstProject.projectId);
    await navigateClassroom();
    const restored = await waitFor(() => evaluate('Boolean(document.querySelector("[data-attempt-result]"))'), 'restored quiz result');
    const rows = await attempts();
    record('重启读回原提交且没有重复计数', restored && rows.length === 1 && rows[0].attemptId === submitted.attemptId && rows[0].answerText === submitted.answerText);
    record('重启后恢复本人解题过程', await evaluate('document.querySelector("[data-scene=quiz] textarea")?.value') === answerProcess && rows[0].processText === answerProcess);
    const simulationCount = await evaluate(`fetch('/api/study/attempts?kind=simulation&recordScope=demo').then(r=>r.json()).then(v=>v.data.attempts.length)`);
    record('本人测验未写入模拟分区', simulationCount === 0);
    await mouseClick('[data-scene-id="scene-interactive-parameter"]');
    await waitFor(() => evaluate('Boolean(document.querySelector("iframe"))'), 'interactive iframe');
    record('包内互动使用受限 iframe', await evaluate('document.querySelector("iframe").getAttribute("sandbox") === "allow-scripts"'));
    const mainFrameId = (await cdp('Page.getFrameTree')).frameTree.frame.id;
    const iframeTarget = await waitFor(async () => {
      const targets = await cdp('Target.getTargets');
      const isolated = targets.targetInfos.filter(item => item.type === 'iframe' && item.url === 'about:srcdoc');
      if (isolated.length === 1) return { targetId: isolated[0].targetId };
      for (const [frameId, contextId] of contexts) if (frameId !== mainFrameId) return { contextId };
      return null;
    }, 'interactive frame or isolated target');
    let iframeSessionId;
    if (iframeTarget.targetId) {
      iframeSessionId = (await cdp('Target.attachToTarget', { targetId: iframeTarget.targetId, flatten: true })).sessionId;
      await cdp('Runtime.enable', {}, iframeSessionId);
    }
    const frameProbe = await cdp('Runtime.evaluate', {
      ...(iframeTarget.contextId ? { contextId: iframeTarget.contextId } : {}),
      expression: '({native:typeof window.sewNative!=="undefined",node:typeof require!=="undefined"||typeof process!=="undefined"})', returnByValue: true }, iframeSessionId);
    record('实际包互动主世界没有 preload 或 Node', frameProbe.result?.value?.native === false && frameProbe.result?.value?.node === false);
    const slider = await cdp('Runtime.evaluate', {
      ...(iframeTarget.contextId ? { contextId: iframeTarget.contextId } : {}),
      expression: `(() => { const input=document.querySelector('input[type=range]');
        if(!input) return null; input.scrollIntoView({block:'center'}); const r=input.getBoundingClientRect();
        return {x:r.x+r.width*0.2,y:r.y+r.height/2,value:input.value}; })()`, returnByValue: true }, iframeSessionId);
    if (!slider.result?.value) throw new Error('Interactive parameter control missing');
    const iframePosition = await evaluate(`(() => { const frame=document.querySelector('iframe');
      frame.scrollIntoView({block:'center'}); const r=frame.getBoundingClientRect(); return {x:r.x+frame.clientLeft,y:r.y+frame.clientTop}; })()`);
    const sliderPoint = { x: iframePosition.x + slider.result.value.x, y: iframePosition.y + slider.result.value.y };
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...sliderPoint, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...sliderPoint, button: 'left', clickCount: 1 });
    const interacted = await waitFor(async () => {
      const result = await cdp('Runtime.evaluate', {
        ...(iframeTarget.contextId ? { contextId: iframeTarget.contextId } : {}),
        expression: `({value:document.querySelector('input[type=range]')?.value,direction:document.querySelector('#dir')?.textContent})`, returnByValue: true }, iframeSessionId);
      return result.result?.value?.value !== slider.result.value.value && result.result?.value?.direction === '递减';
    }, 'mouse parameter interaction');
    record('实际鼠标调整参数并观察方向变化', interacted);
    const afterInteraction = await attempts();
    record('互动观察没有追加或改写本人测验记录', afterInteraction.length === 1 && afterInteraction[0].attemptId === submitted.attemptId);
    if (iframeSessionId) await cdp('Target.detachFromTarget', { sessionId: iframeSessionId });
    await cdp('Network.enable');
    await cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const offlineRejected = await evaluate("fetch('/api/study/attempts?kind=real&recordScope=demo').then(() => false, () => true)");
    await cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const afterOffline = await attempts();
    record('离线读取失败，恢复后既有提交仍可读取', offlineRejected && afterOffline.length === 1 && afterOffline[0].attemptId === submitted.attemptId);
    const staleWrite = await evaluate(`(async () => {
      await window.sewNative.projectClose();
      const state=await window.sewNative.getServiceState();
      const response=await fetch('/api/maic/state', {method:'PUT',headers:{'content-type':'application/json','x-sew-session':state.ready.sessionToken},
        body:JSON.stringify({scope:${JSON.stringify({ projectId: reopened.projectId, generation: reopened.generation })},stageId:'stage-demo-monotonicity-1',sceneId:'scene-slide-intro'})});
      const payload=await response.json(); return {status:response.status,code:payload.error?.code};
    })()`);
    record('关闭项目后旧课堂请求被拒绝',
      (staleWrite.status === 409 && staleWrite.code === 'PROJECT_GENERATION_STALE') ||
      (staleWrite.status === 403 && staleWrite.code === 'PROJECT_NOT_AUTHORIZED'), `${staleWrite.status} ${staleWrite.code}`);
    const crashProject = await selectProject();
    record('故障试验前重新授权原项目', crashProject.projectId === firstProject.projectId);
    await navigateClassroom();
    const beforeCrash = await evaluate('window.sewNative.getServiceState()');
    const processProbe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${child.pid}' | Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress`],
    { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    if (processProbe.status !== 0) throw new Error('Could not locate the owned service process');
    const ownedProcesses = JSON.parse(processProbe.stdout || '[]');
    const bundledBinary = resolve(appDir, 'resources/node/runtime/node.exe').toLowerCase();
    const ownService = (Array.isArray(ownedProcesses) ? ownedProcesses : [ownedProcesses])
      .find(item => Number.isInteger(item.ProcessId) && item.ExecutablePath && resolve(item.ExecutablePath).toLowerCase() === bundledBinary);
    if (!ownService) throw new Error('Owned bundled Node child was not found; no process was stopped');
    const stopOwn = spawnSync('taskkill.exe', ['/PID', String(ownService.ProcessId), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    if (stopOwn.status !== 0) throw new Error('Could not stop the owned test service');
    const crashed = await waitFor(async () => {
      const state = await evaluate('window.sewNative.getServiceState()');
      return state?.status?.state === 'crashed' ? state : null;
    }, 'service crash reported');
    record('自有服务崩溃明确上报且撤销就绪凭据', crashed && !crashed.ready);
    await closeApp();
    await connect();
    const recoveredProject = await selectProject();
    await navigateClassroom();
    await mouseClick('[data-scene-id="scene-quiz-single"]');
    await waitFor(() => evaluate('Boolean(document.querySelector("[data-attempt-result]"))'), 'quiz recovery after service crash');
    const recoveredAttempts = await attempts();
    record('服务崩溃后重开保留原记录且不重复提交', recoveredProject.projectId === firstProject.projectId && recoveredAttempts.length === 1 && recoveredAttempts[0].attemptId === submitted.attemptId);
    const afterCrash = await evaluate('window.sewNative.getServiceState()');
    const oldCredential = await fetch(`${origin}/api/health`, { headers: { 'x-sew-session': beforeCrash.ready.sessionToken }, signal: AbortSignal.timeout(8000) });
    record('新服务凭据轮换且旧会话凭据失效', afterCrash.ready.sessionToken !== beforeCrash.ready.sessionToken && oldCredential.status === 401);
    const switchedProject = await selectProject(alternateProjectDir);
    record('原生选择器切换到另一项目并提升代次', switchedProject.projectId !== recoveredProject.projectId && switchedProject.generation > recoveredProject.generation);
    const staleAfterSwitch = await evaluate(`fetch('/api/maic/state', {method:'PUT',headers:{'content-type':'application/json'},
      body:JSON.stringify({scope:${JSON.stringify({ projectId: recoveredProject.projectId, generation: recoveredProject.generation })},stageId:'stage-demo-monotonicity-1',sceneId:'scene-slide-intro'})
      }).then(async response=>({status:response.status,code:(await response.json()).error?.code}))`);
    record('切换后旧项目写入不能进入新项目', staleAfterSwitch.status === 409 && staleAfterSwitch.code === 'PROJECT_GENERATION_STALE' && (await attempts()).length === 0);
  }
  await closeApp();
} catch (error) {
  checks.push({ name: '实际包课堂 UI 验收', ok: false, detail: error instanceof Error ? error.message : 'Unknown failure' });
  process.exitCode = 1;
  console.error(checks.at(-1).detail);
} finally {
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  if (child?.pid && child.exitCode === null) {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    await waitFor(() => child.exitCode !== null, 'test child cleanup', 10000).catch(() => {});
  }
  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, `${JSON.stringify({ date: new Date().toISOString(), mode: nativeOnly ? 'native-picker-only' : 'packaged-classroom-ui',
    environment: installedApp ? 'installed app; clean Windows independence requires the external environment report' : 'developer Windows with isolated profile/PATH; not clean Windows installation', appDir, checks,
    stderr: process.exitCode ? lastStderr : undefined }, null, 2)}\n`);
  const relativeTemp = relative(tempRoot, resolve(workspace));
  if ((!child || child.exitCode !== null) && relativeTemp && !relativeTemp.startsWith(`..${sep}`) && relativeTemp !== '..' && !relativeTemp.includes(':')) {
    rmSync(workspace, { recursive: true, force: true });
  }
  console.log(`Report: ${reportFile}`);
}
if (!process.exitCode) console.log(`PASS native packaged classroom (${checks.length}/${checks.length})`);
