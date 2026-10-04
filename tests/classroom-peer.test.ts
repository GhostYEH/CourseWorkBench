import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StudyError,
  newId,
  classroomStateSchema,
  type PlanPayloadDto,
} from '@sew/study-contracts';
import { assertPeerTurnAllowed, peerTurnCeiling, shouldPeerSpeak, peerAttemptPartition, peerCapabilities } from '@sew/study-domain';
import { StudyStore, createNodeSqliteDriver, ensureProjectLayout, projectPaths } from '@sew/study-storage';
import { requestPeerTurn } from '../apps/learning/lib/server/classroom-peer';
import type { Session } from '../apps/learning/lib/server/service';

/**
 * AI 同学课堂运行（PEER-01）。
 *
 * 固定的是《规划书》6.4 / 6.6 对同学侧的可机械核对部分：
 * 0—2 名同学可开关、参与度只影响开口频率、用户优先（等待本人时不发言）、
 * 默认无白板写权与本人答题权、发言只进 simulation 分区、示例必须来自已审核内容、
 * 重复请求读回同一条发言且不重复计数。
 */

const expectCode = (action: () => unknown, code: string, reason?: string): void => {
  try {
    action();
  } catch (error) {
    expect((error as StudyError).code).toBe(code);
    if (reason !== undefined) expect((error as StudyError).details?.['reason']).toBe(reason);
    return;
  }
  throw new Error(`预期抛出 ${code}，但调用成功了`);
};

const SCENE = 'scene-1';

describe('AI 同学课堂运行', () => {
  let root: string;
  let store: StudyStore;
  let session: Session;
  let projectId: string;
  let bundleId = '';
  let statementId = '';
  let lessonId = '';
  let lessonVersion = 1;
  let peerId = '';

  const openSession = (sceneId = SCENE) => store.openClassroomSession({
    projectId, lessonId, stageId: null, learnerKey: 'sew:classroom:owner:v1', sceneId,
  });

  const reopen = (): void => {
    store.close();
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    session = { ...session, store };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-peer-'));
    ensureProjectLayout(root);
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    projectId = newId<'project'>('proj');
    store.createProject({ projectId, displayName: '数学', subject: '数学', dailyMinutes: 60 });
    const imported = store.importMaterial({
      projectId, displayName: '考纲.md', materialType: 'md',
      rawText: '本章要求理解增函数的定义。\n\n第二条范围说明。',
    });
    const materialId = imported.material.materialId;
    const proposal = store.createProposal({
      projectId, name: '增函数定义', concept: '区间内任取 x1 < x2 都有 f(x1) < f(x2)',
      conditions: '同一区间 D 内', scopeStatus: 'in_syllabus', prerequisites: [],
      evidence: [{ materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }],
      acceptance: '', priority: 'medium', proposedBy: 'user',
    });
    const knowledgeId = store.applyReview({
      proposalId: proposal.proposalId, decision: 'approved',
      expectedRevision: proposal.revision, semanticReviewed: true,
    }).knowledgePoint!.knowledgeId;
    store.savePlanVersion(projectId, 1, 'confirmed', {
      payloadVersion: 1, goal: '掌握本章', examDate: null, dailyMinutes: 60,
      tasks: [{ knowledgeId, name: '增函数定义', minutes: 30, acceptance: '', evidence: [{ materialId, segmentId: 'S001' }] }],
      gaps: [], basis: '测试计划', confirmedTaskKnowledgeIds: [knowledgeId],
    } satisfies PlanPayloadDto);
    const bundle = store.buildLessonBundle(projectId, [{ knowledgeId, text: '增函数的定义', conditions: '同一区间 D 内' }], []);
    bundleId = bundle.bundleId;
    statementId = bundle.bundle.statements[0]!.statementId;
    const lesson = store.createLessonDraft({
      projectId, lessonId: null, title: '函数单调性（第 1 课时）', bundleId,
      statementIds: bundle.bundle.statements.map((row) => row.statementId), questionIds: [],
    });
    lessonId = lesson.lessonId;
    lessonVersion = lesson.version;
    store.reviewLesson({ projectId, lessonId, version: lessonVersion, decision: 'approved', note: '按原文核对' });
    store.publishLesson({ projectId, lessonId, version: lessonVersion });
    peerId = store.createRoleProfile('peer', { name: '小问', persona: '爱提问', explanation: 'intuitive' }).profileId;
    session = {
      projectId, displayName: '数学', displayPath: root, generation: 1,
      store, openedAt: new Date().toISOString(), learnerUid: 'uid-test-1',
    };
  });

  afterEach(() => {
    try { store.close(); } catch { /* 已关闭 */ }
    rmSync(root, { recursive: true, force: true });
  });

  it('没有同学档案时不能开启同学，避免出现一个空开关', () => {
    const other = mkdtempSync(join(tmpdir(), 'sew-peer-empty-'));
    ensureProjectLayout(other);
    const empty = StudyStore.open({ file: projectPaths(other).databaseFile });
    const otherProject = newId<'project'>('proj');
    empty.createProject({ projectId: otherProject, displayName: '数学', subject: '数学', dailyMinutes: 60 });
    expectCode(
      () => empty.setClassroomPeers(otherProject, 'cls-missing', { enabled: true }),
      'NOT_FOUND',
    );
    empty.close();
    rmSync(other, { recursive: true, force: true });
  });

  it('开启同学要求存在同学档案；关闭同学不影响教师会话继续', () => {
    const opened = openSession();
    // 先删掉档案，验证「没有档案时开启」被拒，而不是得到一个空开关。
    store.deleteRoleProfile(peerId);
    expectCode(
      () => store.setClassroomPeers(projectId, opened.sessionId, { enabled: true, engagement: 'active' }),
      'INVALID_ARGUMENT',
      'no_peer_profile_configured',
    );
    expect(store.getClassroomSession(opened.sessionId, projectId)?.peersEnabled).toBe(false);
    peerId = store.createRoleProfile('peer', { name: '小问', persona: '爱提问', explanation: 'intuitive' }).profileId;
    const enabled = store.setClassroomPeers(projectId, opened.sessionId, { enabled: true, engagement: 'active' });
    expect(enabled.peersEnabled).toBe(true);
    expect(enabled.peersEngagement).toBe('active');
    const disabled = store.setClassroomPeers(projectId, opened.sessionId, { enabled: false });
    expect(disabled.peersEnabled).toBe(false);
    // 关闭同学后教师课堂仍然在进行中，仍可播放卡片。
    expect(store.getClassroomSession(opened.sessionId, projectId)?.status).toBe('in_class');
  });

  it('同学发言落在 simulation 分区并标注 peer_ai，且引用场景内已准入陈述', () => {
    const opened = openSession();
    store.setClassroomPeers(projectId, opened.sessionId, { enabled: true, engagement: 'active' });
    const turn = requestPeerTurn(session, {
      sessionId: opened.sessionId, roleProfileId: peerId, kind: 'question', requestId: 'peer-req-1',
    });
    expect(turn.actorType).toBe('peer_ai');
    expect(turn.partition).toBe('simulation');
    expect(turn.statementIds).toEqual([statementId]);
    expect(turn.text).toContain('模拟');
    expect(turn.peerName).toBe('小问');
    const state = store.classroomState(projectId, opened.sessionId);
    expect(classroomStateSchema.safeParse(state).success).toBe(true);
    expect(state.peerTurns).toHaveLength(1);
    // 同学发言不产生本人作答记录：分区隔离在存储层就已经分开。
    expect(store.listAttempts('real', 'formal')).toHaveLength(0);
    expect(store.listAttempts('simulation', 'formal')).toHaveLength(0);
  });

  it('参与度决定每轮开口上限，超过上限拒绝而不是静默丢弃', () => {
    const opened = openSession();
    store.setClassroomPeers(projectId, opened.sessionId, { enabled: true, engagement: 'quiet' });
    requestPeerTurn(session, { sessionId: opened.sessionId, roleProfileId: peerId, kind: 'question', requestId: 'q1' });
    expectCode(
      () => requestPeerTurn(session, { sessionId: opened.sessionId, roleProfileId: peerId, kind: 'question', requestId: 'q2' }),
      'BUDGET_EXCEEDED',
      'round_peer_turns',
    );
    expect(peerTurnCeiling('quiet')).toBe(1);
    expect(peerTurnCeiling('active')).toBe(2);
    // 切场景开启新一轮，轮内计数清零后同学又能开口。
    store.advanceClassroomScene(projectId, opened.sessionId, 'scene-2', 'advance-1');
    const afterSwitch = requestPeerTurn(session, { sessionId: opened.sessionId, roleProfileId: peerId, kind: 'question', requestId: 'q3' });
    expect(afterSwitch.sceneId).toBe('scene-2');
  });

  it('等待本人作答时同学不发言，作答归来后才恢复', () => {
    const opened = openSession();
    store.setClassroomPeers(projectId, opened.sessionId, { enabled: true, engagement: 'active' });
    store.handBackToLearner(projectId, opened.sessionId, '等本人作答');
    expectCode(
      () => requestPeerTurn(session, { sessionId: opened.sessionId, roleProfileId: peerId, kind: 'question', requestId: 'await-1' }),
      'CLASSROOM_AWAITING_LEARNER',
    );
    expect(shouldPeerSpeak({ sessionStatus: 'awaiting_learner', peersEnabled: true, engagement: 'active', roundPeerTurns: 0 })).toBe(false);
    store.markLearnerAnswered(projectId, opened.sessionId);
    const turn = requestPeerTurn(session, { sessionId: opened.sessionId, roleProfileId: peerId, kind: 'discussion', requestId: 'await-2' });
    expect(turn.roundIndex).toBe(2);
  });

  it('关闭同学后同学发言被拒，教师课堂照常', () => {
    const opened = openSession();
    store.setClassroomPeers(projectId, opened.sessionId, { enabled: true, engagement: 'active' });
    store.setClassroomPeers(projectId, opened.sessionId, { enabled: false });
    expectCode(
      () => requestPeerTurn(session, { sessionId: opened.sessionId, roleProfileId: peerId, kind: 'question', requestId: 'off-1' }),
      'ROLE_PERMISSION_DENIED',
      'peers_disabled',
    );
  });

  it('示例必须绑定已审核讲解卡：没有已审核卡片时拒绝', () => {
    const opened = openSession();
    store.setClassroomPeers(projectId, opened.sessionId, { enabled: true, engagement: 'active' });
    expectCode(
      () => requestPeerTurn(session, { sessionId: opened.sessionId, roleProfileId: peerId, kind: 'example', requestId: 'ex-1' }),
      'SOURCE_MISSING',
      'no_reviewed_example_in_scene',
    );
    // 草案卡片不算已审核示例。
    const draft = store.createExplanation({
      projectId, lessonId, lessonVersion, sceneId: SCENE, kind: 'explain',
      origin: 'teacher_authored', text: '增函数的定义：区间内任取两点', statementIds: [statementId],
    });
    expectCode(
      () => requestPeerTurn(session, { sessionId: opened.sessionId, roleProfileId: peerId, kind: 'example', requestId: 'ex-2' }),
      'SOURCE_MISSING',
      'no_reviewed_example_in_scene',
    );
    store.reviewExplanation({ projectId, explanationId: draft.explanationId, decision: 'approved', note: '通过' });
    const turn = requestPeerTurn(session, { sessionId: opened.sessionId, roleProfileId: peerId, kind: 'example', requestId: 'ex-3' });
    expect(turn.reviewedExampleId).toBe(draft.explanationId);
    expect(turn.statementIds).toEqual([statementId]);
    expect(turn.text).toContain('模拟示例');
  });

  it('示例重试先读收据：切场景、删除角色和撤课后仍只返回原发言', () => {
    const opened = openSession();
    store.setClassroomPeers(projectId, opened.sessionId, { enabled: true, engagement: 'active' });
    const card = store.createExplanation({ projectId, lessonId, lessonVersion, sceneId: SCENE, kind: 'explain',
      origin: 'teacher_authored', text: '审核示例', statementIds: [statementId] });
    store.reviewExplanation({ projectId, explanationId: card.explanationId, decision: 'approved', note: '核对' });
    const input = { sessionId: opened.sessionId, roleProfileId: peerId, kind: 'example' as const, requestId: 'example-retry' };
    const first = requestPeerTurn(session, input);
    store.advanceClassroomScene(projectId, opened.sessionId, 'scene-without-example', 'next');
    store.deleteRoleProfile(peerId);
    store.withdrawLesson({ projectId, lessonId, reason: '撤回' });
    expect(requestPeerTurn(session, input)).toEqual(first);
    expect(store.listClassroomPeerTurns(projectId, opened.sessionId)).toHaveLength(1);
    expectCode(() => requestPeerTurn(session, { ...input, kind: 'discussion' }), 'VERSION_CONFLICT');
  });

  it('直接写同学发言复核已冻结课程，撤课后不留下发言或收据', () => {
    const opened = openSession();
    store.setClassroomPeers(projectId, opened.sessionId, { enabled: true, engagement: 'active' });
    store.withdrawLesson({ projectId, lessonId, reason: '撤回' });
    expect(() => store.recordClassroomPeerTurn({ projectId, sessionId: opened.sessionId, roleProfileId: peerId,
      kind: 'question', text: '模拟', statementIds: [statementId], reviewedExampleId: null, requestId: 'withdrawn' })).toThrow();
    expect(store.listClassroomPeerTurns(projectId, opened.sessionId)).toHaveLength(0);
    expect(store.getClassroomPeerTurnReceipt({ projectId, sessionId: opened.sessionId, roleProfileId: peerId,
      kind: 'question', requestId: 'withdrawn' })).toBeNull();
  });

  it('同学存储收据拒绝同nonce替换发言正文或来源', () => {
    const opened = openSession();
    store.setClassroomPeers(projectId, opened.sessionId, { enabled: true });
    const input = { projectId, sessionId: opened.sessionId, roleProfileId: peerId, kind: 'question' as const,
      text: '模拟提问', statementIds: [statementId], reviewedExampleId: null, requestId: 'storage-nonce' };
    const first = store.recordClassroomPeerTurn(input);
    expect(store.recordClassroomPeerTurn(input)).toEqual({ ...first, deduplicated: true });
    expectCode(() => store.recordClassroomPeerTurn({ ...input, text: '替换正文' }), 'VERSION_CONFLICT');
    expectCode(() => store.recordClassroomPeerTurn({ ...input, statementIds: [] }), 'VERSION_CONFLICT');
    expect(store.listClassroomPeerTurns(projectId, opened.sessionId)).toHaveLength(1);
  });

  it('已挂stage但当前场景无来源时禁止回退整课来源', () => {
    const opened = store.openClassroomSession({ projectId, lessonId, stageId: 'missing-stage',
      learnerKey: 'sew:classroom:owner:v1', sceneId: 'missing-scene' });
    store.setClassroomPeers(projectId, opened.sessionId, { enabled: true });
    expectCode(() => requestPeerTurn(session, { sessionId: opened.sessionId, roleProfileId: peerId,
      kind: 'question', requestId: 'no-scene' }), 'SOURCE_MISSING');
    expect(store.listClassroomPeerTurns(projectId, opened.sessionId)).toHaveLength(0);
  });

  it('来源修订后新发言失败，旧收据仍可读回', () => {
    const opened = openSession();
    store.setClassroomPeers(projectId, opened.sessionId, { enabled: true, engagement: 'active' });
    const input = { sessionId: opened.sessionId, roleProfileId: peerId, kind: 'question' as const, requestId: 'before-source' };
    const first = requestPeerTurn(session, input);
    store.importMaterial({ projectId, displayName: '考纲.md', materialType: 'md', rawText: '来源修订后的内容。' });
    expectCode(() => requestPeerTurn(session, { ...input, requestId: 'after-source' }), 'KNOWLEDGE_INVALIDATED');
    expect(requestPeerTurn(session, input)).toEqual(first);
    expect(store.listClassroomPeerTurns(projectId, opened.sessionId)).toHaveLength(1);
  });

  it('发布新版本后不能继续用会话冻结的旧来源发言', () => {
    const opened = openSession();
    store.setClassroomPeers(projectId, opened.sessionId, { enabled: true });
    const next = store.createLessonDraft({ projectId, lessonId, title: '更新版本', bundleId,
      statementIds: [statementId], questionIds: [] });
    store.reviewLesson({ projectId, lessonId, version: next.version, decision: 'approved', note: '核对' });
    store.publishLesson({ projectId, lessonId, version: next.version });
    expectCode(() => requestPeerTurn(session, { sessionId: opened.sessionId, roleProfileId: peerId,
      kind: 'question', requestId: 'old-version' }), 'CLASSROOM_LESSON_NOT_REVIEWED', 'session_lesson_version_changed');
    expect(store.listClassroomPeerTurns(projectId, opened.sessionId)).toHaveLength(0);
  });

  it('教师档案不能冒充同学发言', () => {
    const opened = openSession();
    store.setClassroomPeers(projectId, opened.sessionId, { enabled: true, engagement: 'active' });
    const teacherId = store.createRoleProfile('teacher', { name: '老师', persona: '严谨', explanation: 'rigorous' }).profileId;
    expectCode(
      () => requestPeerTurn(session, { sessionId: opened.sessionId, roleProfileId: teacherId, kind: 'question', requestId: 't-1' }),
      'ROLE_PERMISSION_DENIED',
      'not_a_peer_role',
    );
  });

  it('同一请求标识重试读回同一条发言，不重复计数', () => {
    const opened = openSession();
    store.setClassroomPeers(projectId, opened.sessionId, { enabled: true, engagement: 'active' });
    const first = requestPeerTurn(session, { sessionId: opened.sessionId, roleProfileId: peerId, kind: 'question', requestId: 'same' });
    const retry = requestPeerTurn(session, { sessionId: opened.sessionId, roleProfileId: peerId, kind: 'question', requestId: 'same' });
    expect(retry.turnId).toBe(first.turnId);
    expect(store.classroomPeerTurnCount(projectId, opened.sessionId, 1)).toBe(1);
    expect(store.listClassroomPeerTurns(projectId, opened.sessionId, 1)).toHaveLength(1);
  });

  it('同学发言跨数据库重开仍读回，且轮内计数不丢', () => {
    const opened = openSession();
    store.setClassroomPeers(projectId, opened.sessionId, { enabled: true, engagement: 'active' });
    const turn = requestPeerTurn(session, { sessionId: opened.sessionId, roleProfileId: peerId, kind: 'discussion', requestId: 'durable' });
    reopen();
    const turns = store.listClassroomPeerTurns(projectId, opened.sessionId, 1);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.turnId).toBe(turn.turnId);
    expect(store.getClassroomSession(opened.sessionId, projectId)?.roundPeerTurns).toBe(1);
    // 重开后再发一次仍受上限约束（active 为 2），说明计数列没有随重开清零。
    requestPeerTurn(session, { sessionId: opened.sessionId, roleProfileId: peerId, kind: 'question', requestId: 'durable-2' });
    expectCode(
      () => requestPeerTurn(session, { sessionId: opened.sessionId, roleProfileId: peerId, kind: 'question', requestId: 'durable-3' }),
      'BUDGET_EXCEEDED',
      'round_peer_turns',
    );
  });

  it('同学能力表不含白板写权、本人答题权与知识修改权', () => {
    const caps = peerCapabilities();
    expect(caps.whiteboardWrite).toBe(false);
    expect(caps.answerAsLearner).toBe(false);
    expect(caps.modifyKnowledge).toBe(false);
    expect(caps.approveContent).toBe(false);
    expect(caps.partition).toBe('simulation');
    expect(peerAttemptPartition()).toBe('simulation');
  });

  it('同一请求标识换了同学或换了发言方式都拒绝，不读回别人的发言', () => {
    const opened = openSession();
    store.setClassroomPeers(projectId, opened.sessionId, { enabled: true, engagement: 'active' });
    const otherPeerId = store.createRoleProfile('peer', { name: '小答', persona: '爱举例', explanation: 'concise' }).profileId;
    requestPeerTurn(session, { sessionId: opened.sessionId, roleProfileId: peerId, kind: 'question', requestId: 'fixed' });
    expectCode(
      () => requestPeerTurn(session, { sessionId: opened.sessionId, roleProfileId: otherPeerId, kind: 'question', requestId: 'fixed' }),
      'VERSION_CONFLICT',
      'peer_turn_context_changed',
    );
    expectCode(
      () => requestPeerTurn(session, { sessionId: opened.sessionId, roleProfileId: peerId, kind: 'discussion', requestId: 'fixed' }),
      'VERSION_CONFLICT',
      'peer_turn_context_changed',
    );
    expect(store.classroomPeerTurnCount(projectId, opened.sessionId, 1)).toBe(1);
  });

  it('发言行、轮内计数与收据同事务：中途失败不留半条发言也不留收据', () => {
    const opened = openSession();
    store.setClassroomPeers(projectId, opened.sessionId, { enabled: true, engagement: 'active' });
    // 让轮内计数更新失败：如果发言行不是和收据在同一个事务里，就会残留一条「没有收据的发言」。
    const db = createNodeSqliteDriver().open(projectPaths(root).databaseFile);
    db.exec("CREATE TRIGGER fail_peer_count BEFORE UPDATE ON classroom_sessions WHEN NEW.round_peer_turns > 0 BEGIN SELECT RAISE(ABORT, 'peer_count_failed'); END;");
    db.close();

    expect(() => requestPeerTurn(session, {
      sessionId: opened.sessionId, roleProfileId: peerId, kind: 'question', requestId: 'atomic',
    })).toThrow();
    expect(store.listClassroomPeerTurns(projectId, opened.sessionId, 1)).toHaveLength(0);
    expect(store.classroomPeerTurnCount(projectId, opened.sessionId, 1)).toBe(0);

    // 触发条件解除后同一次请求仍可成功，说明失败时没有留下会被误读为「已发言」的收据。
    const cleanup = createNodeSqliteDriver().open(projectPaths(root).databaseFile);
    cleanup.exec('DROP TRIGGER fail_peer_count;');
    cleanup.close();
    const turn = requestPeerTurn(session, {
      sessionId: opened.sessionId, roleProfileId: peerId, kind: 'question', requestId: 'atomic',
    });
    expect(turn.partition).toBe('simulation');
    expect(store.classroomPeerTurnCount(projectId, opened.sessionId, 1)).toBe(1);
  });

  it('权限判定与调度判定同源：越权直接抛错，调度只返回布尔', () => {
    expect(() => assertPeerTurnAllowed({
      sessionStatus: 'in_class', peersEnabled: true, engagement: 'active', roundPeerTurns: 0,
      roleKind: 'teacher', actorType: 'peer_ai', partition: 'simulation',
    })).toThrowError(/没有该操作权限/);
    expect(() => assertPeerTurnAllowed({
      sessionStatus: 'in_class', peersEnabled: true, engagement: 'active', roundPeerTurns: 0,
      roleKind: 'peer', actorType: 'peer_ai', partition: 'real',
    })).toThrowError(/没有该操作权限/);
    expect(shouldPeerSpeak({ sessionStatus: 'completed', peersEnabled: true, engagement: 'active', roundPeerTurns: 0 })).toBe(false);
    expect(shouldPeerSpeak({ sessionStatus: 'in_class', peersEnabled: true, engagement: 'active', roundPeerTurns: 1 })).toBe(true);
  });
});
