import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['node_modules', '.next', 'dist', 'release']);
const collect = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return ignored.has(entry.name) ? [] : collect(filename);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [filename] : [];
  }));
  return files.flat();
};

for (const filename of await collect(path.join(root, 'apps/learning'))) {
  const source = ts.createSourceFile(filename, await readFile(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  const isClient = source.statements.some((statement) =>
    ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)
    && statement.expression.text === 'use client');
  if (!isClient) continue;
  const visit = (node) => {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) specifier = node.arguments[0];
    if (specifier && ts.isStringLiteral(specifier)) {
      const target = specifier.text;
      assert.ok(!/^@sew\/study-(storage|domain)(\/|$)/.test(target)
        && !/(^|\/)lib\/server(\/|$)/.test(target)
        && !/(^|\/)packages\/study-(storage|domain)(\/|$)/.test(target),
      `${path.relative(root, filename)}: client must consume DTO contracts, not ${target}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

for (const name of ['study-contracts', 'study-domain', 'study-storage']) {
  const filename = path.join(root, 'packages', name, 'src/index.ts');
  const source = ts.createSourceFile(filename, await readFile(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    assert.ok(!ts.isExportDeclaration(statement) || statement.exportClause,
      `${name}: public exports must be explicit to avoid exposing implementation details`);
  }
}
console.log('Public boundary checks passed (client DTOs and explicit package exports).');
