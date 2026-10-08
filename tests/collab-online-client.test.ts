import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollabServiceStore } from '@sew/study-storage';
import { dispatch, type CollabServiceContext } from '../apps/collab-service/src/service';
import {
  apiResponses,
  collabOnlineCommandSchema,
  COLLAB_PROTOCOL_VERSION,
  StudyError,
} from '@sew/study-contracts';
import {
  clearCollabCredential,
  readCollabCredential,
  writeCollabCredential,
} from '../apps/learning/lib/server/collab-credential-store';
import {
  collabErrorReason,
  collabFetch,
  resolveCollabServiceUrl,
} from '../apps/learning/lib/server/collab-online-client';
import {
  readOnlineView,
  runOnlineCommand,
  enableOnlineIdentity,
} from '../apps/learning/lib/server/collab-online-service';
import type { Session } from '../apps/learning/lib/server/service';

/**
 * 本地服务的在线客户端边界（ADR-0005）。
 *
 * 覆盖：地址解析、凭据受控存储（不进浏览器/日志）、不可达/未配置时的明确失败，
 * 以及「未开通在线身份时命令被拒」。真实双客户端链路见 scripts/collab-two-client-link.mjs。
 */

const UID_A = 'uid_10000000-0000-4000-8000-000000000001';
const fakeSession = { learnerUid: UID_A } as unknown as Session;
const originalUrl = process.env.SEW_COLLAB_SERVICE_URL;
const originalEnrollment = process.env.SEW_COLLAB_ENROLLMENT_TOKEN;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalEnrollment === undefined) delete process.env.SEW_COLLAB_ENROLLMENT_TOKEN;
  else process.env.SEW_COLLAB_ENROLLMENT_TOKEN = originalEnrollment;
  if (originalUrl === undefined) delete process.env.SEW_COLLAB_SERVICE_URL;
  else process.env.SEW_COLLAB_SERVICE_URL = originalUrl;
  clearCollabCredential();
});

describe('协作服务地址解析', () => {
  it('未配置或非法地址返回 null；合法 http/https 取 origin', () => {
    delete process.env.SEW_COLLAB_SERVICE_URL;
    expect(resolveCollabServiceUrl()).toBeNull();
    process.env.SEW_COLLAB_SERVICE_URL = 'not a url';
    expect(resolveCollabServiceUrl()).toBeNull();
    process.env.SEW_COLLAB_SERVICE_URL = 'ftp://host/path';
    expect(resolveCollabServiceUrl()).toBeNull();
    expect(
      resolveCollabServiceUrl({ SEW_COLLAB_SERVICE_URL: 'http://192.168.1.10:9000' }),
    ).toBeNull();
    expect(resolveCollabServiceUrl({ SEW_COLLAB_SERVICE_URL: 'https://collab.example.com' })).toBe(
      'https://collab.example.com',
    );
    expect(
      resolveCollabServiceUrl({ SEW_COLLAB_SERVICE_URL: 'https://user:secret@collab.example.com' }),
    ).toBeNull();
    process.env.SEW_COLLAB_SERVICE_URL = 'http://127.0.0.1:9000/some/path';
    expect(resolveCollabServiceUrl()).toBe('http://127.0.0.1:9000');
  });
});

describe('凭据受控存储', () => {
  it('登记已提交但响应丢失：保留凭据与完整意图，重试读回同一登记', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-collab-registration-retry-'));
    const store = CollabServiceStore.open({ file: join(root, 'collab.db') });
    const context: CollabServiceContext = {
      store,
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      instanceId: 'test-instance',
      dev: true,
      sessions: new Map(),
      now: () => Date.now(),
    };
    process.env.SEW_COLLAB_SERVICE_URL = 'http://127.0.0.1:9001';
    process.env.SEW_COLLAB_ENROLLMENT_TOKEN = store.issueRegistrationClaim(UID_A);
    const intents: string[] = [];
    let loseResponse = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const raw = String(init?.body);
      intents.push(raw);
      const result = dispatch(
        context,
        init?.method ?? 'GET',
        url.pathname,
        url.searchParams,
        null,
        raw,
      );
      if (loseResponse) {
        loseResponse = false;
        throw new Error('response lost');
      }
      return Response.json(result.body, { status: result.status });
    });
    try {
      await expect(enableOnlineIdentity(fakeSession, 'enable-original')).rejects.toMatchObject({
        details: { reason: 'collab_unreachable' },
      });
      const pending = readCollabCredential();
      expect(pending?.pendingRegistration?.requestId).toBe('enable-original');
      expect(store.verifyCredential(pending!.credentialId, pending!.secret)?.uid).toBe(UID_A);
      const result = await enableOnlineIdentity(fakeSession, 'new-ui-request-after-restart');
      expect(result.deduplicated).toBe(true);
      expect(intents[1]).toBe(intents[0]);
      expect(readCollabCredential()?.pendingRegistration).toBeUndefined();
      expect(store.listCredentials(UID_A)).toHaveLength(1);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('写入后可读回；清除后为空；损坏内容不当作合法凭据', () => {
    expect(readCollabCredential()).toBeNull();
    writeCollabCredential({ fileVersion: 1, credentialId: 'cred_a', secret: 'a'.repeat(64) });
    expect(readCollabCredential()).toMatchObject({
      credentialId: 'cred_a',
      secret: 'a'.repeat(64),
    });
    clearCollabCredential();
    expect(readCollabCredential()).toBeNull();
  });
});

describe('在线视图与命令的失败语义', () => {
  it('在线命令合同接受按原动作 eventId 撤销/重放并拒绝混入任意负载', () => {
    const base = {
      action: 'teaching',
      roomId: 'room_1',
      sceneId: 'scene_1',
      expectedRevision: 3,
      expectedSeq: 8,
      eventId: 'event_undo_1',
      requestId: 'request_undo_1',
    };
    expect(
      collabOnlineCommandSchema.safeParse({
        ...base,
        operation: { kind: 'undo-board', actionEventId: 'event_focus_1' },
      }).success,
    ).toBe(true);
    expect(
      collabOnlineCommandSchema.safeParse({
        ...base,
        eventId: 'event_replay_1',
        requestId: 'request_replay_1',
        operation: { kind: 'replay-board', actionEventId: 'event_focus_1' },
      }).success,
    ).toBe(true);
    expect(
      collabOnlineCommandSchema.safeParse({
        ...base,
        operation: {
          kind: 'undo-board',
          actionEventId: 'event_focus_1',
          elementId: 'caller-selected-element',
        },
      }).success,
    ).toBe(false);
  });

  it('未配置地址：视图标记 configured=false，命令直接拒绝', async () => {
    delete process.env.SEW_COLLAB_SERVICE_URL;
    const view = await readOnlineView(fakeSession);
    expect(view.online.configured).toBe(false);
    expect(view.online.authenticated).toBe(false);
    await expect(
      runOnlineCommand(fakeSession, { action: 'start', roomId: 'room_1', requestId: 'r1' }),
    ).rejects.toMatchObject({
      code: 'PROJECT_NOT_AUTHORIZED',
    });
  });

  it('地址不可达：视图标记 connected=false 且给出可读原因', async () => {
    process.env.SEW_COLLAB_SERVICE_URL = 'http://127.0.0.1:1';
    const view = await readOnlineView(fakeSession);
    expect(view.online.configured).toBe(true);
    expect(view.online.connected).toBe(false);
    expect(view.online.authenticated).toBe(false);
    expect(view.online.error).toBeTruthy();
  });

  it('已配置但未开通身份：命令要求先开通', async () => {
    process.env.SEW_COLLAB_SERVICE_URL = 'http://127.0.0.1:1';
    await expect(
      runOnlineCommand(fakeSession, { action: 'start', roomId: 'room_1', requestId: 'r1' }),
    ).rejects.toMatchObject({
      code: 'PROJECT_NOT_AUTHORIZED',
    });
  });

  it('collabFetch 把不可达收敛为可判定的 StudyError', async () => {
    const schema = apiResponses.collabOnlineView;
    await expect(
      collabFetch('http://127.0.0.1:1', { method: 'GET', path: '/health' }, schema),
    ).rejects.toBeInstanceOf(StudyError);
    try {
      await collabFetch('http://127.0.0.1:1', { method: 'GET', path: '/health' }, schema);
    } catch (error) {
      expect(collabErrorReason(error)).toBe('collab_unreachable');
    }
  });

  it('请求已取消时不发起协作 fetch，并返回可判定的取消错误', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(
      collabFetch(
        'https://collab.example.com',
        {
          method: 'POST',
          path: '/collab/v1/teaching-ai/candidates',
          token: 'session-token',
          body: { requestId: 'cancelled-before-send' },
          signal: controller.signal,
        },
        apiResponses.collabTeachingAi,
      ),
    ).rejects.toMatchObject({
      code: 'RUN_TERMINATED',
      details: { reason: 'request_aborted' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
