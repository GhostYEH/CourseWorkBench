import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll } from 'vitest';

// Every file gets a disposable profile. Tests must never create or rename a real learner identity.
const original = process.env.SEW_USER_DATA_DIR;
const directory = mkdtempSync(join(tmpdir(), 'sew-test-profile-'));
process.env.SEW_USER_DATA_DIR = directory;
afterAll(() => {
  if (original === undefined) delete process.env.SEW_USER_DATA_DIR;
  else process.env.SEW_USER_DATA_DIR = original;
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep + 'sew-test-profile-')) throw new Error('Unexpected test profile cleanup path');
  rmSync(directory, { recursive: true, force: true });
});
