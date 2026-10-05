import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  collectSources,
  dependencyTargets,
  moduleSpecifiers,
  parseSource,
} from './quality/source-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const filename of await collectSources(path.join(root, 'apps/learning'), ['.ts', '.tsx'])) {
  const source = await parseSource(filename);
  const isClient = source.statements.some(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression) &&
      statement.expression.text === 'use client',
  );
  if (!isClient) continue;
  for (const target of moduleSpecifiers(source)) {
    assert.ok(
      dependencyTargets(root, filename, target).every(
        (candidate) =>
          !/^@sew\/study-(storage|domain)(\/|$)/.test(candidate) &&
          !/(^|\/)lib\/server(\/|$)/.test(candidate) &&
          !/(^|\/)packages\/study-(storage|domain)(\/|$)/.test(candidate),
      ),
      `${path.relative(root, filename)}: client must consume DTO contracts, not ${target}`,
    );
  }
}

for (const name of ['study-contracts', 'study-domain', 'study-storage']) {
  const filename = path.join(root, 'packages', name, 'src/index.ts');
  const source = ts.createSourceFile(
    filename,
    await readFile(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of source.statements) {
    assert.ok(
      !ts.isExportDeclaration(statement) || statement.exportClause,
      `${name}: public exports must be explicit to avoid exposing implementation details`,
    );
  }
}
console.log('Public boundary checks passed (client DTOs and explicit package exports).');
