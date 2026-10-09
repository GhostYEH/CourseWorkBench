#!/usr/bin/env node
/**
 * 本地服务入口（《Electron 开发设计》2.1）。
 *
 * 由 Electron 用受控资源目录下的随包 Node 启动：
 *   node server.mjs --project-root <已授权目录> [--dev]
 *
 * 职责：
 * 1. 只监听 127.0.0.1，端口由系统分配（不预占后释放）。
 * 2. 生成随机应用会话凭据，经受控父子通道（stdout 单行 JSON）回传真实端口与身份。
 * 3. 校验会话、Host 与修改请求的 Origin；回环地址不是免认证理由。
 * 4. 收到退出信号时先关闭数据库（经 /internal/shutdown 路由），再退出。
 *
 * 本文件是纯 JavaScript：它不做任何业务判断，业务全部在 Next 应用内，
 * 由 Next 编译 TS 源码，避免 Node 直接加载 TS 带来的解析差异。
 */

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = dirname(fileURLToPath(import.meta.url));

const parseArgs = (argv) => {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
};

const args = parseArgs(process.argv.slice(2));
const isDev = Boolean(args.dev);
const projectRoot = typeof args['project-root'] === 'string' ? args['project-root'] : '';
/** 生产路径固定用 0：由系统分配可用端口，不预占后释放。开发可显式指定便于调试。 */
const requestedPort = typeof args.port === 'string' ? Number(args.port) : 0;

// 服务层在首次访问时按该目录打开项目；渲染层拿不到磁盘路径。
process.env.SEW_PROJECT_ROOT = projectRoot;
process.env.SEW_DEV = isDev ? '1' : '0';

// 用户级目录由主进程通过受控参数传入，用于全局外观/阅读偏好；
// 不传时（开发直跑）回退到服务工作目录下的稳定路径。
const userDataDir = typeof args['user-data'] === 'string' ? args['user-data'] : '';
if (userDataDir) process.env.SEW_USER_DATA_DIR = userDataDir;

const sessionToken = randomBytes(32).toString('hex');
const controlToken = randomBytes(32).toString('hex');
const serviceInstanceId = randomBytes(8).toString('hex');
process.env.SEW_SESSION_TOKEN = sessionToken;
// The control credential remains in this process and the parent-only ready line.
// Never expose it through the Next environment or renderer bootstrap.
process.env.SEW_SERVICE_INSTANCE_ID = serviceInstanceId;

const emit = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const isControlRoute = (pathname) =>
  (pathname.startsWith('/internal/') && pathname !== '/internal/health') ||
  pathname === '/api/study/backup';

/**
 * 唯一的外部任务入口：精确路径 `/api/pro/external`。
 *
 * 这是本机服务里**唯一**不要求桌面 session 的业务路径：它用外部 bearer token（owner/project
 * 绑定、有效期、最小 scope、仅存哈希）认证，认证在 Next 路由内完成。这里只做「是否绕过
 * 桌面 session」的判定，且必须是**精确**路径——不能放宽整个 `/api`、Host 或 control 路由。
 * Host 校验与 Origin 校验（对非 GET）仍然照常执行。
 */
const isExternalProRoute = (pathname) => pathname === '/api/pro/external';

const isPublicStatic = (pathname) =>
  pathname.startsWith('/_next/static/') || pathname === '/favicon.ico';

// Next may decode route segments after this boundary. Normalize for every
// policy decision and reject encoded separators or ambiguous multi-encoding.
const normalizePolicyPath = (pathname) => {
  let current = pathname;
  for (let pass = 0; pass < 5; pass += 1) {
    const decodedSegments = current.split('/').map((segment) => {
      let decoded;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        const error = new Error('Malformed URL path');
        error.code = 'PATH_NOT_ALLOWED';
        throw error;
      }
      if (decoded.includes('/') || decoded.includes('\\')) {
        const error = new Error('Encoded path separators are not allowed');
        error.code = 'PATH_NOT_ALLOWED';
        throw error;
      }
      return decoded;
    });
    const next = decodedSegments.join('/');
    if (next === current) return next;
    current = next;
  }
  const error = new Error('Ambiguous URL path encoding');
  error.code = 'PATH_NOT_ALLOWED';
  throw error;
};

const errorBody = (code, message, pending = false) => ({
  ok: false,
  error: { code, message, pending },
});

const main = async () => {
  const nextModule = await import('next');
  const next = nextModule.default ?? nextModule;
  const app = next({ dev: isDev, dir: appDir });
  await app.prepare();
  const handler = app.getRequestHandler();

  let shuttingDown = false;
  let shutdownPromise = null;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      // A signal may arrive without the Electron parent sending its close request.
      // Ask the Next route to close the active store before closing the HTTP listener.
      const address = server.address();
      const origin = address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : null;
      if (origin) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1200);
        try {
          for (const [path, body] of [['/internal/models/cancel', {}], ['/internal/project', { action: 'close' }]]) {
          const response = await fetch(`${origin}${path}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-sew-session': sessionToken,
              'x-sew-control': controlToken,
              origin,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          if (path === '/internal/models/cancel' && response.ok) emit({ type: 'model-requests-cancelled' });
          }
        } catch { /* service may already be unavailable */ }
        finally { clearTimeout(timer); }
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1500);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      process.exit(0);
    })();
    return shutdownPromise;
  };

  const server = http.createServer((req, res) => {
    // 畸形 URL 必须在任何身份/会话判断之前稳定失败，且连接正常结束。
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendJson(res, 400, errorBody('MALFORMED_URL', 'Request URL is malformed'));
      return;
    }
    let policyPath;
    try {
      policyPath = normalizePolicyPath(url.pathname);
    } catch (error) {
      sendJson(res, 400, errorBody(error.code ?? 'PATH_NOT_ALLOWED', error.message));
      return;
    }

    // Host 校验：拒绝非回环 Host，防止 DNS rebinding。
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${server.address()?.port}`) {
      sendJson(res, 403, errorBody('HOST_NOT_ALLOWED', 'Request host is not allowed'));
      return;
    }

    // 外部任务入口用 bearer token 认证，不要求桌面 session；其余 `/api/` 与 `/internal/`
    // 一律要求 session。这里必须是精确路径，不能放宽成前缀匹配。
    const external = isExternalProRoute(policyPath);
    const requiresSession =
      !external &&
      ((!isDev && !isPublicStatic(policyPath)) ||
        policyPath.startsWith('/api/') ||
        policyPath.startsWith('/internal/'));
    if (requiresSession && req.headers['x-sew-session'] !== sessionToken) {
      sendJson(res, 401, errorBody('SESSION_REQUIRED', 'Application session is required'));
      return;
    }

    if (isControlRoute(policyPath) && req.headers['x-sew-control'] !== controlToken) {
      sendJson(res, 401, errorBody('CONTROL_REQUIRED', 'Service control credential is required'));
      return;
    }

    if (policyPath === '/internal/health') {
      sendJson(res, 200, { ok: true, data: { ready: true, instanceId: serviceInstanceId, dev: isDev } });
      return;
    }

    // 外部入口用 bearer token 认证（非浏览器客户端通常不带 Origin），因此桌面 Origin 规则
    // 只保护使用 session 凭据的路径；外部入口的认证与 scope 由路由内的 token 判定负责。
    if (requiresSession && req.method !== 'GET' && req.method !== 'HEAD') {
      const expectedOrigin = `http://${host}`;
      if (req.headers.origin !== expectedOrigin) {
        sendJson(res, 403, errorBody('ORIGIN_NOT_ALLOWED', 'Request origin is not allowed'));
        return;
      }
    }

    if (shuttingDown && policyPath !== '/internal/project' && policyPath !== '/internal/models/cancel') {
      sendJson(res, 503, errorBody('SERVICE_STOPPING', 'Service is stopping', true));
      return;
    }

    if (policyPath === '/internal/shutdown' && req.method === 'POST') {
      sendJson(res, 200, { ok: true, data: { stopping: true } });
      setImmediate(() => { void shutdown(); });
      return;
    }

    handler(req, res);
  });

  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
  process.on('message', (message) => {
    if (message === 'sew:shutdown') void shutdown();
  });

  // 生产：端口 0，由系统分配可用端口，再把真实端口回传父进程。
  server.listen(requestedPort, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    emit({
      type: 'ready',
      port,
      origin: `http://127.0.0.1:${port}`,
      sessionToken,
      controlToken,
      serviceInstanceId,
      dev: isDev,
    });
  });
};

main().catch((error) => {
  emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
