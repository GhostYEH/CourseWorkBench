import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TEACHING_PREFERENCE } from '../apps/learning/lib/preferences';
import { closeProject, openProjectFromDisk, type Session } from '../apps/learning/lib/server/service';
import { readTeachingPreference } from '../apps/learning/lib/server/state';

describe('persisted teaching preference shape validation', () => {
  let directory: string;
  let session: Session;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sew-teaching-pref-'));
    session = openProjectFromDisk(directory);
  });
  afterEach(() => {
    closeProject();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it.each([false, ['rigorous'], { ...DEFAULT_TEACHING_PREFERENCE, hintDepth: 'unbounded' }])(
    'rejects syntactically valid but invalid persisted data: %j', (invalid) => {
      const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      session.store.writeTeachingPreference(session.projectId, invalid);
      expect(readTeachingPreference(session)).toEqual(DEFAULT_TEACHING_PREFERENCE);
      expect(diagnostic).toHaveBeenCalled();
    },
  );

  it('preserves validated preferences and their database revision after reopening', () => {
    const value = { ...DEFAULT_TEACHING_PREFERENCE, explanation: 'rigorous' as const };
    session.store.writeTeachingPreference(session.projectId, value);
    session.store.writeTeachingPreference(session.projectId, value);
    closeProject();
    session = openProjectFromDisk(directory);
    expect(readTeachingPreference(session)).toEqual({ ...value, version: 2 });
  });
});
