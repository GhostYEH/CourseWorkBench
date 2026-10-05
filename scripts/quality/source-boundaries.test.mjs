import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkSourceBoundaries } from './source-boundaries.mjs';
import { dependencyTargets } from './source-files.mjs';

test('layer checks reject relative package dependencies and SQLite in desktop CJS', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sew-layer-check-'));
  try {
    const samples = [
      [
        'packages/study-contracts/src/bad.ts',
        "export { Store } from '../../study-storage/src/store';",
      ],
      ['packages/study-domain/src/bad.ts', "import { readFile } from 'fs/promises';"],
      [
        'packages/study-storage/src/bad.ts',
        "import { app } from '../../../apps/learning/lib/server/service';",
      ],
      ['apps/desktop/src/bad.cjs', "const sqlite = require('node:sqlite');"],
      [
        'apps/desktop/src/relative.cjs',
        "const domain = require('../../../packages/study-domain/src/index');",
      ],
    ];
    for (const [relative, source] of samples) {
      const filename = path.join(root, relative);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, source);
      await assert.rejects(checkSourceBoundaries(root, [filename]), /违反了分层约束/);
    }
    const allowed = path.join(root, 'apps/desktop/src/good.cjs');
    await writeFile(
      allowed,
      "const fs = require('node:fs'); const boundary = require('./boundary.cjs');",
    );
    await checkSourceBoundaries(root, [allowed]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('client relative server and storage imports expose their canonical boundary', () => {
  const root = path.resolve('/source');
  const filename = path.join(root, 'apps/learning/lib/client.ts');
  assert.ok(
    dependencyTargets(root, filename, './server/service').includes(
      '/apps/learning/lib/server/service',
    ),
  );
  assert.ok(
    dependencyTargets(root, filename, '../../../packages/study-storage/src/index').includes(
      '@sew/study-storage/src/index',
    ),
  );
});
