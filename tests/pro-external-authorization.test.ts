import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeSqliteDriver } from '@sew/study-storage';
import {
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';
import { POST as tokensPost } from '../apps/learning/app/api/study/pro/tokens/route';
import { POST as externalPost } from '../apps/learning/app/api/pro/external/route';
import { modelConnection } from '../apps/learning/lib/server/model-connection';
import { commandProSession } from '../apps/learning/lib/server/pro-session-service';

/**
 * Pro 外部 token 的实时授权复验与无截断 requestId 映射（OMA-017）。
 *
 * 覆盖两个已核验缺陷：
 * - 长调用（provider 挂起）期间本机撤销 token：provider 返回后，外部 send 必须拒绝（不得把迟到的
 *   assistant 正文作为业务成功提交），但已派发的用量仍真实结算、任务不留在 running；
 * - 合同允许的 200 字符 requestId 拼接前缀后被截断会碰撞：两个只在末尾不同的合法 nonce 必须
 *   各自成功创建不同会话，同 nonce 同意图重放、改意图拒绝、不同 token 同 nonce 独立。
 */
describe('OMA-017 Pro 外部 token 实时授权复验与 requestId 映射', () => {
  let session: Session | null = null;
  let root: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    if (session) closeProject();
    session = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  const manage = (body: Record<string, unknown>) => {
    const withRequestId =
      body.action === 'list' ? body : { requestId: `m-${Math.random()}`, ...body };
    return tokensPost(
      new Request('http://127.0.0.1/api/study/pro/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: { projectId: session!.projectId, generation: session!.generation },
          ...withRequestId,
        }),
      }),
    );
  };

  const external = (body: Record<string, unknown>, authorization?: string) =>
    externalPost(
      new Request('http://127.0.0.1/api/pro/external', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify(body),
      }),
    );

  const createToken = async (scopes: string[] = ['read', 'create', 'send']): Promise<string> => {
    const response = await manage({ action: 'create', label: '外部任务', scopes, ttlDays: 30 });
    expect(response.status).toBe(200);
    return (await response.json()).data.issued.secret as string;
  };
  it('长编号已有旧版截断回执时拒绝重新执行，不重复创建会话', async () => {
    root = mkdtempSync(join(tmpdir(), 'sew-pro-legacy-'));
    session = openProjectFromDisk(root);
    const secret = await createToken();
    const list = await manage({ action: 'list' });
    const tokenId = (await list.json()).data.tokens[0].tokenId as string;
    const requestId = 'x'.repeat(200);
    await commandProSession({
      scope: { projectId: session.projectId, generation: session.generation },
      action: 'create',
      requestId: `pro-ext-${tokenId}-${requestId}`.slice(0, 200),
      title: '旧请求',
    });
    const response = await external(
      { action: 'create', requestId, title: '旧请求' },
      `Bearer ${secret}`,
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.details.reason).toBe(
      'pro_external_legacy_request_requires_review',
    );
    expect(session.store.proSessions.list(session.projectId, session.learnerUid)).toHaveLength(1);
  });

  /** 冻结证据包 + 进行中的 run：外部 send 需要真实来源。 */
  const prepareFrozenSource = (): { bundleId: string; bundleDigest: string } => {
    const { store, projectId } = session!;
    const material = store.importMaterial({
      projectId,
      displayName: '函数.md',
      materialType: 'md',
      rawText: '同一区间内增函数的函数值随自变量增大而增大。',
    });
    const proposal = store.createProposal({
      projectId,
      name: '增函数',
      concept: '同一区间内增函数的函数值随自变量增大而增大。',
      conditions: '同一区间',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [
        {
          materialId: material.material.materialId,
          revision: 1,
          segmentId: material.segments[0]!.segmentId,
          use: 'concept_basis',
        },
      ],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'user',
    });
    const knowledgeId = store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
    }).knowledgePoint!.knowledgeId;
    store.savePlanVersion(projectId, 1, 'confirmed', {
      payloadVersion: 1,
      goal: '学习增函数',
      examDate: null,
      dailyMinutes: 60,
      tasks: [
        {
          knowledgeId,
          name: '增函数',
          minutes: 30,
          acceptance: '',
          evidence: [
            {
              materialId: material.material.materialId,
              segmentId: material.segments[0]!.segmentId,
            },
          ],
        },
      ],
      gaps: [],
      basis: '测试',
      confirmedTaskKnowledgeIds: [knowledgeId],
    });
    store.startPlanRun(projectId);
    const bundle = store.buildLessonBundle(
      projectId,
      [{ knowledgeId, text: '增函数的定义', conditions: '同一区间' }],
      [],
    );
    return { bundleId: bundle.bundleId, bundleDigest: bundle.digest };
  };

  it('长调用期间撤销 token：迟到 assistant 不得提交，但用量仍结算且任务不留在 running', async () => {
    root = mkdtempSync(join(tmpdir(), 'sew-pro-ext-auth-'));
    session = openProjectFromDisk(root);
    const { bundleId, bundleDigest } = prepareFrozenSource();
    vi.spyOn(modelConnection, 'status').mockReturnValue({
      configured: true,
      persisted: false,
      lastTest: null,
    });
    let release!: (value: {
      dispatched: boolean;
      ok: boolean;
      message: string;
      text: string | null;
      totalTokens: number;
      providerTokens: number | null;
      requestedModel: null;
      returnedModel: null;
      elapsedMs: number;
    }) => void;
    vi.spyOn(modelConnection, 'generate').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const secret = await createToken();
    const createdResponse = await external(
      { action: 'create', requestId: 'ext-create', title: '外部会话' },
      `Bearer ${secret}`,
    );
    expect(createdResponse.status).toBe(200);
    const sessionId = (await createdResponse.json()).data.detail.sessionId as string;

    // provider 挂起期间，从**本机**管理入口撤销同一 token。
    const pending = external(
      {
        action: 'send',
        requestId: 'ext-send',
        sessionId,
        expectedRevision: 0,
        content: '解释定义',
        bundleId,
        bundleDigest,
        skillIds: [],
      },
      `Bearer ${secret}`,
    );
    // 等 provider 真正进入挂起。
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const list = await manage({ action: 'list' });
    const tokenId = (await list.json()).data.tokens[0].tokenId as string;
    const revoked = await manage({ action: 'revoke', tokenId });
    expect(revoked.status).toBe(200);

    release({
      dispatched: true,
      ok: true,
      message: 'fixture',
      text: '{"kind":"message","content":"迟到的正文不得写入。"}',
      totalTokens: 31,
      providerTokens: 31,
      requestedModel: null,
      returnedModel: null,
      elapsedMs: 1,
    });
    const response = await pending;
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PROJECT_NOT_AUTHORIZED');

    const record = session.store.proSessions.get(session.projectId, session.learnerUid, sessionId)!;
    // 迟到的 assistant 正文绝不进入会话；没有留下永远 running 的任务。
    expect(record.messages.some((message) => message.content.includes('迟到的正文'))).toBe(false);
    expect(record.tasks.some((task) => task.status === 'running')).toBe(false);
    // 已派发的用量仍真实结算（不因授权失效删账）。
    expect(session.store.modelCallUsage(session.store.getLatestRun()!.runId)).toMatchObject({
      calls: 1,
      tokens: 31,
    });
  });

  it('长调用期间轮换 token：旧 secret 的迟到结果不得提交，新 secret 正常', async () => {
    root = mkdtempSync(join(tmpdir(), 'sew-pro-ext-rotate-'));
    session = openProjectFromDisk(root);
    const { bundleId, bundleDigest } = prepareFrozenSource();
    vi.spyOn(modelConnection, 'status').mockReturnValue({
      configured: true,
      persisted: false,
      lastTest: null,
    });
    let release!: (value: unknown) => void;
    vi.spyOn(modelConnection, 'generate').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve as (value: unknown) => void;
        }),
    );

    const oldSecret = await createToken();
    const createdResponse = await external(
      { action: 'create', requestId: 'ext-create-2', title: '外部会话' },
      `Bearer ${oldSecret}`,
    );
    const sessionId = (await createdResponse.json()).data.detail.sessionId as string;
    const pending = external(
      {
        action: 'send',
        requestId: 'ext-send-2',
        sessionId,
        expectedRevision: 0,
        content: '解释定义',
        bundleId,
        bundleDigest,
        skillIds: [],
      },
      `Bearer ${oldSecret}`,
    );
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const list = await manage({ action: 'list' });
    const tokenId = (await list.json()).data.tokens[0].tokenId as string;
    const rotated = await manage({ action: 'rotate', tokenId, ttlDays: 30 });
    const newSecret = (await rotated.json()).data.issued.secret as string;
    expect(newSecret).not.toBe(oldSecret);

    release({
      dispatched: true,
      ok: true,
      message: 'fixture',
      text: '{"kind":"message","content":"轮换前的迟到正文。"}',
      totalTokens: 31,
      providerTokens: 31,
      requestedModel: null,
      returnedModel: null,
      elapsedMs: 1,
    });
    expect((await pending).status).toBe(403);
    const record = session.store.proSessions.get(session.projectId, session.learnerUid, sessionId)!;
    expect(record.messages.some((message) => message.content.includes('轮换前的迟到正文'))).toBe(
      false,
    );

    // 新 secret 的只读动作正常。
    const listed = await external(
      { action: 'list', requestId: 'ext-list-new' },
      `Bearer ${newSecret}`,
    );
    expect(listed.status).toBe(200);
  });

  it('长调用期间 token 到期：迟到结果不得提交', async () => {
    root = mkdtempSync(join(tmpdir(), 'sew-pro-ext-expire-'));
    session = openProjectFromDisk(root);
    const { bundleId, bundleDigest } = prepareFrozenSource();
    vi.spyOn(modelConnection, 'status').mockReturnValue({
      configured: true,
      persisted: false,
      lastTest: null,
    });
    let release!: (value: unknown) => void;
    vi.spyOn(modelConnection, 'generate').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve as (value: unknown) => void;
        }),
    );

    const secret = await createToken();
    const createdResponse = await external(
      { action: 'create', requestId: 'ext-create-3', title: '外部会话' },
      `Bearer ${secret}`,
    );
    const sessionId = (await createdResponse.json()).data.detail.sessionId as string;
    const pending = external(
      {
        action: 'send',
        requestId: 'ext-send-3',
        sessionId,
        expectedRevision: 0,
        content: '解释定义',
        bundleId,
        bundleDigest,
        skillIds: [],
      },
      `Bearer ${secret}`,
    );
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    // 独立连接把该 token 的到期时间改到过去（模拟长调用期间自然到期）。
    const db = createNodeSqliteDriver().open(session.store.databaseFile);
    try {
      db.prepare('UPDATE pro_external_tokens SET expires_at=?').run(
        new Date(Date.now() - 1000).toISOString(),
      );
    } finally {
      db.close();
    }

    release({
      dispatched: true,
      ok: true,
      message: 'fixture',
      text: '{"kind":"message","content":"到期后的迟到正文。"}',
      totalTokens: 31,
      providerTokens: 31,
      requestedModel: null,
      returnedModel: null,
      elapsedMs: 1,
    });
    expect((await pending).status).toBe(403);
    const record = session.store.proSessions.get(session.projectId, session.learnerUid, sessionId)!;
    expect(record.messages.some((message) => message.content.includes('到期后的迟到正文'))).toBe(
      false,
    );
  });

  it('200 字符 requestId 只在尾部不同时不碰撞：各自创建独立会话', async () => {
    root = mkdtempSync(join(tmpdir(), 'sew-pro-ext-nonce-'));
    session = openProjectFromDisk(root);
    const secret = await createToken();
    const base = 'n'.repeat(200);
    const firstNonce = `${base.slice(0, 199)}a`;
    const secondNonce = `${base.slice(0, 199)}b`;
    expect(firstNonce.length).toBe(200);
    expect(secondNonce.length).toBe(200);

    const first = await external(
      { action: 'create', requestId: firstNonce, title: '会话 A' },
      `Bearer ${secret}`,
    );
    expect(first.status).toBe(200);
    const firstSession = (await first.json()).data.detail.sessionId as string;

    // 旧实现会把两者截断成同一键并报 pro_request_reused；修复后必须各自成功。
    const second = await external(
      { action: 'create', requestId: secondNonce, title: '会话 B' },
      `Bearer ${secret}`,
    );
    expect(second.status).toBe(200);
    const secondSession = (await second.json()).data.detail.sessionId as string;
    expect(secondSession).not.toBe(firstSession);

    // 同 nonce 同意图重放：读回同一会话。
    const replay = await external(
      { action: 'create', requestId: firstNonce, title: '会话 A' },
      `Bearer ${secret}`,
    );
    expect(replay.status).toBe(200);
    const replayData = (await replay.json()).data;
    expect(replayData.replayed).toBe(true);
    expect(replayData.detail.sessionId).toBe(firstSession);

    // 同 nonce 改意图：拒绝（nonce 复用）。
    const changed = await external(
      { action: 'create', requestId: firstNonce, title: '会话 A 改名' },
      `Bearer ${secret}`,
    );
    expect(changed.status).toBe(409);

    // 不同 token 同 nonce：彼此独立，各自创建。
    const otherSecret = await createToken();
    const other = await external(
      { action: 'create', requestId: firstNonce, title: '会话 A' },
      `Bearer ${otherSecret}`,
    );
    expect(other.status).toBe(200);
    const otherSession = (await other.json()).data.detail.sessionId as string;
    expect(otherSession).not.toBe(firstSession);
  });
});
