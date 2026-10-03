/**
 * 服务会话（《Electron 开发设计》第 4/5 节）。
 *
 * - 项目目录由主进程通过受控通道授权；渲染层只持项目 ID 与打开代次。
 * - 打开代次每次打开都重新分配，同路径重开也算新代次。
 * - 本地服务是唯一数据库写入者，写操作串行执行。
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { MAX_MATERIAL_BYTES, StudyError, newId, type ProjectScope } from '@sew/study-contracts';
import {
  PROJECT_FORMAT_VERSION,
  StudyStore,
  assertManifestCompatible,
  ensureProjectLayout,
  isDirectory,
  readManifest,
  writeManifest,
  type ProjectManifest,
} from '@sew/study-storage';

export interface Session {
  projectId: string;
  displayName: string;
  displayPath: string;
  generation: number;
  store: StudyStore;
  openedAt: string;
}

interface SessionHolder {
  current: Session | null;
  generationCounter: number;
  environmentBootstrapSuppressed: boolean;
  authorizedPaths: Map<string, number>;
}

// Next 的模块在开发期可能被重新加载；会话必须挂在进程级对象上。
const holder = ((): SessionHolder => {
  const globalRef = globalThis as typeof globalThis & { __sewSession?: SessionHolder };
  globalRef.__sewSession ??= {
    current: null,
    generationCounter: 0,
    environmentBootstrapSuppressed: false,
    authorizedPaths: new Map(),
  };
  // HMR may retain the process singleton while re-evaluating this module.
  globalRef.__sewSession.environmentBootstrapSuppressed ??= false;
  globalRef.__sewSession.authorizedPaths ??= new Map();
  return globalRef.__sewSession;
})();

/** 打开（或创建）磁盘上的项目目录。只接受主进程授权过的路径。 */
const openProject = (root: string): Session => {
  if (!root) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'empty_path' });
  }
  // 原生选择器已保证目录存在；开发/首次启动时允许创建。
  // 项目路径在构建期不可知，忽略静态追踪，避免把整个工程打进 standalone。
  mkdirSync(/* turbopackIgnore: true */ root, { recursive: true });
  if (!isDirectory(root)) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'not_a_directory' });
  }

  const canonicalRoot = realpathSync(/* turbopackIgnore: true */ resolve(root));
  const paths = ensureProjectLayout(canonicalRoot);
  let manifest = readManifest(canonicalRoot);
  if (!manifest) {
    manifest = {
      formatVersion: PROJECT_FORMAT_VERSION,
      projectId: newId<'project'>('proj'),
      displayName: canonicalRoot.split(/[\\/]/).filter(Boolean).pop() ?? '未命名项目',
      createdAt: new Date().toISOString(),
    } satisfies ProjectManifest;
    writeManifest(canonicalRoot, manifest);
  }
  assertManifestCompatible(manifest);

  // Prepare the replacement fully before closing the currently usable project.
  const store = StudyStore.open({ file: paths.databaseFile });
  try {
    if (!store.getProject(manifest.projectId)) {
      store.createProject({ projectId: manifest.projectId, displayName: manifest.displayName });
    }
  } catch (error) {
    store.close();
    throw error;
  }

  const previous = holder.current;
  if (previous) {
    try {
      previous.store.close();
    } catch (error) {
      store.close();
      throw error;
    }
  }

  holder.generationCounter += 1;
  const session: Session = {
    projectId: manifest.projectId,
    displayName: manifest.displayName,
    displayPath: canonicalRoot,
    generation: holder.generationCounter,
    store,
    openedAt: new Date().toISOString(),
  };
  holder.current = session;
  holder.authorizedPaths.clear();
  return session;
};

/** Explicit opens disable environment bootstrap from switching back to the configured default. */
export const openProjectFromDisk = (root: string): Session => {
  const session = openProject(root);
  holder.environmentBootstrapSuppressed = true;
  return session;
};

export const closeProject = (): void => {
  holder.environmentBootstrapSuppressed = true;
  holder.authorizedPaths.clear();
  if (!holder.current) return;
  try {
    holder.current.store.close();
  } finally {
    holder.current = null;
  }
};

export const getSession = (): Session | null => holder.current;

export const requireSession = (): Session => {
  // 服务启动时已按环境变量打开项目；这里兜底一次，避免先调接口时没有会话。
  if (!holder.current && !holder.environmentBootstrapSuppressed) bootstrapFromEnvironment();
  if (!holder.current) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'no_open_project' });
  }
  return holder.current;
};

/** 项目切换后，旧请求与旧模型响应携带的代次失效。 */
export const assertScope = (scope: ProjectScope): Session => {
  const session = requireSession();
  if (scope.projectId !== session.projectId) {
    throw new StudyError('PROJECT_GENERATION_STALE', {
      expected: session.projectId,
      received: scope.projectId,
    });
  }
  if (scope.generation !== session.generation) {
    throw new StudyError('PROJECT_GENERATION_STALE', {
      expected: session.generation,
      received: scope.generation,
    });
  }
  return session;
};

/** 代次复验紧邻项目设置写入，旧页面不能修改随后打开的项目。 */
export const updateProjectSettings = (
  scope: ProjectScope,
  patch: Partial<{
    displayName: string;
    subject: string;
    goal: string;
    examDate: string | null;
    dailyMinutes: number;
    learningMode: 'beginner' | 'review';
  }>,
): void => {
  const session = assertScope(scope);
  session.store.updateProjectSettings(session.projectId, patch);
};

/** 服务启动时按环境变量打开项目（`pnpm dev` 与随包启动都走这里）。 */
export const bootstrapFromEnvironment = (): Session | null => {
  if (holder.environmentBootstrapSuppressed) return holder.current;
  const root = process.env.SEW_PROJECT_ROOT;
  if (!root) return null;
  const canonicalRoot = canonicalPath(root);
  if (holder.current && canonicalRoot && holder.current.displayPath === canonicalRoot) return holder.current;
  return openProject(root);
};

const canonicalPath = (value: string): string | null => {
  try {
    return realpathSync(/* turbopackIgnore: true */ resolve(value));
  } catch {
    return null;
  }
};

const isWithin = (parent: string, candidate: string): boolean => {
  const rel = relative(parent, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * 主进程原生选择后发放的操作级路径授权。
 * 渲染层不能凭一个字符串自行获得读取权限，也不能提交课堂 iframe 传来的路径。
 */
export const authorizePaths = (paths: string[]): number => {
  const session = requireSession();
  for (const filePath of paths) {
    const canonical = canonicalPath(filePath);
    if (canonical) holder.authorizedPaths.set(canonical, session.generation);
  }
  return holder.authorizedPaths.size;
};

export const isAuthorizedPath = (filePath: string): boolean => {
  const session = holder.current;
  if (!session) return false;
  const canonical = canonicalPath(filePath);
  if (!canonical) return false;
  if (holder.authorizedPaths.get(canonical) === session.generation) return true;
  return isWithin(session.displayPath, canonical);
};

/**
 * 单次导入大小上限（`MAX_MATERIAL_BYTES`）：读取前先按字节数拦截，
 * 避免把巨型文件直接读入内存。file 与 text 两种导入模式共用同一上限。
 */
export const assertMaterialSize = (bytes: number): void => {
  if (bytes > MAX_MATERIAL_BYTES) {
    throw new StudyError('MATERIAL_TYPE_UNSUPPORTED', {
      reason: 'too_large',
      limit: MAX_MATERIAL_BYTES,
      actual: bytes,
    });
  }
};

/** 读取已授权文件内容。未授权路径一律拒绝，不做静默兜底。 */
export const readAuthorizedFile = (session: Session, filePath: string): string => {
  if (holder.current !== session || holder.current.generation !== session.generation) {
    throw new StudyError('PROJECT_GENERATION_STALE', {
      expected: holder.current?.generation ?? null,
      received: session.generation,
    });
  }
  const canonical = canonicalPath(filePath);
  if (!canonical || !isAuthorizedPath(canonical)) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'path_not_authorized' });
  }
  if (!existsSync(/* turbopackIgnore: true */ canonical)) {
    throw new StudyError('MATERIAL_NOT_FOUND', { path: filePath });
  }
  const stat = statSync(/* turbopackIgnore: true */ canonical);
  if (!stat.isFile()) {
    throw new StudyError('MATERIAL_NOT_FOUND', { path: filePath, reason: 'not_a_file' });
  }
  assertMaterialSize(stat.size);
  return readFileSync(/* turbopackIgnore: true */ canonical, 'utf8');
};
