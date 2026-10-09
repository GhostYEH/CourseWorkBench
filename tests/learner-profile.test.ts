import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { learnerProfileSchema, learnerProfileUpdateSchema } from '@sew/study-contracts';
import {
  createLearnerProfileStore, getLearnerProfile, updateLearnerProfile, LEARNER_PROFILE_FILE_NAME,
} from '../apps/learning/lib/server/learner-profile';

const childSource = `
  import { getLearnerProfile, updateLearnerProfile } from './apps/learning/lib/server/learner-profile.ts';
  const current = getLearnerProfile();
  const value = process.env.PROFILE_CHILD_RENAME
    ? updateLearnerProfile({ displayName: process.env.PROFILE_CHILD_RENAME, expectedUid: current.uid, expectedRevision: current.revision })
    : current;
  process.stdout.write(JSON.stringify(value));
`;
const cwd = resolve(import.meta.dirname, '..');
const validUid = 'uid_00000000-0000-4000-8000-000000000000';

describe('user-level learner profile', () => {
  let root: string;
  let previousUserDataDir: string | undefined;

  beforeEach(() => {
    previousUserDataDir = process.env.SEW_USER_DATA_DIR;
    root = fs.mkdtempSync(join(tmpdir(), 'sew-learner-profile-'));
    process.env.SEW_USER_DATA_DIR = root;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (previousUserDataDir === undefined) delete process.env.SEW_USER_DATA_DIR;
    else process.env.SEW_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates one UUID v4 identity and reuses it after an independent process restart', () => {
    const first = getLearnerProfile();
    expect(learnerProfileSchema.parse(first)).toEqual(first);
    expect(first).toMatchObject({ revision: 1, displayName: '本地学习者', registrationStatus: 'local_only', canInvite: false });
    expect(getLearnerProfile()).toEqual(first);
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], {
      cwd, env: { ...process.env, SEW_USER_DATA_DIR: root }, encoding: 'utf8', windowsHide: true,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(learnerProfileSchema.parse(JSON.parse(child.stdout))).toEqual(first);
  });

  it('renames with a revision CAS while preserving UID and creation time', () => {
    const first = getLearnerProfile();
    const renamed = updateLearnerProfile({ displayName: '  小姚  ', expectedUid: first.uid, expectedRevision: 1 });
    expect(renamed).toMatchObject({ uid: first.uid, createdAt: first.createdAt, displayName: '小姚', revision: 2 });
    expect(() => updateLearnerProfile({ displayName: '过期写入', expectedUid: first.uid, expectedRevision: 1 })).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    expect(getLearnerProfile()).toEqual(renamed);
    expect(fs.readdirSync(root)).toEqual([LEARNER_PROFILE_FILE_NAME]);
  });

  it('rejects identity or storage-path forgery and empty or excessive names', () => {
    for (const value of [
      { displayName: '姚', expectedUid: validUid, expectedRevision: 1, uid: 'uid_forged' },
      { displayName: '姚', expectedUid: validUid, expectedRevision: 1, root: 'D:/other' },
      { displayName: '   ', expectedUid: validUid, expectedRevision: 1 },
      { displayName: '姚'.repeat(81), expectedUid: validUid, expectedRevision: 1 },
      { displayName: '姚', expectedUid: validUid, expectedRevision: 0 },
      { displayName: '姚', expectedUid: 'uid_forged', expectedRevision: 1 },
      { displayName: '姚', expectedRevision: 1 },
    ]) expect(learnerProfileUpdateSchema.safeParse(value).success).toBe(false);
  });

  it.each(['{broken', JSON.stringify({ schemaVersion: 99 }), JSON.stringify({ schemaVersion: 1, uid: 'bad' })])(
    'does not silently create a replacement when the existing identity is invalid: %s', (raw) => {
      const file = join(root, LEARNER_PROFILE_FILE_NAME);
      fs.writeFileSync(file, raw, 'utf8');
      expect(() => getLearnerProfile()).toThrowError(expect.objectContaining({ code: 'INTERNAL' }));
      expect(() => updateLearnerProfile({ displayName: '新昵称', expectedUid: validUid, expectedRevision: 1 })).toThrowError(expect.objectContaining({ code: 'INTERNAL' }));
      expect(fs.readFileSync(file, 'utf8')).toBe(raw);
      expect(fs.readdirSync(root)).toEqual([LEARNER_PROFILE_FILE_NAME]);
    },
  );

  it('preserves the previous identity when atomic replacement fails', () => {
    const original = getLearnerProfile();
    const originalBytes = fs.readFileSync(join(root, LEARNER_PROFILE_FILE_NAME), 'utf8');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('write denied'), { code: 'EACCES' }); });
    expect(() => updateLearnerProfile({ displayName: '未保存昵称', expectedUid: original.uid, expectedRevision: 1 })).toThrowError(expect.objectContaining({ code: 'INTERNAL' }));
    expect(fs.readFileSync(join(root, LEARNER_PROFILE_FILE_NAME), 'utf8')).toBe(originalBytes);
    expect(getLearnerProfile()).toEqual(original);
    expect(fs.readdirSync(root)).toEqual([LEARNER_PROFILE_FILE_NAME]);
  });

  it('recovers a transient Windows file-occupancy failure on atomic replacement without losing identity', () => {
    const original = getLearnerProfile();
    const real = fs.renameSync.bind(fs);
    let calls = 0;
    // 首次 EPERM（杀毒/索引器短暂占用），随后成功：有限次重试后仍完成原子替换。
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('busy'), { code: 'EPERM' });
      return real(from, to);
    });
    const renamed = updateLearnerProfile({ displayName: '瞬态重试后保存', expectedUid: original.uid, expectedRevision: 1 });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(renamed).toMatchObject({ uid: original.uid, createdAt: original.createdAt, displayName: '瞬态重试后保存', revision: 2 });
    expect(getLearnerProfile()).toEqual(renamed);
    expect(fs.readdirSync(root)).toEqual([LEARNER_PROFILE_FILE_NAME]);
    spy.mockRestore();
  });

  it('preserves the previous identity when writing or flushing the temporary file fails', () => {
    const original = getLearnerProfile();
    const originalBytes = fs.readFileSync(join(root, LEARNER_PROFILE_FILE_NAME), 'utf8');
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw Object.assign(new Error('disk failure'), { code: 'EIO' }); });
    expect(() => updateLearnerProfile({ displayName: '未落盘昵称', expectedUid: original.uid, expectedRevision: 1 })).toThrowError(expect.objectContaining({ code: 'INTERNAL' }));
    expect(fs.readFileSync(join(root, LEARNER_PROFILE_FILE_NAME), 'utf8')).toBe(originalBytes);
    expect(getLearnerProfile()).toEqual(original);
    expect(fs.readdirSync(root)).toEqual([LEARNER_PROFILE_FILE_NAME]);
  });

  it('fails safely when initial publication fails without leaving a half-written profile', () => {
    vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw Object.assign(new Error('write denied'), { code: 'EACCES' }); });
    expect(() => getLearnerProfile()).toThrowError(expect.objectContaining({ code: 'INTERNAL' }));
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('publishes the same complete identity for concurrent first creation in separate processes', async () => {
    const child = (): Promise<string> => new Promise((resolveChild, rejectChild) => {
      const processChild = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], {
        cwd, env: { ...process.env, SEW_USER_DATA_DIR: root }, windowsHide: true,
      });
      let output = '';
      let errors = '';
      processChild.stdout.on('data', (value) => { output += String(value); });
      processChild.stderr.on('data', (value) => { errors += String(value); });
      processChild.on('error', rejectChild);
      processChild.on('close', (code) => {
        if (code === 0) resolveChild(output);
        else rejectChild(new Error(`child exited ${code}: ${errors}`));
      });
    });
    const profiles = (await Promise.all([child(), child(), child(), child()]))
      .map((raw) => learnerProfileSchema.parse(JSON.parse(raw)));
    expect(new Set(profiles.map((profile) => profile.uid)).size).toBe(1);
    for (const profile of profiles) expect(profile).toEqual(getLearnerProfile());
    expect(fs.readdirSync(root)).toEqual([LEARNER_PROFILE_FILE_NAME]);
  });

  it('protects cross-process revisions and never steals an existing writer lock', () => {
    const first = getLearnerProfile();
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], {
      cwd, env: { ...process.env, SEW_USER_DATA_DIR: root, PROFILE_CHILD_RENAME: '另一个进程' },
      encoding: 'utf8', windowsHide: true,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(() => updateLearnerProfile({ displayName: '旧版本', expectedUid: first.uid, expectedRevision: first.revision })).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    const current = getLearnerProfile();
    const lock = join(root, `${LEARNER_PROFILE_FILE_NAME}.lock`);
    fs.writeFileSync(lock, 'existing writer', 'utf8');
    expect(() => updateLearnerProfile({ displayName: '争抢锁', expectedUid: current.uid, expectedRevision: current.revision })).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    expect(fs.readFileSync(lock, 'utf8')).toBe('existing writer');
    expect(getLearnerProfile()).toEqual(current);
  });

  it('allows only one of concurrent process writes with the same expected revision', async () => {
    const original = getLearnerProfile();
    const source = `
      import { updateLearnerProfile } from './apps/learning/lib/server/learner-profile.ts';
      try {
        const data = updateLearnerProfile({ displayName: process.env.PROFILE_CHILD_RENAME, expectedUid: process.env.PROFILE_CHILD_EXPECTED_UID, expectedRevision: 1 });
        process.stdout.write(JSON.stringify({ ok: true, data }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code }));
      }
    `;
    const write = (name: string): Promise<{ ok: boolean; code?: string }> => new Promise((resolveChild, rejectChild) => {
      const processChild = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
        cwd, env: { ...process.env, SEW_USER_DATA_DIR: root, PROFILE_CHILD_RENAME: name, PROFILE_CHILD_EXPECTED_UID: original.uid }, windowsHide: true,
      });
      let output = '';
      let errors = '';
      processChild.stdout.on('data', (value) => { output += String(value); });
      processChild.stderr.on('data', (value) => { errors += String(value); });
      processChild.on('error', rejectChild);
      processChild.on('close', (code) => {
        if (code !== 0) { rejectChild(new Error(`child exited ${code}: ${errors}`)); return; }
        try { resolveChild(JSON.parse(output)); } catch (error) { rejectChild(error); }
      });
    });
    const results = await Promise.all([write('进程甲'), write('进程乙'), write('进程丙')]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    for (const failed of results.filter((result) => !result.ok)) expect(failed.code).toBe('VERSION_CONFLICT');
    expect(getLearnerProfile()).toMatchObject({ uid: original.uid, createdAt: original.createdAt, revision: 2 });
    expect(fs.readdirSync(root)).toEqual([LEARNER_PROFILE_FILE_NAME]);
  });

  it('resolves trusted environment changes on each request and keeps profiles separate', () => {
    const first = getLearnerProfile();
    const secondRoot = join(root, 'another-user');
    process.env.SEW_USER_DATA_DIR = secondRoot;
    const second = getLearnerProfile();
    expect(second.uid).not.toBe(first.uid);
    process.env.SEW_USER_DATA_DIR = root;
    expect(getLearnerProfile()).toEqual(first);
    expect(createLearnerProfileStore(secondRoot).get()).toEqual(second);
  });

  it('rejects a previous user-directory form even when both profile revisions are equal', () => {
    const first = getLearnerProfile();
    process.env.SEW_USER_DATA_DIR = join(root, 'another-user');
    const second = getLearnerProfile();
    expect(second.revision).toBe(first.revision);
    const originalBytes = fs.readFileSync(join(process.env.SEW_USER_DATA_DIR, LEARNER_PROFILE_FILE_NAME), 'utf8');
    expect(() => updateLearnerProfile({
      displayName: '旧表单的昵称', expectedUid: first.uid, expectedRevision: first.revision,
    })).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    expect(getLearnerProfile()).toEqual(second);
    expect(fs.readFileSync(join(process.env.SEW_USER_DATA_DIR, LEARNER_PROFILE_FILE_NAME), 'utf8')).toBe(originalBytes);
  });

  it('rejects an old form after a valid profile replacement with the same revision', () => {
    const first = getLearnerProfile();
    const replacement = createLearnerProfileStore(join(root, 'replacement')).get();
    expect(replacement.revision).toBe(first.revision);
    const file = join(root, LEARNER_PROFILE_FILE_NAME);
    const replacementBytes = `${JSON.stringify(replacement)}\n`;
    fs.writeFileSync(file, replacementBytes, 'utf8');
    expect(() => updateLearnerProfile({
      displayName: '旧档案的昵称', expectedUid: first.uid, expectedRevision: first.revision,
    })).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    expect(getLearnerProfile()).toEqual(replacement);
    expect(fs.readFileSync(file, 'utf8')).toBe(replacementBytes);
  });

  it('does not create a new identity when an old form targets a missing profile', () => {
    expect(() => updateLearnerProfile({
      displayName: '旧档案昵称', expectedUid: validUid, expectedRevision: 1,
    })).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
