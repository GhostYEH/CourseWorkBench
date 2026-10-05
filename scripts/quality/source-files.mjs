import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const generatedDirectories = new Set([
  'node_modules',
  'dist',
  'dist-test',
  'release',
  'coverage',
  '.task-cache',
  '.sew-user-data',
]);
const generated = (name) =>
  generatedDirectories.has(name) || name.startsWith('.next') || name.startsWith('stale-');

/** Shared source enumeration for the dependency and public-boundary checks. */
export const collectSources = async (directory, extensions) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory())
        return generated(entry.name) ? [] : collectSources(filename, extensions);
      return entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))
        ? [filename]
        : [];
    }),
  );
  return files.flat();
};

export const parseSource = async (filename) =>
  ts.createSourceFile(filename, await readFile(filename, 'utf8'), ts.ScriptTarget.Latest, true);

export const moduleSpecifiers = (source) => {
  const targets = [];
  const visit = (node) => {
    let target;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) target = node.moduleSpecifier;
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      target = node.moduleReference.expression;
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      target = node.arguments[0];
    if (target && ts.isStringLiteralLike(target)) targets.push(target.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return targets;
};

/** Compare package aliases and relative imports against the same layer rules. */
export const dependencyTargets = (root, filename, target) => {
  const targets = [target, target.replace(/^node:/, '')];
  if (target.startsWith('.')) {
    const resolved =
      '/' +
      path
        .relative(root, path.resolve(path.dirname(filename), target))
        .split(path.sep)
        .join('/');
    targets.push(resolved);
    const packagePath = /^\/packages\/(study-[^/]+)(\/.*)?$/.exec(resolved);
    if (packagePath) targets.push('@sew/' + packagePath[1] + (packagePath[2] ?? ''));
  }
  return targets;
};

export const callsJsonParse = (source) => {
  let found = false;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'JSON' &&
      node.expression.name.text === 'parse'
    )
      found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};
