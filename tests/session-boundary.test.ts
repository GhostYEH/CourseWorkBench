import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { StudyError } from '@sew/study-contracts';
import {
  authorizePaths,
  bootstrapFromEnvironment,
  closeProject,
  getSession,
  openProjectFromDisk,
  readAuthorizedFile,
  requireSession,
} from '../apps/learning/lib/server/service';

const tempRoots: string[] = [];
const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'sew-session-boundary-'));
  tempRoots.push(directory);
  return directory;
};

const expectStudyError = (operation: () => unknown, code: string): void => {
  try {
    operation();
    throw new Error(`Expected StudyError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(StudyError);
    expect((error as StudyError).code).toBe(code);
  }
};

describe('session and disk authorization boundaries', () => {
  const originalProjectRoot = process.env.SEW_PROJECT_ROOT;

  beforeAll(() => {
    // The single-thread pool retains this intentional process singleton across
    // files. Start this bootstrap test from a fresh-process state, rather than
    // inheriting another suite's explicit-close suppression flag.
    closeProject();
    const holder = (globalThis as { __sewSession?: { environmentBootstrapSuppressed: boolean } }).__sewSession;
    if (holder) holder.environmentBootstrapSuppressed = false;
    process.env.SEW_PROJECT_ROOT = temporaryDirectory();
  });

  afterEach(() => closeProject());

  afterAll(() => {
    if (originalProjectRoot === undefined) delete process.env.SEW_PROJECT_ROOT;
    else process.env.SEW_PROJECT_ROOT = originalProjectRoot;
    for (const directory of tempRoots) rmSync(directory, { recursive: true, force: true });
  });

  it('bootstraps the configured project once and does not reopen after explicit close', () => {
    const first = bootstrapFromEnvironment();
    expect(first?.displayPath).toBe(resolve(process.env.SEW_PROJECT_ROOT!));
    closeProject();

    expect(bootstrapFromEnvironment()).toBeNull();
    expectStudyError(() => requireSession(), 'PROJECT_NOT_AUTHORIZED');
    expect(getSession()).toBeNull();
  });

  it('rejects traversal and junction escapes from the open project', () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    const source = join(root, 'materials', 'lesson.md');
    const secret = join(outside, 'secret.md');
    mkdirSync(join(root, 'materials'));
    writeFileSync(source, 'lesson text', 'utf8');
    writeFileSync(secret, 'secret text', 'utf8');
    const junction = join(root, 'external');
    symlinkSync(outside, junction, 'junction');

    const session = openProjectFromDisk(root);
    expect(readAuthorizedFile(session, source)).toBe('lesson text');
    expectStudyError(() => readAuthorizedFile(session, join(root, '..', basename(outside), 'secret.md')), 'PROJECT_NOT_AUTHORIZED');
    expectStudyError(() => readAuthorizedFile(session, join(junction, 'secret.md')), 'PROJECT_NOT_AUTHORIZED');
    expectStudyError(() => readAuthorizedFile(session, root), 'MATERIAL_NOT_FOUND');
  });

  it('scopes native file authorization to the current project generation', () => {
    const rootA = temporaryDirectory();
    const rootB = temporaryDirectory();
    const nativeFile = join(temporaryDirectory(), 'picked.md');
    writeFileSync(nativeFile, 'picked text', 'utf8');
    const sessionA = openProjectFromDisk(rootA);
    authorizePaths([nativeFile]);
    expect(readAuthorizedFile(sessionA, nativeFile)).toBe('picked text');

    const sessionB = openProjectFromDisk(rootB);
    expect(sessionB.generation).toBeGreaterThan(sessionA.generation);
    expectStudyError(() => readAuthorizedFile(sessionB, nativeFile), 'PROJECT_NOT_AUTHORIZED');
    expectStudyError(() => readAuthorizedFile(sessionA, nativeFile), 'PROJECT_GENERATION_STALE');
  });

  it('preserves the active project when opening a malformed replacement fails', () => {
    const activeRoot = temporaryDirectory();
    const invalidRoot = temporaryDirectory();
    writeFileSync(join(invalidRoot, 'project.json'), JSON.stringify({ formatVersion: 999 }), 'utf8');
    const active = openProjectFromDisk(activeRoot);

    expect(() => openProjectFromDisk(invalidRoot)).toThrow();
    expect(getSession()).toBe(active);
    expect(requireSession()).toBe(active);
  });

  it('rejects stale session handles after the project has been closed', () => {
    const session = openProjectFromDisk(temporaryDirectory());
    closeProject();
    expectStudyError(() => readAuthorizedFile(session, join(session.displayPath, 'missing.md')), 'PROJECT_GENERATION_STALE');
  });
});
