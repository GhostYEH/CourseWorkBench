import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiResponses } from '@sew/study-contracts';
import { RUNTIME_DSL_VERSION } from '@openmaic/dsl';
import { closeProject, openProjectFromDisk, type Session } from '../apps/learning/lib/server/service';
import { attachFormalLessonDocument } from '../apps/learning/lib/server/classroom-service';
import { GET as recoveryGet } from '../apps/learning/app/api/study/recovery/route';
import { POST as classroomPost } from '../apps/learning/app/api/study/classroom/route';
import { POST as boardPost } from '../apps/learning/app/api/study/board/route';
import { POST as generatePost } from '../apps/learning/app/api/study/generate/route';
import { PATCH as roomPatch } from '../apps/learning/app/api/study/rooms/route';
import { modelConnection } from '../apps/learning/lib/server/model-connection';

describe('recovery gates production classroom commands without replaying receipts', () => {
  let root: string; let session: Session; let lessonId: string; let stageId: string; let statementId: string; let scenes: string[]; let quizScene: string; let dslId: string; let peerId: string;
  const scope = () => ({ projectId: session.projectId, generation: session.generation });
  const request = (method: string, body: unknown) => new Request('http://service.local/api/study/test', {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: scope(), ...body as Record<string, unknown> }),
  });
  const query = (extra: string) => new Request(`http://service.local/api/study/test?projectId=${session.projectId}&generation=${session.generation}${extra}`);
  const opened = async (noStage = false, roomId?: string) => {
    if (noStage) {
      const current = session.store.getLessonVersion(lessonId, 1, session.projectId)!;
      const lesson = session.store.createLessonDraft({ projectId: session.projectId, lessonId: null, title: '未挂课件的旧工作面',
        bundleId: current.bundleId, statementIds: current.statementIds, questionIds: current.questionIds });
      lessonId = lesson.lessonId;
      session.store.reviewLesson({ projectId: session.projectId, lessonId, version: 1, decision: 'approved', note: '人工核对' });
      session.store.publishLesson({ projectId: session.projectId, lessonId, version: 1 });
    }
    const response = await classroomPost(request('POST', { action: 'open', lessonId, stageId: noStage ? null : stageId, sceneId: noStage ? 'legacy-scene' : scenes[0], ...(roomId ? { roomId } : {}) }));
    expect(response.status).toBe(200);
    return apiResponses.classroomSession.parse((await response.json()).data).session;
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-recovery-http-')); session = openProjectFromDisk(root);
    const projectId = session.projectId;
    const material = session.store.importMaterial({ projectId, displayName: '函数定义.md', materialType: 'md', rawText: '函数增大时遵守同一区间内任意两点的定义。' }).material;
    const proposal = session.store.createProposal({ projectId, name: '增函数定义', concept: '同区间任意两点', conditions: '同一区间',
      scopeStatus: 'in_syllabus', prerequisites: [], evidence: [{ materialId: material.materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }],
      acceptance: '', priority: 'medium', proposedBy: 'user' });
    const knowledgeId = session.store.applyReview({ proposalId: proposal.proposalId, decision: 'approved', expectedRevision: proposal.revision, semanticReviewed: true }).knowledgePoint!.knowledgeId;
    session.store.savePlanVersion(projectId, 1, 'confirmed', { payloadVersion: 1, goal: '定义', examDate: null, dailyMinutes: 20,
      tasks: [{ knowledgeId, name: '定义', minutes: 20, acceptance: '', evidence: [{ materialId: material.materialId, segmentId: 'S001' }] }], gaps: [], basis: '测试', confirmedTaskKnowledgeIds: [knowledgeId] });
    const question = session.store.createQuestion({ stem: '恢复题', answer: 'A', solution: '定义', knowledgeIds: [knowledgeId], requestedOrigin: 'ai_new', originRecord: null,
      assessment: { schemaVersion: 1, type: 'single', options: [{ value: 'A', label: '定义' }, { value: 'B', label: '反例' }], correctAnswers: ['A'], maxScore: 5, rubric: '定义', answerVersion: 1 } }).question;
    const bundle = session.store.buildLessonBundle(projectId, [{ knowledgeId, text: '同一区间任取 x1 < x2', conditions: '' }, { knowledgeId, text: '函数值保持相应次序', conditions: '' }], [question.questionId]);
    statementId = bundle.bundle.statements[0]!.statementId;
    const lesson = session.store.createLessonDraft({ projectId, lessonId: null, title: '正式定义课', bundleId: bundle.bundleId, statementIds: bundle.bundle.statements.map(row => row.statementId), questionIds: [question.questionId] });
    lessonId = lesson.lessonId;
    session.store.reviewLesson({ projectId, lessonId, version: 1, decision: 'approved', note: '技术夹具人工核对' });
    session.store.publishLesson({ projectId, lessonId, version: 1 });
    const attached = attachFormalLessonDocument(session, lessonId, 1); stageId = attached.stageId; scenes = attached.scenes.map(scene => scene.sceneId);
    quizScene = [...session.store.listClassroomSceneSources(projectId, stageId).values()].find(source => source.questionId === question.questionId)!.sceneId;
    const document = session.store.getClassroomDocument(projectId, stageId)!.document as { scenes: Array<{ id: string; content: { questions?: Array<{ id: string }> } }> };
    dslId = document.scenes.find(scene => scene.id === quizScene)!.content.questions![0]!.id;
    peerId = session.store.createRoleProfile('peer', { name: '同学', persona: '提问', explanation: 'concise' }).profileId;
  });
  afterEach(() => { vi.restoreAllMocks(); closeProject(); rmSync(root, { recursive: true, force: true }); });


  const checkpoint = async (sessionId: string) => {
    const response = await recoveryGet(query(`&sessionId=${sessionId}`)); expect(response.status).toBe(200);
    return apiResponses.recovery.parse((await response.json()).data).checkpoint;
  };
  const runtimeRecord = (mode: 'broken' | 'unconfirmed' | 'missing-receipt' = 'broken') => {
    const at = new Date().toISOString(); const id = `runtime-${mode}`;
    session.store.runtime.createSession(session.projectId, { id, kind: 'quizAttempt', stageId,
      learnerKey: session.store.getLocalLearnerBinding(session.projectId)!.learnerKey,
      runtimeDslVersion: RUNTIME_DSL_VERSION, status: 'active', createdAt: at, updatedAt: at });
    // 已完成的会话不能再追加记录：要用 appendRecord 的 sessionTransition 把「写记录 + 置为完成」
    // 放在同一次原子操作里，否则夹具本身就构造不出「已完成且有审核结果」的合法状态。
    session.store.runtime.appendRecord(session.projectId, { id: `record-${mode}`, sessionId: id, sceneId: quizScene,
      subAnchor: dslId, createdAt: at, payload: { payloadVersion: mode === 'broken' ? 99 : 1,
        phase: mode === 'missing-receipt' ? 'reviewed' : 'submitted', answers: { [dslId]: 'A' },
        ...(mode === 'missing-receipt' ? { results: [{ questionId: dslId }] } : {}) } },
      mode === 'missing-receipt' ? { sessionTransition: { status: 'completed', updatedAt: at } } : {});
  };
  const card = async (sceneId: string) => {
    const created = await classroomPost(request('POST', { action: 'create-card', lessonId, lessonVersion: 1, sceneId,
      kind: 'explain', text: '审核过的定义讲解', statementIds: [statementId] })); expect(created.status).toBe(200);
    const draft = apiResponses.explanationWrite.parse((await created.json()).data).card;
    expect((await classroomPost(request('POST', { action: 'review-card', explanationId: draft.explanationId, decision: 'approved', note: '人工核对' }))).status).toBe(200);
    return draft;
  };
  const boardItem = async (sceneId: string) => {
    const created = await boardPost(request('POST', { action: 'create', lessonId, lessonVersion: 1, sceneId,
      statementIds: [statementId], content: { kind: 'text', text: '审核白板定义' }, requestId: 'boardnew1' })); expect(created.status).toBe(200);
    const item = apiResponses.classroomBoardItem.parse((await created.json()).data).item;
    expect((await boardPost(request('POST', { action: 'review', itemId: item.itemId, expectedVersion: 1, decision: 'approved',
      semanticReviewed: true, note: '人工核对', requestId: 'boardreview1' }))).status).toBe(200);
    return item;
  };
  const effects = (sessionId: string) => ({ actions: session.store.listClassroomActions(sessionId, session.projectId),
    board: session.store.classroomBoardState(session.projectId, sessionId), peers: session.store.listClassroomPeerTurns(session.projectId, sessionId) });

  it.each(['broken', 'missing-receipt'] as const)('%s owned quiz history blocks new actions but leaves stop commands usable', async mode => {
    const classroom = await opened(); await card(scenes[0]!); const item = await boardItem(scenes[0]!);
    expect((await classroomPost(request('POST', { action: 'set-peers', sessionId: classroom.sessionId, enabled: true }))).status).toBe(200);
    runtimeRecord(mode);
    const recovered = await checkpoint(classroom.sessionId);
    expect(recovered.continuation).toBe('blocked'); expect(recovered.layers.find(layer => layer.layer === 'document')?.status).toBe('restored');
    const before = effects(classroom.sessionId);
    for (const body of [
      { action: 'play-next', requestId: 'blockedplay1' },
      { action: 'advance-scene', sceneId: scenes[1], requestId: 'blockedadvance1' },
      { action: 'peer-turn', roleProfileId: peerId, kind: 'question', requestId: 'blockedpeer1' },
      { action: 'learner-answered' },
    ]) expect((await classroomPost(request('POST', { sessionId: classroom.sessionId, ...body }))).status).toBe(409);
    expect((await boardPost(request('POST', { action: 'play', sessionId: classroom.sessionId, itemId: item.itemId,
      expectedVersion: 2, expectedSeq: 0, requestId: 'blockedboard1' }))).status).toBe(409);
    const generate = vi.spyOn(modelConnection, 'generate');
    const lesson = session.store.getLessonVersion(lessonId, 1, session.projectId)!;
    const generated = await generatePost(request('POST', { purpose: 'teaching_prompt', lessonId, bundleId: lesson.bundleId,
      instruction: '解释当前定义', requestId: 'blockedgeneration1' }));
    expect(generated.status).toBe(409); expect(generate).not.toHaveBeenCalled();
    expect(session.store.listModelUsageCalls(session.projectId)).toEqual([]);
    expect(effects(classroom.sessionId)).toEqual(before);
    expect((await classroomPost(request('POST', { action: 'handback', sessionId: classroom.sessionId, reason: '安全停止' }))).status).toBe(200);
    expect(session.store.getClassroomSession(classroom.sessionId, session.projectId)?.status).toBe('awaiting_learner');
    expect((await classroomPost(request('POST', { action: 'close', sessionId: classroom.sessionId, status: 'cancelled', reason: '停止' }))).status).toBe(200);
  });

  it('a bound room cannot advance past blocked recovery and the room change rolls back', async () => {
    const room = session.store.createLocalClassroomRoom({ projectId: session.projectId, lessonId, lessonVersion: 1, requestId: 'recovery-room' }, session.learnerUid).room;
    const classroom = await opened(false, room.roomId);
    runtimeRecord(); const before = effects(classroom.sessionId);
    const blocked = await roomPatch(request('PATCH', { action: 'scene', roomId: room.roomId, expectedRevision: room.revision,
      sceneId: scenes[1], requestId: 'blocked-room-scene' }));
    expect(blocked.status).toBe(409);
    expect(session.store.getClassroomRoom(session.projectId, room.roomId, session.learnerUid)).toEqual(room);
    expect(effects(classroom.sessionId)).toEqual(before);
    expect((await roomPatch(request('PATCH', { action: 'close', roomId: room.roomId, expectedRevision: room.revision,
      requestId: 'recovery-room-close' }))).status).toBe(200);
  });

  it('receipt retries bypass a broken recovery layer and nonce changes still conflict', async () => {
    const classroom = await opened(); await card(scenes[0]!); const item = await boardItem(scenes[0]!);
    await classroomPost(request('POST', { action: 'set-peers', sessionId: classroom.sessionId, enabled: true }));
    const play = { action: 'play-next', sessionId: classroom.sessionId, requestId: 'receiptplay1' };
    const peer = { action: 'peer-turn', sessionId: classroom.sessionId, roleProfileId: peerId, kind: 'question', requestId: 'receiptpeer1' };
    const board = { action: 'play', sessionId: classroom.sessionId, itemId: item.itemId, expectedVersion: 2, expectedSeq: 0, requestId: 'receiptboard1' };
    const advance = { action: 'advance-scene', sessionId: classroom.sessionId, sceneId: scenes[1], requestId: 'receiptadvance1' };
    const playedResponse = await classroomPost(request('POST', play)); expect(playedResponse.status).toBe(200);
    const played = apiResponses.classroomPlay.parse((await playedResponse.json()).data);
    const peerResponse = await classroomPost(request('POST', peer)); expect(peerResponse.status).toBe(200);
    const spoken = apiResponses.classroomPeer.parse((await peerResponse.json()).data);
    const boardResponse = await boardPost(request('POST', board)); expect(boardResponse.status).toBe(200);
    const written = (await boardResponse.json()).data;
    expect((await classroomPost(request('POST', advance))).status).toBe(200);
    runtimeRecord(); expect((await checkpoint(classroom.sessionId)).continuation).toBe('blocked');
    const before = effects(classroom.sessionId);
    const replay = await classroomPost(request('POST', play)); expect(replay.status).toBe(200);
    expect(apiResponses.classroomPlay.parse((await replay.json()).data).card).toEqual(played.card);
    const peerReplay = await classroomPost(request('POST', peer)); expect(peerReplay.status).toBe(200);
    expect(apiResponses.classroomPeer.parse((await peerReplay.json()).data).turn).toEqual(spoken.turn);
    const boardReplay = await boardPost(request('POST', board)); expect(boardReplay.status).toBe(200);
    expect((await boardReplay.json()).data).toMatchObject({ ...written, deduplicated: true });
    const advanceReplay = await classroomPost(request('POST', advance)); expect(advanceReplay.status).toBe(200);
    expect((await advanceReplay.json()).data.deduplicated).toBe(true);
    expect((await classroomPost(request('POST', { ...advance, sceneId: scenes[0] }))).status).toBe(409);
    expect((await boardPost(request('POST', { ...board, expectedSeq: 1 }))).status).toBe(409);
    expect((await classroomPost(request('POST', { ...peer, kind: 'discussion' }))).status).toBe(409);
    expect(effects(classroom.sessionId)).toEqual(before);
  });

  it('a submitted quiz without confirmation prevents learner-answered from leaving waiting', async () => {
    const classroom = await opened(); runtimeRecord('unconfirmed');
    expect((await classroomPost(request('POST', { action: 'handback', sessionId: classroom.sessionId, reason: '等待确认本人提交' }))).status).toBe(200);
    const recovered = await checkpoint(classroom.sessionId);
    expect(recovered.continuation).toBe('waiting');
    expect(recovered.layers.find(layer => layer.layer === 'attempt')?.reason).toBe('quiz_submission_unconfirmed');
    const before = effects(classroom.sessionId);
    expect((await classroomPost(request('POST', { action: 'learner-answered', sessionId: classroom.sessionId }))).status).toBe(409);
    expect(session.store.getClassroomSession(classroom.sessionId, session.projectId)?.status).toBe('awaiting_learner');
    expect(effects(classroom.sessionId)).toEqual(before);
  });

  it('legacy classrooms without a stage can teach reviewed material but still reject invalid sources', async () => {
    const classroom = await opened(true); expect(classroom.stageId).toBeNull();
    const approved = await card('legacy-scene');
    await classroomPost(request('POST', { action: 'set-peers', sessionId: classroom.sessionId, enabled: true, engagement: 'active' }));
    const played = await classroomPost(request('POST', { action: 'play-next', sessionId: classroom.sessionId, requestId: 'legacyplay1' }));
    expect(played.status).toBe(200);
    expect(apiResponses.classroomPlay.parse((await played.json()).data).card?.explanationId).toBe(approved.explanationId);
    expect((await classroomPost(request('POST', { action: 'peer-turn', sessionId: classroom.sessionId, roleProfileId: peerId,
      kind: 'question', requestId: 'legacypeer1' }))).status).toBe(200);
    const before = effects(classroom.sessionId);
    session.store.importMaterial({ projectId: session.projectId, displayName: '函数定义.md', materialType: 'md', rawText: '来源已修订。' });
    for (const body of [{ action: 'play-next', requestId: 'legacyplay2' },
      { action: 'peer-turn', roleProfileId: peerId, kind: 'question', requestId: 'legacypeer2' }]) {
      const response = await classroomPost(request('POST', { ...body, sessionId: classroom.sessionId }));
      expect(response.status).toBe(409); expect((await response.json()).error.code).toBe('KNOWLEDGE_INVALIDATED');
    }
    expect(effects(classroom.sessionId)).toEqual(before);
  });
});
