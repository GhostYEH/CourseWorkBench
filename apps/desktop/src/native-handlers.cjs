// @ts-check
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

/** @type {import('./native-handler-ports').InvokeMethod[]} */
const INVOKE_METHODS = [
  'projectCreate',
  'projectOpen',
  'projectClose',
  'projectRecent',
  'materialsPickFiles',
  'materialsOpenOriginal',
  'exportsPickTarget',
  'exportsBackupProject',
  'exportsRestoreProject',
  'preferencesRead',
  'preferencesSave',
  'modelsConfigure',
  'modelsTest',
  'getServiceState',
];

/** @type {(import('./native-handler-ports').SendMethod & import('./native-handler-ports').NoArgumentMethod)[]} */
const SEND_METHODS = ['windowMinimize', 'windowToggleMaximize', 'windowClose'];

/** @param {unknown} value @returns {value is import('./native-handler-ports').RecordValue} */
const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const { validateModelConfig } = require('./model-config.cjs');

/** @param {unknown} value @returns {import('../../../packages/study-contracts/src/ipc').OpenedProjectPayload} */
const openedProject = (value) => {
  if (
    !isPlainObject(value) ||
    typeof value.projectId !== 'string' ||
    typeof value.displayName !== 'string' ||
    typeof value.generation !== 'number' ||
    typeof value.displayPath !== 'string' ||
    typeof value.formatVersion !== 'number'
  ) {
    throw new Error('本地服务未返回有效项目身份');
  }
  return {
    ...value,
    projectId: value.projectId,
    displayName: value.displayName,
    generation: value.generation,
    displayPath: value.displayPath,
    formatVersion: value.formatVersion,
  };
};

/**
 * 解析真实路径后要求候选确实落在项目根内。
 *
 * 主进程不默认信任本地服务返回的路径：服务被绕过或目录被替换时，
 * 越出项目根的候选一律拒绝打开。
 */
/** @param {string} projectRoot @param {unknown} candidate */
const resolveWithinProject = (projectRoot, candidate) => {
  if (typeof candidate !== 'string' || candidate.length === 0) throw new Error('原文副本路径无效');
  const root = realpathSync(resolve(projectRoot));
  const target = realpathSync(resolve(candidate));
  const relativePath = relative(root, target);
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error('原文副本不在当前项目内，已拒绝打开');
  }
  return target;
};

/**
 * 服务按父目录的真实路径发布新目录，而选择框回显的可能是联接前缀或不同盘符大小写。
 * 字符串不等不代表写错了位置，因此回退到真实路径比较；两者都不成立时拒绝承认完成。
 */
/** @param {string} selected @param {unknown} reported @returns {boolean} */
const publishedRootMatches = (selected, reported) => {
  if (typeof reported !== 'string' || reported.length === 0) return false;
  if (reported === selected) return true;
  try {
    return realpathSync(resolve(selected)) === reported;
  } catch {
    return false;
  }
};

/** @param {unknown[]} args @param {import('./native-handler-ports').NoArgumentMethod} method */
const assertNoArgs = (args, method) => {
  if (args.length !== 0) throw new Error(`${method} 不接受参数`);
};

/** @param {import('./native-handler-ports').NativeHandlerPorts} ports */
const registerNativeHandlers = ({
  ipcMain,
  dialog,
  channels,
  getWindow,
  service,
  projects,
  settings,
  shell,
}) => {
  let configureQueue = Promise.resolve();
  /** 只接受来自本窗口主框架的调用；内层 iframe 与外部页不能调用。 */
  /** @param {import('./native-handler-ports').CallerEvent} event */
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

  /** @satisfies {import('./native-handler-ports').InvokeHandlers} */
  const handlers = {
    /** @param {unknown[]} args */
    projectCreate: async (...args) => {
      assertNoArgs(args, 'projectCreate');
      const result = await dialog.showOpenDialog(getWindow(), {
        title: '选择或新建项目目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      const selected = result.filePaths[0];
      if (result.canceled || selected === undefined) return null; // 取消是正常取消
      return openedProject(await projects.open(selected));
    },

    /** @param {unknown[]} args */
    projectOpen: async (...args) => {
      assertNoArgs(args, 'projectOpen');
      const result = await dialog.showOpenDialog(getWindow(), {
        title: '打开项目目录',
        properties: ['openDirectory'],
      });
      const selected = result.filePaths[0];
      if (result.canceled || selected === undefined) return null;
      return openedProject(await projects.open(selected));
    },

    /** @param {unknown[]} args */
    projectClose: async (...args) => {
      assertNoArgs(args, 'projectClose');
      await projects.close();
    },

    /** @param {unknown[]} args */
    projectRecent: async (...args) => {
      assertNoArgs(args, 'projectRecent');
      // 只返回 RecentProjectDto 的真实字段，不再伪造 projectId/generation/formatVersion。
      return settings.readRecentProjects().flatMap((item) => {
        if (!isPlainObject(item) || typeof item.path !== 'string' || typeof item.name !== 'string')
          return [];
        return [
          {
            displayPath: item.path,
            displayName: item.name,
            lastOpenedAt: typeof item.at === 'string' ? item.at : '',
          },
        ];
      });
    },

    /** @param {unknown[]} args */
    materialsPickFiles: async (...args) => {
      assertNoArgs(args, 'materialsPickFiles');
      const selectedFor = projects.scopeOf();
      const result = await dialog.showOpenDialog(getWindow(), {
        title: '选择要导入的材料',
        filters: [{ name: '学习材料', extensions: ['txt', 'md', 'pdf', 'docx', 'pptx', 'xlsx'] }],
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled) return { files: [] };
      if (!projects.sameScope(selectedFor, projects.scopeOf()))
        throw new Error('选择期间项目已切换，请重新选择材料');
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
    /** @param {unknown} [value] @param {unknown[]} rest */
    materialsOpenOriginal: async (value, ...rest) => {
      if (rest.length > 0) throw new Error('materialsOpenOriginal 只接受一个参数');
      if (!isPlainObject(value)) throw new Error('打开原文的请求必须是一个对象');
      const scope = value.scope;
      if (!isPlainObject(scope) || typeof scope.projectId !== 'string' || !scope.projectId) {
        throw new Error('打开原文需要有效的项目身份');
      }
      if (typeof scope.generation !== 'number' || !Number.isSafeInteger(scope.generation))
        throw new Error('打开原文需要有效的项目代次');
      if (typeof value.materialId !== 'string' || !value.materialId)
        throw new Error('材料标识无效');
      if (
        typeof value.revision !== 'number' ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 1
      )
        throw new Error('材料版本无效');
      if (
        value.segmentId !== undefined &&
        (typeof value.segmentId !== 'string' || !value.segmentId)
      ) {
        throw new Error('段落标识无效');
      }
      /** @satisfies {import('../../../packages/study-contracts/src/ipc').IpcContract['materialsOpenOriginal']['args']} */
      const requestArgs = [
        {
          scope: { projectId: scope.projectId, generation: scope.generation },
          materialId: value.materialId,
          revision: value.revision,
          ...(value.segmentId === undefined ? {} : { segmentId: value.segmentId }),
        },
      ];
      const request = requestArgs[0];

      const project = projects.current();
      if (!project) throw new Error('尚未打开项目，无法打开原文');
      if (!projects.sameScope(project, request.scope))
        throw new Error('项目已切换或已重新打开，请重新选择材料');

      const selectedFor = projects.scopeOf();
      // 与材料导入同样的在途保护：打开过程中切换项目不能把副本写进新项目。
      const finishGrant = projects.beginGrant();
      let result;
      try {
        result = await service.request('POST', '/internal/project', {
          action: 'materialize-original',
          scope: selectedFor,
          materialId: request.materialId,
          revision: request.revision,
          ...(request.segmentId === undefined ? {} : { segmentId: request.segmentId }),
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
        lineStart:
          typeof result.lineStart === 'number' && Number.isSafeInteger(result.lineStart)
            ? result.lineStart
            : null,
        lineEnd:
          typeof result.lineEnd === 'number' && Number.isSafeInteger(result.lineEnd)
            ? result.lineEnd
            : null,
      };
    },

    /** @param {unknown} [defaultName] @param {unknown[]} rest */
    exportsPickTarget: async (defaultName, ...rest) => {
      if (rest.length > 0) throw new Error('exportsPickTarget 只接受一个参数');
      if (defaultName !== undefined && typeof defaultName !== 'string') {
        throw new Error('导出文件名必须是字符串');
      }
      const name = defaultName && defaultName.trim() ? defaultName : '导出.md';
      /** @satisfies {import('../../../packages/study-contracts/src/ipc').IpcContract['exportsPickTarget']['args']} */
      const requestArgs = [name];
      const result = await dialog.showSaveDialog(getWindow(), {
        title: '导出',
        defaultPath: requestArgs[0],
      });
      return result.canceled ? null : (result.filePath ?? null);
    },

    /** @param {unknown[]} args */
    exportsBackupProject: async (...args) => {
      assertNoArgs(args, 'exportsBackupProject');
      const project = projects.current();
      if (!project) return null;
      const selectedFor = projects.scopeOf();
      const projectName = project.displayName;
      const result = await dialog.showSaveDialog(getWindow(), {
        title: '项目备份：选择新备份目录的名称',
        defaultPath: `${projectName}-backup-${Date.now()}`,
      });
      if (result.canceled) return null;
      if (!result.filePath) throw new Error('未选择备份目录');
      if (!projects.sameScope(selectedFor, projects.scopeOf()))
        throw new Error('备份期间项目已切换，请重试');
      // 服务用一致性数据库快照及校验清单生成新目录，不覆盖已有内容。
      const finishGrant = projects.beginGrant();
      try {
        const backup = await service.request(
          'POST',
          '/api/study/backup',
          { action: 'backup', scope: selectedFor, targetPath: result.filePath },
          300000,
        );
        if (
          !isPlainObject(backup) ||
          !publishedRootMatches(result.filePath, backup.destinationRoot)
        )
          throw new Error('服务未确认项目备份结果');
      } finally {
        finishGrant();
      }
      return result.filePath;
    },

    /** @param {unknown[]} args */
    exportsRestoreProject: async (...args) => {
      assertNoArgs(args, 'exportsRestoreProject');
      const selectedFor = projects.scopeOf();
      const source = await dialog.showOpenDialog(getWindow(), {
        title: '选择包含 backup.json 的项目备份目录',
        properties: ['openDirectory'],
      });
      if (source.canceled || source.filePaths.length === 0) return null;
      const destination = await dialog.showSaveDialog(getWindow(), {
        title: '恢复项目：选择尚不存在的新目录名称',
        defaultPath: `恢复项目-${Date.now()}`,
      });
      if (destination.canceled) return null;
      if (!destination.filePath) throw new Error('未选择恢复目录');
      if (!projects.sameScope(selectedFor, projects.scopeOf()))
        throw new Error('选择期间项目已切换，请重新恢复');
      const finishGrant = projects.beginGrant();
      try {
        const restored = await service.request(
          'POST',
          '/api/study/backup',
          {
            action: 'restore',
            scope: selectedFor.projectId ? selectedFor : null,
            backupPath: source.filePaths[0],
            targetPath: destination.filePath,
          },
          300000,
        );
        if (
          !isPlainObject(restored) ||
          !publishedRootMatches(destination.filePath, restored.destinationRoot)
        )
          throw new Error('服务未确认项目恢复结果');
      } finally {
        finishGrant();
      }
      return destination.filePath;
    },

    /** @param {unknown[]} args */
    preferencesRead: async (...args) => {
      assertNoArgs(args, 'preferencesRead');
      const data = await service.request('GET', '/api/study/preferences');
      if (!isPlainObject(data)) throw new Error('本地服务未返回偏好信息');
      return data.appearance;
    },

    /** @param {unknown} [value] @param {unknown[]} rest */
    preferencesSave: async (value, ...rest) => {
      if (rest.length > 0) throw new Error('preferencesSave 只接受一个参数');
      if (!isPlainObject(value)) throw new Error('偏好必须是一个对象');
      /** @satisfies {import('../../../packages/study-contracts/src/ipc').IpcContract['preferencesSave']['args']} */
      const requestArgs = [value];
      const data = await service.request('PUT', '/api/study/preferences', {
        appearance: requestArgs[0],
      });
      if (!isPlainObject(data)) throw new Error('本地服务未返回偏好信息');
      return data.appearance;
    },

    /** @param {unknown} [value] @param {unknown[]} rest */
    modelsConfigure: async (value, ...rest) => {
      if (rest.length > 0) throw new Error('modelsConfigure 只接受一个参数');
      if (!isPlainObject(value)) throw new Error('模型配置必须是一个对象');
      /** @satisfies {import('../../../packages/study-contracts/src/ipc').IpcContract['modelsConfigure']['args']} */
      const requestArgs = [value];
      const config = validateModelConfig(requestArgs[0]);
      const saved = configureQueue
        .catch(() => undefined)
        .then(async () => {
          const { persisted } = settings.saveModelCredentials(config);
          await service.request('POST', '/internal/models', {
            action: 'configure',
            config,
            persisted,
          });
        });
      configureQueue = saved;
      await saved;
    },

    /** @param {unknown[]} args */
    modelsTest: async (...args) => {
      assertNoArgs(args, 'modelsTest');
      await configureQueue.catch(() => undefined);
      const result = await service.request('POST', '/internal/models', { action: 'test' }, 45000);
      if (
        !isPlainObject(result) ||
        typeof result.ok !== 'boolean' ||
        typeof result.message !== 'string'
      ) {
        throw new Error('本地服务未返回有效模型测试结果');
      }
      return { ...result, ok: result.ok, message: result.message };
    },

    /** @param {unknown[]} args */
    getServiceState: async (...args) => {
      assertNoArgs(args, 'getServiceState');
      const ready = service.getReady();
      const rendererReady = ready ? (({ controlToken, ...payload }) => payload)(ready) : null;
      return { status: service.getStatus(), ready: rendererReady };
    },
  };

  /** @satisfies {import('./native-handler-ports').SendHandlers} */
  const sendHandlers = {
    /** @param {unknown[]} _args */
    windowMinimize: (..._args) => getWindow()?.minimize(),
    /** @param {unknown[]} _args */
    windowToggleMaximize: (..._args) => {
      const window = getWindow();
      if (!window) return;
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    },
    /** @param {unknown[]} _args */
    windowClose: (..._args) => getWindow()?.close(),
  };

  /** @template {import('../../../packages/study-contracts/src/ipc').IpcMethod} M @param {M[]} methods @returns {[M, string][]} */
  const channelsFor = (methods) =>
    methods.map((method) => {
      // Snapshot reads share the existing status channel: incoming invoke
      // requests and outgoing status events use opposite IPC directions.
      const channel = method === 'getServiceState' ? channels.serviceStatus : channels[method];
      if (typeof channel !== 'string' || !channel.startsWith('sew:')) {
        throw new Error(`IPC 合同缺少 ${method} 的通道名`);
      }
      return [method, channel];
    });

  // 声明与实现一一对应：缺实现或实现不在合同中都直接失败。
  for (const method of INVOKE_METHODS) {
    if (typeof handlers[method] !== 'function') throw new Error(`IPC 方法 ${method} 未实现`);
  }
  for (const method of Object.keys(handlers)) {
    if (!INVOKE_METHODS.some((allowed) => allowed === method))
      throw new Error(`IPC handler ${method} 不在合同方法表中`);
  }
  for (const method of SEND_METHODS) {
    if (typeof sendHandlers[method] !== 'function') throw new Error(`IPC 方法 ${method} 未实现`);
  }

  for (const [method, channel] of channelsFor(INVOKE_METHODS)) {
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedCaller(event);
      return handlers[method](...args);
    });
  }

  for (const [method, channel] of channelsFor(SEND_METHODS)) {
    ipcMain.on(channel, (event, ...args) => {
      assertTrustedCaller(event);
      sendHandlers[method](...args);
    });
  }
};

module.exports = { registerNativeHandlers, INVOKE_METHODS, SEND_METHODS };
