#!/usr/bin/env node
/**
 * 服务产物启动试验（PACK-01 服务资源与启动链路校验）。
 *
 * 用随包 Node 启动 apps/learning/dist/service/server.mjs（生产模式），
 * 验证安装包形态下真实可用的最小闭环：
 *   1. stdout 单行 JSON ready 握手（端口、会话/控制凭据）。
 *   2. 生产 SSR 与 API 的会话边界：匿名请求 401，带会话 200。
 *   3. 控制凭据边界：无控制凭据的内部命令 401，进程不被误停。
 *   4. /internal/shutdown 正常退出。
 *
 * 前置：pnpm build:learning && node scripts/prepare-learning-dist.mjs
 *       node scripts/fetch-node-runtime.mjs
 * 通过输出 `PASS service dist boot smoke completed`，任一步失败退出码非 0。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyServiceManifest } from './freshness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const serviceDir = join(root, 'apps', 'learning', 'dist', 'service');
const nodeBinary = join(root, 'resources', 'node', 'runtime',
  process.platform === 'win32' ? 'node.exe' : 'node');

const fail = (message) => {
  console.error(`verify-learning-dist: ${message}`);
  process.exit(1);
};

const copyTree = (source, target) => {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile() || (entry.isSymbolicLink() && statSync(from).isFile())) copyFileSync(from, to);
    else throw new Error(`服务目录复制遇到不支持的条目：${from}`);
  }
};

if (!existsSync(join(serviceDir, 'server.mjs'))) {
  fail(`缺少服务产物 ${serviceDir}；请先运行 pnpm build:learning && node scripts/prepare-learning-dist.mjs`);
}
if (!existsSync(nodeBinary)) {
  fail(`缺少随包 Node ${nodeBinary}；请先运行 node scripts/fetch-node-runtime.mjs`);
}
try {
  verifyServiceManifest(root, serviceDir);
} catch (error) {
  fail(`${error instanceof Error ? error.message : String(error)}；旧服务产物不能通过本检查`);
}

const verificationRoot = mkdtempSync(join(tmpdir(), 'sew-service-package-'));
const isolatedServiceDir = join(verificationRoot, 'service');
try {
  copyTree(serviceDir, isolatedServiceDir);
} catch (error) {
  rmSync(verificationRoot, { recursive: true, force: true });
  fail(`无法隔离复制服务产物：${error instanceof Error ? error.message : String(error)}`);
}

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

/** 带超时的 JSON 请求；返回 { status, body } 或抛错。 */
const requestJson = async (url, { method = 'GET', headers = {}, body: requestBody, timeout = 8000 } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: requestBody,
      signal: controller.signal,
      redirect: 'manual',
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
};

const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const child = spawn(nodeBinary, [join(isolatedServiceDir, 'server.mjs'), '--project-root', ''], {
  cwd: isolatedServiceDir,
  shell: false,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATH: `${systemRoot}\\System32;${systemRoot}`,
    TEMP: verificationRoot,
    TMP: verificationRoot,
    NODE_ENV: 'production',
    NODE_PATH: '',
    NODE_OPTIONS: '',
  },
});

const stderrChunks = [];
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

let exited = false;
let exitInfo = null;
child.on('exit', (code, signal) => {
  exited = true;
  exitInfo = { code, signal };
});

const waitForExit = (timeout) => new Promise((resolvePromise) => {
  if (exited) return resolvePromise(true);
  const timer = setTimeout(() => resolvePromise(false), timeout);
  child.once('exit', () => {
    clearTimeout(timer);
    resolvePromise(true);
  });
});

const stopChild = async () => {
  if (exited) return true;
  try { child.kill(); } catch { /* 已退出或尚未启动 */ }
  if (await waitForExit(3000)) return true;
  try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  return waitForExit(1000);
};

/** 等待 stdout 上的 ready 单行 JSON。 */
const waitReady = (timeout = 30000) =>
  new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`ready 超时（${timeout}ms）${exited ? `，进程已退出 ${JSON.stringify(exitInfo)}` : ''}`));
    }, timeout);
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line) continue;
        try {
          const payload = JSON.parse(line);
          if (payload.type === 'error') {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            rejectPromise(new Error(payload.message));
            return;
          }
          if (payload.type === 'ready') {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            resolvePromise(payload);
          }
        } catch { /* 非 JSON 行忽略 */ }
      }
    };
    child.on('exit', () => {
      clearTimeout(timer);
      rejectPromise(new Error(`服务在 ready 前退出 ${JSON.stringify(exitInfo)}：${stderrChunks.join('')}`));
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectPromise(new Error(`无法启动随包 Node 子进程：${error.message}`));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
  });

let ready;
try {
  ready = await waitReady();
} catch (error) {
  console.error(`verify-learning-dist: 启动失败：${error.message}`);
  await stopChild();
  process.exit(1);
}
record('ready 握手', Boolean(ready.port && ready.sessionToken && ready.controlToken),
  `port ${ready.port}`);

const origin = `http://127.0.0.1:${ready.port}`;
const authedHeaders = {
  'x-sew-session': ready.sessionToken,
  'x-sew-control': ready.controlToken,
  origin,
};

try {
  const anonymous = await requestJson(`${origin}/internal/health`);
  record('匿名 health 被拒', anonymous.status === 401 && anonymous.body?.error?.code === 'SESSION_REQUIRED',
    `HTTP ${anonymous.status}`);
} catch (error) {
  record('匿名 health 被拒', false, error.message);
}

try {
  const authed = await requestJson(`${origin}/internal/health`, { headers: authedHeaders });
  record('带会话 health 通过', authed.status === 200 && authed.body?.data?.ready === true && authed.body?.data?.dev === false,
    `HTTP ${authed.status}`);
} catch (error) {
  record('带会话 health 通过', false, error.message);
}

try {
  const anonymousPage = await fetch(`${origin}/workbench`, { redirect: 'manual' });
  record('匿名 SSR 被拒', anonymousPage.status === 401, `HTTP ${anonymousPage.status}`);
} catch (error) {
  record('匿名 SSR 被拒', false, error.message);
}

try {
  // 无项目时 /workbench 可能 307 到 /no-project；跟随重定向后应为已认证页面。
  const response = await fetch(`${origin}/workbench`, {
    headers: { 'x-sew-session': ready.sessionToken },
    redirect: 'follow',
  });
  const html = await response.text();
  record('带会话 SSR 通过', response.status === 200 && html.includes('<html'), `HTTP ${response.status}`);
} catch (error) {
  record('带会话 SSR 通过', false, error.message);
}

try {
  // 随包产物必须带上课堂文档路由；没有已授权项目时它必须拒绝而不是回退成 404 或空文档。
  const classroomApi = await requestJson(`${origin}/api/maic/documents`, {
    headers: { 'x-sew-session': ready.sessionToken },
  });
  record(
    '随包产物含课堂文档路由且无项目时拒绝',
    classroomApi.status === 403 && classroomApi.body?.error?.code === 'PROJECT_NOT_AUTHORIZED',
    `HTTP ${classroomApi.status} ${classroomApi.body?.error?.code ?? ''}`,
  );
} catch (error) {
  record('随包产物含课堂文档路由且无项目时拒绝', false, error.message);
}

try {
  const projectPath = join(verificationRoot, '课堂资产 中文 项目');
  mkdirSync(projectPath);
  const commandHeaders = { ...authedHeaders, 'content-type': 'application/json' };
  const openProject = async () => {
    const result = await requestJson(`${origin}/internal/project`, { method: 'POST', headers: commandHeaders,
      body: JSON.stringify({ action: 'open', path: projectPath }) });
    if (result.status !== 200 || !result.body?.data?.session) throw new Error(`打开隔离项目失败 HTTP ${result.status}`);
    return result.body.data.session;
  };
  const scope = await openProject();
  const imported = await requestJson(`${origin}/api/maic/demo`, { method: 'POST', headers: commandHeaders,
    body: JSON.stringify({ scope, confirmDemoImport: true }) });
  if (imported.status !== 200) throw new Error(`显式导入失败 HTTP ${imported.status} ${imported.body?.error?.code ?? ''}`);
  const stageId = imported.body.data.stageId;
  const headersFor = (current) => ({ 'x-sew-session': ready.sessionToken,
    'x-sew-project-id': current.projectId, 'x-sew-generation': String(current.generation) });
  const bindingUrl = `${origin}/api/maic/demo-assets/${encodeURIComponent(stageId)}`;
  const mapping = await requestJson(bindingUrl, { headers: headersFor(scope) });
  if (mapping.status !== 200 || mapping.body?.data?.assets?.length !== 2) throw new Error('随包演示资产绑定不完整');
  const files = new Map([
    ['demo-image-monotonicity-v1', 'monotonicity-demo.png'],
    ['demo-font-katex-main-regular-v1', 'KaTeX_Main-Regular.woff2'],
  ]);
  for (const asset of mapping.body.data.assets) {
    const filename = files.get(asset.symbolicRef);
    if (!filename) throw new Error('演示资产清单含未知引用');
    const original = readFileSync(join(isolatedServiceDir, 'classroom-assets', filename));
    const expected = createHash('sha256').update(original).digest('hex');
    const response = await fetch(`${origin}/api/maic/assets/${encodeURIComponent(asset.assetId)}/content`, {
      headers: headersFor(scope), signal: AbortSignal.timeout(8000),
    });
    const actual = createHash('sha256').update(new Uint8Array(await response.arrayBuffer())).digest('hex');
    record(`随包资产字节与审核摘要一致：${filename}`, response.status === 200 && actual === expected && asset.sha256 === expected,
      `HTTP ${response.status}; SHA-256 ${actual}`);
  }
  const license = readFileSync(join(isolatedServiceDir, 'classroom-assets', 'KaTeX-LICENSE.txt'), 'utf8');
  record('随包课堂字体保留完整许可', license.includes('Khan Academy') && license.includes('Permission is hereby granted'));
  const reopened = await openProject();
  const oldMapping = await requestJson(bindingUrl, { headers: headersFor(scope) });
  const restored = await requestJson(bindingUrl, { headers: headersFor(reopened) });
  record('随包资产重开后绑定保持且旧代次拒绝', oldMapping.status === 409 && restored.status === 200 &&
    JSON.stringify(restored.body?.data?.assets) === JSON.stringify(mapping.body.data.assets));
} catch (error) {
  record('随包图片字体导入与持久化', false, error.message);
}

try {
  const withoutControl = await requestJson(`${origin}/internal/shutdown`, {
    method: 'POST',
    headers: { 'x-sew-session': ready.sessionToken, origin },
  });
  record('无控制凭据的内部命令被拒', withoutControl.status === 401 && withoutControl.body?.error?.code === 'CONTROL_REQUIRED',
    `HTTP ${withoutControl.status}`);
} catch (error) {
  record('无控制凭据的内部命令被拒', false, error.message);
}

if (exited) {
  record('拒绝命令后进程仍存活', false, `进程已提前退出 ${JSON.stringify(exitInfo)}`);
} else {
  record('拒绝命令后进程仍存活', true);
}

try {
  const shutdown = await requestJson(`${origin}/internal/shutdown`, {
    method: 'POST',
    headers: authedHeaders,
  });
  record('受控 shutdown 受理', shutdown.status === 200 && shutdown.body?.data?.stopping === true,
    `HTTP ${shutdown.status}`);
} catch (error) {
  record('受控 shutdown 受理', false, error.message);
}

const exitWithin = (timeout = 8000) =>
  new Promise((resolvePromise) => {
    if (exited) return resolvePromise(true);
    const timer = setTimeout(() => resolvePromise(false), timeout);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });

const didExit = await exitWithin();
const exitedCleanly = didExit && exitInfo?.code === 0 && exitInfo?.signal === null;
record('进程正常退出', exitedCleanly,
  didExit ? `code ${exitInfo?.code}, signal ${exitInfo?.signal}` : '超时未退出');
if (!didExit) await stopChild();
rmSync(verificationRoot, { recursive: true, force: true });

if (process.exitCode !== 1) {
  console.log(`PASS service dist boot smoke completed（${results.filter((item) => item.ok).length}/${results.length} 项通过）`);
}
