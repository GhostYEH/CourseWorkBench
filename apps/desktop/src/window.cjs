/**
 * 窗口与渲染会话边界（《Electron 开发设计》2.1 第 5 点、第 7 节）。
 *
 * 职责：创建 BrowserWindow、拦截导航与新窗口、只给本窗口主框架 + 精确 origin 注入会话头、
 * 持久化窗口几何。
 *
 * 安全约定：
 * - contextIsolation + sandbox 开启，nodeIntegration 关闭，禁用不安全内容。
 * - 会话头只注入本窗口 webContents 的主框架且请求 origin 等于已握手 origin；
 *   绝不给 iframe 或相似域名（判定逻辑在 http-boundary.cjs，有独立测试）。
 * - 控制凭据绝不出现在渲染请求头中。
 */

const { join } = require('node:path');
const { rendererRequestHeaders } = require('./http-boundary.cjs');

const createWindowController = ({ BrowserWindow, shell, settings, getServiceReady }) => {
  let window = null;
  let geometryTimer = null;

  const getWindow = () => window;

  const cancelGeometrySave = () => {
    if (geometryTimer !== null) clearTimeout(geometryTimer);
    geometryTimer = null;
  };

  const persistGeometry = () => {
    cancelGeometrySave();
    try {
      settings.persistWindowGeometry(window);
    } catch (error) {
      // Geometry is optional: a full/read-only disk must not crash the app or block exit.
      console.error('[desktop] unable to save window geometry', error);
    }
  };

  const scheduleGeometrySave = () => {
    cancelGeometrySave();
    geometryTimer = setTimeout(persistGeometry, 250);
  };

  const create = () => {
    const saved = settings.readWindowGeometry();
    const created = new BrowserWindow({
      width: saved?.width ?? 1440,
      height: saved?.height ?? 960,
      x: saved?.x ?? undefined,
      y: saved?.y ?? undefined,
      minWidth: 1024,
      minHeight: 640,
      show: false,
      backgroundColor: '#F7F3E8',
      title: '学科备考工作台',
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });

    window = created;
    if (saved?.maximized) created.maximize();

    // 导航与新窗口一律拦截，外链交给系统浏览器。
    created.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    created.webContents.on('will-navigate', (event, url) => {
      let destinationOrigin;
      try {
        destinationOrigin = new URL(url).origin;
      } catch {
        event.preventDefault();
        return;
      }
      const ready = getServiceReady();
      if (ready && destinationOrigin === ready.origin) return;
      event.preventDefault();
    });

    // Bind the renderer session credential to this BrowserWindow's main frame only.
    // Never inject the service control credential into renderer initiated requests.
    created.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['http://127.0.0.1/*'] },
      (details, callback) => {
        const ready = getServiceReady();
        callback({
          requestHeaders: rendererRequestHeaders(
            details,
            created.webContents.id,
            ready?.origin,
            ready?.sessionToken,
            details.requestHeaders,
          ),
        });
      },
    );

    created.once('ready-to-show', () => created.show());
    created.on('resize', scheduleGeometrySave);
    created.on('move', scheduleGeometrySave);
    created.on('close', persistGeometry);
    created.on('closed', () => {
      cancelGeometrySave();
      if (window === created) window = null;
    });
    return created;
  };

  return { create, getWindow, persistGeometry };
};

module.exports = { createWindowController };
