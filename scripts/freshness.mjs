import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export const SERVICE_MANIFEST = 'bundle-manifest.json';
export const BUILD_INPUTS_MANIFEST = 'build-inputs.json';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const sha256File = (file) => hash(readFileSync(file));

/** electron-builder intentionally strips development-only package metadata. */
export const runtimePackageMetadata = (source) => {
  const runtime = { ...source };
  delete runtime.scripts;
  delete runtime.devDependencies;
  return runtime;
};

const sourceDirectories = ['apps/learning', 'packages/study-contracts', 'packages/study-domain', 'packages/study-storage'];
const ignoredDirectories = new Set(['.next', '.next-build', '.sew-user-data', 'dist', 'node_modules', 'coverage', 'release']);
const generatedInputFiles = new Set(['next-env.d.ts', 'tsconfig.tsbuildinfo']);

const collectFiles = (root, directory, output, excludedOutputDir) => {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    const relativePath = relative(root, absolute).split(sep).join('/');
    if (entry.isDirectory() && excludedOutputDir &&
      (relativePath === excludedOutputDir || relativePath.startsWith(`${excludedOutputDir}/`))) continue;
    if (entry.isDirectory()) collectFiles(root, absolute, output, excludedOutputDir);
    else if (entry.isFile() && !generatedInputFiles.has(entry.name)) output.push(relativePath);
  }
};

/** Fingerprint all tracked learning inputs while excluding generated outputs and dependencies. */
export const learningSourceFingerprint = (root, distName = process.env.SEW_DIST_DIR || '.next') => {
  const files = [];
  const resolvedDist = resolve(root, 'apps', 'learning', distName);
  const learningDir = resolve(root, 'apps', 'learning');
  const distRelative = relative(learningDir, resolvedDist);
  const excludedOutputDir = distRelative === '..' || distRelative.startsWith(`..${sep}`) ? null
    : `apps/learning/${distRelative.split(sep).join('/')}`;
  for (const item of sourceDirectories) {
    const absolute = join(root, item);
    if (existsSync(absolute)) collectFiles(root, absolute, files, excludedOutputDir);
  }
  for (const item of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    if (existsSync(join(root, item))) files.push(item);
  }
  const entries = [...new Set(files)].sort().map((path) => [path, sha256File(join(root, path))]);
  return { algorithm: 'sha256', files: entries.length, digest: hash(Buffer.from(JSON.stringify(entries))) };
};

export const readBuildInputs = (buildDir) => {
  const file = join(buildDir, BUILD_INPUTS_MANIFEST);
  if (!existsSync(file)) throw new Error(`缺少 ${file}；请运行 pnpm build:learning（不可直接用 next build 后组装）`);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`build-inputs 清单不是有效 JSON：${file}`);
  }
};

export const inventoryTree = (root, excluded = new Set()) => {
  const entries = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name);
      const path = relative(root, file).split(sep).join('/');
      if (excluded.has(path)) continue;
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) entries.push([path, sha256File(file)]);
      else throw new Error(`产物含不支持的文件类型：${file}`);
    }
  };
  visit(root);
  return entries;
};

export const compareInventory = (root, expected) => {
  const actual = inventoryTree(root, new Set([SERVICE_MANIFEST]));
  const expectedMap = new Map(expected);
  const actualMap = new Map(actual);
  const missing = [...expectedMap.keys()].filter((path) => !actualMap.has(path));
  const changed = [...expectedMap.keys()].filter((path) => actualMap.has(path) && expectedMap.get(path) !== actualMap.get(path));
  const unexpected = [...actualMap.keys()].filter((path) => !expectedMap.has(path));
  return { ok: missing.length === 0 && changed.length === 0 && unexpected.length === 0, missing, changed, unexpected };
};

export const validateBuildInputs = (root, buildDir, inputs = readBuildInputs(buildDir)) => {
  const buildIdFile = join(buildDir, 'BUILD_ID');
  if (!existsSync(buildIdFile)) throw new Error(`缺少 Next BUILD_ID：${buildIdFile}`);
  const buildId = readFileSync(buildIdFile, 'utf8').trim();
  const current = learningSourceFingerprint(root);
  const problems = [];
  if (!inputs || typeof inputs !== 'object' || inputs.schemaVersion !== 1) problems.push('build-inputs schemaVersion 不支持');
  if (typeof inputs?.buildId !== 'string' || !inputs.buildId) problems.push('build-inputs 缺少有效 buildId');
  if (!inputs?.source || !Number.isInteger(inputs.source.files) || typeof inputs.source.digest !== 'string') {
    problems.push('build-inputs 缺少有效源码指纹');
  }
  if (inputs.buildId !== buildId) problems.push('build-inputs 与 BUILD_ID 不匹配');
  if (inputs.source?.digest !== current.digest || inputs.source?.files !== current.files) problems.push('学习源码已在 Next 构建后变更');
  if (problems.length) throw new Error(problems.join('；'));
  return { buildId, source: current };
};

export const writeBuildInputs = (root, buildDir, source) => {
  const buildId = readFileSync(join(buildDir, 'BUILD_ID'), 'utf8').trim();
  const record = { schemaVersion: 1, buildId, source, createdAt: new Date().toISOString() };
  writeFileSync(join(buildDir, BUILD_INPUTS_MANIFEST), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
};

export const verifyServiceManifest = (root, serviceDir) => {
  const manifestPath = join(serviceDir, SERVICE_MANIFEST);
  if (!existsSync(manifestPath)) throw new Error(`缺少服务产物清单 ${manifestPath}；请重新运行 prepare-learning-dist`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error(`服务 bundle manifest 不是有效 JSON：${manifestPath}`);
  }
  const buildDir = resolve(root, 'apps', 'learning', process.env.SEW_DIST_DIR || '.next');
  const build = validateBuildInputs(root, buildDir);
  if (manifest.schemaVersion !== 1) throw new Error('服务 bundle manifest 版本不支持');
  if (!Array.isArray(manifest.files) || !manifest.files.every((entry) => Array.isArray(entry) &&
    entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'string')) {
    throw new Error('服务 bundle manifest 缺少有效 SHA-256 文件清单');
  }
  if (manifest.buildId !== build.buildId || manifest.source?.digest !== build.source.digest) {
    throw new Error('服务产物与当前 Next 构建输入不匹配；请重新运行 prepare-learning-dist');
  }
  const comparison = compareInventory(serviceDir, manifest.files);
  if (!comparison.ok) {
    const detail = [
      comparison.missing.length && `missing: ${comparison.missing.slice(0, 3).join(', ')}`,
      comparison.changed.length && `changed: ${comparison.changed.slice(0, 3).join(', ')}`,
      comparison.unexpected.length && `unexpected: ${comparison.unexpected.slice(0, 3).join(', ')}`,
    ].filter(Boolean).join('; ');
    throw new Error(`服务产物内容与 bundle manifest 不一致（${detail}）`);
  }
  return manifest;
};
