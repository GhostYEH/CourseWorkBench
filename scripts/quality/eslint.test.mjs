import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ESLint } from 'eslint';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const eslint = new ESLint({ cwd: root });
const filePath = path.join(root, 'apps/desktop/src/lint-fixture.cjs');

test('desktop CJS lint accepts Node globals and rejects undefined, unreachable, and unused code', async () => {
  const [valid] = await eslint.lintText(
    "const fs = require('node:fs'); module.exports = () => { const timeout = setTimeout(() => console.log(process.pid), 1); clearTimeout(timeout); return fs.existsSync(__filename); };",
    { filePath },
  );
  assert.equal(valid.errorCount, 0);
  const [invalid] = await eslint.lintText(
    'module.exports = () => { return missingNodeGlobal; const unused = 1; };',
    { filePath },
  );
  const rules = new Set(invalid.messages.map((message) => message.ruleId));
  for (const rule of ['no-undef', 'no-unreachable', 'no-unused-vars'])
    assert.ok(rules.has(rule), rule);
});

test('generated preload is excluded while the authoritative preload template is linted', async () => {
  assert.equal(await eslint.isPathIgnored(path.join(root, 'apps/desktop/src/preload.cjs')), true);
  const [template] = await eslint.lintText('module.exports = __IPC_CHANNELS__; ', {
    filePath: path.join(root, 'apps/desktop/src/preload.template.cjs'),
  });
  assert.equal(template.errorCount, 0);
});
