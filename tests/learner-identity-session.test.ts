import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LEGACY_LOCAL_LEARNER_KEY } from '@sew/study-contracts';
import { closeProject, getSession, openProjectFromDisk, requireSession } from '../apps/learning/lib/server/service';
import { getLearnerProfile, LEARNER_PROFILE_FILE_NAME, updateLearnerProfile } from '../apps/learning/lib/server/learner-profile';

describe('UID across subjects and project replacement', () => {
  let root: string; let userData: string | undefined;
  beforeEach(() => { closeProject(); root = mkdtempSync(join(tmpdir(), 'sew-uid-session-')); userData = process.env.SEW_USER_DATA_DIR; process.env.SEW_USER_DATA_DIR = join(root, 'profile-a'); });
  afterEach(() => { closeProject(); if (userData === undefined) delete process.env.SEW_USER_DATA_DIR; else process.env.SEW_USER_DATA_DIR = userData; rmSync(root, { recursive: true, force: true }); });
  it('preserves UID and old learner data through nickname/subject edits, switching and reopen', () => {
    const a = openProjectFromDisk(join(root, 'subject-a')); const uid = getLearnerProfile().uid;
    a.store.classroomKV.set(a.projectId, LEGACY_LOCAL_LEARNER_KEY, 'draft', { answer: '本人原答' });
    a.store.updateProjectSettings(a.projectId, { subject: '物理', displayName: '更名科目' });
    updateLearnerProfile({ displayName: '新昵称', expectedRevision: 1, expectedUid: uid });
    const b = openProjectFromDisk(join(root, 'subject-b')); expect(b.learnerUid).toBe(uid);
    closeProject(); const reopened = openProjectFromDisk(join(root, 'subject-a'));
    expect(reopened.learnerUid).toBe(uid); expect(getLearnerProfile().displayName).toBe('新昵称');
    expect(reopened.store.classroomKV.get(reopened.projectId, LEGACY_LOCAL_LEARNER_KEY, 'draft')).toEqual({ answer: '本人原答' });
  });
  it('rejects a project owned by another profile and preserves the usable active project', () => {
    const a = openProjectFromDisk(join(root, 'subject-a')); const uidA = a.learnerUid; closeProject();
    process.env.SEW_USER_DATA_DIR = join(root, 'profile-b'); const b = openProjectFromDisk(join(root, 'subject-b'));
    expect(b.learnerUid).not.toBe(uidA);
    expect(() => openProjectFromDisk(join(root, 'subject-a'))).toThrowError(expect.objectContaining({ code: 'PROJECT_NOT_AUTHORIZED' }));
    expect(getSession()).toBe(b); expect(b.store.getProject(b.projectId)).not.toBeNull();
  });
  it('fails closed if a trusted profile change or corrupt identity occurs during an open session', () => {
    openProjectFromDisk(join(root, 'subject')); process.env.SEW_USER_DATA_DIR = join(root, 'profile-b');
    expect(() => requireSession()).toThrowError(expect.objectContaining({ code: 'PROJECT_NOT_AUTHORIZED' }));
    process.env.SEW_USER_DATA_DIR = join(root, 'profile-a');
    writeFileSync(join(process.env.SEW_USER_DATA_DIR, LEARNER_PROFILE_FILE_NAME), '{broken');
    expect(() => getSession()).toThrowError(expect.objectContaining({ code: 'INTERNAL' }));
  });
});
