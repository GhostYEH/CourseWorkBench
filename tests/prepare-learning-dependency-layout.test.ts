import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPackageSourceNotActive,
  chooseRootPackageVersions,
  needsLocalPackage,
  resolveInstalledPackageIdentity,
} from '../scripts/learning-dependency-layout.mjs';

const tempRoots: string[] = [];
const createRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'sew-dependency-layout-'));
  tempRoots.push(root);
  return root;
};

const writePackage = (path: string, name: string, version: string): void => {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version }), 'utf8');
};

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe('learning dependency layout', () => {
  it('preselects traced direct versions and hoists the most-used transitive identity deterministically', () => {
    const selected = chooseRootPackageVersions(
      [{ name: 'direct', identity: 'direct@1.0.0' }],
      [
        { name: 'direct', identity: 'direct@2.0.0' },
        { name: 'shared', identity: 'shared@1.0.0' },
        { name: 'shared', identity: 'shared@2.0.0' },
        { name: 'shared', identity: 'shared@2.0.0' },
        { name: 'shared', identity: 'shared@2.0.0' },
        { name: 'tied', identity: 'tied@2.0.0' },
        { name: 'tied', identity: 'tied@1.0.0' },
      ],
    );

    expect(selected.get('direct')).toBe('direct@1.0.0');
    expect(selected.get('shared')).toBe('shared@2.0.0');
    expect(selected.get('tied')).toBe('tied@1.0.0');
  });

  it('keeps multiple exact versions and overrides a mismatching nearer ancestor', () => {
    const root = createRoot();
    const service = join(root, 'service');
    const rootShared = join(service, 'node_modules', 'shared');
    const consumerA = join(service, 'node_modules', 'consumer-a');
    const consumerB = join(service, 'node_modules', 'consumer-b');
    const ancestor = join(service, 'node_modules', 'ancestor');
    const child = join(ancestor, 'node_modules', 'child');
    const ancestorShared = join(ancestor, 'node_modules', 'shared');
    const localA = join(consumerA, 'node_modules', 'shared');
    const localChild = join(child, 'node_modules', 'shared');

    writePackage(rootShared, 'shared', '2.0.0');
    writePackage(consumerA, 'consumer-a', '1.0.0');
    writePackage(consumerB, 'consumer-b', '1.0.0');
    writePackage(ancestor, 'ancestor', '1.0.0');
    writePackage(child, 'child', '1.0.0');
    writePackage(ancestorShared, 'shared', '1.0.0');
    writePackage(localA, 'shared', '1.0.0');

    expect(needsLocalPackage(consumerA, 'shared', 'shared@1.0.0', service)).toBe(false);
    expect(resolveInstalledPackageIdentity(consumerB, 'shared', service)).toBe('shared@2.0.0');
    expect(needsLocalPackage(consumerB, 'shared', 'shared@2.0.0', service)).toBe(false);

    // The root has the wanted version, but Node resolves the nearer ancestor first.
    expect(resolveInstalledPackageIdentity(child, 'shared', service)).toBe('shared@1.0.0');
    expect(needsLocalPackage(child, 'shared', 'shared@2.0.0', service)).toBe(true);
    writePackage(localChild, 'shared', '2.0.0');
    expect(resolveInstalledPackageIdentity(child, 'shared', service)).toBe('shared@2.0.0');
    expect(needsLocalPackage(child, 'shared', 'shared@2.0.0', service)).toBe(false);
  });

  it('rejects a four-instance version cycle when ancestor shadowing requires infinite local copies', () => {
    const active = new Set([
      'store/a@1',
      'store/b@2',
      'store/a@2',
      'store/b@1',
    ]);

    expect(() => assertPackageSourceNotActive('store/a@1', active))
      .toThrow('unsupported cyclic dependency layout');
    expect(() => assertPackageSourceNotActive('store/c@1', active)).not.toThrow();
  });
});
