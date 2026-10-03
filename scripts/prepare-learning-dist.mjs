#!/usr/bin/env node
/**
 * 组装随包 Node 启动的本地服务产物（PACK-01 分发资源准备）。
 *
 * 背景：pnpm monorepo 下 `next build` 的 standalone 输出嵌套在
 *   apps/learning/.next/standalone/apps/learning/
 * 而 Electron 主进程（apps/desktop/src/main.cjs）安装后固定从
 *   <resources>/learning/server.mjs 启动服务。
 *
 * 本脚本把 standalone 产物平整组装为最终布局：
 *   apps/learning/dist/service/
 *   ├── server.mjs            由本脚本从源码复制（真正的服务入口与安全边界）
 *   ├── next.config.ts        运行时配置
 *   ├── package.json          来自 standalone 应用目录
 *   ├── .next/                构建产物（static 由源码 .next/static 补齐）
 *   └── node_modules/         应用依赖及消费者各自的依赖树
 *
 * 依赖处理：standalone 内的依赖是 pnpm junction，且部分指回仓库根 store，
 * 无法在安装包里保留。脚本按包实例的 node_modules 依赖关系递归物化：
 * 应用直依赖保留在顶层；其它包优先提升到服务 node_modules 根目录。
 * 只有最近祖先查找不能解析到所需精确版本时，才在消费者自己的 node_modules
 * 下放置局部副本；多版本冲突因此不会退化成同名包先到先得。
 *
 * 实现说明：不使用 fs.cpSync——本机环境下 recursive cpSync 会以
 * 0xC0000409 崩溃，改用 readdir/copyFile/mkdir 手工递归，语义等同。
 *
 * 只做复制与布局校验，不做任何业务判断；幂等，可重复执行。
 * 用法：pnpm build:learning 之后运行 `node scripts/prepare-learning-dist.mjs`。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inventoryTree, SERVICE_MANIFEST, validateBuildInputs } from './freshness.mjs';
import {
  chooseRootPackageVersions,
  assertPackageSourceNotActive,
  needsLocalPackage,
  packageNodeModulesDir,
  readPackageIdentity,
} from './learning-dependency-layout.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const learningDir = join(root, 'apps', 'learning');
const nextDistDir = join(learningDir, process.env.SEW_DIST_DIR || '.next');
const standaloneDir = join(nextDistDir, 'standalone');
const standaloneAppDir = join(standaloneDir, 'apps', 'learning');
const serviceDir = join(learningDir, 'dist', 'service');
const MAX_SERVICE_RELATIVE_PATH = 140;
const MAX_WINDOWS_ABSOLUTE_PATH = 250;
const SERVICE_INSTALL_RELATIVE_PATH = '\\resources\\learning\\';

const fail = (message) => {
  console.error(`prepare-learning-dist: ${message}`);
  process.exit(1);
};

/**
 * 手工递归复制：junction 一律按其真实目标内容物化（statSync/readdir 自动跟随）。
 * 返回复制的文件数。
 */
const copyTreeReal = (source, target) => {
  let files = 0;
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      if (statSync(sourcePath).isDirectory()) files += copyTreeReal(sourcePath, targetPath);
      else {
        copyFileSync(sourcePath, targetPath);
        files += 1;
      }
    } else if (entry.isFile()) {
      copyFileSync(sourcePath, targetPath);
      files += 1;
    } else {
      fail(`无法复制的条目类型：${sourcePath}`);
    }
  }
  return files;
};

/** 统计目录下的文件数，用于布局校验与进度输出。 */
const countTree = (source) => {
  let files = 0;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const entryPath = join(source, entry.name);
    if (entry.isDirectory()) files += countTree(entryPath);
    else if (entry.isFile()) files += 1;
  }
  return files;
};

/** Enumerate package aliases while preserving complete scoped names. */
const listPackages = (nodeModulesDir, prefix = '') => {
  if (!existsSync(nodeModulesDir)) return [];
  const packages = [];
  for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.name === '.pnpm') continue;
    const entryPath = join(nodeModulesDir, entry.name);
    if (!existsSync(entryPath)) continue;
    if (entry.name.startsWith('@') && statSync(entryPath).isDirectory()) {
      packages.push(...listPackages(entryPath, `${prefix}${entry.name}/`));
    } else {
      packages.push({ name: `${prefix}${entry.name}`, path: entryPath });
    }
  }
  return packages;
};

/** Copy package payload only; dependency trees are rebuilt with deliberate hoisting. */
const copyPackageFiles = (source, target, onlyMissing = false) => {
  let files = 0;
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      if (statSync(sourcePath).isDirectory()) files += copyPackageFiles(sourcePath, targetPath, onlyMissing);
      else if (!onlyMissing || !existsSync(targetPath)) {
        copyFileSync(sourcePath, targetPath);
        files += 1;
      }
    } else if (entry.isFile() && (!onlyMissing || !existsSync(targetPath))) {
      copyFileSync(sourcePath, targetPath);
      files += 1;
    }
  }
  return files;
};

const serviceNodeModules = join(serviceDir, 'node_modules');
const pnpmStore = join(standaloneDir, 'node_modules', '.pnpm');
const workspacePnpmStore = join(root, 'node_modules', '.pnpm');
const expandedTargets = new Set();
const activeSourceInstances = new Set();
const packageSourceCandidates = new Map();
const preferredPackageSources = new Map();
let mergedFiles = 0;
let mergedPackages = 0;

const packageIdentity = (packagePath) => {
  return readPackageIdentity(packagePath)?.identity ?? null;
};

const registerPackageSources = (nodeModulesDir) => {
  for (const pkg of listPackages(nodeModulesDir)) {
    const identity = packageIdentity(pkg.path);
    if (!identity) continue;
    const candidates = packageSourceCandidates.get(identity) ?? [];
    candidates.push(pkg.path);
    packageSourceCandidates.set(identity, candidates);
  }
};

const registerStoreSources = (storeDir) => {
  if (!existsSync(storeDir)) return;
  for (const storeEntry of readdirSync(storeDir, { withFileTypes: true })) {
    const storeNodeModules = join(storeDir, storeEntry.name, 'node_modules');
    if (existsSync(storeNodeModules)) registerPackageSources(storeNodeModules);
  }
};

const preferredPackageSource = (sourcePath) => {
  const identity = packageIdentity(sourcePath);
  if (!identity) return sourcePath;
  if (preferredPackageSources.has(identity)) return preferredPackageSources.get(identity);
  let preferred = sourcePath;
  let preferredFileCount = countTree(sourcePath);
  for (const candidate of [...(packageSourceCandidates.get(identity) ?? [])].sort()) {
    const candidateFileCount = countTree(candidate);
    if (candidateFileCount > preferredFileCount) {
      preferred = candidate;
      preferredFileCount = candidateFileCount;
    }
  }
  preferredPackageSources.set(identity, preferred);
  return preferred;
};

const materializePackagePayload = (sourcePath, targetPath) => {
  const preferredSourcePath = preferredPackageSource(sourcePath);
  const sourceIdentity = packageIdentity(preferredSourcePath);
  const targetExists = existsSync(targetPath);
  if (targetExists) {
    const targetIdentity = packageIdentity(targetPath);
    if (sourceIdentity && targetIdentity !== sourceIdentity) {
      fail(`依赖目标版本冲突：${targetPath} 已有 ${targetIdentity ?? '无有效 package.json'}，请求物化 ${sourceIdentity}`);
    }
  }
  if (!targetExists) {
    mkdirSync(dirname(targetPath), { recursive: true });
    mergedFiles += copyPackageFiles(preferredSourcePath, targetPath);
    mergedPackages += 1;
  } else {
    mergedFiles += copyPackageFiles(preferredSourcePath, targetPath, true);
  }
};

/** Materialize package dependencies only when nearest-ancestor lookup is wrong. */
const expandPackageDependencies = (sourcePath, targetPath) => {
  const instancePath = realpathSync(sourcePath);
  if (expandedTargets.has(targetPath)) return;
  expandedTargets.add(targetPath);

  activeSourceInstances.add(instancePath);
  try {
    for (const dependency of listPackages(packageNodeModulesDir(instancePath))) {
      const dependencyPath = realpathSync(dependency.path);
      if (dependencyPath === instancePath) continue;
      const dependencyIdentity = packageIdentity(dependencyPath);
      if (!dependencyIdentity) fail(`依赖缺少有效 package.json：${dependencyPath}`);
      if (!needsLocalPackage(targetPath, dependency.name, dependencyIdentity, serviceDir)) continue;
      materializePackage(dependencyPath, join(targetPath, 'node_modules', dependency.name));
    }
  } finally {
    activeSourceInstances.delete(instancePath);
  }
};

/** Materialize one exact package identity and its necessary local dependencies. */
const materializePackage = (sourcePath, targetPath) => {
  const instancePath = realpathSync(sourcePath);
  try {
    assertPackageSourceNotActive(instancePath, activeSourceInstances);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  materializePackagePayload(sourcePath, targetPath);
  expandPackageDependencies(sourcePath, targetPath);
};

if (!existsSync(join(standaloneAppDir, 'server.js'))) {
  fail(`未找到 standalone 应用产物 ${standaloneAppDir}；请先运行 pnpm build:learning`);
}
if (!existsSync(join(standaloneDir, 'node_modules'))) {
  fail('standalone 缺少根 node_modules；standalone 输出不完整，请重新构建');
}
let buildProvenance;
try {
  buildProvenance = validateBuildInputs(root, nextDistDir);
} catch (error) {
  fail(`${error instanceof Error ? error.message : String(error)}；请运行 pnpm build:learning`);
}

console.log(`清理旧产物 ${serviceDir}`);
rmSync(serviceDir, { recursive: true, force: true });

// 1. standalone 应用目录整体上移到服务根（.next、package.json、应用依赖）。
const appFiles = copyTreeReal(standaloneAppDir, serviceDir);
console.log(`已复制 standalone 应用目录（${appFiles} 个文件，junction 已物化）`);

// 2. Index package sources and trace only runtime-reachable instances.
const appNodeModules = join(standaloneAppDir, 'node_modules');
const appPackages = listPackages(appNodeModules);
if (appPackages.length === 0) fail('standalone 应用缺少可物化的直依赖');
registerPackageSources(appNodeModules);
registerStoreSources(pnpmStore);
registerStoreSources(workspacePnpmStore);

const dependencyEdges = [];
const scannedInstances = new Set();
const pendingInstances = appPackages.map((pkg) => pkg.path);
while (pendingInstances.length > 0) {
  const sourcePath = realpathSync(pendingInstances.pop());
  if (scannedInstances.has(sourcePath)) continue;
  scannedInstances.add(sourcePath);
  for (const dependency of listPackages(packageNodeModulesDir(sourcePath))) {
    const dependencyPath = realpathSync(dependency.path);
    if (dependencyPath === sourcePath) continue;
    const identity = packageIdentity(dependencyPath);
    if (identity) dependencyEdges.push({ name: dependency.name, identity });
    pendingInstances.push(dependencyPath);
  }
}

const directVersions = appPackages.flatMap((pkg) => {
  const identity = packageIdentity(pkg.path);
  return identity ? [{ name: pkg.name, identity }] : [];
});
const rootVersions = chooseRootPackageVersions(directVersions, dependencyEdges);
const rootSources = new Map();
for (const pkg of appPackages) {
  const identity = packageIdentity(pkg.path);
  if (identity && rootVersions.get(pkg.name) !== identity) {
    fail(`应用直依赖版本预选不一致：${pkg.name} (${identity})`);
  }
  if (!rootSources.has(pkg.name)) rootSources.set(pkg.name, pkg.path);
}
for (const [name, identity] of rootVersions) {
  if (rootSources.has(name)) continue;
  const candidate = (packageSourceCandidates.get(identity) ?? [])
    .slice()
    .sort((a, b) => countTree(b) - countTree(a) || a.localeCompare(b))[0];
  if (!candidate) fail(`无法定位根目录版本 ${identity}`);
  rootSources.set(name, candidate);
}

// Start from a clean module tree: app standalone files may carry traced aliases,
// but their layout is replaced by the explicit version-aware graph below.
rmSync(serviceNodeModules, { recursive: true, force: true });
mkdirSync(serviceNodeModules, { recursive: true });
for (const [name, sourcePath] of rootSources) {
  materializePackagePayload(sourcePath, join(serviceNodeModules, name));
}
for (const [name, sourcePath] of rootSources) {
  expandPackageDependencies(sourcePath, join(serviceNodeModules, name));
}
console.log(`依赖物化：根目录 ${rootSources.size} 个包版本，局部冲突副本使总量 ${mergedPackages} 个包（${mergedFiles} 个文件）`);

// 3. 复制真正的服务入口与运行时配置；主进程握手与边界校验都在 server.mjs。
copyFileSync(join(learningDir, 'server.mjs'), join(serviceDir, 'server.mjs'));
copyFileSync(join(learningDir, 'next.config.ts'), join(serviceDir, 'next.config.ts'));

// 4. standalone 不会包含静态资源，必须从源码构建输出补齐。
const staticSource = join(nextDistDir, 'static');
if (!existsSync(staticSource)) fail('缺少 apps/learning/.next/static；请先运行 pnpm build:learning');
const staticFiles = copyTreeReal(staticSource, join(serviceDir, '.next', 'static'));
console.log(`已补齐 .next/static（${staticFiles} 个文件）`);

// 5. public 目录当前不存在；一旦加入静态公共资源，这里自动带上。
const publicSource = join(learningDir, 'public');
if (existsSync(publicSource)) {
  console.log(`已复制 public（${copyTreeReal(publicSource, join(serviceDir, 'public'))} 个文件）`);
} else {
  console.log('public 目录不存在，跳过');
}

// 字体字节嵌入服务端模块时，Next 文件追踪不会自动保留相邻许可文本。
// 显式携带演示资产的原始文件和许可，纳入下方完整产物清单。
const classroomAssetSource = join(learningDir, 'lib', 'classroom', 'assets');
if (existsSync(classroomAssetSource)) {
  if (!existsSync(join(classroomAssetSource, 'KaTeX-LICENSE.txt'))) fail('课堂字体缺少 KaTeX 许可文本');
  console.log(`已复制课堂资产与许可（${copyTreeReal(classroomAssetSource, join(serviceDir, 'classroom-assets'))} 个文件）`);
}

// Browser-bundled upstream source still requires its complete license and an
// inspectable record of which core files were copied versus independently adapted.
const classroomAdaptation = join(learningDir, 'components', 'openmaic-adaptation');
if (existsSync(classroomAdaptation)) {
  const noticesDir = join(serviceDir, 'third-party', 'openmaic');
  mkdirSync(noticesDir, { recursive: true });
  for (const filename of ['LICENSE', 'upstream-provenance.json']) {
    const source = join(classroomAdaptation, filename);
    if (!existsSync(source)) fail(`课堂源码适配缺少 ${filename}`);
    copyFileSync(source, join(noticesDir, filename));
  }
  console.log('已复制 OpenMAIC 课堂源码许可与采用清单');
}

// 布局校验：入口、构建标识、依赖解析与静态资源缺一不可。
const requireFromService = createRequire(join(serviceDir, 'server.mjs'));
const buildIdFile = join(serviceDir, '.next', 'BUILD_ID');
const problems = [];
if (!existsSync(join(serviceDir, 'server.mjs'))) problems.push('缺少 server.mjs');
if (!existsSync(buildIdFile)) problems.push('缺少 .next/BUILD_ID');
for (const moduleId of ['next', '@swc/helpers/_/_interop_require_default', 'react', 'sharp']) {
  try {
    const resolved = realpathSync(requireFromService.resolve(moduleId));
    const serviceReal = realpathSync(serviceDir);
    const relativeDependency = relative(serviceReal, resolved);
    if (relativeDependency === '..' || relativeDependency.startsWith(`..${sep}`) || isAbsolute(relativeDependency)) {
      problems.push(`依赖 ${moduleId} 解析到服务产物外部 ${resolved}`);
    }
  } catch {
    problems.push(`从服务目录无法解析依赖 ${moduleId}`);
  }
}
const bundledNode = join(root, 'resources', 'node', 'runtime', 'node.exe');
if (!existsSync(bundledNode)) problems.push('缺少 resources/node/runtime/node.exe，无法验证随包 Node 原生模块');
else {
  const sharpCheck = String.raw`const { createRequire } = require('node:module');
const req = createRequire(process.argv[1]);
const sharpPath = req.resolve('sharp');
const sharp = req('sharp');
const sharpRequire = createRequire(sharpPath);
const semverPath = sharpRequire.resolve('semver');
const semverPackage = require('node:path').join(require('node:path').dirname(semverPath), 'package.json');
const helper = req('@swc/helpers/_/_ts_add_disposable_resource');
const helperRequire = createRequire(req.resolve('@swc/helpers/package.json'));
const tslibPath = helperRequire.resolve('tslib');
const tslibPackage = require('node:path').join(require('node:path').dirname(tslibPath), 'package.json');
(async () => {
  const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('sharp did not produce a valid PNG');
  if (typeof helper._ !== 'function') throw new Error('@swc/helpers tslib entry did not load');
  process.stdout.write(JSON.stringify({ sharp: sharp.versions.sharp, semver: JSON.parse(require('node:fs').readFileSync(semverPackage, 'utf8')).version, helper: typeof helper._, tslib: JSON.parse(require('node:fs').readFileSync(tslibPackage, 'utf8')).version, pngBytes: png.length }));
})().catch((error) => { console.error(error?.stack ?? String(error)); process.exitCode = 1; });`;
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const result = spawnSync(bundledNode, ['-e', sharpCheck, join(serviceDir, 'server.mjs')], {
    encoding: 'utf8',
    cwd: serviceDir,
    env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: `${systemRoot}\\System32;${systemRoot}`, NODE_PATH: '', NODE_OPTIONS: '' },
  });
  if (result.error) problems.push(`随包 Node 启动失败：${result.error.message}`);
  else if (result.status !== 0) problems.push(`随包 Node sharp 原生编码检查失败：${(result.stderr || result.stdout).trim()}`);
  else console.log(`随包 Node sharp PNG 编码通过：${result.stdout.trim()}`);
}
const staticDir = join(serviceDir, '.next', 'static');
if (!existsSync(staticDir) || countTree(staticDir) === 0) problems.push('.next/static 为空');
if (problems.length > 0) fail(problems.join('；'));

const finalProvenance = validateBuildInputs(root, nextDistDir);
if (finalProvenance.buildId !== buildProvenance.buildId
  || finalProvenance.source.digest !== buildProvenance.source.digest) {
  fail('组装期间构建或输入发生变化；请在构建完成后重新组装');
}
const inventory = inventoryTree(serviceDir, new Set([SERVICE_MANIFEST]));
const longestRelativePath = inventory.reduce((max, [path]) => Math.max(max, path.length), 0);
if (longestRelativePath > MAX_SERVICE_RELATIVE_PATH) {
  fail(`服务清单最长相对路径 ${longestRelativePath} 超出 Windows 安装安全限值 ${MAX_SERVICE_RELATIVE_PATH}`);
}
const maxInstallDirLength = MAX_WINDOWS_ABSOLUTE_PATH
  - SERVICE_INSTALL_RELATIVE_PATH.length
  - longestRelativePath;
if (maxInstallDirLength < 1) {
  fail(`服务路径无法满足 Windows 绝对路径安全限值 ${MAX_WINDOWS_ABSOLUTE_PATH}`);
}
console.log(`服务清单路径校验通过：${inventory.length} 个文件，最长相对路径 ${longestRelativePath}/${MAX_SERVICE_RELATIVE_PATH}`);

const manifest = {
  schemaVersion: 1,
  buildId: buildProvenance.buildId,
  source: buildProvenance.source,
  maxRelativePathLength: longestRelativePath,
  files: inventory,
};
writeFileSync(join(serviceDir, SERVICE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const desktopBuildDir = join(root, 'apps', 'desktop', 'build');
mkdirSync(desktopBuildDir, { recursive: true });
const installPathLimitsInclude = join(desktopBuildDir, 'service-path-limits.nsh');
writeFileSync(
  installPathLimitsInclude,
  `!define SEW_MAX_INSTALL_DIR_LENGTH ${maxInstallDirLength}\n`,
  'utf8',
);
console.log(`NSIS 安装目录长度上限已写入：${installPathLimitsInclude}（${maxInstallDirLength} 字符）`);

console.log(`布局校验通过：BUILD_ID ${readFileSync(buildIdFile, 'utf8').trim()}`);
console.log(`服务产物就绪：${serviceDir}`);
