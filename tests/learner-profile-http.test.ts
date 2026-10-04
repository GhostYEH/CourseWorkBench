import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiEnvelopeSchema, apiResponses } from '@sew/study-contracts';
import { GET, PUT } from '../apps/learning/app/api/study/identity/route';
import { createLearnerProfileStore, LEARNER_PROFILE_FILE_NAME } from '../apps/learning/lib/server/learner-profile';

const url = 'http://localhost/api/study/identity';
const validUid = 'uid_00000000-0000-4000-8000-000000000000';
const put = (body: unknown) => PUT(new Request(url, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));

describe('learner identity HTTP boundary without a project', () => {
  let root: string;
  let previousUserDataDir: string | undefined;
  beforeEach(() => {
    previousUserDataDir = process.env.SEW_USER_DATA_DIR;
    root = fs.mkdtempSync(join(tmpdir(), 'sew-identity-http-'));
    process.env.SEW_USER_DATA_DIR = root;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (previousUserDataDir === undefined) delete process.env.SEW_USER_DATA_DIR;
    else process.env.SEW_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns a validated local-only profile without project credentials and forbids caching', async () => {
    const response = await GET(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const parsed = apiEnvelopeSchema(apiResponses.learnerProfile).parse(await response.json());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.data).toMatchObject({ registrationStatus: 'local_only', canInvite: false, revision: 1 });
  });

  it('updates only the display name and returns 409 for a stale revision', async () => {
    const initial = await (await GET(new Request(url))).json();
    const response = await put({ displayName: '我的昵称', expectedUid: initial.data.uid, expectedRevision: 1 });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const updated = await response.json();
    expect(updated.data).toMatchObject({ uid: initial.data.uid, createdAt: initial.data.createdAt, revision: 2, displayName: '我的昵称' });
    const stale = await put({ displayName: '旧表单', expectedUid: initial.data.uid, expectedRevision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.headers.get('cache-control')).toBe('no-store');
    expect((await stale.json()).error.code).toBe('VERSION_CONFLICT');
  });

  it('rejects UID, path, registration, or unexpected query fields rather than accepting client identity', async () => {
    for (const patch of [
      { uid: 'uid_forged' }, { path: 'C:/other' }, { registrationStatus: 'online' }, { canInvite: true },
      { createdAt: new Date().toISOString() }, { revision: 7 }, { displayName: '  ' }, { expectedRevision: 0 },
      { expectedUid: 'uid_forged' },
    ]) {
      const response = await put({ displayName: '正常昵称', expectedUid: validUid, expectedRevision: 1, ...patch });
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect((await GET(new Request(`${url}?uid=forged`))).status).toBe(400);
    expect((await PUT(new Request(`${url}?path=forged`, {
      method: 'PUT', body: JSON.stringify({ displayName: '姚', expectedUid: validUid, expectedRevision: 1 }),
    }))).status).toBe(400);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('rejects an old profile UID after the trusted directory changes with an equal revision', async () => {
    const first = await (await GET(new Request(url))).json();
    process.env.SEW_USER_DATA_DIR = join(root, 'another-user');
    const second = await (await GET(new Request(url))).json();
    expect(second.data.revision).toBe(first.data.revision);
    const response = await put({
      displayName: '旧页面昵称', expectedUid: first.data.uid, expectedRevision: first.data.revision,
    });
    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await (await GET(new Request(url))).json()).data).toEqual(second.data);
  });

  it('rejects an old profile UID after a valid file replacement and preserves the replacement', async () => {
    const first = await (await GET(new Request(url))).json();
    const replacement = createLearnerProfileStore(join(root, 'replacement')).get();
    const file = join(root, LEARNER_PROFILE_FILE_NAME);
    const raw = `${JSON.stringify(replacement)}\n`;
    fs.writeFileSync(file, raw, 'utf8');
    const response = await put({
      displayName: '旧页面昵称', expectedUid: first.data.uid, expectedRevision: first.data.revision,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('VERSION_CONFLICT');
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
  });

  it('requires the profile UID precondition and never creates identity from a rename request', async () => {
    expect((await put({ displayName: '未绑定昵称', expectedRevision: 1 })).status).toBe(400);
    const missing = await put({ displayName: '旧档案昵称', expectedUid: validUid, expectedRevision: 1 });
    expect(missing.status).toBe(409);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('rejects malformed JSON without creating a profile', async () => {
    const response = await PUT(new Request(url, { method: 'PUT', body: '{broken' }));
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('reports invalid stored identities as failure without leaking a local path or regenerating UID', async () => {
    const raw = JSON.stringify({ schemaVersion: 88 });
    fs.writeFileSync(join(root, LEARNER_PROFILE_FILE_NAME), raw, 'utf8');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await GET(new Request(url));
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const failure = await response.json();
    expect(failure.error.code).toBe('INTERNAL');
    expect(JSON.stringify(failure)).not.toContain(root);
    expect(fs.readFileSync(join(root, LEARNER_PROFILE_FILE_NAME), 'utf8')).toBe(raw);
  });
});
