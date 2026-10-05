import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = path.join(root, 'apps/desktop/tsconfig.ipc.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
assert.equal(config.error, undefined);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
assert.equal(parsed.errors.length, 0);
const handlerPath = path.join(root, 'apps/desktop/src/native-handlers.cjs');
const contractPath = path.join(root, 'packages/study-contracts/src/ipc.ts');
const actualHandler = readFileSync(handlerPath, 'utf8');
const actualContract = readFileSync(contractPath, 'utf8');

// Compile mutations of the actual production files in memory. No synthetic
// handler interface or on-disk fixture can hide an unchecked implementation.
const compile = (replacements = new Map()) => {
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (filename, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = replacements.get(path.resolve(filename));
    return text === undefined
      ? getSourceFile(filename, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(filename, text, languageVersion, true);
  };
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  return ts.getPreEmitDiagnostics(program);
};
const replace = (source, before, after) => {
  assert.ok(source.includes(before), `Production source changed: ${before}`);
  return source.replace(before, after);
};

test('the real native handler implementation satisfies its IPC contract', () => {
  const diagnostics = compile();
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (filename) => filename,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }),
  );
});

test('real handler parameter, result, and void-result drift fail compilation', () => {
  const mutations = [
    replace(actualHandler, '@param {unknown} [defaultName]', '@param {number} [defaultName]'),
    replace(actualHandler, 'ok: result.ok', "ok: 'invalid'"),
    replace(
      actualHandler,
      'await projects.close();',
      'await projects.close(); return { unexpected: true };',
    ),
    replace(actualHandler, 'materialId: value.materialId', 'materialId: 123'),
  ];
  for (const mutation of mutations) {
    const diagnostics = compile(new Map([[handlerPath, mutation]]));
    assert.ok(
      diagnostics.some((diagnostic) => diagnostic.code === 2322),
      'Expected a contract assignment failure',
    );
  }
});

test('changing a contract no-argument method to require an argument rejects the actual handler', () => {
  const mutation = replace(
    actualContract,
    'projectRecent: { args: [];',
    'projectRecent: { args: [required: string];',
  );
  const diagnostics = compile(new Map([[contractPath, mutation]]));
  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.code === 2345),
    'Expected NoArgumentMethod binding to fail',
  );
});
