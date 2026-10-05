import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A checked-in list keeps CI and local checks identical, including clean trees.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scope = JSON.parse(
  await readFile(new URL('./quality/format-scope.json', import.meta.url), 'utf8'),
);
if (!Array.isArray(scope) || scope.length === 0 || new Set(scope).size !== scope.length) {
  throw new Error('Formatting scope must be a nonempty list of unique source files.');
}
for (const filename of scope) {
  if (
    typeof filename !== 'string' ||
    path.isAbsolute(filename) ||
    filename.startsWith('-') ||
    /[?*{}[\]\\]/.test(filename) ||
    filename.split('/').includes('..') ||
    !(await stat(path.join(root, filename))).isFile()
  ) {
    throw new Error(`Formatting scope must contain explicit relative files: ${String(filename)}`);
  }
}
const option = process.argv[2];
if (option !== '--write' && option !== '--check') {
  console.error('Usage: node scripts/format.mjs --check|--write');
  process.exit(1);
}
const require = createRequire(import.meta.url);
const result = spawnSync(
  process.execPath,
  [require.resolve('prettier/bin/prettier.cjs'), option, ...scope],
  {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  },
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
