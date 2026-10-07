#!/usr/bin/env node
/**
 * 独立协作服务双客户端链路验证（ADR-0005）。
 *
 * 用两个隔离数据目录、两个本人凭据、两个真实客户端连接**同一独立协作服务**，
 * 自动验证：登记、邀请接受、双人准备与 start、同一共享快照、双向消息、结构化场景推进、
 * 断连重连、丢失响应原 requestId 重试、服务重启后读回；以及第三身份越权、已退出成员、
 * 争抢房间、游标越界、版本不一致、隐私投影、重复副作用计数等负例。
 *
 * 重要：自动双客户端**不等于**两位真人两台物理设备验收（COLLAB-EVAL-01 仍未执行）。
 *
 * 用法：node scripts/collab-two-client-link.mjs
 * 通过输出 `PASS collab two-client link ...`，任一步失败退出码非 0。
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = join(root, 'apps', 'collab-service', 'server.mjs');
const localClientEntry = join(root, 'scripts', 'collab-local-client.mjs');
const PROTOCOL_VERSION = 4;

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'ok' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

const UID_A = 'uid_10000000-0000-4000-8000-000000000001';
const UID_B = 'uid_10000000-0000-4000-8000-000000000002';
const UID_C = 'uid_10000000-0000-4000-8000-000000000003';
const SECRET_A = 'a'.repeat(64);
const SECRET_B = 'b'.repeat(64);
const SECRET_C = 'c'.repeat(64);
const DIGEST = 'd'.repeat(64);
const ROOM = 'room_link_1';
const LOCAL_UID_A = 'uid_10000000-0000-4000-8000-000000000011';
const LOCAL_UID_B = 'uid_10000000-0000-4000-8000-000000000012';

const snapshot = () => ({
  snapshotVersion: 1,
  course: {
    lessonId: 'lesson_1',
    lessonVersion: 1,
    title: '单调性',
    stageId: 'stage_1',
    dslVersion: '0.11.2',
    documentDigest: DIGEST,
    bundleDigest: DIGEST,
  },
  scenes: [
    {
      sceneId: 'scene_1',
      type: 'slide',
      title: '引入',
      order: 0,
      elements: [
        {
          elementId: 'e1',
          type: 'text',
          left: 0,
          top: 0,
          width: 10,
          height: 10,
          rotate: 0,
          text: '内容',
        },
      ],
    },
    {
      sceneId: 'scene_2',
      type: 'slide',
      title: '例题',
      order: 1,
      elements: [
        {
          elementId: 'e2',
          type: 'text',
          left: 0,
          top: 0,
          width: 10,
          height: 10,
          rotate: 0,
          text: '例题',
        },
      ],
    },
  ],
  evidence: {
    planVersion: 1,
    knowledgeVersions: [
      { knowledgeId: 'k1', revision: 0 },
      { knowledgeId: 'k2', revision: 0 },
    ],
    statements: [
      {
        statementId: 'statement_k1_scene2',
        knowledgeId: 'k1',
        text: '在同一区间内，函数值随自变量增大而增大的函数称为增函数。',
        conditions: '同一区间',
        evidence: [{ materialId: 'm1', revision: 1, segmentId: 'S001', use: 'concept_basis' }],
      },
      {
        statementId: 'statement_k2_scene1',
        knowledgeId: 'k2',
        text: '例题场景的独立知识陈述。',
        conditions: '仅适用于引入场景',
        evidence: [{ materialId: 'm1', revision: 1, segmentId: 'S001', use: 'concept_basis' }],
      },
    ],
    segments: [
      { materialId: 'm1', revision: 1, segmentId: 'S001', fingerprint: DIGEST, text: '文本' },
    ],
  },
  sceneSources: [
    { sceneId: 'scene_1', knowledgeIds: ['k2'], questionId: null },
    { sceneId: 'scene_2', knowledgeIds: ['k1'], questionId: null },
  ],
  assets: [],
});

/** 一个真实客户端：只经 HTTP 访问协作服务。 */
const createClient = (origin) => {
  const call = async (
    method,
    path,
    { body, token, query, protocolVersion = PROTOCOL_VERSION } = {},
  ) => {
    const url = new URL(`${origin}${path}`);
    for (const [key, value] of Object.entries(query ?? {}))
      url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-sew-collab-protocol': String(protocolVersion),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const json = await response.json();
    return { status: response.status, ok: json.ok === true, data: json.data, error: json.error };
  };
  return {
    origin,
    call,
    register: (uid, displayName, credentialId, secret, requestId, activationToken) =>
      call('POST', '/collab/v1/register', {
        body: { uid, displayName, credentialId, secret, proof: null, requestId, activationToken },
      }),
    authenticate: (credentialId, secret) =>
      call('POST', '/collab/v1/session', {
        body: { credentialId, secret, requestId: `s_${credentialId}` },
      }),
    invite: (token, input) =>
      call('POST', '/collab/v1/invitations', { token, body: { action: 'invite', ...input } }),
    decide: (token, input) =>
      call('POST', '/collab/v1/invitations', { token, body: { action: 'decide', ...input } }),
    listInvitations: (token) => call('GET', '/collab/v1/invitations', { token }),
    readiness: (token, input) =>
      call('POST', '/collab/v1/rooms', { token, body: { action: 'readiness', ...input } }),
    start: (token, input) =>
      call('POST', '/collab/v1/rooms', { token, body: { action: 'start', ...input } }),
    room: (token, roomId) => call('GET', '/collab/v1/rooms', { token, query: { roomId } }),
    message: (token, input) => call('POST', '/collab/v1/messages', { token, body: input }),
    messages: (token, roomId, afterSeq = 0) =>
      call('GET', '/collab/v1/messages', { token, query: { roomId, afterSeq } }),
    sceneSync: (token, input) => call('POST', '/collab/v1/scene-sync', { token, body: input }),
    teaching: (token, roomId) => call('GET', '/collab/v1/teaching', { token, query: { roomId } }),
    applyTeaching: (token, input) => call('POST', '/collab/v1/teaching', { token, body: input }),
    snapshotUpload: (token, input) => call('POST', '/collab/v1/snapshot', { token, body: input }),
    snapshot: (token, roomId) => call('GET', '/collab/v1/snapshot', { token, query: { roomId } }),
  };
};

const waitReady = (child, timeout = 20000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ready 超时（${timeout}ms）`)), timeout);
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line) continue;
        try {
          const payload = JSON.parse(line);
          if (payload.type === 'ready') {
            clearTimeout(timer);
            resolve(payload);
          } else if (payload.type === 'error') {
            clearTimeout(timer);
            reject(new Error(payload.message));
          }
        } catch {
          /* 非 JSON 行忽略 */
        }
      }
    });
    child.on('exit', () => reject(new Error('协作服务在 ready 前退出')));
  });

const startService = async (dataDir) => {
  const child = spawn(process.execPath, [serverEntry, '--port', '0', '--data-dir', dataDir], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(`[collab] ${chunk}`));
  const ready = await waitReady(child);
  return { child, origin: ready.origin };
};

const startLocalClient = async (
  projectDir,
  userDataDir,
  serviceUrl,
  uid,
  activationToken,
  displayName,
) => {
  const child = spawn(
    process.execPath,
    ['--conditions=import', '--import', 'tsx/esm', localClientEntry],
    {
      cwd: root,
      env: {
        ...process.env,
        SEW_PROJECT_ROOT: projectDir,
        SEW_USER_DATA_DIR: userDataDir,
        SEW_COLLAB_SERVICE_URL: serviceUrl,
        SEW_FIXTURE_UID: uid,
        SEW_FIXTURE_NAME: displayName,
        SEW_COLLAB_ENROLLMENT_TOKEN: activationToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(`[local-client] ${chunk}`));
  const ready = await waitReady(child);
  return { child, ...ready };
};

const provisionClaim = (dataDir, uid) => {
  const raw = execFileSync(
    process.execPath,
    [join(root, 'apps', 'collab-service', 'provision.mjs'), '--data-dir', dataDir, '--uid', uid],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
  const claim = JSON.parse(raw.trim());
  if (claim.uid !== uid || typeof claim.activationToken !== 'string' || !claim.activationToken) {
    throw new Error(`无法为隔离身份签发激活凭据：${uid}`);
  }
  return claim.activationToken;
};

const createHistoricalExpiredInvitation = (dataDir) => {
  const source = `
import { register } from 'tsx/esm/api';
register();
const { CollabServiceStore } = await import('@sew/study-storage');
const store = CollabServiceStore.open({ file: process.argv[1] + '/collab.db' });
try {
  const result = store.collaboration.invite({
    roomId: 'room_expired_link',
    inviterUid: '${UID_A}',
    inviteeUid: '${UID_C}',
    lessonId: 'lesson_1',
    lessonVersion: 1,
    snapshotDigest: '${DIGEST}',
    requestId: 'invite-historical-expired',
    now: '2000-01-01T00:00:00.000Z',
  });
  process.stdout.write(JSON.stringify({ invitationId: result.invitation.invitationId }) + '\\n');
} finally {
  store.close();
}
`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', source, dataDir], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  const fixture = JSON.parse(output.trim());
  if (typeof fixture.invitationId !== 'string' || !fixture.invitationId) {
    throw new Error('未创建历史过期邀请夹具');
  }
  return fixture.invitationId;
};

const createLocalProxyClient = (origin) => ({
  call: async (method, { body, query } = {}) => {
    const url = new URL('/api/study/collab/online', origin);
    for (const [key, value] of Object.entries(query ?? {}))
      url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    const json = await response.json();
    return { status: response.status, ok: json.ok === true, data: json.data, error: json.error };
  },
  view: (roomId) => createLocalProxyClient(origin).call('GET', { query: roomId ? { roomId } : {} }),
  command: (action, input) =>
    createLocalProxyClient(origin).call('POST', { body: { action, ...input } }),
});

const stopService = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      resolve();
    }, 2000);
  });

const dataDir = mkdtempSync(join(tmpdir(), 'sew-collab-link-'));
let service = null;
const localClients = [];

try {
  // ————————————————— 启动独立协作服务 —————————————————
  service = await startService(dataDir);
  const health = await createClient(service.origin).call('GET', '/health');
  record(
    'health：协议版本与就绪',
    health.status === 200 && health.data?.protocolVersion === PROTOCOL_VERSION,
    `HTTP ${health.status}, protocol ${health.data?.protocolVersion}`,
  );
  const mismatchedProtocol = await createClient(service.origin).call('POST', '/collab/v1/session', {
    body: { credentialId: 'unused', secret: 'x'.repeat(64), requestId: 'protocol-mismatch' },
    protocolVersion: PROTOCOL_VERSION + 1,
  });
  record(
    '负例·协议版本不一致：协作 API 写入口拒绝未支持版本',
    mismatchedProtocol.status === 409 &&
      mismatchedProtocol.error?.details?.reason === 'collab_protocol_mismatch',
    `HTTP ${mismatchedProtocol.status}`,
  );

  // Two isolated learning services use the real online route as their local
  // controlled-client proxy; only that proxy talks to the shared collab service.
  const claimA = provisionClaim(dataDir, UID_A);
  const claimB = provisionClaim(dataDir, UID_B);
  const claimC = provisionClaim(dataDir, UID_C);
  const localClaimA = provisionClaim(dataDir, LOCAL_UID_A);
  const localClaimB = provisionClaim(dataDir, LOCAL_UID_B);
  const localA = await startLocalClient(
    join(dataDir, 'local-a', 'project'),
    join(dataDir, 'local-a', 'user'),
    service.origin,
    LOCAL_UID_A,
    localClaimA,
    '本地甲',
  );
  localClients.push(localA);
  const localB = await startLocalClient(
    join(dataDir, 'local-b', 'project'),
    join(dataDir, 'local-b', 'user'),
    service.origin,
    LOCAL_UID_B,
    localClaimB,
    '本地乙',
  );
  localClients.push(localB);
  const proxyA = createLocalProxyClient(localA.origin);
  const proxyB = createLocalProxyClient(localB.origin);
  const isolationOk =
    localA.projectId !== localB.projectId &&
    localA.uid !== localB.uid &&
    localA.projectId !== localB.uid &&
    localB.projectId !== localA.uid &&
    localA.origin !== localB.origin &&
    localA.lessonId !== localB.lessonId;
  record(
    '本地代理：两个真实 route 进程使用隔离项目/用户目录与独立身份',
    isolationOk,
    `projectDistinct=${localA.projectId !== localB.projectId}, identityDistinct=${localA.uid !== localB.uid}`,
  );

  const localEnableA = await proxyA.command('enable', { requestId: 'local-enable-a' });
  const localEnableB = await proxyB.command('enable', { requestId: 'local-enable-b' });
  const enabledViewA = await proxyA.view();
  const enabledViewB = await proxyB.view();
  record(
    '本地代理：两端 enable 后均通过本人认证',
    localEnableA.ok &&
      localEnableB.ok &&
      enabledViewA.data?.view?.online?.authenticated === true &&
      enabledViewB.data?.view?.online?.authenticated === true &&
      enabledViewA.data.view.online.registration?.uid === localA.uid &&
      enabledViewB.data.view.online.registration?.uid === localB.uid,
  );

  const localRoom = 'room_local_proxy_link';
  const localInvite = await proxyA.command('invite', {
    roomId: localRoom,
    inviteeUid: localB.uid,
    lessonId: localA.lessonId,
    lessonVersion: localA.lessonVersion,
    snapshotDigest: localA.snapshotDigest,
    requestId: 'local-invite-a-b',
  });
  const localInviteView = await proxyA.view(localRoom);
  const invitationIdLocal = localInviteView.data?.view?.invitations?.find(
    (item) => item.roomId === localRoom,
  )?.invitationId;
  record(
    '本地代理：A 经受控路由发布冻结快照并邀请 B',
    localInvite.ok &&
      Boolean(invitationIdLocal) &&
      localInviteView.data?.view?.online?.authenticated === true,
    `HTTP ${localInvite.status}, reason=${localInvite.error?.details?.reason ?? ''}, code=${localInvite.error?.code ?? ''}, room=${Boolean(invitationIdLocal)}`,
  );

  const localAccept = await proxyB.command('decide', {
    invitationId: invitationIdLocal,
    decision: 'accepted',
    requestId: 'local-accept-b',
  });
  await proxyA.command('readiness', {
    roomId: localRoom,
    readiness: 'ready',
    requestId: 'local-ready-a',
  });
  await proxyB.command('readiness', {
    roomId: localRoom,
    readiness: 'ready',
    requestId: 'local-ready-b',
  });
  const localStarted = await proxyA.command('start', {
    roomId: localRoom,
    requestId: 'local-start-a',
  });
  const localViewA = await proxyA.view(localRoom);
  const localViewB = await proxyB.view(localRoom);
  record(
    '本地代理：B 接受、双方准备、房主开始，双方读回同一快照',
    localAccept.ok &&
      localStarted.ok &&
      localViewA.data?.view?.room?.status === 'active' &&
      localViewB.data?.view?.room?.status === 'active' &&
      localViewA.data?.view?.snapshot?.snapshotDigest === localA.snapshotDigest &&
      localViewB.data?.view?.snapshot?.snapshotDigest === localA.snapshotDigest &&
      JSON.stringify(localViewA.data?.view?.snapshot?.snapshot) ===
        JSON.stringify(localViewB.data?.view?.snapshot?.snapshot),
  );
  const localSnapshotText = JSON.stringify(localViewB.data?.view?.snapshot?.snapshot);
  record(
    '本地代理：共享投影不含答案与评分私有数据',
    !localSnapshotText.includes('private-answer-fixture') &&
      !localSnapshotText.includes('private-rubric-fixture') &&
      !localSnapshotText.includes('private-score-fixture'),
  );

  const localMessageA = await proxyA.command('message', {
    roomId: localRoom,
    body: '本地代理甲消息',
    requestId: 'local-msg-a',
  });
  const localMessageB = await proxyB.command('message', {
    roomId: localRoom,
    body: '本地代理乙消息',
    requestId: 'local-msg-b',
  });
  const localRetry = await proxyA.command('message', {
    roomId: localRoom,
    body: '本地代理甲消息',
    requestId: 'local-msg-a',
  });
  const localMessages = await proxyB.view(localRoom);
  record(
    '本地代理：双向消息与原 requestId 重试保持幂等',
    localMessageA.ok &&
      localMessageB.ok &&
      localRetry.ok &&
      localRetry.data?.deduplicated === true &&
      localMessages.data?.view?.messages?.messages?.length === 2,
  );

  const localScene = await proxyA.command('scene', {
    roomId: localRoom,
    sceneId: localA.scenes?.[1]?.sceneId ?? 'scene-2',
    expectedRevision: localViewA.data?.view?.room?.revision,
    expectedSeq: (localMessages.data?.view?.events?.tailSeq ?? 0) + 1,
    eventId: 'local-event-scene-1',
    requestId: 'local-scene-1',
  });
  const localSceneView = await proxyB.view(localRoom);
  record(
    '本地代理：结构化场景推进由 B 读回',
    localScene.ok &&
      localSceneView.data?.view?.room?.currentSceneId ===
        (localA.scenes?.[1]?.sceneId ?? 'scene-2'),
    `HTTP ${localScene.status}, reason=${localScene.error?.details?.reason ?? ''}, expectedRevision=${localViewA.data?.view?.room?.revision}, expectedSeq=${(localMessages.data?.view?.events?.tailSeq ?? 0) + 1}, tail=${localMessages.data?.view?.events?.tailSeq}`,
  );

  // Exercise the actual controlled local route for reviewed public teaching and
  // a board action. The service must resolve statement text from the frozen
  // snapshot; the browser command only supplies its stable statement ID.
  const localTeachingBefore = await proxyA.view(localRoom);
  const localShared = localTeachingBefore.data?.view?.snapshot?.snapshot;
  const localCurrentSceneId = localTeachingBefore.data?.view?.room?.currentSceneId;
  const localCurrentScene = localShared?.scenes?.find(
    (item) => item.sceneId === localCurrentSceneId,
  );
  const localSceneKnowledge =
    localShared?.sceneSources?.find((item) => item.sceneId === localCurrentSceneId)?.knowledgeIds ??
    [];
  const localStatement = localShared?.evidence?.statements?.find(
    (item) =>
      localSceneKnowledge.includes(item.knowledgeId) &&
      localA.publicStatements?.some(
        (fixtureStatement) =>
          fixtureStatement.statementId === item.statementId &&
          fixtureStatement.knowledgeId === item.knowledgeId,
      ),
  );
  const localPublicElement =
    localCurrentScene?.type === 'slide' ? localCurrentScene.elements[0] : null;
  const localTeachingState = localTeachingBefore.data?.view?.teaching;
  const localSpeakIntent = {
    roomId: localRoom,
    sceneId: localCurrentSceneId,
    expectedRevision: localTeachingState?.roomRevision,
    expectedSeq: (localTeachingState?.tailSeq ?? 0) + 1,
    eventId: 'local-teaching-speak-1',
    requestId: 'local-teaching-speak-1',
    operation: { kind: 'speak', statementId: localStatement?.statementId ?? 'missing' },
  };
  const localSpeak = await proxyA.command('teaching', localSpeakIntent);
  const localTeachingB = await proxyB.view(localRoom);
  const localSpeakRetry = await proxyA.command('teaching', localSpeakIntent);
  const localTeachingAfterRetry = await proxyA.view(localRoom);
  record(
    '本地代理：冻结陈述按 ID 公共发言、双端读回且原请求重试不重复',
    Boolean(localStatement) &&
      localSpeak.ok &&
      localSpeak.data?.view?.teaching?.state?.outputs?.length === 1 &&
      localSpeak.data?.view?.teaching?.state?.outputs?.[0]?.body === localStatement?.text &&
      localSpeak.data?.view?.teaching?.state?.outputs?.[0]?.conditions ===
        localStatement?.conditions &&
      JSON.stringify(localTeachingB.data?.view?.teaching?.state) ===
        JSON.stringify(localSpeak.data?.view?.teaching?.state) &&
      localSpeakRetry.ok &&
      localSpeakRetry.data?.deduplicated === true &&
      localTeachingAfterRetry.data?.view?.teaching?.state?.outputs?.length === 1,
    `statement=${Boolean(localStatement)}, HTTP ${localSpeak.status}, retryDedup=${localSpeakRetry.data?.deduplicated}`,
  );

  const localFocus = await proxyA.command('teaching', {
    roomId: localRoom,
    sceneId: localCurrentSceneId,
    expectedRevision: localTeachingAfterRetry.data?.view?.teaching?.roomRevision,
    expectedSeq: (localTeachingAfterRetry.data?.view?.teaching?.tailSeq ?? 0) + 1,
    eventId: 'local-teaching-focus-1',
    requestId: 'local-teaching-focus-1',
    operation: { kind: 'focus', elementId: localPublicElement?.elementId ?? 'missing' },
  });
  const localFocusB = await proxyB.view(localRoom);
  record(
    '本地代理：公共白板 focus 经受控路由后由 B 读回',
    Boolean(localPublicElement) &&
      localA.sceneElements?.some(
        (fixtureScene) =>
          fixtureScene.sceneId === localCurrentSceneId &&
          fixtureScene.elementIds.includes(localPublicElement.elementId),
      ) &&
      localFocus.ok &&
      localFocus.data?.view?.teaching?.state?.board?.focusElementId ===
        localPublicElement?.elementId &&
      localFocusB.data?.view?.teaching?.state?.board?.focusElementId ===
        localPublicElement?.elementId,
    `HTTP ${localFocus.status}, reason=${localFocus.error?.details?.reason ?? ''}`,
  );
  const localFocusActionId = localFocus.data?.view?.teaching?.state?.board?.history?.actions?.find(
    (item) => item.kind === 'focus' && item.elementId === localPublicElement?.elementId,
  )?.eventId;
  const localUndoView = await proxyA.view(localRoom);
  const localUndoInput = {
    roomId: localRoom,
    sceneId: localUndoView.data?.view?.teaching?.state?.sceneId,
    expectedRevision: localUndoView.data?.view?.teaching?.roomRevision,
    expectedSeq: (localUndoView.data?.view?.teaching?.tailSeq ?? 0) + 1,
    eventId: 'local-teaching-undo-focus-1',
    requestId: 'local-teaching-undo-focus-1',
    operation: { kind: 'undo-board', actionEventId: localFocusActionId ?? 'missing' },
  };
  const localUndo = await proxyA.command('teaching', localUndoInput);
  const localUndoRetry = await proxyA.command('teaching', localUndoInput);
  const localUndoB = await proxyB.view(localRoom);
  const localReplayView = await proxyA.view(localRoom);
  const localReplayInput = {
    roomId: localRoom,
    sceneId: localReplayView.data?.view?.teaching?.state?.sceneId,
    expectedRevision: localReplayView.data?.view?.teaching?.roomRevision,
    expectedSeq: (localReplayView.data?.view?.teaching?.tailSeq ?? 0) + 1,
    eventId: 'local-teaching-replay-focus-1',
    requestId: 'local-teaching-replay-focus-1',
    operation: { kind: 'replay-board', actionEventId: localFocusActionId ?? 'missing' },
  };
  const localReplay = await proxyA.command('teaching', localReplayInput);
  const localReplayB = await proxyB.view(localRoom);
  record(
    '本地代理：undo/replay 穿过本地合同与 outbox，双端状态相同且原请求重试幂等',
    Boolean(localFocusActionId) &&
      localUndo.ok &&
      localUndo.data?.view?.teaching?.state?.board?.focusElementId === null &&
      localUndoRetry.ok &&
      localUndoRetry.data?.deduplicated === true &&
      localUndoB.data?.view?.teaching?.state?.board?.focusElementId === null &&
      localReplay.ok &&
      localReplay.data?.view?.teaching?.state?.board?.focusElementId ===
        localPublicElement?.elementId &&
      localReplayB.data?.view?.teaching?.state?.board?.focusElementId ===
        localPublicElement?.elementId,
    `undo=${localUndo.status}, retry=${localUndoRetry.data?.deduplicated}, replay=${localReplay.status}`,
  );

  const clientA = createClient(service.origin);
  const clientB = createClient(service.origin);
  const clientC = createClient(service.origin);
  let teachingCommandNumber = 0;
  const submitTeaching = async (client, token, uid, operation, label) => {
    const current = await client.teaching(token, ROOM);
    const tailSeq = current.data?.tailSeq ?? 0;
    teachingCommandNumber += 1;
    const input = {
      roomId: ROOM,
      actorUid: uid,
      sceneId: current.data?.state?.sceneId ?? 'scene_2',
      expectedRevision: current.data?.roomRevision,
      expectedSeq: tailSeq + 1,
      eventId: `evt-teaching-${label}-${teachingCommandNumber}`,
      requestId: `teaching-${label}-${teachingCommandNumber}`,
      operation,
    };
    return { current, input, result: await client.applyTeaching(token, input) };
  };

  // ————————————————— 在线登记与认证 —————————————————
  const regA = await clientA.register(UID_A, '甲', 'cred_a', SECRET_A, 'reg-a', claimA);
  const regB = await clientB.register(UID_B, '乙', 'cred_b', SECRET_B, 'reg-b', claimB);
  const regC = await clientC.register(UID_C, '丙', 'cred_c', SECRET_C, 'reg-c', claimC);
  record(
    '在线登记：authority=online 且返回公开句柄',
    regA.ok && regA.data?.registration?.authority === 'online' && regB.ok && regC.ok,
    `A=${regA.data?.registration?.authority}`,
  );
  // 冒充：用错误秘密认证必须失败。
  const forged = await clientA.authenticate('cred_a', 'e'.repeat(64));
  record(
    '认证：错误秘密被拒',
    forged.status === 403 && forged.error?.details?.reason === 'collab_credential_invalid',
  );

  const sessionA = await clientA.authenticate('cred_a', SECRET_A);
  const sessionB = await clientB.authenticate('cred_b', SECRET_B);
  const sessionC = await clientC.authenticate('cred_c', SECRET_C);
  const tokenA = sessionA.data?.session?.token;
  const tokenB = sessionB.data?.session?.token;
  const tokenC = sessionC.data?.session?.token;
  record('认证：三方各自换取会话令牌', Boolean(tokenA && tokenB && tokenC));

  const expiredInvitationId = createHistoricalExpiredInvitation(dataDir);
  const expiredReadback = await clientC.listInvitations(tokenC);
  const expiredAccept = await clientC.decide(tokenC, {
    invitationId: expiredInvitationId,
    actorUid: UID_C,
    decision: 'accepted',
    requestId: 'decide-expired',
  });
  const expiredRevoke = await clientA.call('POST', '/collab/v1/invitations', {
    token: tokenA,
    body: {
      action: 'revoke',
      invitationId: expiredInvitationId,
      actorUid: UID_A,
      requestId: 'revoke-expired',
    },
  });
  const expiredRoom = await clientA.room(tokenA, 'room_expired_link');
  const expiredMessages = await clientA.messages(tokenA, 'room_expired_link', 0);
  record(
    '邀请过期：真实服务读回 expired，accept/revoke 均拒绝且不建房/消息',
    expiredReadback.data?.invitations?.some(
      (item) => item.invitationId === expiredInvitationId && item.status === 'expired',
    ) &&
      expiredAccept.status === 409 &&
      expiredAccept.error?.details?.reason === 'invitation_expired' &&
      expiredRevoke.status === 409 &&
      expiredRevoke.error?.details?.reason === 'invitation_already_decided' &&
      expiredRevoke.error?.details?.status === 'expired' &&
      expiredRoom.ok &&
      expiredRoom.data?.room === null &&
      expiredRoom.data?.members?.length === 0 &&
      expiredMessages.ok &&
      expiredMessages.data?.messages?.length === 0,
    `accept=${expiredAccept.status}/${expiredAccept.error?.details?.reason}, revoke=${expiredRevoke.status}/${expiredRevoke.error?.details?.reason}`,
  );

  const declinedInvite = await clientA.invite(tokenA, {
    roomId: 'room_declined_link',
    inviterUid: UID_A,
    inviteeUid: UID_C,
    lessonId: 'lesson_1',
    lessonVersion: 1,
    snapshotDigest: DIGEST,
    requestId: 'invite-decline',
  });
  const cInvitations = await clientC.listInvitations(tokenC);
  const declineId = cInvitations.data?.invitations?.find(
    (item) => item.roomId === 'room_declined_link',
  )?.invitationId;
  const declined = await clientC.decide(tokenC, {
    invitationId: declineId,
    actorUid: UID_C,
    decision: 'rejected',
    requestId: 'decide-decline',
  });
  const declinedReadback = await clientA.listInvitations(tokenA);
  record(
    '邀请拒绝：受邀本人拒绝后双方读回 rejected',
    declinedInvite.ok &&
      declined.ok &&
      declinedReadback.data?.invitations?.some(
        (item) => item.invitationId === declineId && item.status === 'rejected',
      ),
  );

  const cancelledInvite = await clientA.invite(tokenA, {
    roomId: 'room_cancelled_link',
    inviterUid: UID_A,
    inviteeUid: UID_C,
    lessonId: 'lesson_1',
    lessonVersion: 1,
    snapshotDigest: DIGEST,
    requestId: 'invite-cancel',
  });
  const cancelId = cancelledInvite.data?.invitation?.invitationId;
  const cancelled = await clientA.call('POST', '/collab/v1/invitations', {
    token: tokenA,
    body: { action: 'revoke', invitationId: cancelId, actorUid: UID_A, requestId: 'revoke-cancel' },
  });
  const cancelledReadback = await clientC.listInvitations(tokenC);
  record(
    '邀请取消：发起人撤销后受邀人读回 revoked',
    cancelledInvite.ok &&
      cancelled.ok &&
      cancelledReadback.data?.invitations?.some(
        (item) => item.invitationId === cancelId && item.status === 'revoked',
      ),
  );

  // ————————————————— 邀请 → 接受 → 双人准备 → start —————————————————
  const invited = await clientA.invite(tokenA, {
    roomId: ROOM,
    inviterUid: UID_A,
    inviteeUid: UID_B,
    lessonId: 'lesson_1',
    lessonVersion: 1,
    snapshotDigest: DIGEST,
    requestId: 'inv-1',
  });
  record('邀请：A 发起给 B', invited.ok && invited.data?.invitation?.status === 'pending');

  const bInvitations = await clientB.listInvitations(tokenB);
  const invitationId = bInvitations.data?.invitations?.[0]?.invitationId;
  const accepted = await clientB.decide(tokenB, {
    invitationId,
    actorUid: UID_B,
    decision: 'accepted',
    requestId: 'acc-1',
  });
  record('邀请：B 接受并成为成员', accepted.ok && accepted.data?.member?.uid === UID_B);

  await clientA.readiness(tokenA, {
    roomId: ROOM,
    uid: UID_A,
    readiness: 'ready',
    requestId: 'r-a',
  });
  await clientB.readiness(tokenB, {
    roomId: ROOM,
    uid: UID_B,
    readiness: 'ready',
    requestId: 'r-b',
  });
  const started = await clientA.start(tokenA, {
    roomId: ROOM,
    actorUid: UID_A,
    requestId: 'start-1',
  });
  record(
    '开始共同课堂：双人 ready 后房主 start → active',
    started.ok && started.data?.room?.status === 'active',
  );

  // ————————————————— 同一共享快照 —————————————————
  const uploaded = await clientA.snapshotUpload(tokenA, {
    roomId: ROOM,
    actorUid: UID_A,
    snapshot: snapshot(),
    snapshotDigest: DIGEST,
    requestId: 'snap-1',
  });
  const viewA = await clientA.snapshot(tokenA, ROOM);
  const viewB = await clientB.snapshot(tokenB, ROOM);
  record(
    '共享快照：两端读回同一摘要与同一投影',
    uploaded.ok &&
      viewA.data?.snapshotDigest === DIGEST &&
      viewB.data?.snapshotDigest === viewA.data?.snapshotDigest &&
      JSON.stringify(viewA.data?.snapshot) === JSON.stringify(viewB.data?.snapshot),
  );
  record(
    '隐私投影：共享快照不含答案/正确顺序/评分依据',
    !JSON.stringify(viewB.data?.snapshot).match(/correctOrder|"answer"|"analysis"|"points"/),
  );

  // ————————————————— 双向消息 —————————————————
  const m1 = await clientA.message(tokenA, {
    roomId: ROOM,
    senderUid: UID_A,
    senderType: 'human_learner',
    body: '这一步我算出来是增函数。',
    requestId: 'msg-a-1',
  });
  const m2 = await clientB.message(tokenB, {
    roomId: ROOM,
    senderUid: UID_B,
    senderType: 'human_learner',
    body: '我同意，条件也满足。',
    requestId: 'msg-b-1',
  });
  const bothMessages = await clientA.messages(tokenA, ROOM, 0);
  record(
    '双向消息：两端可发，A 读回两条且序号单调',
    m1.ok &&
      m2.ok &&
      bothMessages.data?.messages?.length === 2 &&
      bothMessages.data.messages[1].seq === 2,
  );

  // 丢失响应原 requestId 重试：不产生第二条消息。
  const retryMessage = await clientA.message(tokenA, {
    roomId: ROOM,
    senderUid: UID_A,
    senderType: 'human_learner',
    body: '这一步我算出来是增函数。',
    requestId: 'msg-a-1',
  });
  const afterRetry = await clientA.messages(tokenA, ROOM, 0);
  record(
    '丢失响应重试：原 requestId 重发不重复计数',
    retryMessage.ok &&
      retryMessage.data?.deduplicated === true &&
      afterRetry.data?.messages?.length === 2,
    `dedup=${retryMessage.data?.deduplicated}, count=${afterRetry.data?.messages?.length}`,
  );

  // ————————————————— 结构化场景推进 —————————————————
  const roomBefore = await clientA.room(tokenA, ROOM);
  const sceneRevision = roomBefore.data?.room?.revision;
  const synced = await clientA.sceneSync(tokenA, {
    roomId: ROOM,
    actorUid: UID_A,
    sceneId: 'scene_2',
    lessonId: 'lesson_1',
    lessonVersion: 1,
    expectedRevision: sceneRevision,
    expectedSeq: 1,
    eventId: 'evt-scene-1',
    requestId: 'sync-1',
  });
  const roomAfter = await clientB.room(tokenB, ROOM);
  record(
    '场景推进：房主原子推进到下一场景，B 读回同一场景与推进后的版本',
    synced.ok &&
      synced.data?.room?.currentSceneId === 'scene_2' &&
      synced.data?.event?.kind === 'scene_changed' &&
      roomAfter.data?.room?.currentSceneId === 'scene_2' &&
      roomAfter.data?.room?.revision === sceneRevision + 1,
  );

  // ————————————————— 公共教师/白板/wait 闭环 —————————————————
  const teachingStart = await clientA.teaching(tokenA, ROOM);
  const speak = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'speak', statementId: 'statement_k1_scene2' },
    'speak',
  );
  const speakRetry = await clientA.applyTeaching(tokenA, speak.input);
  const teachingFromB = await clientB.teaching(tokenB, ROOM);
  record(
    '公共教师输出：冻结陈述按 statementId 发布，双端读回且重试不重复',
    teachingStart.ok &&
      speak.result.ok &&
      speak.result.data?.state?.outputs?.length === 1 &&
      speak.result.data.state.outputs[0]?.statementId === 'statement_k1_scene2' &&
      speak.result.data.state.outputs[0]?.body === snapshot().evidence.statements[0].text &&
      speak.result.data.state.outputs[0]?.conditions ===
        snapshot().evidence.statements[0].conditions &&
      speak.result.data.state.outputs[0]?.source === 'reviewed_statement' &&
      speakRetry.ok &&
      speakRetry.data?.deduplicated === true &&
      speakRetry.data?.event?.seq === speak.result.data.event.seq &&
      teachingFromB.data?.tailSeq === speak.result.data?.event?.seq &&
      teachingFromB.data?.roomRevision === speak.result.data?.roomRevision &&
      JSON.stringify(teachingFromB.data?.state) === JSON.stringify(speak.result.data?.state),
    `HTTP ${speak.result.status}, dedup=${speakRetry.data?.deduplicated}, source=${speak.result.data?.state?.outputs?.[0]?.source}`,
  );

  const arbitraryTeacherText = await clientA.applyTeaching(tokenA, {
    ...speak.input,
    eventId: 'evt-teaching-arbitrary-text',
    requestId: 'teaching-arbitrary-text',
    operation: {
      kind: 'speak',
      statementId: 'statement_k1_scene2',
      body: '客户端提交的任意正文',
    },
  });
  const unknownStatement = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'speak', statementId: 'statement_k2_scene1' },
    'statement-from-other-scene',
  );
  record(
    '负例·教师输出：拒绝客户端任意正文与非当前场景 knowledgeId 的陈述',
    arbitraryTeacherText.status === 400 &&
      unknownStatement.result.status === 400 &&
      unknownStatement.result.error?.details?.reason === 'collab_statement_not_in_scene',
    `body=${arbitraryTeacherText.status}, statement=${unknownStatement.result.status}/${unknownStatement.result.error?.details?.reason}`,
  );

  const focused = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'focus', elementId: 'e2' },
    'focus',
  );
  const focusedFromB = await clientB.teaching(tokenB, ROOM);
  const lasered = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'laser', elementId: 'e2' },
    'laser',
  );
  const laseredFromB = await clientB.teaching(tokenB, ROOM);
  const invalidElement = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'focus', elementId: 'element_not_in_current_scene' },
    'invalid-element',
  );
  record(
    '公共白板：focus/laser 绑定冻结当前场景真实元素并由 B 读回',
    focused.result.ok &&
      focused.result.data?.state?.board?.focusElementId === 'e2' &&
      focusedFromB.data?.state?.board?.focusElementId === 'e2' &&
      lasered.result.ok &&
      lasered.result.data?.state?.board?.laserElementId === 'e2' &&
      laseredFromB.data?.state?.board?.laserElementId === 'e2' &&
      invalidElement.result.status === 400 &&
      invalidElement.result.error?.details?.reason === 'collab_element_not_in_scene',
    `focus=${focused.result.status}, laser=${lasered.result.status}, invalid=${invalidElement.result.status}/${invalidElement.result.error?.details?.reason}`,
  );

  const laserActionEventId = lasered.result.data?.event?.eventId;
  const laserUndone = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'undo-board', actionEventId: laserActionEventId },
    'undo-laser',
  );
  const laserUndoRetry = await clientA.applyTeaching(tokenA, laserUndone.input);
  const laserUndoFromB = await clientB.teaching(tokenB, ROOM);
  const laserUndoTwice = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'undo-board', actionEventId: laserActionEventId },
    'undo-laser-twice',
  );
  record(
    '公共白板撤销：指定 laser 动作只翻生效位，双端读回，原请求重试不重复',
    laserUndone.result.ok &&
      laserUndone.result.data?.state?.board?.focusElementId === 'e2' &&
      laserUndone.result.data?.state?.board?.laserElementId === null &&
      laserUndone.result.data?.state?.board?.history?.actions?.find(
        (item) => item.eventId === laserActionEventId,
      )?.applied === false &&
      JSON.stringify(laserUndoFromB.data?.state) ===
        JSON.stringify(laserUndone.result.data?.state) &&
      laserUndoRetry.ok &&
      laserUndoRetry.data?.deduplicated === true &&
      laserUndoRetry.data?.event?.seq === laserUndone.result.data?.event?.seq &&
      laserUndoTwice.result.status === 409 &&
      laserUndoTwice.result.error?.details?.reason === 'collab_board_action_already_undone',
    `undo=${laserUndone.result.status}, retryDedup=${laserUndoRetry.data?.deduplicated}, second=${laserUndoTwice.result.status}/${laserUndoTwice.result.error?.details?.reason}`,
  );

  const laserReplayed = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'replay-board', actionEventId: laserActionEventId },
    'replay-laser',
  );
  const laserReplayFromB = await clientB.teaching(tokenB, ROOM);
  const laserReplayTwice = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'replay-board', actionEventId: laserActionEventId },
    'replay-laser-twice',
  );
  const focusActionEventId = focused.result.data?.event?.eventId;
  const focusUndone = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'undo-board', actionEventId: focusActionEventId },
    'undo-focus',
  );
  const focusReplayed = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'replay-board', actionEventId: focusActionEventId },
    'replay-focus',
  );
  const boardAfterReplay = await clientA.teaching(tokenA, ROOM);
  const missingBoardAction = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'undo-board', actionEventId: 'event_not_a_board_action' },
    'unknown-board-action',
  );
  record(
    '公共白板重放：原序恢复 focus/laser，拒绝重复 replay 与未知动作',
    laserReplayed.result.ok &&
      laserReplayed.result.data?.state?.board?.laserElementId === 'e2' &&
      laserReplayed.result.data?.state?.board?.history?.actions?.find(
        (item) => item.eventId === laserActionEventId,
      )?.applied === true &&
      JSON.stringify(laserReplayFromB.data?.state) ===
        JSON.stringify(laserReplayed.result.data?.state) &&
      laserReplayTwice.result.status === 409 &&
      laserReplayTwice.result.error?.details?.reason === 'collab_board_action_already_applied' &&
      focusUndone.result.ok &&
      focusUndone.result.data?.state?.board?.focusElementId === null &&
      focusReplayed.result.ok &&
      focusReplayed.result.data?.state?.board?.focusElementId === 'e2' &&
      boardAfterReplay.data?.state?.board?.focusElementId === 'e2' &&
      missingBoardAction.result.status === 409 &&
      missingBoardAction.result.error?.details?.reason === 'collab_board_action_not_found',
    `laser replay=${laserReplayed.result.status}, repeat=${laserReplayTwice.result.status}, focus replay=${focusReplayed.result.status}, unknown=${missingBoardAction.result.status}/${missingBoardAction.result.error?.details?.reason}`,
  );

  const written = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    {
      kind: 'write',
      statementId: 'statement_k1_scene2',
      content: { kind: 'text', text: '公共板书：一次函数 y=kx+b' },
    },
    'write-text',
  );
  const writtenFromB = await clientB.teaching(tokenB, ROOM);
  const writeActionEventId = written.result.data?.event?.eventId;
  const eraseUnknown = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'erase', actionEventId: 'event_not_written' },
    'erase-unknown',
  );
  const writeOffScene = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    {
      kind: 'write',
      statementId: 'statement_k2_scene1',
      content: { kind: 'text', text: '跨场景板书' },
    },
    'write-off-scene',
  );
  record(
    '公共白板内容：write 挂已审核陈述写入并由 B 读回，拒绝未知擦除目标与跨场景陈述',
    written.result.ok &&
      written.result.data?.state?.board?.contents?.length === 1 &&
      written.result.data.state.board.contents[0]?.statementId === 'statement_k1_scene2' &&
      written.result.data.state.board.contents[0]?.content?.kind === 'text' &&
      written.result.data.state.board.history?.actions?.find(
        (item) => item.eventId === writeActionEventId,
      )?.kind === 'write' &&
      JSON.stringify(writtenFromB.data?.state) === JSON.stringify(written.result.data?.state) &&
      eraseUnknown.result.status === 409 &&
      eraseUnknown.result.error?.details?.reason === 'collab_board_action_not_found' &&
      writeOffScene.result.status === 400 &&
      writeOffScene.result.error?.details?.reason === 'collab_statement_not_in_scene',
    `write=${written.result.status}, contents=${written.result.data?.state?.board?.contents?.length}, eraseUnknown=${eraseUnknown.result.status}/${eraseUnknown.result.error?.details?.reason}, offScene=${writeOffScene.result.status}/${writeOffScene.result.error?.details?.reason}`,
  );

  const writeUndone = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'undo-board', actionEventId: writeActionEventId },
    'undo-write',
  );
  const writeReplayed = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'replay-board', actionEventId: writeActionEventId },
    'replay-write',
  );
  const writtenAgainFromB = await clientB.teaching(tokenB, ROOM);
  const erased = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'erase', actionEventId: writeActionEventId },
    'erase-text',
  );
  const eraseRetry = await clientA.applyTeaching(tokenA, erased.input);
  const erasedFromB = await clientB.teaching(tokenB, ROOM);
  record(
    '公共白板内容：撤销 write 使内容消失、重放按原序恢复、erase 移除内容且重试幂等，双端一致',
    writeUndone.result.ok &&
      writeUndone.result.data?.state?.board?.contents?.length === 0 &&
      writeReplayed.result.ok &&
      writeReplayed.result.data?.state?.board?.contents?.length === 1 &&
      writeReplayed.result.data.state.board.contents[0]?.eventId === writeActionEventId &&
      JSON.stringify(writtenAgainFromB.data?.state) ===
        JSON.stringify(writeReplayed.result.data?.state) &&
      erased.result.ok &&
      erased.result.data?.state?.board?.contents?.length === 0 &&
      erased.result.data.state.board.history?.actions?.find(
        (item) => item.eventId === erased.result.data.event.eventId,
      )?.targetEventId === writeActionEventId &&
      eraseRetry.ok &&
      eraseRetry.data?.deduplicated === true &&
      JSON.stringify(erasedFromB.data?.state) === JSON.stringify(erased.result.data?.state),
    `undo=${writeUndone.result.data?.state?.board?.contents?.length}, replay=${writeReplayed.result.data?.state?.board?.contents?.length}, erase=${erased.result.data?.state?.board?.contents?.length}, dedup=${eraseRetry.data?.deduplicated}`,
  );

  const peerUndo = await submitTeaching(
    clientB,
    tokenB,
    UID_B,
    { kind: 'undo-board', actionEventId: focusActionEventId },
    'peer-undo',
  );
  record(
    '负例·白板历史越权：受邀同学不能撤销房主共享动作',
    peerUndo.result.status === 403 &&
      peerUndo.result.error?.details?.reason === 'collab_teacher_owner_required',
    `HTTP ${peerUndo.result.status}, reason=${peerUndo.result.error?.details?.reason}`,
  );

  const firstWait = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'wait', targetUid: UID_B },
    'wait',
  );
  const waitEventId = firstWait.result.data?.state?.waiting?.waitEventId;
  const blockedSceneRoom = await clientA.room(tokenA, ROOM);
  const blockedScene = await clientA.sceneSync(tokenA, {
    roomId: ROOM,
    actorUid: UID_A,
    sceneId: 'scene_1',
    lessonId: 'lesson_1',
    lessonVersion: 1,
    expectedRevision: blockedSceneRoom.data?.room?.revision,
    expectedSeq: (firstWait.result.data?.event?.seq ?? 0) + 1,
    eventId: 'evt-scene-during-wait',
    requestId: 'sync-during-wait',
  });
  const blockedTeacher = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'speak', statementId: 'statement_k1_scene2' },
    'speak-during-wait',
  );
  const undoDuringWait = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'undo-board', actionEventId: focusActionEventId },
    'undo-during-wait',
  );
  const replayDuringWait = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'replay-board', actionEventId: laserActionEventId },
    'replay-during-wait',
  );
  const wrongUidAck = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'acknowledge', waitEventId },
    'wrong-uid-ack',
  );
  const prematureRelease = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'release-wait', waitEventId },
    'premature-release',
  );
  record(
    '等待门禁：场景推进/普通讲解被阻断，只有指定 UID 可确认且 release 要求确认',
    firstWait.result.ok &&
      Boolean(waitEventId) &&
      blockedScene.status === 409 &&
      blockedScene.error?.details?.reason === 'collab_scene_sync_waiting' &&
      blockedTeacher.result.status === 409 &&
      blockedTeacher.result.error?.details?.reason === 'collab_teaching_waiting' &&
      undoDuringWait.result.status === 409 &&
      undoDuringWait.result.error?.details?.reason === 'collab_teaching_waiting' &&
      replayDuringWait.result.status === 409 &&
      replayDuringWait.result.error?.details?.reason === 'collab_teaching_waiting' &&
      wrongUidAck.result.status === 403 &&
      wrongUidAck.result.error?.details?.reason === 'collab_wait_acknowledgement_denied' &&
      prematureRelease.result.status === 409 &&
      prematureRelease.result.error?.details?.reason === 'collab_wait_not_acknowledged',
    `scene=${blockedScene.status}/${blockedScene.error?.details?.reason}, speak=${blockedTeacher.result.status}/${blockedTeacher.result.error?.details?.reason}, undo=${undoDuringWait.result.status}, replay=${replayDuringWait.result.status}, wrongAck=${wrongUidAck.result.status}, release=${prematureRelease.result.status}`,
  );

  const clearedWhileWaiting = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'clear-board' },
    'clear-while-waiting',
  );
  const canceledWait = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'cancel-wait', waitEventId },
    'cancel-wait',
  );
  const secondWait = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'wait', targetUid: UID_B },
    'wait-acknowledged',
  );
  const secondWaitId = secondWait.result.data?.state?.waiting?.waitEventId;
  const acknowledged = await submitTeaching(
    clientB,
    tokenB,
    UID_B,
    { kind: 'acknowledge', waitEventId: secondWaitId },
    'acknowledge',
  );
  const released = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'release-wait', waitEventId: secondWaitId },
    'release-wait',
  );
  const clearActionEventId = clearedWhileWaiting.result.data?.event?.eventId;
  const undoClear = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'undo-board', actionEventId: clearActionEventId },
    'undo-clear',
  );
  const replayClear = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'replay-board', actionEventId: clearActionEventId },
    'replay-clear',
  );
  const finalTeachingA = await clientA.teaching(tokenA, ROOM);
  const finalTeachingB = await clientB.teaching(tokenB, ROOM);
  record(
    '等待收尾：等待中允许清板；房主可显式取消；目标本人确认后房主释放',
    clearedWhileWaiting.result.ok &&
      clearedWhileWaiting.result.data?.state?.board?.focusElementId === null &&
      clearedWhileWaiting.result.data?.state?.board?.laserElementId === null &&
      canceledWait.result.ok &&
      canceledWait.result.data?.state?.waiting === null &&
      secondWait.result.ok &&
      acknowledged.result.ok &&
      acknowledged.result.data?.state?.waiting?.acknowledged === true &&
      released.result.ok &&
      released.result.data?.state?.waiting === null &&
      undoClear.result.ok &&
      undoClear.result.data?.state?.board?.focusElementId === 'e2' &&
      undoClear.result.data?.state?.board?.laserElementId === 'e2' &&
      undoClear.result.data?.state?.board?.history?.actions?.find(
        (item) => item.eventId === clearActionEventId,
      )?.applied === false &&
      replayClear.result.ok &&
      replayClear.result.data?.state?.board?.focusElementId === null &&
      replayClear.result.data?.state?.board?.laserElementId === null &&
      replayClear.result.data?.state?.board?.history?.actions?.find(
        (item) => item.eventId === clearActionEventId,
      )?.applied === true &&
      JSON.stringify(finalTeachingA.data?.state) === JSON.stringify(finalTeachingB.data?.state) &&
      finalTeachingA.data?.roomRevision === finalTeachingB.data?.roomRevision &&
      finalTeachingA.data?.tailSeq === finalTeachingB.data?.tailSeq,
    `cancel=${canceledWait.result.status}, ack=${acknowledged.result.status}, release=${released.result.status}, undo/redo clear=${undoClear.result.status}/${replayClear.result.status}, tail=${finalTeachingA.data?.tailSeq}`,
  );

  const fakeTeacherEvent = await clientA.call('POST', '/collab/v1/events', {
    token: tokenA,
    body: {
      roomId: ROOM,
      eventId: 'evt-summary-teacher-output',
      kind: 'teacher_output',
      actorUid: UID_A,
      summary: '伪造的教师输出摘要',
      expectedSeq: (finalTeachingA.data?.tailSeq ?? 0) + 1,
      requestId: 'summary-teacher-output',
    },
  });
  const fakeBoardEvent = await clientA.call('POST', '/collab/v1/events', {
    token: tokenA,
    body: {
      roomId: ROOM,
      eventId: 'evt-summary-board-action',
      kind: 'board_action',
      actorUid: UID_A,
      summary: '伪造的白板动作摘要',
      expectedSeq: (finalTeachingA.data?.tailSeq ?? 0) + 1,
      requestId: 'summary-board-action',
    },
  });
  record(
    '负例·旧摘要入口：teacher_output/board_action 必须改走结构化 teaching 命令',
    fakeTeacherEvent.status === 400 &&
      fakeTeacherEvent.error?.details?.reason === 'collab_teaching_requires_structured_command' &&
      fakeBoardEvent.status === 400 &&
      fakeBoardEvent.error?.details?.reason === 'collab_teaching_requires_structured_command',
    `teacher=${fakeTeacherEvent.status}, board=${fakeBoardEvent.status}`,
  );

  await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'focus', elementId: 'e2' },
    'focus-before-scene',
  );
  await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'laser', elementId: 'e2' },
    'laser-before-scene',
  );
  const beforeTeachingSceneChange = await clientA.teaching(tokenA, ROOM);
  const beforeSceneChangeRoom = await clientA.room(tokenA, ROOM);
  const nextSharedScene = await clientA.sceneSync(tokenA, {
    roomId: ROOM,
    actorUid: UID_A,
    sceneId: 'scene_1',
    lessonId: 'lesson_1',
    lessonVersion: 1,
    expectedRevision: beforeSceneChangeRoom.data?.room?.revision,
    expectedSeq: (beforeTeachingSceneChange.data?.tailSeq ?? 0) + 1,
    eventId: 'evt-scene-after-teaching',
    requestId: 'sync-after-teaching',
  });
  const teachingAfterSceneChangeA = await clientA.teaching(tokenA, ROOM);
  const teachingAfterSceneChangeB = await clientB.teaching(tokenB, ROOM);
  record(
    '场景换页：教学状态切到新场景、清除白板指针并保留已发布陈述历史',
    nextSharedScene.ok &&
      teachingAfterSceneChangeA.ok &&
      teachingAfterSceneChangeA.data?.state?.sceneId === 'scene_1' &&
      teachingAfterSceneChangeA.data?.state?.board?.focusElementId === null &&
      teachingAfterSceneChangeA.data?.state?.board?.laserElementId === null &&
      teachingAfterSceneChangeA.data?.state?.outputs?.length === 1 &&
      teachingAfterSceneChangeA.data?.state?.outputs?.[0]?.statementId === 'statement_k1_scene2' &&
      JSON.stringify(teachingAfterSceneChangeA.data?.state) ===
        JSON.stringify(teachingAfterSceneChangeB.data?.state),
    `scene=${teachingAfterSceneChangeA.data?.state?.sceneId}, focus=${teachingAfterSceneChangeA.data?.state?.board?.focusElementId}, laser=${teachingAfterSceneChangeA.data?.state?.board?.laserElementId}, outputs=${teachingAfterSceneChangeA.data?.state?.outputs?.length}`,
  );

  const oldSceneUndo = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'undo-board', actionEventId: focusActionEventId },
    'old-scene-undo',
  );
  const freshSceneFocus = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'focus', elementId: 'e1' },
    'fresh-scene-focus',
  );
  const freshSceneLaser = await submitTeaching(
    clientA,
    tokenA,
    UID_A,
    { kind: 'laser', elementId: 'e1' },
    'fresh-scene-laser',
  );
  const boardHistoryBeforeRestart = await clientB.teaching(tokenB, ROOM);
  record(
    '场景历史隔离：旧场景动作不能撤销新场景白板；新场景动作形成独立可持久历史',
    oldSceneUndo.result.status === 409 &&
      oldSceneUndo.result.error?.details?.reason === 'collab_board_action_not_found' &&
      freshSceneFocus.result.ok &&
      freshSceneLaser.result.ok &&
      boardHistoryBeforeRestart.data?.state?.sceneId === 'scene_1' &&
      boardHistoryBeforeRestart.data?.state?.board?.history?.actions?.length === 2 &&
      JSON.stringify(boardHistoryBeforeRestart.data?.state) ===
        JSON.stringify(freshSceneLaser.result.data?.state),
    `old=${oldSceneUndo.result.status}/${oldSceneUndo.result.error?.details?.reason}, history=${boardHistoryBeforeRestart.data?.state?.board?.history?.actions?.length}`,
  );

  // ————————————————— 负例 —————————————————
  // 第三身份越权：非成员不能读房间。
  const outsiderRead = await clientC.room(tokenC, ROOM);
  record(
    '负例·第三身份越权：非成员读房间被拒',
    outsiderRead.status === 403 && outsiderRead.error?.details?.reason === 'not_room_member',
  );
  // 争抢房间：第三方不能借已有 roomId 邀请混入。
  const hijack = await clientC.invite(tokenC, {
    roomId: ROOM,
    inviterUid: UID_C,
    inviteeUid: UID_A,
    lessonId: 'lesson_1',
    lessonVersion: 1,
    snapshotDigest: DIGEST,
    requestId: 'hijack-1',
  });
  record(
    '负例·争抢房间：第三方借已有房间邀请被拒',
    hijack.status === 403 || hijack.status === 409,
    `HTTP ${hijack.status}`,
  );
  // 自报他人身份：B 用 A 的 UID 发言被拒。
  const forgedSender = await clientB.message(tokenB, {
    roomId: ROOM,
    senderUid: UID_A,
    senderType: 'human_learner',
    body: '我是甲。',
    requestId: 'forged-sender',
  });
  record(
    '负例·身份冒充：请求体自报他人 UID 被拒',
    forgedSender.status === 403 &&
      forgedSender.error?.details?.reason === 'collab_identity_mismatch',
  );
  // 游标越界。
  const ahead = await clientA.messages(tokenA, ROOM, 999);
  record(
    '负例·游标越界：afterSeq 超前被拒',
    ahead.status === 409 && ahead.error?.details?.reason === 'collab_cursor_ahead',
  );
  // 版本不一致：错误的房间版本推进被拒。
  const roomAtNegativeCases = await clientA.room(tokenA, ROOM);
  const currentTeachingBeforeNegative = await clientA.teaching(tokenA, ROOM);
  const negativeEventSeq = (currentTeachingBeforeNegative.data?.tailSeq ?? 0) + 1;
  const staleScene = await clientA.sceneSync(tokenA, {
    roomId: ROOM,
    actorUid: UID_A,
    sceneId: 'scene_2',
    lessonId: 'lesson_1',
    lessonVersion: 1,
    expectedRevision: (roomAtNegativeCases.data?.room?.revision ?? 1) - 1,
    expectedSeq: negativeEventSeq,
    eventId: 'evt-scene-stale',
    requestId: 'sync-stale',
  });
  record(
    '负例·版本不一致：过期房间版本推进被拒',
    staleScene.status === 409 &&
      staleScene.error?.details?.reason === 'collab_room_revision_mismatch',
  );
  // 非房主推进场景被拒。
  const peerScene = await clientB.sceneSync(tokenB, {
    roomId: ROOM,
    actorUid: UID_B,
    sceneId: 'scene_2',
    lessonId: 'lesson_1',
    lessonVersion: 1,
    expectedRevision: roomAtNegativeCases.data?.room?.revision,
    expectedSeq: negativeEventSeq,
    eventId: 'evt-scene-peer',
    requestId: 'sync-peer',
  });
  record(
    '负例·唯一教师执行权：受邀同学推进场景被拒',
    peerScene.status === 403 && peerScene.error?.details?.reason === 'only_owner_advances',
  );
  // 摘要事件不能冒充场景同步：kind=scene_changed 的普通事件追加被拒。
  const summaryScene = await clientA.call('POST', '/collab/v1/events', {
    token: tokenA,
    body: {
      roomId: ROOM,
      eventId: 'evt-summary-scene',
      kind: 'scene_changed',
      actorUid: UID_A,
      summary: '摘要说明',
      expectedSeq: negativeEventSeq,
      requestId: 'summary-scene',
    },
  });
  record(
    '负例·摘要冒充同步：scene_changed 普通事件被拒，只能走 scene-sync',
    summaryScene.status === 400 &&
      summaryScene.error?.details?.reason === 'collab_scene_requires_scene_sync',
  );

  // ————————————————— 断连重连 —————————————————
  // 客户端丢掉旧令牌（模拟断连）后重新认证，仍能读回房间与消息。
  const reconnect = await clientB.authenticate('cred_b', SECRET_B);
  const reconnectToken = reconnect.data?.session?.token;
  const reconnectedRoom = await clientB.room(reconnectToken, ROOM);
  const reconnectedMessages = await clientB.messages(reconnectToken, ROOM, 0);
  record(
    '断连重连：重新认证后读回同一房间与消息，无重复',
    reconnectedRoom.ok && reconnectedMessages.data?.messages?.length === 2,
  );

  // ————————————————— 已退出成员 —————————————————
  await clientB.readiness(tokenB, {
    roomId: ROOM,
    uid: UID_B,
    readiness: 'left',
    requestId: 'b-left',
  });
  const leftRead = await clientB.room(tokenB, ROOM);
  record(
    '负例·已退出成员：left 后失去读取权限',
    leftRead.status === 403 && leftRead.error?.details?.reason === 'not_room_member',
  );

  // ————————————————— 服务重启后读回 —————————————————
  await stopService(service.child);
  service = await startService(dataDir);
  const clientA2 = createClient(service.origin);
  const sessionA2 = await clientA2.authenticate('cred_a', SECRET_A);
  const tokenA2 = sessionA2.data?.session?.token;
  const afterRestart = await clientA2.room(tokenA2, ROOM);
  const messagesAfterRestart = await clientA2.messages(tokenA2, ROOM, 0);
  const teachingAfterRestart = await clientA2.teaching(tokenA2, ROOM);
  record(
    '服务重启读回：房间、消息与公共教师/白板状态持久化，凭据仍有效',
    afterRestart.ok &&
      messagesAfterRestart.data?.messages?.length === 2 &&
      teachingAfterRestart.ok &&
      teachingAfterRestart.data?.state?.sceneId === 'scene_1' &&
      teachingAfterRestart.data?.state?.outputs?.length === 1 &&
      teachingAfterRestart.data?.state?.board?.history?.actions?.length === 2 &&
      JSON.stringify(teachingAfterRestart.data?.state) ===
        JSON.stringify(boardHistoryBeforeRestart.data?.state) &&
      teachingAfterRestart.data?.roomRevision === boardHistoryBeforeRestart.data?.roomRevision &&
      teachingAfterRestart.data?.tailSeq === boardHistoryBeforeRestart.data?.tailSeq,
  );
  // 重启后事件序号继续单调；新场景没有旧白板历史，但已发布陈述历史仍保留。
  const restartScene = await clientA2.sceneSync(tokenA2, {
    roomId: ROOM,
    actorUid: UID_A,
    sceneId: 'scene_2',
    lessonId: 'lesson_1',
    lessonVersion: 1,
    expectedRevision: afterRestart.data?.room?.revision,
    expectedSeq: teachingAfterRestart.data?.tailSeq + 1,
    eventId: 'evt-scene-restart-2',
    requestId: 'sync-restart-2',
  });
  const teachingAfterRestartScene = await clientA2.teaching(tokenA2, ROOM);
  record(
    '服务重启后继续推进：事件序号接续，白板清空且公共陈述历史保留',
    restartScene.ok &&
      restartScene.data?.event?.seq === (teachingAfterRestart.data?.tailSeq ?? 0) + 1 &&
      teachingAfterRestartScene.data?.state?.sceneId === 'scene_2' &&
      teachingAfterRestartScene.data?.state?.board?.focusElementId === null &&
      teachingAfterRestartScene.data?.state?.board?.laserElementId === null &&
      (teachingAfterRestartScene.data?.state?.board?.history?.actions?.length ?? 0) === 0 &&
      teachingAfterRestartScene.data?.state?.outputs?.length === 1,
  );

  // ————————————————— 吊销失效既有会话 —————————————————
  const UID_D = 'uid_10000000-0000-4000-8000-000000000004';
  const SECRET_D = 'e'.repeat(64);
  await clientA2.register(UID_D, '丁', 'cred_d', SECRET_D, 'reg-d', provisionClaim(dataDir, UID_D));
  const sessionD = await clientA2.authenticate('cred_d', SECRET_D);
  const tokenD = sessionD.data?.session?.token;
  const beforeRevoke = await clientA2.call('GET', '/collab/v1/registrations/read', {
    token: tokenD,
  });
  const revoked = await clientA2.call('POST', '/collab/v1/credentials/revoke', {
    token: tokenD,
    body: { credentialId: 'cred_d', actorUid: UID_D, requestId: 'rev-d' },
  });
  const afterRevoke = await clientA2.call('GET', '/collab/v1/registrations/read', {
    token: tokenD,
  });
  record(
    '负例·吊销失效既有会话：吊销凭据后旧令牌立即不可用',
    beforeRevoke.ok && revoked.ok && afterRevoke.status === 403,
    `before=${beforeRevoke.status}, revoke=${revoked.status}, after=${afterRevoke.status}`,
  );
} catch (error) {
  record('双客户端链路执行', false, error instanceof Error ? error.message : String(error));
} finally {
  for (const client of localClients) await stopService(client.child);
  if (service) await stopService(service.child);
  rmSync(dataDir, { recursive: true, force: true });
}

const passed = results.filter((item) => item.ok).length;
if (process.exitCode !== 1) {
  console.log(`PASS collab two-client link completed（${passed}/${results.length} 项通过）`);
} else {
  console.error(`FAIL collab two-client link（${passed}/${results.length} 项通过）`);
}
