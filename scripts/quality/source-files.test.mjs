import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { callsJsonParse, collectSources, moduleSpecifiers } from './source-files.mjs';

const parse = (text) => ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);

test('dependency checks inspect syntax instead of comments and quoted examples', () => {
  const source = parse(`
    // import fake from '@sew/study-storage'; JSON.parse('example');
    const example = "require('electron')";
    import type { T } from '@sew/study-contracts';
    export { value } from './value';
    import fs = require('node:fs');
    const db = require('node:sqlite');
    const lazy = import('next');
  `);
  assert.deepEqual(moduleSpecifiers(source), [
    '@sew/study-contracts',
    './value',
    'node:fs',
    'node:sqlite',
    'next',
  ]);
  assert.equal(callsJsonParse(source), false);
  assert.equal(callsJsonParse(parse('const data = JSON.parse(input);')), true);
});

test('source checks exclude generated trees but retain installation resources', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sew-source-enumeration-'));
  try {
    for (const name of ['src', 'build', '.next-test', 'stale-backup', 'release', '.task-cache']) {
      await mkdir(path.join(root, name));
      await writeFile(path.join(root, name, 'entry.ts'), 'export {};');
    }
    const files = await collectSources(root, ['.ts']);
    assert.deepEqual(
      files.map((filename) => path.relative(root, filename).split(path.sep).join('/')).sort(),
      ['build/entry.ts', 'src/entry.ts'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
