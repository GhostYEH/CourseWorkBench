import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyError, newId, type PlanPayloadDto } from '@sew/study-contracts';
import { assertClassroomBudget, nextPlayableCard } from '@sew/study-domain';
import { StudyStore, ensureProjectLayout, projectPaths, type ExplanationRow } from '@sew/study-storage';

/**
 * 讲解卡与课堂会话（TEACH-01）。
 *
 * 固定的是《规划书》6.2 / 6.4 对教师侧的可机械核对部分：正式授课只用已审核卡片、
 * 模型产生的内容先进待核区、等待本人时不再自动播报且重启后仍等待、
 * 每轮与整节课两级预算共用、重复动作读回既有收据。
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

describe('讲解卡与课堂会话', () => {
  let root: string;
  let store: StudyStore;
  let projectId: string;
  let materialId: string;
  let knowledgeId: string;
  let bundleId = '';
  let statementId = '';
  let lessonId = '';
  let lessonVersion = 1;

  const card = (text: string, statementIds: string[] = [statementId], origin: 'teacher_authored' | 'model_generated' = 'teacher_authored') =>
    store.createExplanation({
      projectId,
      lessonId,
      lessonVersion,
      sceneId: SCENE,
      kind: 'explain',
      origin,
      text,
      statementIds,
    });

  const openSession = (sceneId = SCENE) => store.openClassroomSession({
    projectId,
    lessonId,
    stageId: null,
    learnerKey: 'sew:classroom:owner:v1',
    sceneId,
  });

  const reopen = (): void => {
    store.close();
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-teaching-'));
    ensureProjectLayout(root);
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    projectId = newId<'project'>('proj');
    store.createProject({ projectId, displayName: '数学', subject: '数学', dailyMinutes: 60 });
    const imported = store.importMaterial({
      projectId,
      displayName: '考纲.md',
      materialType: 'md',
      rawText: '本章要求理解增函数的定义。\n\n第二条范围说明。',
    });
    materialId = imported.material.materialId;
    const proposal = store.createProposal({
      projectId,
      name: '增函数定义',
      concept: '区间内任取 x1 < x2 都有 f(x1) < f(x2)',
      conditions: '同一区间 D 内',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [{ materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'user',
    });
    knowledgeId = store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
    }).knowledgePoint!.knowledgeId;
    store.savePlanVersion(projectId, 1, 'confirmed', {
      payloadVersion: 1,
      goal: '掌握本章',
      examDate: null,
      dailyMinutes: 60,
      tasks: [{ knowledgeId, name: '增函数定义', minutes: 30, acceptance: '', evidence: [{ materialId, segmentId: 'S001' }] }],
      gaps: [],
      basis: '测试计划',
      confirmedTaskKnowledgeIds: [knowledgeId],
    } satisfies PlanPayloadDto);
    const bundle = store.buildLessonBundle(projectId, [{ knowledgeId, text: '增函数的定义', conditions: '同一区间 D 内' }], []);
    bundleId = bundle.bundleId;
    statementId = bundle.bundle.statements[0]!.statementId;
    const lesson = store.createLessonDraft({
      projectId,
      lessonId: null,
      title: '函数单调性（第 1 课时）',
      bundleId,
      statementIds: bundle.bundle.statements.map((row) => row.statementId),
      questionIds: [],
    });
    lessonId = lesson.lessonId;
    lessonVersion = lesson.version;
    store.reviewLesson({ projectId, lessonId, version: lessonVersion, decision: 'approved', note: '按原文核对' });
    store.publishLesson({ projectId, lessonId, version: lessonVersion });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('开课先复核课程发布与来源，未发布的课程不能开课堂会话', () => {
    const draft = store.createLessonDraft({
      projectId,
      lessonId: null,
      title: '尚未发布的一节课',
      bundleId,
      statementIds: [statementId],
      questionIds: [],
    });
    expectCode(
      () => store.openClassroomSession({ projectId, lessonId: draft.lessonId, stageId: null, learnerKey: 'k', sceneId: SCENE }),
      'CLASSROOM_LESSON_NOT_REVIEWED',
      'no_published_link',
    );
    expect(store.getOpenClassroomSession(projectId)).toBeNull();
  });

  it('重复开课读回同一会话，不会开出第二节并行的课', () => {
    const first = openSession();
    const again = openSession();
    expect(again.sessionId).toBe(first.sessionId);
    expect(store.listClassroomSessions(projectId)).toHaveLength(1);
  });

  it('待核卡片不能播放，审核通过后按位置顺序进入队列', () => {
    const pending = card('待核内容');
    const session = openSession();
    expect(store.playNextExplanation(projectId, session.sessionId).card).toBeNull();

    store.reviewExplanation({ projectId, explanationId: pending.explanationId, decision: 'approved', note: '与原文一致' });
    const played = store.playNextExplanation(projectId, session.sessionId);
    expect(played.deduplicated).toBe(false);
    expect(played.card?.explanationId).toBe(pending.explanationId);
    expect(played.playedIds).toEqual([pending.explanationId]);
    expectCode(
      () => store.reviewExplanation({ projectId, explanationId: pending.explanationId, decision: 'rejected', note: '' }),
      'STEP_ALREADY_COMMITTED',
      'card_not_draft',
    );
  });

  it('重复请求播放同一张卡读回既有收据，不二次播报', () => {
    const approved = card('第一张');
    store.reviewExplanation({ projectId, explanationId: approved.explanationId, decision: 'approved', note: '' });
    const session = openSession();
    const first = store.playNextExplanation(projectId, session.sessionId);
    const replay = store.playNextExplanation(projectId, session.sessionId);
    expect(first.deduplicated).toBe(false);
    // 队列里只剩这一张已审核卡片，第二次取不到新卡，因此既没有二次播报也没有第二条收据。
    expect(replay.card).toBeNull();
    const actions = store.listClassroomActions(session.sessionId, projectId);
    expect(actions.filter((action) => action.payload.kind === 'card_played')).toHaveLength(1);
  });

  it('交还本人后不再自动播报，切场景也被挡住；作答归来开启新一轮', () => {
    const approved = card('可播内容');
    store.reviewExplanation({ projectId, explanationId: approved.explanationId, decision: 'approved', note: '' });
    const session = openSession();
    store.handBackToLearner(projectId, session.sessionId, '请本人完成第 3 题');

    expectCode(() => store.playNextExplanation(projectId, session.sessionId), 'CLASSROOM_AWAITING_LEARNER', 'awaiting_learner');
    expectCode(() => store.advanceClassroomScene(projectId, session.sessionId, 'scene-2'), 'CLASSROOM_AWAITING_LEARNER', 'awaiting_learner');

    reopen();
    const afterRestart = store.getClassroomSession(session.sessionId, projectId);
    expect(afterRestart?.status).toBe('awaiting_learner');
    expect(afterRestart?.awaitingReason).toBe('请本人完成第 3 题');

    const resumed = store.markLearnerAnswered(projectId, session.sessionId);
    expect(resumed.status).toBe('in_class');
    expect(resumed.roundIndex).toBe(2);
    expect(resumed.awaitingReason).toBe('');
    expect(store.playNextExplanation(projectId, session.sessionId).card?.explanationId).toBe(approved.explanationId);
    expectCode(
      () => store.markLearnerAnswered(projectId, session.sessionId),
      'INVALID_ARGUMENT',
      'not_awaiting_learner',
    );
  });

  it('交还动作按轮次去重，同轮重复提交读回第一条原因', () => {
    const session = openSession();
    store.handBackToLearner(projectId, session.sessionId, '第一次交还');
    store.handBackToLearner(projectId, session.sessionId, '第二次交还');
    const reopened = store.getClassroomSession(session.sessionId, projectId);
    expect(reopened?.awaitingReason).toBe('第一次交还');
    expect(store.listClassroomActions(session.sessionId, projectId).filter((action) => action.payload.kind === 'handback')).toHaveLength(1);
  });

  it('模型产生的卡片默认无依据，补上陈述并审核后才会播报', () => {
    const generated: ExplanationRow = card('模型现场说法', [], 'model_generated');
    expect(generated.origin).toBe('model_generated');
    expect(generated.statementIds).toEqual([]);
    expectCode(
      () => store.reviewExplanation({ projectId, explanationId: generated.explanationId, decision: 'approved', note: '' }),
      'SOURCE_MISSING',
      'card_has_no_statements',
    );

    const edited = store.updateExplanationDraft({ projectId, explanationId: generated.explanationId, statementIds: [statementId] });
    expect(edited.statementIds).toEqual([statementId]);
    store.reviewExplanation({ projectId, explanationId: generated.explanationId, decision: 'approved', note: '补来源后核对' });
    const session = openSession();
    const played = store.playNextExplanation(projectId, session.sessionId);
    expect(played.card?.explanationId).toBe(generated.explanationId);
    // 来源标记不因审核改写：仍是模型产生，界面据此显示出处。
    expect(played.card?.origin).toBe('model_generated');
  });

  it('卡片依据必须落在本节课的证据包里，包外陈述被拒绝', () => {
    expectCode(
      () => store.createExplanation({
        projectId, lessonId, lessonVersion, sceneId: SCENE, kind: 'explain', origin: 'teacher_authored',
        text: '引用了不存在依据的一句话', statementIds: ['stmt-not-in-bundle'],
      }),
      'INVALID_ARGUMENT',
      'statement_outside_bundle',
    );
    expectCode(
      () => store.createExplanation({
        projectId, lessonId, lessonVersion, sceneId: SCENE, kind: 'explain', origin: 'teacher_authored',
        text: '没有依据的教师手写卡片', statementIds: [],
      }),
      'SOURCE_MISSING',
      'card_has_no_statements',
    );
  });

  it('来源失效后已审核卡片也停止播报，与发布、审核入口同一判定', () => {
    const approved = card('曾经可用的内容');
    store.reviewExplanation({ projectId, explanationId: approved.explanationId, decision: 'approved', note: '' });
    const session = openSession();
    store.importMaterial({
      projectId,
      displayName: '考纲.md',
      materialType: 'md',
      rawText: '本章要求理解增函数的定义（表述已修订）。',
    });
    expectCode(() => store.playNextExplanation(projectId, session.sessionId), 'KNOWLEDGE_INVALIDATED');
  });

  it('课堂模型调用按每轮与整节课两级上限计数', () => {
    const session = openSession();
    for (let index = 0; index < 4; index += 1) {
      store.noteClassroomModelCall({ projectId, sessionId: session.sessionId, purpose: 'teaching_prompt', ok: true, totalTokens: 50 });
    }
    const counted = store.getClassroomSession(session.sessionId, projectId);
    expect(counted?.roundCalls).toBe(4);
    expect(counted?.lessonCalls).toBe(4);
    expectCode(
      () => store.noteClassroomModelCall({ projectId, sessionId: session.sessionId, purpose: 'teaching_prompt', ok: true, totalTokens: 50 }),
      'BUDGET_EXCEEDED',
      'round_calls',
    );
    // 新一轮清空轮内计数，整节课累计继续保留。
    store.advanceClassroomScene(projectId, session.sessionId, 'scene-2');
    const nextRound = store.noteClassroomModelCall({ projectId, sessionId: session.sessionId, purpose: 'teaching_prompt', ok: true, totalTokens: 10 });
    expect(nextRound.roundCalls).toBe(1);
    expect(nextRound.lessonCalls).toBe(5);
    expect(nextRound.roundIndex).toBe(2);
  });

  it('失败的调用同样计入预算，预算判定与实现共用同一函数', () => {
    const session = openSession();
    store.noteClassroomModelCall({ projectId, sessionId: session.sessionId, purpose: 'teaching_prompt', ok: false, totalTokens: 0 });
    const after = store.getClassroomSession(session.sessionId, projectId);
    expect(after?.roundCalls).toBe(1);
    expectCode(
      () => assertClassroomBudget({
        roundCalls: after!.roundCalls,
        roundPeerTurns: after!.roundPeerTurns,
        lessonCalls: after!.lessonCalls,
        peersEnabled: after!.peersEnabled,
        maxCallsPerRound: 1,
      }, 'model_call'),
      'BUDGET_EXCEEDED',
      'round_calls',
    );
  });

  it('同学发言在未启用时被拒绝，启用后仍受每轮次数上限', () => {
    const session = openSession();
    expectCode(
      () => assertClassroomBudget({
        roundCalls: session.roundCalls, roundPeerTurns: 0, lessonCalls: session.lessonCalls, peersEnabled: false,
      }, 'peer_turn'),
      'ROLE_PERMISSION_DENIED',
      'peers_disabled',
    );
    expectCode(
      () => assertClassroomBudget({
        roundCalls: 0, roundPeerTurns: 2, lessonCalls: 0, peersEnabled: true,
      }, 'peer_turn'),
      'BUDGET_EXCEEDED',
      'round_peer_turns',
    );
  });

  it('结束或取消后不再执行任何课堂动作', () => {
    const session = openSession();
    store.closeClassroomSession(projectId, session.sessionId, 'cancelled', '教师中断');
    expectCode(() => store.playNextExplanation(projectId, session.sessionId), 'RUN_TERMINATED');
    expectCode(() => store.handBackToLearner(projectId, session.sessionId, '再交还'), 'RUN_TERMINATED');
    expectCode(() => store.advanceClassroomScene(projectId, session.sessionId, 'scene-2'), 'RUN_TERMINATED');
    expectCode(
      () => store.noteClassroomModelCall({ projectId, sessionId: session.sessionId, purpose: 'teaching_prompt', ok: true, totalTokens: 1 }),
      'RUN_TERMINATED',
    );
    expect(store.getOpenClassroomSession(projectId)).toBeNull();
  });

  it('队列取卡在领域层是可确定的：跳过待核与已播放，按位置优先', () => {
    const draft = card('草案不播');
    const second = card('第二张');
    const first = card('第一张');
    store.reviewExplanation({ projectId, explanationId: first.explanationId, decision: 'approved', note: '' });
    store.reviewExplanation({ projectId, explanationId: second.explanationId, decision: 'approved', note: '' });
    const cards = store.listExplanationCards(lessonId, lessonVersion, projectId);
    // 位置由服务端按登记顺序追加：draft 0、second 1、first 2；待核的 draft 虽然位置最前也不进队列。
    expect(cards.map((row) => row.position)).toEqual([0, 1, 2]);
    const dtos = cards.map((row) => ({ ...row }));
    expect(nextPlayableCard(dtos, new Set(), SCENE)?.explanationId).toBe(second.explanationId);
    expect(nextPlayableCard(dtos, new Set([second.explanationId]), SCENE)?.explanationId).toBe(first.explanationId);
    expect(nextPlayableCard(dtos, new Set([first.explanationId, second.explanationId]), SCENE)).toBeNull();
    expect(draft.status).toBe('draft');
  });
});
