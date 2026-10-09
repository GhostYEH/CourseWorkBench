/**
 * Electron 主进程组合根（《Electron 开发设计》第 2/4/5 节）。
 *
 * 职责边界：
 * - 原生权限、凭据、窗口与本地服务生命周期；**不**打开数据库，也不做领域判断。
 * - 本地服务（随包 Node 运行的 Next 应用）拥有 SQLite 与全部领域事实。
 *
 * 结构：本文件只做 bootstrap 与退出编排，具体职责在下列模块中，共享状态各自单点持有：
 * - settings.cjs           用户目录、desktop-state.json、窗口几何、模型凭据
 * - service-lifecycle.cjs  随包 Node、启动/停止本地服务、受控请求、崩溃上报
 * - project-coordinator.cjs 项目打开/关闭/代次、scope、材料授权在途计数
 * - window.cjs             窗口创建、导航拦截、主框架精确 origin 会话头注入
 * - native-handlers.cjs    IPC handler 注册与调用方/入参校验
 *
 * 安全约定：
 * - contextIsolation + sandbox 开启，nodeIntegration 关闭。
 * - preload 逐项暴露白名单方法，不提供任意 invoke/send。
 * - IPC 校验调用方主框架、参数与项目打开代次。
 * - 应用会话凭据只经受控通道（preload）传递，不放 URL、日志或 NEXT_PUBLIC 配置；
 *   控制凭据只留在主进程与服务，serviceReady 下发前必须剥掉 controlToken。
 */

const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const { mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const channels = require('@sew/study-contracts/ipc-channels.json');
const { createSettings } = require('./settings.cjs');
const { createServiceLifecycle } = require('./service-lifecycle.cjs');
const { createProjectCoordinator } = require('./project-coordinator.cjs');
const { createWindowController } = require('./window.cjs');
const { registerNativeHandlers } = require('./native-handlers.cjs');

// Honor Electron's standard per-launch user-data-dir switch before any profile
// reads. This also lets portable installs and isolated verification runs keep
// their settings beside a caller-selected profile without touching the default.
const explicitUserDataDir = app.commandLine.getSwitchValue('user-data-dir');
if (explicitUserDataDir) {
  const absoluteUserDataDir = resolve(explicitUserDataDir);
  mkdirSync(absoluteUserDataDir, { recursive: true });
  app.setPath('userData', absoluteUserDataDir);
}

const settings = createSettings({ app, safeStorage });

const notifyServiceStatus = (payload) => {
  const window = windows?.getWindow();
  if (window && !window.isDestroyed()) window.webContents.send(channels.serviceStatus, payload);
};

const service = createServiceLifecycle({ app, onStatus: notifyServiceStatus });

const projects = createProjectCoordinator({
  service,
  onProjectChanged: (project) => {
    if (project) settings.rememberProject(project);
    const window = windows?.getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channels.projectOpen, project);
  },
});

const windows = createWindowController({
  BrowserWindow,
  shell,
  settings,
  getServiceReady: () => service.getReady(),
});

// ——————————————————————— 启动与退出 ———————————————————————

const bootstrap = async () => {
  registerNativeHandlers({
    ipcMain,
    dialog,
    channels,
    getWindow: () => windows.getWindow(),
    service,
    projects,
    settings,
    shell,
  });
  const window = windows.create();
  const initialRoot = process.env.SEW_PROJECT_ROOT || settings.startupProjectRoot();

  try {
    await service.start(initialRoot);
  } catch (error) {
    dialog.showErrorBox('本地服务启动失败', String(error && error.message ? error.message : error));
    app.quit();
    return;
  }

  const ready = service.getReady();
  const savedModel = settings.readModelCredentials();
  if (savedModel) {
    await service
      .request('POST', '/internal/models', { action: 'configure', ...savedModel })
      .catch(() => {
        console.error('[desktop] unable to restore model configuration');
      });
  }
  // Validate the space before rendering: a damaged old space must not trap the
  // learner on an error page without access to the native recovery controls.
  let entry = '/workbench';
  try {
    const opened = await service.request(
      'POST',
      '/internal/project',
      { action: 'open', path: initialRoot },
      30000,
    );
    projects.adopt(opened.session);
    settings.rememberProject(opened.session);
  } catch {
    await projects.close();
    entry = '/no-project?recovery=1';
  }
  // 只加载已握手的准确本地 origin。
  await window.loadURL(`${ready.origin}${entry}`);
  // 下发前剥掉控制凭据：渲染层只拿到会话凭据。
  const { controlToken, ...rendererState } = ready;
  window.webContents.send(channels.serviceReady, rendererState);

  if (projects.current()) window.webContents.send(channels.projectOpen, projects.current());
};

/**
 * 退出顺序：停止新任务（等待材料授权在途）→ 关闭数据库（/internal/project close）
 * → 停止本应用启动的子进程（/internal/shutdown + kill 自有 child）。
 */
const shutdown = async () => {
  if (!service.getService()) return;
  try {
    await projects.waitForGrants();
    if (projects.current()) {
      await service.request('POST', '/internal/project', { action: 'close' }, 1500);
    }
  } catch {
    /* 服务可能已不可达 */
  }
  await service.stop();
};

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  app.quit();
});

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  try {
    windows.persistGeometry();
  } catch (error) {
    console.error('[desktop] unable to save window geometry before exit', error);
  }
  shutdown().finally(() => app.exit(0));
});
