/**
 * 服务会话（《Electron 开发设计》第 4/5 节）。
 *
 * - 项目目录由主进程通过受控通道授权；渲染层只持项目 ID 与打开代次。
 * - 打开代次每次打开都重新分配，同路径重开也算新代次。
 * - 本地服务是唯一数据库写入者，写操作串行执行。
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  GENERATED_ID_PATTERN,
  MAX_MATERIAL_BYTES,
  StudyError,
  newId,
  type ProjectScope,
} from '@sew/study-contracts';
import {
  PROJECT_FORMAT_VERSION,
  StudyStore,
  assertManifestCompatible,
  ensureProjectLayout,
  isDirectory,
  projectPaths,
  readManifest,
  writeManifest,
  type ProjectManifest,
} from '@sew/study-storage';
import { getLearnerProfile } from './learner-profile';

export interface Session {
  projectId: string;
  displayName: string;
  displayPath: string;
  generation: number;
  formatVersion: number;
  store: StudyStore;
  openedAt: string;
  learnerUid: string;
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
  const paths = ensureProjectLayout(canonicalRoot);

  // Prepare the replacement fully before closing the currently usable project.
  const store = StudyStore.open({ file: paths.databaseFile });
  let learnerUid: string;
  try {
    if (!store.getProject(manifest.projectId)) {
      store.createProject({ projectId: manifest.projectId, displayName: manifest.displayName });
    }
    // A trusted native/environment open authorizes the local legacy association.
    // Its provenance stays legacy_local; it does not establish an online identity.
    learnerUid = getLearnerProfile().uid;
    store.bindLocalLearner(manifest.projectId, learnerUid);
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
    formatVersion: manifest.formatVersion,
    store,
    openedAt: new Date().toISOString(),
    learnerUid,
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

export const getSession = (): Session | null => {
  const session = holder.current;
  if (session && session.learnerUid !== getLearnerProfile().uid)
    throw new StudyError(
      'PROJECT_NOT_AUTHORIZED',
      { reason: 'active_project_learner_uid_mismatch' },
      '当前个人档案与项目身份不一致，请关闭项目后重新打开。',
    );
  return session;
};

export const requireSession = (): Session => {
  // 服务启动时已按环境变量打开项目；这里兜底一次，避免先调接口时没有会话。
  if (!holder.current && !holder.environmentBootstrapSuppressed) bootstrapFromEnvironment();
  if (!holder.current) {
    throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'no_open_project' });
  }
  return getSession()!;
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
  if (holder.environmentBootstrapSuppressed) return getSession();
  const root = process.env.SEW_PROJECT_ROOT;
  if (!root) return null;
  const canonicalRoot = canonicalPath(root);
  if (holder.current && canonicalRoot && holder.current.displayPath === canonicalRoot)
    return getSession();
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

/**
 * 读取已授权文件的内容与原样字节。未授权路径一律拒绝，不做静默兜底。
 *
 * 原样字节（含 BOM 与原换行风格）随文本一起返回，导入时才能归档并核对来源身份。
 */
export const readAuthorizedFile = (
  session: Session,
  filePath: string,
): { text: string; bytes: Uint8Array; originalName: string } => {
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
  const read = readFileSync(/* turbopackIgnore: true */ canonical);
  // Recheck the actual bytes: a selected file may have grown after stat.
  assertMaterialSize(read.byteLength);
  try {
    // Buffer.toString('utf8') silently replaces invalid bytes with U+FFFD.
    // A fatal decoder preserves the evidence boundary by rejecting corruption.
    // ignoreBOM keeps the leading BOM in the text so it matches the archived bytes
    // character for character; normalization removes it before fingerprinting.
    return {
      text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read),
      bytes: new Uint8Array(read),
      originalName: basename(canonical),
    };
  } catch {
    throw new StudyError(
      'MATERIAL_TYPE_UNSUPPORTED',
      { reason: 'invalid_utf8' },
      '材料不是有效的 UTF-8 文本，请转换编码后重新导入',
    );
  }
};

/**
 * Read an explicitly selected supported document as bounded opaque bytes.
 * Unlike `readAuthorizedFile`, this does not decode or interpret user content.
 */
export const readAuthorizedDocumentBytes = (
  session: Session,
  filePath: string,
): { bytes: Uint8Array; originalName: string; extension: string } => {
  if (holder.current !== session || holder.current.generation !== session.generation) {
    throw new StudyError('PROJECT_GENERATION_STALE', {
      expected: holder.current?.generation ?? null,
      received: session.generation,
    });
  }
  const canonical = canonicalPath(filePath);
  const extension = extname(canonical ?? '')
    .slice(1)
    .toLowerCase();
  if (
    !canonical ||
    !['pdf', 'docx', 'pptx', 'xlsx'].includes(extension) ||
    !isAuthorizedPath(canonical)
  )
    throw new StudyError('PROJECT_NOT_AUTHORIZED', {
      reason: 'document_path_not_authorized_or_unsupported',
    });

  let descriptor: number | null = null;
  try {
    const before = lstatSync(/* turbopackIgnore: true */ canonical);
    if (!before.isFile() || before.isSymbolicLink())
      throw new StudyError('MATERIAL_NOT_FOUND', { reason: 'not_a_regular_file' });
    assertMaterialSize(before.size);
    descriptor = openSync(
      /* turbopackIgnore: true */ canonical,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor);
    const resolvedAfterOpen = canonicalPath(filePath);
    if (
      !opened.isFile() ||
      opened.size !== before.size ||
      !resolvedAfterOpen ||
      resolvedAfterOpen !== canonical
    )
      throw new StudyError('MATERIAL_NOT_FOUND', { reason: 'document_changed_during_open' });
    const bytes = readFileSync(descriptor);
    const afterRead = fstatSync(descriptor);
    if (bytes.byteLength !== opened.size || afterRead.size !== opened.size)
      throw new StudyError('MATERIAL_NOT_FOUND', { reason: 'document_changed_during_read' });
    assertMaterialSize(bytes.byteLength);
    return { bytes: new Uint8Array(bytes), originalName: basename(canonical), extension };
  } catch (error) {
    if (error instanceof StudyError) throw error;
    throw new StudyError('MATERIAL_NOT_FOUND', { reason: 'document_read_failed' });
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
};

/** 原文副本的落盘目录：项目内的 `exports/originals`，随项目一起备份与迁移。 */
const originalCopyDir = (session: Session): string =>
  join(projectPaths(session.displayPath).exportsDir, 'originals');

/**
 * 把归档的原始字节写成项目内的只读副本，返回路径给主进程校验归属后打开。
 *
 * 文件名由材料标识、版本与内容摘要拼成，不含任何调用方提交的字符串；
 * 同内容重复物化是幂等的，内容不同则摘要不同、不会互相覆盖。
 */
export const materializeOriginalCopy = (
  session: Session,
  materialId: string,
  revision: number,
): { path: string; displayName: string | null } => {
  if (!GENERATED_ID_PATTERN.test(materialId)) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'malformed_material_id' });
  }
  const { archive, bytes } = session.store.readMaterialRaw(materialId, revision);
  const extension = archive.mediaType === 'text/markdown' ? 'md' : 'txt';
  const dir = originalCopyDir(session);
  mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
  const target = join(
    dir,
    `原文-${materialId}-r${revision}-${archive.sha256.slice(0, 12)}.${extension}`,
  );
  try {
    writeFileSync(/* turbopackIgnore: true */ target, bytes, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return { path: target, displayName: archive.originalName };
};
