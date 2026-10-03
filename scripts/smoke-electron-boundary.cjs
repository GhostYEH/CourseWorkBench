/*
 * Hidden Electron integration smoke for the production HTTP boundary.
 * Run from the repository root with:
 *   node scripts/run-electron-boundary-smoke.cjs
 *
 * This harness uses the real sandboxed preload and production learning server.
 * The two project IPC handlers use a controlled temporary directory in place
 * of native dialogs, so they exercise the preload IPC path without showing UI.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, sep } = require('node:path');
const { rendererRequestHeaders } = require('../apps/desktop/src/http-boundary.cjs');
const channels = require('../packages/study-contracts/ipc-channels.json');

const projectRoot = resolve(__dirname, '..');
const serverEntry = join(projectRoot, 'apps', 'learning', 'server.mjs');
const preloadPath = join(projectRoot, 'apps', 'desktop', 'src', 'preload.cjs');
const nodeBinary = process.env.SEW_NODE_BINARY || 'node';
const timeoutMs = 20000;
const resultFile = process.env.SEW_ELECTRON_SMOKE_RESULT;
const userDataPath = process.env.SEW_ELECTRON_SMOKE_USER_DATA;
if (userDataPath && app && !app.isReady()) {
  mkdirSync(userDataPath, { recursive: true });
  app.setPath('userData', userDataPath);
}

let serviceChild;
let window;
let tempRoot;
let ready;
let failure = null;
let lastStep = 'module-loaded';
let finishing = false;
let cleanupPromise = null;
const rendererRequests = [];
/** 已覆盖的边界断言，写进结果文件便于外部复核（stdio 被隐藏窗口丢弃）。 */
const coveredChecks = [];
const cover = (label) => { coveredChecks.push(label); };

const writeResult = (result) => {
  if (!resultFile) return;
  writeFileSync(resultFile, `${JSON.stringify(result)}\n`, 'utf8');
};
const markStep = (step, extra = {}) => {
  lastStep = step;
  writeResult({
    state: 'started',
    step,
    electronVersion: process.versions.electron || null,
    appApiAvailable: Boolean(app && typeof app.whenReady === 'function'),
    ...extra,
  });
};
markStep('module-loaded');
process.on('exit', (code) => {
  if (!finishing) writeResult({ state: 'process-exited', code, step: lastStep, servicePid: serviceChild?.pid ?? null });
});

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const startService = () => new Promise((resolveReady, reject) => {
  serviceChild = spawn(nodeBinary, [serverEntry, '--project-root', ''], {
    cwd: join(projectRoot, 'apps', 'learning'),
    env: { ...process.env, NODE_ENV: 'production', SEW_DEV: '0', SEW_PROJECT_ROOT: '' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  markStep('service-spawned', { servicePid: serviceChild.pid ?? null });
  let buffer = '';
  const timer = setTimeout(() => reject(new Error('production service startup timed out')), 45000);
  serviceChild.stdout.setEncoding('utf8');
  serviceChild.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      try {
        const payload = JSON.parse(line);
        if (payload.type === 'ready') {
          clearTimeout(timer);
          markStep('service-ready', { servicePid: serviceChild.pid ?? null });
          resolveReady(payload);
        } else if (payload.type === 'error') {
          clearTimeout(timer);
          reject(new Error('production service failed to start'));
        }
      } catch { /* Ignore non-protocol startup output without printing it. */ }
    }
  });
  serviceChild.once('error', () => {
    clearTimeout(timer);
    reject(new Error('could not launch production service'));
  });
  serviceChild.once('exit', (code) => {
    if (!ready) {
      clearTimeout(timer);
      reject(new Error(`production service exited before ready (${code})`));
    }
  });
});

const serviceRequest = async (method, path, body) => {
  const response = await fetch(`${ready.origin}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: ready.origin,
      'x-sew-session': ready.sessionToken,
      ...(path.startsWith('/internal/') || path === '/api/study/backup'
        ? { 'x-sew-control': ready.controlToken }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`controlled service request failed (${payload.error.code})`);
  return payload.data;
};

const assertNativeCaller = (event) => {
  const frame = event.senderFrame;
  assert(window && event.sender === window.webContents, 'IPC caller was not the smoke window');
  assert(frame && frame.parent === null, 'IPC caller was not the main frame');
  assert(new URL(frame.url).origin === ready.origin, 'IPC caller origin was not the service origin');
};

const registerMockProjectIpc = () => {
  ipcMain.handle('sew:project:open', async (event) => {
    assertNativeCaller(event);
    const data = await serviceRequest('POST', '/internal/project', { action: 'open', path: tempRoot });
    window.webContents.send(channels.projectOpen, data.session);
    return data.session;
  });
  ipcMain.handle('sew:project:close', async (event) => {
    assertNativeCaller(event);
    await serviceRequest('POST', '/internal/project', { action: 'close' });
    window.webContents.send(channels.projectOpen, null);
  });
};

const waitForUrl = async (predicate, message) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!window || window.isDestroyed()) throw new Error('smoke window was destroyed');
    if (predicate(window.webContents.getURL())) return window.webContents.getURL();
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(message);
};

const waitForText = async (needle, message) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!window || window.isDestroyed()) throw new Error('smoke window was destroyed');
    const bodyText = await window.webContents.executeJavaScript('document.body?.innerText || ""');
    if (bodyText.includes(needle)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(message);
};

const readClassroomPersistence = async () => window.webContents.executeJavaScript(`(async () => {
  const stateResponse = await fetch('/api/study/state');
  if (!stateResponse.ok) throw new Error('classroom state request failed while checking reload persistence');
  const state = await stateResponse.json();
  if (!state.ok || !state.data?.project?.projectId || !state.data?.project?.generation) {
    throw new Error('classroom state did not provide the active project scope');
  }
  const assetsResponse = await fetch('/api/maic/demo-assets/stage-demo-monotonicity-1', {
    headers: {
      'x-sew-project-id': state.data.project.projectId,
      'x-sew-generation': String(state.data.project.generation)
    }
  });
  if (!assetsResponse.ok) throw new Error('scoped demo asset binding request failed while checking reload persistence');
  const assetPayload = await assetsResponse.json();
  if (!assetPayload.ok || !Array.isArray(assetPayload.data?.assets)) {
    throw new Error('scoped demo asset response was malformed');
  }
  return {
    counts: state.data.counts,
    assets: assetPayload.data.assets
      .map(({ symbolicRef, assetId, sha256 }) => ({ symbolicRef, assetId, sha256 }))
      .sort((a, b) => a.symbolicRef.localeCompare(b.symbolicRef))
  };
})()`);

const run = async () => {
  assert(existsSync(serverEntry), 'learning server entry is missing');
  assert(existsSync(preloadPath), 'sandboxed preload is missing');
  assert(existsSync(join(projectRoot, 'apps', 'learning', '.next', 'BUILD_ID')),
    'production Next build is missing; run pnpm build:learning first');

  tempRoot = mkdtempSync(join(tmpdir(), 'sew-electron-boundary-'));
  mkdirSync(tempRoot, { recursive: true });
  ready = await startService();

  registerMockProjectIpc();
  window = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  markStep('window-created', { servicePid: serviceChild.pid ?? null });
  assert(window.isVisible() === false, 'smoke BrowserWindow became visible');

  window.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ['http://127.0.0.1/*'] },
    (details, callback) => {
      const nextHeaders = rendererRequestHeaders(
        details,
        window.webContents.id,
        ready.origin,
        ready.sessionToken,
        details.requestHeaders,
      );
      rendererRequests.push({
        resourceType: details.resourceType,
        url: details.url,
        sessionInjected: nextHeaders['x-sew-session'] === ready.sessionToken,
        controlInjected: Object.keys(nextHeaders).some((name) => name.toLowerCase() === 'x-sew-control'),
      });
      callback({ requestHeaders: nextHeaders });
    },
  );
  markStep('request-hook-installed', { servicePid: serviceChild.pid ?? null });

  const anonymous = await fetch(`${ready.origin}/workbench`);
  assert(anonymous.status === 401, 'anonymous production SSR request was not rejected');
  markStep('anonymous-ssr-rejected', { servicePid: serviceChild.pid ?? null });

  await window.loadURL(`${ready.origin}/workbench`);
  await waitForUrl((url) => url.endsWith('/no-project'), 'initial no-project redirect did not finish');
  await waitForText('还没有打开项目', 'no-project page content did not load');
  markStep('no-project-rendered', { servicePid: serviceChild.pid ?? null });
  const bridgeCheck = await window.webContents.executeJavaScript(`(() => {
    window.__smokeReady = null;
    window.sewNative.onServiceReady((payload) => { window.__smokeReady = payload; });
    return {
      bridge: typeof window.sewNative,
      isolated: typeof window.process === 'undefined' && typeof window.require === 'undefined',
      methods: ['projectOpen', 'projectClose', 'onServiceReady'].every((key) => typeof window.sewNative[key] === 'function')
    };
  })()`);
  assert(bridgeCheck.bridge === 'object' && bridgeCheck.isolated && bridgeCheck.methods,
    'sandboxed preload bridge was not exposed as expected');
  cover('sandboxed preload bridge, no Node globals in main frame');

  const rendererReady = (({ controlToken, ...payload }) => payload)(ready);
  window.webContents.send('sew:service-ready', rendererReady);
  const projectionDeadline = Date.now() + 5000;
  while (Date.now() < projectionDeadline) {
    if (await window.webContents.executeJavaScript('window.__smokeReady !== null')) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  const projection = await window.webContents.executeJavaScript('window.__smokeReady');
  assert(projection && projection.sessionToken === ready.sessionToken, 'serviceReady did not deliver the session token');
  assert(!Object.prototype.hasOwnProperty.call(projection, 'controlToken'), 'serviceReady projection exposed controlToken');

  const openButton = await window.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('打开项目'));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(openButton, 'no-project page did not expose the native project-open action');
  await waitForUrl((url) => url.endsWith('/workbench'), 'native project-open action did not navigate to the workbench');
  await waitForText('关闭项目', 'opened workbench page did not finish rendering');
  const workbenchText = await window.webContents.executeJavaScript('document.body.innerText');
  assert(workbenchText.includes('sew-electron-boundary-'), 'opened project was not rendered in the workbench');

  const apiResult = await window.webContents.executeJavaScript(`fetch('/api/study/state').then(async (response) => ({ status: response.status, body: await response.json() }))`);
  assert(apiResult.status === 200 && apiResult.body.ok === true, 'main-frame API request did not receive session authentication');
  cover('main-frame API received session authentication');

  // ——— 真实课堂：OpenMAIC SlideCanvas 渲染 + 互动 iframe 隔离 ———
  await window.loadURL(`${ready.origin}/classroom/lesson-demo-monotonicity-1`);
  await waitForText('确认将演示材料', 'classroom page did not ask for explicit demo import');
  const beforeDemo = await window.webContents.executeJavaScript(`fetch('/api/study/state').then((response) => response.json())`);
  assert(beforeDemo.ok === true && beforeDemo.data.counts.knowledgeVerified === 0 && beforeDemo.data.counts.materials === 0,
    'opening the classroom silently wrote authoritative demo knowledge');
  await window.webContents.executeJavaScript(`document.querySelector('[data-demo-import]').click()`);
  cover('demo material import requires an explicit user action; classroom GET is read-only');
  let classroom = { rendered: false, hasTab: false, imageNaturalWidth: 0, imageSrc: '', fontLoaded: false, formulaFontFamily: '' };
  const classroomDeadline = Date.now() + 20000;
  while (Date.now() < classroomDeadline) {
    classroom = await window.webContents.executeJavaScript(`(() => {
      const painted = document.getElementById('slide-element-slide-1-title');
      const image = document.getElementById('slide-element-slide-1-demo-image')?.querySelector('img');
      const formula = document.getElementById('slide-element-slide-1-formula-font-proof');
      const formulaFontFamily = formula
        ? [formula, ...formula.querySelectorAll('*')].map((node) => getComputedStyle(node).fontFamily)
          .find((family) => family.includes('SEW KaTeX Main')) || ''
        : '';
      const tab = [...document.querySelectorAll('button.tab')].find((item) => item.textContent.includes('参数实验'));
      return {
        rendered: Boolean(painted),
        paintedText: painted ? painted.textContent.slice(0, 40) : '',
        hasTab: Boolean(tab),
        imageNaturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
        imageSrc: image instanceof HTMLImageElement ? image.currentSrc : '',
        fontLoaded: [...document.fonts].some((face) => face.family === 'SEW KaTeX Main' && face.status === 'loaded'),
        formulaFontFamily,
        bodyText: document.body.innerText.slice(0, 200)
      };
    })()`);
    if (classroom.rendered && classroom.hasTab && classroom.imageNaturalWidth === 240 && classroom.fontLoaded && classroom.formulaFontFamily) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  assert(classroom.rendered,
    `真实课堂没有由 @openmaic/renderer 画出审核课件元素：${classroom.bodyText}`);
  assert(String(classroom.paintedText).includes('增函数的定义'), 'painted slide element text did not match the audited lesson');
  cover('OpenMAIC SlideCanvas painted the audited slide element');
  assert(classroom.imageNaturalWidth === 240, `reviewed demo image did not load at its checked-in width: ${classroom.imageNaturalWidth}`);
  assert(String(classroom.imageSrc).startsWith('blob:'), 'demo image was not resolved to the HttpAssetStore object URL');
  assert(classroom.fontLoaded, 'reviewed KaTeX FontFace was not registered with loaded status');
  assert(classroom.formulaFontFamily.includes('SEW KaTeX Main'), `formula element did not use the reviewed font: ${classroom.formulaFontFamily}`);
  cover('project-scoped HttpAssetStore loaded and integrity-checked image bytes and KaTeX font');
  markStep('classroom-slide-rendered', { servicePid: serviceChild.pid ?? null });

  const persistenceBeforeReload = await readClassroomPersistence();
  const reloadFinished = new Promise((resolveReload) => {
    const timer = setTimeout(() => resolveReload(false), 20000);
    window.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolveReload(true);
    });
  });
  await window.webContents.reload();
  assert(await reloadFinished, 'classroom reload did not finish loading');
  let reloadedAssets = { imageNaturalWidth: 0, fontLoaded: false, formulaFontFamily: '' };
  const reloadDeadline = Date.now() + 20000;
  while (Date.now() < reloadDeadline) {
    reloadedAssets = await window.webContents.executeJavaScript(`(() => {
      const image = document.getElementById('slide-element-slide-1-demo-image')?.querySelector('img');
      const formula = document.getElementById('slide-element-slide-1-formula-font-proof');
      const formulaFontFamily = formula
        ? [formula, ...formula.querySelectorAll('*')].map((node) => getComputedStyle(node).fontFamily)
          .find((family) => family.includes('SEW KaTeX Main')) || ''
        : '';
      return {
        imageNaturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
        fontLoaded: [...document.fonts].some((face) => face.family === 'SEW KaTeX Main' && face.status === 'loaded'),
        formulaFontFamily
      };
    })()`);
    if (reloadedAssets.imageNaturalWidth === 240 && reloadedAssets.fontLoaded && reloadedAssets.formulaFontFamily) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  assert(reloadedAssets.imageNaturalWidth === 240 && reloadedAssets.fontLoaded,
    'persisted demo image and registered KaTeX FontFace did not render after reloading the classroom');
  assert(reloadedAssets.formulaFontFamily.includes('SEW KaTeX Main'),
    `formula did not use the reviewed font after classroom reload: ${reloadedAssets.formulaFontFamily}`);
  const persistenceAfterReload = await readClassroomPersistence();
  assert(JSON.stringify(persistenceAfterReload) === JSON.stringify(persistenceBeforeReload),
    'reloading the classroom changed authoritative records or demo asset bindings');
  cover('classroom reload reused the same image/font assets and left authoritative records unchanged');

  await window.webContents.executeJavaScript(`(() => {
    const tab = [...document.querySelectorAll('button.tab')].find((item) => item.textContent.includes('参数实验'));
    tab.click();
    return true;
  })()`);
  let widget = { present: false, isolationReport: '' };
  const widgetDeadline = Date.now() + 15000;
  while (Date.now() < widgetDeadline) {
    widget = await window.webContents.executeJavaScript(`(() => {
      const frame = document.querySelector('iframe[title="参数实验互动"]');
      if (!frame) return { present: false, isolationReport: '' };
      return {
        present: true,
        sandbox: frame.getAttribute('sandbox'),
        parentCanReadFrameDom: frame.contentDocument !== null,
        usesSrcdoc: (frame.getAttribute('srcdoc') || '').length > 0,
        isolationReport: document.querySelector('[data-widget-observation]')?.textContent || '',
        ready: document.querySelector('[data-interactive-ready]')?.textContent || '',
        srcdocProtocol: (frame.getAttribute('srcdoc') || '').includes('__maicErrorReplayRequest')
      };
    })()`);
    if (widget.present && widget.ready.includes('已加载') && widget.isolationReport.includes('nativeBridge=')) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  assert(widget.present && widget.sandbox === 'allow-scripts',
    '课堂互动 iframe 不是仅 allow-scripts 的沙箱');
  assert(widget.usesSrcdoc && !widget.parentCanReadFrameDom,
    '课堂互动 iframe 与主框架同源可达，隔离边界失效');
  assert(widget.srcdocProtocol, '互动 iframe 未包含上游 runtime-error replay 请求协议');
  assert(widget.isolationReport.includes('nativeBridge=undefined'),
    `互动 iframe 内可见原生桥：${widget.isolationReport}`);
  assert(widget.isolationReport.includes('nodeRequire=undefined'),
    `互动 iframe 内可见 Node require：${widget.isolationReport}`);
  cover('classroom widget iframe: sandbox=allow-scripts only, opaque srcdoc, no sewNative/require inside, DOM unreadable from parent');
  markStep('classroom-widget-isolated', { servicePid: serviceChild.pid ?? null });

  await window.loadURL(`${ready.origin}/workbench`);
  await waitForText('关闭项目', 'returning to the workbench did not finish rendering');

  const iframeResult = await window.webContents.executeJavaScript(`new Promise((resolveFrame) => {
    const frame = document.createElement('iframe');
    frame.id = 'boundary-iframe';
    frame.onload = () => resolveFrame(frame.contentDocument.body.innerText);
    frame.onerror = () => resolveFrame('iframe-load-error');
    frame.src = '/workbench?boundary-iframe=1';
    document.body.append(frame);
  })`);
  assert(String(iframeResult).includes('SESSION_REQUIRED'), 'same-origin iframe unexpectedly received session authentication');
  const iframeDecision = rendererRequests.find((entry) => entry.resourceType === 'subFrame' && entry.url.includes('boundary-iframe=1'));
  assert(iframeDecision && !iframeDecision.sessionInjected && !iframeDecision.controlInjected,
    'iframe request received a renderer credential');
  assert(rendererRequests.every((entry) => !entry.controlInjected), 'a renderer request received the control credential');
  cover('same-origin iframe got no renderer credential; no control credential anywhere');

  const closeButton = await window.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('关闭项目'));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(closeButton, 'workbench page did not expose the native project-close action');
  await waitForUrl((url) => url.endsWith('/no-project'), 'native project-close action did not navigate to no-project');
  await waitForText('还没有打开项目', 'closed-project page did not finish rendering');

  console.log('PASS hidden Electron smoke: sandboxed preload, SSR/API auth, OpenMAIC slide render, sandboxed classroom widget, iframe isolation, ready projection, project open/close');
};

const cleanup = async () => {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (window && !window.isDestroyed()) window.destroy();
    if (ready && serviceChild && serviceChild.exitCode === null) {
      await fetch(`${ready.origin}/internal/shutdown`, {
        method: 'POST',
        headers: {
          origin: ready.origin,
          'x-sew-session': ready.sessionToken,
          'x-sew-control': ready.controlToken,
        },
      }).catch(() => undefined);
    }
    if (serviceChild && serviceChild.exitCode === null) {
      await Promise.race([
        new Promise((resolveExit) => serviceChild.once('exit', resolveExit)),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, 3500)),
      ]);
      if (serviceChild.exitCode === null) serviceChild.kill();
    }
    if (tempRoot) {
      const absoluteTemp = resolve(tempRoot);
      const absoluteBase = resolve(tmpdir()) + sep;
      if (absoluteTemp.startsWith(absoluteBase) && absoluteTemp.includes('sew-electron-boundary-')) {
        rmSync(absoluteTemp, { recursive: true, force: true });
      }
    }
  })();
  return cleanupPromise;
};

const finish = async (error = null) => {
  if (finishing) return;
  finishing = true;
  failure = error;
  await cleanup();
  writeResult({
    state: failure ? 'failed' : 'passed',
    step: lastStep,
    message: failure
      ? (failure instanceof Error ? failure.message : 'unknown error')
      : `hidden Electron smoke completed: ${coveredChecks.join(' | ')}`,
  });
  app.exit(failure ? 1 : 0);
};

const beginSmoke = async () => {
  markStep('app-ready');
  try {
    await run();
    await finish();
  } catch (error) {
    await finish(error);
  }
};

process.on('uncaughtException', (error) => { void finish(error); });
process.on('unhandledRejection', (error) => { void finish(error); });
// Finish asynchronous cleanup before explicitly exiting the hidden Electron app.
app.on('window-all-closed', () => {});
app.on('ready', () => { void beginSmoke(); });
if (app.isReady()) setImmediate(() => { void beginSmoke(); });
