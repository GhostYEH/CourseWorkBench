import { afterEach, describe, expect, it } from 'vitest';
import {
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';
import { GET, POST } from '../apps/learning/app/api/study/pro/route';
import { proSessionResponseSchema } from '../packages/study-contracts/src/pro-session';
import { StudyError } from '@sew/study-contracts';
import { commandProSession } from '../apps/learning/lib/server/pro-session-service';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('same-origin Pro session API', () => {
  let session: Session | null = null;
  let root: string | null = null;
  afterEach(() => {
    if (session) closeProject();
    session = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('creates a durable owner-bound session and lists it through the current open project', async () => {
    root = mkdtempSync(join(tmpdir(), 'sew-pro-http-'));
    session = openProjectFromDisk(root);
    const scope = { projectId: session.projectId, generation: session.generation };
    const response = await POST(
      new Request('http://localhost/api/study/pro', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope,
          requestId: 'pro-create-1',
          action: 'create',
          title: '一次函数复习',
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; data: unknown };
    expect(body.ok).toBe(true);
    const created = proSessionResponseSchema.safeParse(body.data);
    expect(created.success).toBe(true);
    if (!created.success) return;
    expect(created.data.detail?.title).toBe('一次函数复习');
    expect(created.data.detail?.learnerUid).toBe(session.learnerUid);
    expect(created.data.detail?.skills).toHaveLength(24);

    const listed = await GET(
      new Request(
        `http://localhost/api/study/pro?projectId=${session.projectId}&generation=${session.generation}`,
      ),
    );
    const listBody = (await listed.json()) as { data: { sessions: Array<{ sessionId: string }> } };
    expect(listBody.data.sessions.map((item) => item.sessionId)).toContain(
      created.data.detail?.sessionId,
    );
  });

  it('does not treat a caller supplied project id as authorization', async () => {
    root = mkdtempSync(join(tmpdir(), 'sew-pro-owner-'));
    session = openProjectFromDisk(root);
    const response = await GET(
      new Request('http://localhost/api/study/pro?projectId=another-project&generation=1'),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { ok: boolean; error?: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('PROJECT_GENERATION_STALE');
  });

  it('denies turns without a matching frozen source before recording or dispatch', async () => {
    root = mkdtempSync(join(tmpdir(), 'sew-pro-no-source-'));
    session = openProjectFromDisk(root);
    const scope = { projectId: session.projectId, generation: session.generation };
    const created = await POST(
      new Request('http://localhost/api/study/pro', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope,
          requestId: 'create-source-test',
          action: 'create',
          title: '缺来源测试',
        }),
      }),
    );
    const createdBody = (await created.json()) as { data: { detail: { sessionId: string } } };
    const send = await POST(
      new Request('http://localhost/api/study/pro', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope,
          requestId: 'send-without-source',
          action: 'send',
          sessionId: createdBody.data.detail.sessionId,
          expectedRevision: 0,
          content: '请总结资料',
          bundleId: 'missing_bundle',
          bundleDigest: 'a'.repeat(64),
          skillIds: [],
        }),
      }),
    );
    expect(send.status).toBe(500);
    const record = session.store.proSessions.get(
      session.projectId,
      session.learnerUid,
      createdBody.data.detail.sessionId,
    );
    expect(record?.messages).toEqual([]);
    expect(record?.tasks).toEqual([]);
  });

  it('honors a revocable authorization callback before private writes', async () => {
    root = mkdtempSync(join(tmpdir(), 'sew-pro-auth-'));
    session = openProjectFromDisk(root);
    await expect(
      commandProSession(
        {
          scope: { projectId: session.projectId, generation: session.generation },
          requestId: 'denied-create',
          action: 'create',
          title: '不应创建',
        },
        undefined,
        () => {
          throw new StudyError('ROLE_PERMISSION_DENIED');
        },
      ),
    ).rejects.toThrow(StudyError);
    expect(session.store.proSessions.list(session.projectId, session.learnerUid)).toEqual([]);
  });
});
