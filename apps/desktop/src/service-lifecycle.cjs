/**
 * 本地服务生命周期（《Electron 开发设计》2.1、第 5 节）。
 *
 * 职责：随包 Node 解析、以参数数组启动本地服务、父子握手、受控请求、退出时停止自有子进程、
 * 崩溃状态上报。
 *
 * 安全约定：
 * - 参数数组启动，不使用 shell 拼接路径；Windows 下隐藏后台窗口。
 * - 会话凭据经受控父子通道回传；控制凭据只留在本模块与服务，绝不下发渲染层。
 * - 只停止本模块启动的子进程，不误杀他人进程。
 */

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const createServiceLifecycle = ({ app, onStatus, spawn: spawnProcess = spawn }) => {
  const isDev = process.argv.includes('--dev') || !app.isPackaged;

  let service = null; // { child, origin, port, ..., projectRoot }
  let ready = null; // { origin, port, sessionToken, controlToken, serviceInstanceId }
  let stopping = false; // 主动停止中：exit 处理器据此上报 stopped 而非 crashed。
  let knownOrigin = null;
  let status = { state: 'starting', message: '本地服务正在启动。', port: null, revision: 0 };
  let statusRevision = 0;

  const publishStatus = (next) => {
    status = { ...next, revision: ++statusRevision };
    onStatus(status);
  };

  const serviceDir = () => {
    if (app.isPackaged) return join(process.resourcesPath, 'learning');
    return resolve(__dirname, '..', '..', 'learning');
  };

  /** 随包 Node：安装后用户无需另装 Node，也避免把 Next 服务绑定 Electron 的 ABI。 */
  const resolveNodeBinary = () => {
    if (app.isPackaged) {
      const bundled = join(process.resourcesPath, 'node', 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
      if (existsSync(bundled)) return bundled;
      throw new Error(`随包 Node 缺失：${bundled}`);
    }
    return process.env.SEW_NODE_BINARY || 'node';
  };

  const start = (projectRoot) =>
    new Promise((resolvePromise, reject) => {
      publishStatus({ state: 'starting', message: '本地服务正在启动。', port: null });
      const args = [join(serviceDir(), 'server.mjs'), '--project-root', projectRoot || ''];
      if (isDev) args.push('--dev');
      // 用户级目录交给本地服务，使全局外观/阅读偏好落到 userData 而非项目目录。
      args.push('--user-data', app.getPath('userData'));

      const child = spawnProcess(resolveNodeBinary(), args, {
        cwd: serviceDir(),
        // 参数数组启动，不使用 shell 拼接路径；Windows 下隐藏后台窗口。
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_ENV: isDev ? 'development' : 'production' },
      });

      let buffer = '';
      let settled = false;

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\n');
          if (!line) continue;
          let payload;
          try {
            payload = JSON.parse(line);
          } catch {
            continue;
          }
          if (payload.type === 'ready' && !settled) {
            settled = true;
            service = { child, ...payload, projectRoot: projectRoot || null };
            ready = {
              origin: payload.origin,
              port: payload.port,
              sessionToken: payload.sessionToken,
              controlToken: payload.controlToken,
              serviceInstanceId: payload.serviceInstanceId,
            };
            knownOrigin = payload.origin;
            publishStatus({ state: 'ready', message: '本地服务已就绪。', port: payload.port });
            resolvePromise(service);
          }
          if (payload.type === 'error' && !settled) {
            settled = true;
            reject(new Error(payload.message));
          }
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        // 只记录到主进程日志，不写入项目数据；凭据不会出现在这里。
        console.error('[local-service]', String(chunk).trim());
      });

      child.on('exit', (code, signal) => {
        // 主动停止（stop()）导致的退出不是崩溃，上报 stopped。
        const crashed = !stopping && service && service.child === child;
        service = null;
        ready = null;
        publishStatus({
          state: crashed ? 'crashed' : 'stopped',
          message: crashed
            ? `本地服务已退出（code ${code ?? 'null'}，signal ${signal ?? 'null'}）。可重新启动或退出后重开应用。`
            : '本地服务已停止。',
          port: null,
        });
        if (!settled) {
          settled = true;
          reject(new Error(`本地服务启动失败（code ${code ?? 'null'}）`));
        }
      });

      child.on('error', (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });

  /** 主进程到本地服务的受控请求：始终带会话凭据，控制路由额外带控制凭据。 */
  const request = async (method, path, body, timeout = 20000) => {
    if (!ready) throw new Error('本地服务未就绪');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
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
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!payload.ok) throw new Error(`${payload.error.code}: ${payload.error.message}`);
      return payload.data;
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * 退出时停止本模块启动的子进程：先注册退出等待，再请求服务关闭数据库（/internal/shutdown），
   * 超时后只 kill 自己的 child。调用方负责在停止前关闭当前项目。
   */
  const stop = async () => {
    const current = service;
    if (!current) return;
    // 置位后 exit 处理器将上报 stopped（D1）；结束后复位。
    stopping = true;
    try {
      // 子进程已退出（exitCode/signalCode 已置）时 exit 处理器已上报，立即完成，避免空等。
      if (current.child.exitCode !== null || current.child.signalCode !== null) return;
      // 先注册退出等待，再发起 shutdown 请求，避免请求期间子进程已退出导致 once('exit') 永不触发（D2）。
      const exited = new Promise((done) => {
        const timer = setTimeout(() => {
          try {
            current.child.kill();
          } catch {
            /* 已退出 */
          }
          done();
        }, 1200);
        current.child.once('exit', () => {
          clearTimeout(timer);
          done();
        });
      });
      try {
        await request('POST', '/internal/shutdown', undefined, 1500);
      } catch {
        /* 服务可能已不可达 */
      }
      await exited;
    } finally {
      service = null;
      ready = null;
      stopping = false;
    }
  };

  return {
    start,
    stop,
    request,
    getReady: () => ready,
    getService: () => service,
    getKnownOrigin: () => knownOrigin,
    getStatus: () => ({ ...status }),
  };
};

module.exports = { createServiceLifecycle };
