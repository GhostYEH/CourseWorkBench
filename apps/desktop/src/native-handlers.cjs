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

const { realpathSync } = require('node:fs');
const { isAbsolute, relative, resolve, sep } = require('node:path');

const INVOKE_METHODS = [
  'projectCreate',
  'projectOpen',
  'projectClose',
  'projectRecent',
  'materialsPickFiles',
  'materialsOpenOriginal',
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
const { validateModelConfig } = require('./model-config.cjs');

/**
 * 解析真实路径后要求候选确实落在项目根内。
 *
 * 主进程不默认信任本地服务返回的路径：服务被绕过或目录被替换时，
 * 越出项目根的候选一律拒绝打开。
 */
const resolveWithinProject = (projectRoot, candidate) => {
  if (typeof candidate !== 'string' || candidate.length === 0) throw new Error('原文副本路径无效');
  const root = realpathSync(resolve(projectRoot));
  const target = realpathSync(resolve(candidate));
  const relativePath = relative(root, target);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('原文副本不在当前项目内，已拒绝打开');
  }
  return target;
};

const assertNoArgs = (args, method) => {
  if (args.length !== 0) throw new Error(`${method} 不接受参数`);
};

const registerNativeHandlers = ({ ipcMain, dialog, channels, getWindow, service, projects, settings, shell }) => {
  let configureQueue = Promise.resolve();
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

    /**
     * 打开某材料版本归档的原文副本。
     *
     * 渲染层只提交标识、版本与打开代次；副本由本地服务写在项目内，路径由服务返回，
     * 主进程复验归属后才交给系统打开。原文未归档时服务返回明确错误，这里不静默成功。
     */
    materialsOpenOriginal: async (value, ...rest) => {
      if (rest.length > 0) throw new Error('materialsOpenOriginal 只接受一个参数');
      if (!isPlainObject(value)) throw new Error('打开原文的请求必须是一个对象');
      const scope = value.scope;
      if (!isPlainObject(scope) || typeof scope.projectId !== 'string' || !scope.projectId) {
        throw new Error('打开原文需要有效的项目身份');
      }
      if (!Number.isSafeInteger(scope.generation)) throw new Error('打开原文需要有效的项目代次');
      if (typeof value.materialId !== 'string' || !value.materialId) throw new Error('材料标识无效');
      if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('材料版本无效');
      if (value.segmentId !== undefined && (typeof value.segmentId !== 'string' || !value.segmentId)) {
        throw new Error('段落标识无效');
      }

      const project = projects.current();
      if (!project) throw new Error('尚未打开项目，无法打开原文');
      if (!projects.sameScope(project, scope)) throw new Error('项目已切换或已重新打开，请重新选择材料');

      const selectedFor = projects.scopeOf();
      // 与材料导入同样的在途保护：打开过程中切换项目不能把副本写进新项目。
      const finishGrant = projects.beginGrant();
      let result;
      try {
        result = await service.request('POST', '/internal/project', {
          action: 'materialize-original',
          scope: selectedFor,
          materialId: value.materialId,
          revision: value.revision,
          ...(value.segmentId === undefined ? {} : { segmentId: value.segmentId }),
        });
      } finally {
        finishGrant();
      }
      if (!isPlainObject(result)) throw new Error('本地服务未返回原文副本信息');

      const target = resolveWithinProject(project.displayPath, result.path);
      const failure = await shell.openPath(target);
      if (failure) throw new Error('系统未能打开原文副本，请检查文件关联程序');
      return {
        displayName: typeof result.displayName === 'string' ? result.displayName : null,
        lineStart: Number.isSafeInteger(result.lineStart) ? result.lineStart : null,
        lineEnd: Number.isSafeInteger(result.lineEnd) ? result.lineEnd : null,
      };
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
      const config = validateModelConfig(value);
      const saved = configureQueue.catch(() => undefined).then(async () => {
        const { persisted } = settings.saveModelCredentials(config);
        await service.request('POST', '/internal/models', { action: 'configure', config, persisted });
      });
      configureQueue = saved;
      await saved;
    },

    modelsTest: async (...args) => {
      assertNoArgs(args, 'modelsTest');
      await configureQueue.catch(() => undefined);
      return service.request('POST', '/internal/models', { action: 'test' }, 45000);
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
