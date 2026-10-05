#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_INPUTS_MANIFEST, learningSourceFingerprint, writeBuildInputs } from './freshness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const learningDir = join(root, 'apps', 'learning');
const learningRequire = createRequire(join(learningDir, 'package.json'));
const nextCli = learningRequire.resolve('next/dist/bin/next');
const distName = process.env.SEW_DIST_DIR || '.next';
const buildDir = resolve(learningDir, distName);
const before = learningSourceFingerprint(root);
// An interrupted/failed rebuild must not leave the previous successful provenance usable.
rmSync(join(buildDir, BUILD_INPUTS_MANIFEST), { force: true });
// standalone 会追踪应用目录下的文件；残留的 dist/service（上一次组装产物）会被整棵追踪进
// standalone，形成 dist/service/dist/service/… 的自引用嵌套并突破 Windows 路径上限。
// 该产物由 prepare:learning-dist 重新生成，构建前清掉即可。
rmSync(join(learningDir, 'dist'), { recursive: true, force: true });
const result = spawnSync(process.execPath, [nextCli, 'build'], {
  cwd: learningDir,
  env: process.env,
  stdio: 'inherit',
  shell: false,
});
if (result.error) {
  console.error(`build:learning: unable to start Next build: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

const after = learningSourceFingerprint(root);
if (before.digest !== after.digest || before.files !== after.files) {
  console.error('build:learning: source files changed while Next was building; output provenance was not recorded. Rerun after the edits settle.');
  process.exit(1);
}
try {
  const inputs = writeBuildInputs(root, buildDir, after);
  console.log(`Recorded Next build inputs for ${inputs.buildId} (${after.files} files, sha256 ${after.digest}).`);
} catch (error) {
  console.error(`build:learning: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
