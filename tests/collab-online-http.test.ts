import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiResponses } from '@sew/study-contracts';
import {
  GET as onlineGet,
  POST as onlinePost,
} from '../apps/learning/app/api/study/collab/online/route';
import {
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';

/**
 * 本地服务在线协作入口的 HTTP 边界（ADR-0005）。
 *
 * 覆盖：项目代次校验、未配置在线服务时的明确失败（不伪报成功）、
 * 命令失败不返回成功信封。真实双客户端链路见 scripts/collab-two-client-link.mjs。
 */

describe('在线协作入口 HTTP 边界', () => {
  let root: string;
  let session: Session;
  const originalUrl = process.env.SEW_COLLAB_SERVICE_URL;
  const url = (path: string): string => `http://127.0.0.1${path}`;
  const headers = () => ({
    'content-type': 'application/json',
    'x-sew-project-id': session.projectId,
    'x-sew-generation': String(session.generation),
  });
  const post = (body: Record<string, unknown>) =>
    new Request(url('/api/study/collab/online'), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
  const get = (query = '') =>
    new Request(url(`/api/study/collab/online${query}`), { method: 'GET', headers: headers() });

  beforeEach(() => {
    delete process.env.SEW_COLLAB_SERVICE_URL;
    root = mkdtempSync(join(tmpdir(), 'sew-collab-online-http-'));
    session = openProjectFromDisk(root);
  });

  afterEach(() => {
    closeProject();
    rmSync(root, { recursive: true, force: true });
    if (originalUrl === undefined) delete process.env.SEW_COLLAB_SERVICE_URL;
    else process.env.SEW_COLLAB_SERVICE_URL = originalUrl;
  });

  it('无项目代次：读取被拒', async () => {
    const response = await onlineGet(new Request(url('/api/study/collab/online')));
    expect(response.status).toBe(400);
  });

  it('未配置在线服务：视图明确标记 configured=false，不伪报在线可用', async () => {
    const response = await onlineGet(get());
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { data?: { view?: unknown } };
    expect(apiResponses.collabOnlineView.safeParse(payload.data).success).toBe(true);
    const view = (
      payload.data as { view: { online: { configured: boolean; authenticated: boolean } } }
    ).view;
    expect(view.online.configured).toBe(false);
    expect(view.online.authenticated).toBe(false);
  });

  it('未配置在线服务：开通/邀请命令失败且不返回成功信封', async () => {
    const enable = await onlinePost(post({ action: 'enable', requestId: 'enable-1' }));
    expect(enable.status).toBe(403);
    const enableBody = (await enable.json()) as {
      ok: boolean;
      error?: { details?: { reason?: string } };
    };
    expect(enableBody.ok).toBe(false);
    expect(enableBody.error?.details?.reason).toBe('collab_not_configured');

    const invite = await onlinePost(
      post({
        action: 'invite',
        roomId: 'room_online_1',
        inviteeUid: 'uid_20000000-0000-4000-8000-000000000002',
        lessonId: 'lesson_1',
        lessonVersion: 1,
        snapshotDigest: 'a'.repeat(64),
        requestId: 'invite-1',
      }),
    );
    expect(invite.status).toBe(403);
    expect(((await invite.json()) as { ok: boolean }).ok).toBe(false);
  });
});
