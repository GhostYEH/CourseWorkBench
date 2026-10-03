import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compareInventory, inventoryTree, learningSourceFingerprint, runtimePackageMetadata, validateBuildInputs, writeBuildInputs } from './freshness.mjs';

test('package provenance allows builder stripping development metadata but preserves the runtime entry', () => {
  const source = { name: 'example', version: '1.0.0', main: 'src/main.cjs',
    dependencies: { runtime: '1.0.0' }, scripts: { build: 'builder' }, devDependencies: { builder: '1.0.0' } };
  const expected = { name: 'example', version: '1.0.0', main: 'src/main.cjs', dependencies: { runtime: '1.0.0' } };
  assert.deepEqual(runtimePackageMetadata(source), expected);
  assert.notDeepEqual(runtimePackageMetadata(source), { ...expected, main: 'src/stale.cjs' });
  assert.notDeepEqual(runtimePackageMetadata(source), { ...expected, dependencies: { runtime: '0.9.0' } });
});

test('service inventory rejects stale, missing, and extra package content', () => {
  const root = mkdtempSync(join(tmpdir(), 'sew-freshness-inventory-'));
  try {
    writeFileSync(join(root, 'server.mjs'), 'export const current = true;');
    const expected = inventoryTree(root);
    assert.equal(compareInventory(root, expected).ok, true);
    writeFileSync(join(root, 'server.mjs'), 'export const current = false;');
    assert.deepEqual(compareInventory(root, expected).changed, ['server.mjs']);
    rmSync(join(root, 'server.mjs'));
    writeFileSync(join(root, 'unexpected.js'), 'extra');
    const result = compareInventory(root, expected);
    assert.deepEqual(result.missing, ['server.mjs']);
    assert.deepEqual(result.unexpected, ['unexpected.js']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('build provenance rejects a source edit after build even when BUILD_ID is unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'sew-freshness-build-'));
  const buildDir = join(root, 'apps', 'learning', '.next');
  try {
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"private":true}');
    writeFileSync(join(root, 'apps', 'learning', 'server.mjs'), 'export const version = 1;');
    writeFileSync(join(buildDir, 'BUILD_ID'), 'build-a\n');
    const source = learningSourceFingerprint(root);
    writeBuildInputs(root, buildDir, source);
    assert.equal(validateBuildInputs(root, buildDir).buildId, 'build-a');

    writeFileSync(join(root, 'apps', 'learning', 'server.mjs'), 'export const version = 2;');
    assert.throws(() => validateBuildInputs(root, buildDir), /源码已在 Next 构建后变更/);
    writeFileSync(join(root, 'apps', 'learning', 'server.mjs'), 'export const version = 1;');
    writeFileSync(join(buildDir, 'BUILD_ID'), 'build-b\n');
    assert.throws(() => validateBuildInputs(root, buildDir), /BUILD_ID 不匹配/);
    assert.equal(JSON.parse(readFileSync(join(buildDir, 'build-inputs.json'), 'utf8')).source.digest, source.digest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
