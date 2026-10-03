import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const readPackageIdentity = (packagePath) => {
  try {
    const manifest = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8'));
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return null;
    return { name: manifest.name, identity: `${manifest.name}@${manifest.version}` };
  } catch {
    return null;
  }
};

/** The node_modules directory whose aliases resolve a package instance. */
export const packageNodeModulesDir = (packagePath) => {
  let directory = dirname(packagePath);
  if (basename(directory).startsWith('@')) directory = dirname(directory);
  return directory;
};

/**
 * Select one version per package name for the service root. Application direct
 * dependencies keep their traced version; transitive packages choose the most
 * commonly required exact identity, with a stable lexical tie break.
 */
export const chooseRootPackageVersions = (directPackages, dependencyEdges) => {
  const selected = new Map();
  for (const pkg of directPackages) {
    const current = selected.get(pkg.name);
    if (current && current !== pkg.identity) {
      throw new Error(`multiple direct package versions for ${pkg.name}: ${current}, ${pkg.identity}`);
    }
    selected.set(pkg.name, pkg.identity);
  }

  const countsByName = new Map();
  for (const edge of dependencyEdges) {
    const counts = countsByName.get(edge.name) ?? new Map();
    counts.set(edge.identity, (counts.get(edge.identity) ?? 0) + 1);
    countsByName.set(edge.name, counts);
  }
  for (const [name, counts] of countsByName) {
    if (selected.has(name)) continue;
    const [identity] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
    if (identity) selected.set(name, identity);
  }
  return selected;
};

/**
 * Simulate Node's nearest-ancestor node_modules lookup inside the service tree.
 * A nearer, different version shadows the root copy and is returned as-is.
 */
export const resolveInstalledPackageIdentity = (fromPackagePath, packageName, serviceRoot) => {
  const root = resolve(serviceRoot);
  let directory = resolve(fromPackagePath);
  while (directory === root || isWithin(root, directory)) {
    const candidate = join(directory, 'node_modules', packageName);
    if (existsSync(candidate)) {
      return readPackageIdentity(candidate)?.identity ?? null;
    }
    if (directory === root) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
};

/** A local copy is required whenever the actual nearest lookup is not exact. */
export const needsLocalPackage = (fromPackagePath, packageName, requestedIdentity, serviceRoot) =>
  resolveInstalledPackageIdentity(fromPackagePath, packageName, serviceRoot) !== requestedIdentity;

/** Fail clearly instead of growing endless local copies through a shadowed cycle. */
export const assertPackageSourceNotActive = (sourcePath, activeSourceInstances) => {
  if (activeSourceInstances.has(sourcePath)) {
    throw new Error(`unsupported cyclic dependency layout: package source is already active (${sourcePath})`);
  }
};

const isWithin = (root, candidate) => {
  const path = relative(root, candidate);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

