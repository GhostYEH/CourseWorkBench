/**
 * 原生 IPC handler 注册（《Electron 开发设计》第 5 节）。
 *
 * 职责：按方法名表把声明（ipc-channels.json）与实现一一绑定，并校验调用方与入参。
 *
 * 安全约定：
 * - 只接受本窗口 webContents 主框架、且 origin 等于已握手服务 origin 的调用；
 *   内层 iframe 与外部页不能调用（assertTrustedCaller）。
 * - 每个 handler 校验入参对象/类型/范围；界面隐藏按钮不构成权限检查。
 * - 控制凭据只留在主进程与服务，绝不在此下发渲染层。
 */

const INVOKE_METHODS = [
  'projectCreate',
  'projectOpen',
  'projectClose',
  'projectRecent',
  'materialsPickFiles',
  'exportsPickTarget',
  'exportsBackupProject',
  'preferencesRead',
  'preferencesSave',
  'modelsConfigure',
  'modelsTest',
  'getServiceState',
];

const SEND_METHODS = ['windowMinimize', 'windowToggleMaximize', 'windowClose'];

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const assertNoArgs = (args, method) => {
  if (args.length !== 0) throw new Error(`${method} 不接受参数`);
};

const registerNativeHandlers = ({ ipcMain, dialog, channels, getWindow, service, projects, settings }) => {
  /** 只接受来自本窗口主框架的调用；内层 iframe 与外部页不能调用。 */
  const assertTrustedCaller = (event) => {
    const window = getWindow();
    const frame = event.senderFrame;
    if (!window || event.sender !== window.webContents) {
      throw new Error('IPC 调用方不是本应用窗口');
    }
    if (!frame || frame.parent !== null) {
      throw new Error('IPC 只接受主框架调用');
    }
    let callerOrigin;
    try {
      callerOrigin = new URL(frame.url).origin;
    } catch {
      throw new Error('IPC 调用方来源无效');
    }
    // The local service may have exited while the renderer remains loaded.
    // Permit only the origin previously established by its authenticated ready
    // handshake so the renderer can retrieve the current crashed status.
    const trustedOrigin = service.getReady()?.origin ?? service.getKnownOrigin();
    if (!trustedOrigin || callerOrigin !== trustedOrigin) {
      throw new Error('IPC 调用方来源不是本地应用');
    }
  };

  const handlers = {
    projectCreate: async (...args) => {
      assertNoArgs(args, 'projectCreate');
      const result = await dialog.showOpenDialog(getWindow(), {
        title: '选择或新建项目目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return null; // 取消是正常取消
      return projects.open(result.filePaths[0]);
    },

    projectOpen: async (...args) => {
      assertNoArgs(args, 'projectOpen');
      const result = await dialog.showOpenDialog(getWindow(), {
        title: '打开项目目录',
        properties: ['openDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return projects.open(result.filePaths[0]);
    },

    projectClose: async (...args) => {
      assertNoArgs(args, 'projectClose');
      await projects.close();
    },

    projectRecent: async (...args) => {
      assertNoArgs(args, 'projectRecent');
      // 只返回 RecentProjectDto 的真实字段，不再伪造 projectId/generation/formatVersion。
      return settings
        .readRecentProjects()
        .filter((item) => item && typeof item.path === 'string' && typeof item.name === 'string')
        .map((item) => ({
          displayPath: item.path,
          displayName: item.name,
          lastOpenedAt: typeof item.at === 'string' ? item.at : '',
        }));
    },

    materialsPickFiles: async (...args) => {
      assertNoArgs(args, 'materialsPickFiles');
      const selectedFor = projects.scopeOf();
      const result = await dialog.showOpenDialog(getWindow(), {
        title: '选择要导入的材料',
        filters: [{ name: '文本材料', extensions: ['txt', 'md'] }],
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled) return { files: [] };
      if (!projects.sameScope(selectedFor, projects.scopeOf())) throw new Error('选择期间项目已切换，请重新选择材料');
      const files = result.filePaths.map((filePath) => ({
        path: filePath,
        name: filePath.split(/[\\/]/).pop() || filePath,
        size: 0,
      }));
      // 发放操作级路径授权：渲染层拿到路径字符串不等于可以任意读盘。
      const finishGrant = projects.beginGrant();
      try {
        await service.request('POST', '/internal/project', {
          action: 'authorize',
          scope: selectedFor,
          paths: files.map((file) => file.path),
        });
      } finally {
        finishGrant();
      }
      return { files };
    },

    exportsPickTarget: async (defaultName, ...rest) => {
      if (rest.length > 0) throw new Error('exportsPickTarget 只接受一个参数');
      if (defaultName !== undefined && typeof defaultName !== 'string') {
        throw new Error('导出文件名必须是字符串');
      }
      const name = defaultName && defaultName.trim() ? defaultName : '导出.md';
      const result = await dialog.showSaveDialog(getWindow(), { title: '导出', defaultPath: name });
      return result.canceled ? null : result.filePath;
    },

    exportsBackupProject: async (...args) => {
      assertNoArgs(args, 'exportsBackupProject');
      const project = projects.current();
      if (!project) return null;
      const selectedFor = projects.scopeOf();
      const projectName = project.displayName;
      const result = await dialog.showSaveDialog(getWindow(), {
        title: '备份项目',
        defaultPath: `${projectName}-backup.db`,
        filters: [{ name: 'SQLite 备份', extensions: ['db'] }],
      });
      if (result.canceled) return null;
      if (!projects.sameScope(selectedFor, projects.scopeOf())) throw new Error('备份期间项目已切换，请重试');
      // 一致性备份由服务端驱动完成，不复制运行中的 .db 文件。
      await service.request('POST', '/api/study/backup', { scope: selectedFor, targetPath: result.filePath });
      return result.filePath;
    },

    preferencesRead: async (...args) => {
      assertNoArgs(args, 'preferencesRead');
      const data = await service.request('GET', '/api/study/preferences');
      return data.appearance;
    },

    preferencesSave: async (value, ...rest) => {
      if (rest.length > 0) throw new Error('preferencesSave 只接受一个参数');
      if (!isPlainObject(value)) throw new Error('偏好必须是一个对象');
      const data = await service.request('PUT', '/api/study/preferences', { appearance: value });
      return data.appearance;
    },

    modelsConfigure: async (value, ...rest) => {
      if (rest.length > 0) throw new Error('modelsConfigure 只接受一个参数');
      if (!isPlainObject(value)) throw new Error('模型配置必须是一个对象');
      settings.saveModelCredentials(value);
    },

    modelsTest: async (...args) => {
      assertNoArgs(args, 'modelsTest');
      return { ok: false, message: '尚未配置模型连接' };
    },

    getServiceState: async (...args) => {
      assertNoArgs(args, 'getServiceState');
      const ready = service.getReady();
      const rendererReady = ready
        ? (({ controlToken, ...payload }) => payload)(ready)
        : null;
      return { status: service.getStatus(), ready: rendererReady };
    },
  };

  const sendHandlers = {
    windowMinimize: () => getWindow()?.minimize(),
    windowToggleMaximize: () => {
      const window = getWindow();
      if (!window) return;
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    },
    windowClose: () => getWindow()?.close(),
  };

  const channelsFor = (methods) =>
    Object.fromEntries(
      methods.map((method) => {
        // Snapshot reads share the existing status channel: incoming invoke
        // requests and outgoing status events use opposite IPC directions.
        const channel = method === 'getServiceState' ? channels.serviceStatus : channels[method];
        if (typeof channel !== 'string' || !channel.startsWith('sew:')) {
          throw new Error(`IPC 合同缺少 ${method} 的通道名`);
        }
        return [method, channel];
      }),
    );

  // 声明与实现一一对应：缺实现或实现不在合同中都直接失败。
  for (const method of INVOKE_METHODS) {
    if (typeof handlers[method] !== 'function') throw new Error(`IPC 方法 ${method} 未实现`);
  }
  for (const method of Object.keys(handlers)) {
    if (!INVOKE_METHODS.includes(method)) throw new Error(`IPC handler ${method} 不在合同方法表中`);
  }
  for (const method of SEND_METHODS) {
    if (typeof sendHandlers[method] !== 'function') throw new Error(`IPC 方法 ${method} 未实现`);
  }

  for (const [method, channel] of Object.entries(channelsFor(INVOKE_METHODS))) {
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedCaller(event);
      return handlers[method](...args);
    });
  }

  for (const [method, channel] of Object.entries(channelsFor(SEND_METHODS))) {
    ipcMain.on(channel, (event, ...args) => {
      assertTrustedCaller(event);
      sendHandlers[method](...args);
    });
  }
};

module.exports = { registerNativeHandlers, INVOKE_METHODS, SEND_METHODS };
