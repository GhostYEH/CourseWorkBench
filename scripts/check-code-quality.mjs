import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkPreload } from './quality/preload-check.mjs';
import { checkSourceBoundaries } from './quality/source-boundaries.mjs';
import { collectSources } from './quality/source-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run(process.execPath, ['scripts/generate-preload.mjs', '--check']);

const [desktop, scripts, packages, learning, collabService] = await Promise.all([
  collectSources(path.join(root, 'apps/desktop/src'), ['.cjs', '.mjs']),
  collectSources(path.join(root, 'scripts'), ['.cjs', '.mjs']),
  collectSources(path.join(root, 'packages'), ['.ts']),
  collectSources(path.join(root, 'apps/learning'), ['.ts', '.tsx']),
  collectSources(path.join(root, 'apps/collab-service'), ['.ts']),
]);
for (const file of [
  ...desktop,
  ...scripts,
  path.join(root, 'apps/learning/server.mjs'),
  path.join(root, 'apps/collab-service/server.mjs'),
  path.join(root, 'apps/collab-service/provision.mjs'),
]) {
  run(process.execPath, ['--check', file]);
}
const methods = await checkPreload(root);
await checkSourceBoundaries(root, [...packages, ...learning, ...collabService, ...desktop]);
console.log('Code quality checks passed (' + methods + ' whitelisted preload methods).');
