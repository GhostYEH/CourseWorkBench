/**
 * 用户级设置（《Electron 开发设计》第 4 节）。
 *
 * 职责：userData 路径、`desktop-state.json` 读写、窗口几何持久化、
 * 模型凭据（safeStorage）持久化与会话内回退。
 *
 * 边界：本模块不持有窗口、服务或项目状态，只读写用户目录；窗口对象由调用方显式传入。
 * 全局配置只由主进程写入，本地服务负责阅读/主题/课堂视图偏好。
 */

const {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  statSync,
} = require('node:fs');
const { join, isAbsolute } = require('node:path');
const { validateModelConfig } = require('./model-config.cjs');

const EMPTY_STATE = Object.freeze({ window: null, recentProjects: [] });

const createSettings = ({ app, safeStorage }) => {
  const userDataDir = () => app.getPath('userData');
  const configFile = () => join(userDataDir(), 'desktop-state.json');
  const credentialFile = () => join(userDataDir(), 'model-credentials.bin');

  /** 磁盘 JSON 是不可信输入：只接受普通对象，其余回退默认值。 */
  const readState = () => {
    try {
      const parsed = JSON.parse(readFileSync(configFile(), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...EMPTY_STATE };
      return parsed;
    } catch {
      return { ...EMPTY_STATE };
    }
  };

  const writeState = (next) => {
    mkdirSync(userDataDir(), { recursive: true });
    writeFileSync(configFile(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  };

  const readRecentProjects = () => {
    const recent = readState().recentProjects;
    return Array.isArray(recent) ? recent : [];
  };

  // Restore a previously selected space; a fresh install needs no directory picker.
  const startupProjectRoot = () => {
    for (const item of readRecentProjects()) {
      if (!item || typeof item.path !== 'string' || !isAbsolute(item.path)) continue;
      try {
        if (statSync(item.path).isDirectory() && statSync(join(item.path, 'project.json')).isFile())
          return item.path;
      } catch {
        /* A moved/deleted space stays in recent history for manual recovery. */
      }
    }
    return join(userDataDir(), 'study-spaces', '我的备考');
  };

  const rememberProject = (project) => {
    const current = readState();
    const previous = Array.isArray(current.recentProjects) ? current.recentProjects : [];
    const recent = [
      { path: project.displayPath, name: project.displayName, at: new Date().toISOString() },
      ...previous.filter((item) => item && item.path !== project.displayPath),
    ].slice(0, 10);
    writeState({ ...current, recentProjects: recent });
  };

  const readWindowGeometry = () => {
    const saved = readState().window;
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : null;
  };

  const persistWindowGeometry = (window) => {
    if (!window || window.isDestroyed()) return;
    const bounds = window.getNormalBounds();
    const current = readState();
    writeState({ ...current, window: { ...bounds, maximized: window.isMaximized() } });
  };

  // 加密不可用时使用会话内密钥，并明确不持久保存（《Electron 开发设计》第 4 节）。
  let sessionModelCredentials = null;

  const saveModelCredentials = (value) => {
    const validated = validateModelConfig(value);
    if (!safeStorage.isEncryptionAvailable()) {
      sessionModelCredentials = validated;
      return { persisted: false };
    }
    mkdirSync(userDataDir(), { recursive: true });
    const temporary = `${credentialFile()}.tmp`;
    const ciphertext = safeStorage.encryptString(JSON.stringify(validated));
    writeFileSync(temporary, ciphertext, { mode: 0o600 });
    try {
      renameSync(temporary, credentialFile());
    } catch (error) {
      // Some redirected Windows user-data volumes reject rename with EXDEV.
      // The fallback writes encrypted bytes only; invalid/partial ciphertext is
      // rejected by readModelCredentials, never consumed as configuration.
      if (error.code !== 'EXDEV') throw error;
      writeFileSync(credentialFile(), ciphertext, { mode: 0o600 });
      unlinkSync(temporary);
    }
    sessionModelCredentials = null;
    return { persisted: true };
  };

  const readSessionModelCredentials = () => sessionModelCredentials;
  const readModelCredentials = () => {
    if (sessionModelCredentials)
      return { config: validateModelConfig(sessionModelCredentials), persisted: false };
    if (!safeStorage.isEncryptionAvailable()) return null;
    try {
      const decoded = safeStorage.decryptString(readFileSync(credentialFile()));
      return { config: validateModelConfig(JSON.parse(decoded)), persisted: true };
    } catch {
      return null;
    }
  };

  return {
    userDataDir,
    configFile,
    credentialFile,
    readState,
    writeState,
    readRecentProjects,
    startupProjectRoot,
    rememberProject,
    readWindowGeometry,
    persistWindowGeometry,
    saveModelCredentials,
    readSessionModelCredentials,
    readModelCredentials,
  };
};

module.exports = { createSettings };
