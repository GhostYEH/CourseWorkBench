import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StudyError,
  recoveryCheckpointSchema,
  type PlanPayloadDto,
} from '@sew/study-contracts';
import { closeProject, openProjectFromDisk, type Session } from '../apps/learning/lib/server/service';
import { attachFormalLessonDocument } from '../apps/learning/lib/server/classroom-service';
import { RUNTIME_DSL_VERSION } from '@openmaic/dsl';
import { createNodeSqliteDriver, projectPaths } from '@sew/study-storage';
import { commandFormalInteraction, loadFormalInteraction } from '../apps/learning/lib/server/formal-interaction-service';
import { POST as runtimePost } from '../apps/learning/app/api/maic/runtime/[...segments]/route';
import { checkRecovery } from '../apps/learning/lib/server/classroom-recovery';

/**
 * 四层恢复核对（RESUME-01 /《规划书》6.7）。
 *
 * 固定的是「恢复是判定而不是重放」这件事：恢复核对不发 provider、不重复白板/消息/提交；
 * 权威事实对不上时明确阻断；只有临时现场才允许重置，且已提交的本人记录必须保留。
 *
 * 注意：这里用的是真实 SQLite 与真实课件链，但**数据库句柄重开不等于整应用或服务崩溃恢复**，
 * 因此本文件不构成 RESUME-01 的整应用崩溃签核。
 */

describe('四层恢复核对', () => {
  let root: string;
  let session: Session;
  let projectId: string;
  let bundleId = '';
  let statementIds: string[] = [];
  let lessonId = '';
  let lessonVersion = 1;

  const buildLesson = (): void => {
    const bundle = session.store.buildLessonBundle(
      projectId,
      [{ knowledgeId: session.store.listKnowledge('formal')[0]!.knowledgeId, text: '增函数的定义：在区间 D 内任取 x1 < x2 都有 f(x1) < f(x2)', conditions: '同一区间 D 内' }],
      [],
    );
    bundleId = bundle.bundleId;
    statementIds = bundle.bundle.statements.map((statement) => statement.statementId);
    const lesson = session.store.createLessonDraft({
      projectId, lessonId: null, title: '函数单调性（第 1 课时）', bundleId, statementIds, questionIds: [],
    });
    lessonId = lesson.lessonId;
    lessonVersion = lesson.version;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-recovery-'));
    session = openProjectFromDisk(root);
    projectId = session.projectId;
    const imported = session.store.importMaterial({
      projectId, displayName: '考纲.md', materialType: 'md',
      rawText: '本章要求理解增函数的定义。\n\n第二条范围说明。',
    });
    const materialId = imported.material.materialId;
    const proposal = session.store.createProposal({
      projectId, name: '增函数定义', concept: '区间内任取 x1 < x2 都有 f(x1) < f(x2)',
      conditions: '同一区间 D 内', scopeStatus: 'in_syllabus', prerequisites: [],
      evidence: [{ materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }],
      acceptance: '', priority: 'medium', proposedBy: 'user',
    });
    const knowledgeId = session.store.applyReview({
      proposalId: proposal.proposalId, decision: 'approved',
      expectedRevision: proposal.revision, semanticReviewed: true,
    }).knowledgePoint!.knowledgeId;
    session.store.savePlanVersion(projectId, 1, 'confirmed', {
      payloadVersion: 1, goal: '掌握本章', examDate: null, dailyMinutes: 60,
      tasks: [{ knowledgeId, name: '增函数定义', minutes: 30, acceptance: '', evidence: [{ materialId, segmentId: 'S001' }] }],
      gaps: [], basis: '测试计划', confirmedTaskKnowledgeIds: [knowledgeId],
    } satisfies PlanPayloadDto);
    buildLesson();
  });

  afterEach(() => {
    closeProject();
    rmSync(root, { recursive: true, force: true });
  });

  const publishAndAttach = (): { stageId: string; sceneId: string } => {
    session.store.reviewLesson({ projectId, lessonId, version: lessonVersion, decision: 'approved', note: '按原文核对' });
    session.store.publishLesson({ projectId, lessonId, version: lessonVersion });
    const info = attachFormalLessonDocument(session, lessonId, lessonVersion);
    return { stageId: info.stageId, sceneId: info.scenes[0]!.sceneId };
  };

  const classroom = (stageId: string, sceneId: string) => session.store.openClassroomSession({ projectId, lessonId, stageId, learnerKey: 'sew:classroom:owner:v1', sceneId });
  const mutate = (sql: string, ...values: Array<string | number>) => {
    const db = createNodeSqliteDriver().open(projectPaths(root).databaseFile);
    try { db.prepare(sql).run(...values); } finally { db.close(); }
  };
  const requestRuntime = (segments: string[], body: unknown) => runtimePost(new Request('http://local/api/maic/runtime/' + segments.join('/'), {
    method: 'POST', headers: { 'x-sew-project-id': projectId, 'x-sew-generation': String(session.generation) }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ segments }) });
  const makeQuiz = (type: 'single' | 'short_answer' = 'single') => {
    const knowledgeId = session.store.listKnowledge('formal')[0]!.knowledgeId;
    const question = session.store.createQuestion({ stem: '恢复题', answer: 'A', solution: '定义', knowledgeIds: [knowledgeId], requestedOrigin: 'ai_new', originRecord: null,
      assessment: { schemaVersion: 1, type, options: type === 'single' ? [{ value: 'A', label: '定义' }, { value: 'B', label: '反例' }] : [], correctAnswers: type === 'single' ? ['A'] : [], maxScore: 5, rubric: '定义', answerVersion: 1 } }).question;
    const bundle = session.store.buildLessonBundle(projectId, [{ knowledgeId, text: '定义陈述', conditions: '' }], [question.questionId]);
    const lesson = session.store.createLessonDraft({ projectId, lessonId: null, title: '恢复测验课', bundleId: bundle.bundleId, statementIds: bundle.bundle.statements.map(s => s.statementId), questionIds: [question.questionId] });
    lessonId = lesson.lessonId; lessonVersion = lesson.version;
    const info = publishAndAttach();
    const source = session.store.listClassroomSceneSources(projectId, info.stageId);
    const sceneId = [...source.values()].find(s => s.questionId === question.questionId)!.sceneId;
    const stored = session.store.getClassroomDocument(projectId, info.stageId)!.document as { scenes: Array<{ id: string; content: { questions?: Array<{ id: string }> } }> };
    const dslId = stored.scenes.find(s => s.id === sceneId)!.content.questions![0]!.id;
    return { stageId: info.stageId, sceneId, dslId, questionId: question.questionId };
  };

  it.each(['completed', 'cancelled'] as const)('终止会话 %s 只恢复历史，不能续课', status => {
    const { stageId, sceneId } = publishAndAttach(); const opened = classroom(stageId, sceneId);
    mutate('UPDATE classroom_sessions SET status=? WHERE session_id=?', status, opened.sessionId);
    const result = checkRecovery(session, opened.sessionId);
    expect(result.resumable).toBe(false); expect(result.continuation).toBe('terminal'); expect(result.sessionStatus).toBe(status);
  });

  it('本人真实草稿与正式事务提交分别恢复，不计其他 UID 分区或其他课历史', async () => {
    const q = makeQuiz(); const opened = classroom(q.stageId, q.sceneId); const at = new Date().toISOString();
    const init = (id: string, learnerKey: string) => session.store.runtime.createSession(projectId, { id, kind: 'quizAttempt', stageId: q.stageId, learnerKey, runtimeDslVersion: RUNTIME_DSL_VERSION, status: 'active', createdAt: at, updatedAt: at });
    init('mine-draft', 'sew:classroom:owner:v1'); init('another-uid', 'uid-other');
    for (const id of ['mine-draft', 'another-uid']) session.store.runtime.appendRecord(projectId, { id: `draft-${id}`, sessionId: id, sceneId: q.sceneId, subAnchor: q.dslId, createdAt: at, payload: { payloadVersion: 1, phase: 'draft', answers: { [q.dslId]: 'A' } } });
    expect(checkRecovery(session, opened.sessionId).layers.find(l => l.layer === 'attempt')).toMatchObject({ status: 'restored', preserved: 1 });
    init('mine-submit', 'sew:classroom:owner:v1');
    const response = await requestRuntime(['submit'], { scope: { projectId, generation: session.generation }, sessionId: 'mine-submit', sceneId: q.sceneId, questionId: q.questionId, idempotencyKey: 'real-submit', answerText: 'A', processText: '按定义', expectedLastSeq: null });
    expect(response.status).toBe(200);
    const before = session.store.runtime.listRecords(projectId, 'mine-submit');
    const result = checkRecovery(session, opened.sessionId);
    expect(result.layers.find(l => l.layer === 'attempt')).toMatchObject({ status: 'restored', preserved: 2 });
    expect(session.store.runtime.listRecords(projectId, 'mine-submit')).toEqual(before);
    expect(session.store.listAttempts()).toHaveLength(1);
    mutate('UPDATE attempts SET answer_version=2 WHERE idempotency_key=?', 'real-submit');
    expect(checkRecovery(session, opened.sessionId).layers.find(l => l.layer === 'attempt')).toMatchObject({ status: 'blocked', reason: 'quiz_receipt_or_version_mismatch' });
  });

  it('真实简答的正式提交恢复后保持待判分，核对不替本人判分', async () => {
    const q = makeQuiz('short_answer'); const opened = classroom(q.stageId, q.sceneId); const at = new Date().toISOString();
    session.store.runtime.createSession(projectId, { id: 'pending-grade', kind: 'quizAttempt', stageId: q.stageId, learnerKey: 'sew:classroom:owner:v1', runtimeDslVersion: RUNTIME_DSL_VERSION, status: 'active', createdAt: at, updatedAt: at });
    expect((await requestRuntime(['submit'], { scope: { projectId, generation: session.generation }, sessionId: 'pending-grade', sceneId: q.sceneId, questionId: q.questionId, idempotencyKey: 'pending-grade-key', answerText: '按定义比较函数值', processText: '取区间内两点', expectedLastSeq: null })).status).toBe(200);
    session.store.handBackToLearner(projectId, opened.sessionId, '等待本人继续');
    const before = session.store.listAttempts();
    const result = checkRecovery(session, opened.sessionId);
    expect(result.continuation).toBe('waiting'); expect(result.layers.find(l => l.layer === 'attempt')).toMatchObject({ status: 'waiting', preserved: 1 });
    expect(result.layers.find(l => l.layer === 'attempt')?.message).toContain('1 条待判分');
    expect(session.store.listAttempts()).toEqual(before); expect(before[0]?.grading?.status).toBe('pending_review');
  });

  it('提交前中断只读回提交意图并保持等待，不自动重复判分', () => {
    const q = makeQuiz(); const opened = classroom(q.stageId, q.sceneId); const at = new Date().toISOString();
    session.store.runtime.createSession(projectId, { id: 'unconfirmed', kind: 'quizAttempt', stageId: q.stageId, learnerKey: 'sew:classroom:owner:v1', runtimeDslVersion: RUNTIME_DSL_VERSION, status: 'active', createdAt: at, updatedAt: at });
    session.store.runtime.appendRecord(projectId, { id: 'intent', sessionId: 'unconfirmed', sceneId: q.sceneId, createdAt: at, payload: { payloadVersion: 1, phase: 'submitted', answers: { [q.dslId]: 'A' } } });
    const result = checkRecovery(session, opened.sessionId);
    expect(result.continuation).toBe('waiting'); expect(result.resumable).toBe(false);
    expect(result.layers.find(l => l.layer === 'attempt')).toMatchObject({ status: 'waiting', reason: 'quiz_submission_unconfirmed', preserved: 0 });
    expect(session.store.listAttempts()).toHaveLength(0); expect(session.store.runtime.listRecords(projectId, 'unconfirmed')).toHaveLength(1);
  });

  it.each(['schema', 'seq', 'uid-owner'] as const)('真实本人草稿 %s 损坏不能谎报恢复成功', mode => {
    const q = makeQuiz(); const opened = classroom(q.stageId, q.sceneId); const at = new Date().toISOString();
    session.store.runtime.createSession(projectId, { id: 'draft-corrupt', kind: 'quizAttempt', stageId: q.stageId, learnerKey: 'sew:classroom:owner:v1', runtimeDslVersion: RUNTIME_DSL_VERSION, status: 'active', createdAt: at, updatedAt: at });
    session.store.runtime.appendRecord(projectId, { id: 'corrupt-record', sessionId: 'draft-corrupt', sceneId: q.sceneId, subAnchor: q.dslId, createdAt: at, payload: { payloadVersion: 1, phase: 'draft', answers: { [q.dslId]: 'A' } } });
    if (mode === 'schema') mutate('UPDATE classroom_runtime_records SET payload_json=? WHERE record_id=?', JSON.stringify({ payloadVersion: 99, phase: 'draft', answers: {} }), 'corrupt-record');
    if (mode === 'seq') mutate('UPDATE classroom_runtime_records SET seq=9 WHERE record_id=?', 'corrupt-record');
    if (mode === 'uid-owner') mutate('UPDATE learner_identity_bindings SET learner_uid=? WHERE project_id=?', 'uid-corrupt', projectId);
    expect(checkRecovery(session, opened.sessionId).layers.find(l => l.layer === 'attempt')?.status).toBe('blocked');
  });

  it('本人提交UID归属损坏即使草稿及事务收据完整也阻断', async () => {
    const q = makeQuiz(); const opened = classroom(q.stageId, q.sceneId); const at = new Date().toISOString();
    session.store.runtime.createSession(projectId, { id: 'uid-submit', kind: 'quizAttempt', stageId: q.stageId, learnerKey: 'sew:classroom:owner:v1', runtimeDslVersion: RUNTIME_DSL_VERSION, status: 'active', createdAt: at, updatedAt: at });
    expect((await requestRuntime(['submit'], { scope: { projectId, generation: session.generation }, sessionId: 'uid-submit', sceneId: q.sceneId, questionId: q.questionId, idempotencyKey: 'uid-submit-key', answerText: 'A', processText: '', expectedLastSeq: null })).status).toBe(200);
    mutate('UPDATE feedback_originals SET uid=? WHERE attempt_id=?', 'uid-other', session.store.listAttempts()[0]!.attemptId);
    expect(checkRecovery(session, opened.sessionId).layers.find(l => l.layer === 'attempt')).toMatchObject({ status: 'blocked', reason: 'attempt_owner_mismatch' });
  });

  it('独立本人练习与课堂共存时保留历史、不计当前恢复、不误阻断课堂', () => {
    const q = makeQuiz(); const opened = classroom(q.stageId, q.sceneId);
    session.store.submitAttempt({ projectId, questionId: q.questionId, idempotencyKey: 'old-direct', actorType: 'human_learner', kind: 'real', answerText: 'A', processText: '' });
    const before = session.store.listAttempts();
    expect(session.store.getFeedbackContext(projectId, session.learnerUid, before[0]!.attemptId).canWrite).toBe(true);
    const recovery = checkRecovery(session, opened.sessionId);
    expect(recovery.resumable).toBe(true);
    expect(recovery.layers.find(l => l.layer === 'attempt')).toMatchObject({ status: 'restored', reason: 'attempts_read', preserved: 0 });
    expect(recovery.layers.find(l => l.layer === 'attempt')?.message).toContain('保留但不计本次恢复');
    expect(session.store.listAttempts()).toEqual(before);
  });

  it('独立本人练习与同题正式课堂提交同时存在，仅恢复课堂收据且收据缺失仍阻断', async () => {
    const q = makeQuiz(); const opened = classroom(q.stageId, q.sceneId); const at = new Date().toISOString();
    session.store.submitAttempt({ projectId, questionId: q.questionId, idempotencyKey: 'personal-practice', actorType: 'human_learner', kind: 'real', answerText: 'A', processText: '个人练习' });
    session.store.runtime.createSession(projectId, { id: 'coexisting-quiz', kind: 'quizAttempt', stageId: q.stageId, learnerKey: 'sew:classroom:owner:v1', runtimeDslVersion: RUNTIME_DSL_VERSION, status: 'active', createdAt: at, updatedAt: at });
    expect((await requestRuntime(['submit'], { scope: { projectId, generation: session.generation }, sessionId: 'coexisting-quiz', sceneId: q.sceneId, questionId: q.questionId, idempotencyKey: 'classroom-only', answerText: 'A', processText: '课堂作答', expectedLastSeq: null })).status).toBe(200);
    const recovery = checkRecovery(session, opened.sessionId);
    expect(recovery.resumable).toBe(true); expect(recovery.layers.find(l => l.layer === 'attempt')).toMatchObject({ status: 'restored', preserved: 1 });
    expect(session.store.listAttempts()).toHaveLength(2);
    mutate('DELETE FROM classroom_quiz_receipts WHERE idempotency_key=?', 'classroom-only');
    expect(checkRecovery(session, opened.sessionId).layers.find(l => l.layer === 'attempt')).toMatchObject({ status: 'blocked', reason: 'quiz_receipt_or_version_mismatch' });
  });

  it('课堂 UID 绑定漂移拒绝本人层', () => {
    const { stageId, sceneId } = publishAndAttach(); const opened = classroom(stageId, sceneId);
    mutate('UPDATE classroom_sessions SET learner_key=? WHERE session_id=?', 'another-uid', opened.sessionId);
    expect(checkRecovery(session, opened.sessionId).layers.find(l => l.layer === 'attempt')).toMatchObject({ status: 'blocked', reason: 'recovery_learner_mismatch' });
  });

  it.each(['uid', 'binding', 'seq', 'result'] as const)('正式互动提交权威 %s 损坏必须阻断，绝不假称重置', mode => {
    commandFormalInteraction(session, { operation: 'review', scope: { projectId, generation: session.generation }, lessonId, lessonVersion, semanticReviewed: true, reviewNote: '来源核对', definitions: [{ id: 'parameter', kind: 'parameter', title: '参数实验', statementIds, formula: 'linear', min: -3, max: 3, step: 1, intercept: 2, predictionRequired: true }] });
    const { stageId } = publishAndAttach(); const sceneId = 'scene_formal_interaction_parameter'; const opened = classroom(stageId, sceneId);
    const state = loadFormalInteraction(session, stageId, sceneId);
    commandFormalInteraction(session, { operation: 'submit', scope: { projectId, generation: session.generation }, binding: state.binding, nonce: 'real-interaction', values: { kind: 'parameter', a: 2, x: 3, prediction: 8, explanation: '本人预测' } });
    commandFormalInteraction(session, { operation: 'draft', scope: { projectId, generation: session.generation }, binding: state.binding, nonce: 'draft-interaction', values: { kind: 'parameter', a: 1, x: 3, prediction: 5, explanation: '下一次草稿' } });
    const initial = checkRecovery(session, opened.sessionId);
    expect(initial.layers.find(l => l.layer === 'interaction')).toMatchObject({ status: 'restored', preserved: 2 });
    const records = session.store.runtime.listSessions(projectId, stageId, session.learnerUid);
    const owner = records.find(r => r.kind === 'formalInteractionObservation')!;
    const saved = session.store.runtime.listRecords(projectId, owner.id)[0]!;
    if (mode === 'seq') mutate('UPDATE classroom_runtime_records SET seq=7 WHERE record_id=?', saved.id);
    else {
      const payload = saved.payload as { uid: string; result: number; binding: { definitionDigest: string } };
      if (mode === 'uid') payload.uid = 'uid-foreign';
      if (mode === 'binding') payload.binding.definitionDigest = 'wrong';
      if (mode === 'result') payload.result = 9;
      mutate('UPDATE classroom_runtime_records SET payload_json=? WHERE record_id=?', JSON.stringify(payload), saved.id);
    }
    const before = session.store.runtime.listRecords(projectId, owner.id);
    const result = checkRecovery(session, opened.sessionId);
    expect(result.resumable).toBe(false); expect(result.layers.find(l => l.layer === 'interaction')).toMatchObject({ status: 'blocked', discarded: 0 });
    expect(session.store.runtime.listRecords(projectId, owner.id)).toEqual(before);
    expect(session.store.listModelUsageCalls(projectId)).toHaveLength(0);
  });

  it('冻结正式题目修订冲突阻断文档，不影响历史正文', () => {
    const q = makeQuiz(); const opened = classroom(q.stageId, q.sceneId);
    mutate('UPDATE questions SET revision=revision+1 WHERE question_id=?', q.questionId);
    expect(checkRecovery(session, opened.sessionId).layers.find(l => l.layer === 'document')).toMatchObject({ status: 'blocked', reason: 'frozen_question_version_mismatch' });
    expect(JSON.stringify(session.store.getClassroomDocument(projectId, q.stageId)!.document)).toContain('恢复题');
  });

  it('四层都有结论，恢复核对本身不发 provider 请求', () => {
    const { stageId, sceneId } = publishAndAttach();
    const opened = session.store.openClassroomSession({
      projectId, lessonId, stageId, learnerKey: 'sew:classroom:owner:v1', sceneId,
    });
    const run = session.store.getLatestRun();
    const eventsBefore = run ? session.store.listRunEvents(run.runId) : [];
    const callsBefore = session.store.listModelUsageCalls(projectId);

    const checkpoint = checkRecovery(session, opened.sessionId);
    expect(recoveryCheckpointSchema.safeParse(checkpoint).success).toBe(true);
    expect(checkpoint.layers.map((item) => item.layer)).toEqual(['document', 'board', 'attempt', 'interaction']);
    expect(checkpoint.providerCalls).toBe(0);
    expect(checkpoint.layers.every((item) => item.providerCalls === 0)).toBe(true);
    expect(checkpoint.resumable).toBe(true);
    expect(checkpoint.uid).toBe(session.learnerUid);
    expect(checkpoint.generation).toBe(session.generation);

    // 「不发 provider」不是靠自报字段证明的：核对前后台账与 run 事件必须一模一样。
    expect(session.store.listModelUsageCalls(projectId)).toEqual(callsBefore);
    expect(run ? session.store.listRunEvents(run.runId) : []).toEqual(eventsBefore);
  });

  it('未挂接课件文档时文档层明确阻断，整体不可恢复', () => {
    session.store.reviewLesson({ projectId, lessonId, version: lessonVersion, decision: 'approved', note: '' });
    session.store.publishLesson({ projectId, lessonId, version: lessonVersion });
    const opened = session.store.openClassroomSession({
      projectId, lessonId, stageId: 'stage-not-attached', learnerKey: 'sew:classroom:owner:v1', sceneId: 'scene-x',
    });
    const checkpoint = checkRecovery(session, opened.sessionId);
    const document = checkpoint.layers.find((item) => item.layer === 'document')!;
    expect(document.status).toBe('blocked');
    expect(checkpoint.resumable).toBe(false);
  });

  it('撤回课程后文档层阻断，不会静默降级成「按旧内容继续上」', () => {
    const { stageId, sceneId } = publishAndAttach();
    const opened = session.store.openClassroomSession({
      projectId, lessonId, stageId, learnerKey: 'sew:classroom:owner:v1', sceneId,
    });
    expect(checkRecovery(session, opened.sessionId).resumable).toBe(true);
    session.store.withdrawLesson({ projectId, lessonId, reason: '教师停用' });
    const after = checkRecovery(session, opened.sessionId);
    expect(after.layers.find((item) => item.layer === 'document')!.status).toBe('blocked');
    expect(after.resumable).toBe(false);
  });

  it('等待本人作答时本人作答层为等待态，而不是恢复失败', () => {
    const { stageId, sceneId } = publishAndAttach();
    const opened = session.store.openClassroomSession({
      projectId, lessonId, stageId, learnerKey: 'sew:classroom:owner:v1', sceneId,
    });
    session.store.handBackToLearner(projectId, opened.sessionId, '等本人作答');
    const checkpoint = checkRecovery(session, opened.sessionId);
    const attempt = checkpoint.layers.find((item) => item.layer === 'attempt')!;
    // 等待本人是合法状态，不是恢复失败：恢复后仍保持等待。
    expect(attempt.status).toBe('waiting');
    expect(attempt.reason).toBe('attempts_read');
    expect(checkpoint.resumable).toBe(false);
    expect(checkpoint.continuation).toBe('waiting');
  });

  it('已提交白板动作只读回不重放，序号供界面判断是否过期', () => {
    const { stageId, sceneId } = publishAndAttach();
    const opened = session.store.openClassroomSession({
      projectId, lessonId, stageId, learnerKey: 'sew:classroom:owner:v1', sceneId,
    });
    const item = session.store.createClassroomBoardItem({
      projectId, lessonId, lessonVersion, sceneId, statementIds: [statementIds[0]!],
      actor: 'local_user', requestId: 'board-1',
      content: { kind: 'text', text: '增函数：区间内任取两点，函数值随自变量增大而增大' },
    });
    const reviewed = session.store.reviewClassroomBoardItem({
      projectId, actor: 'local_user', requestId: 'board-2', itemId: item.item.itemId, expectedVersion: item.item.version,
      decision: 'approved', semanticReviewed: true, note: '与来源一致',
    });
    session.store.playClassroomBoardItem({
      projectId, actor: 'teacher', requestId: 'board-3', sessionId: opened.sessionId, itemId: item.item.itemId,
      expectedVersion: reviewed.item.version, expectedSeq: 0,
    });
    const before = session.store.classroomBoardState(projectId, opened.sessionId);
    const checkpoint = checkRecovery(session, opened.sessionId);
    const board = checkpoint.layers.find((item) => item.layer === 'board')!;
    expect(board.status).toBe('restored');
    expect(board.preserved).toBe(1);
    expect(board.discarded).toBe(0);
    // 恢复核对不产生第二个动作，序号与已执行集合都不变。
    const after = session.store.classroomBoardState(projectId, opened.sessionId);
    expect(after.seq).toBe(before.seq);
    expect(after.effects).toHaveLength(before.effects.length);
  });

  it('非互动场景不伪造互动现场，互动层如实说明无需恢复', () => {
    const { stageId, sceneId } = publishAndAttach();
    const opened = session.store.openClassroomSession({
      projectId, lessonId, stageId, learnerKey: 'sew:classroom:owner:v1', sceneId,
    });
    const checkpoint = checkRecovery(session, opened.sessionId);
    const interaction = checkpoint.layers.find((item) => item.layer === 'interaction')!;
    expect(interaction.status).toBe('restored');
    expect(interaction.reason).toBe('no_interactive_scene');
  });

  it('不存在的会话按 NOT_FOUND 拒绝，不返回一份空检查点', () => {
    expect(() => checkRecovery(session, 'cls-missing')).toThrowError(StudyError);
    try {
      checkRecovery(session, 'cls-missing');
    } catch (error) {
      expect((error as StudyError).code).toBe('NOT_FOUND');
    }
  });
});
