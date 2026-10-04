import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiResponses } from '@sew/study-contracts';
import { createNodeSqliteDriver, projectPaths } from '@sew/study-storage';
import { closeProject, openProjectFromDisk, type Session } from '../apps/learning/lib/server/service';
import { attachFormalLessonDocument } from '../apps/learning/lib/server/classroom-service';
import { GET as roomsGet, POST as roomCreate, PATCH as roomPatch } from '../apps/learning/app/api/study/rooms/route';
import { GET as classroomGet, POST as classroomPost } from '../apps/learning/app/api/study/classroom/route';
import { GET as boardGet, POST as boardPost } from '../apps/learning/app/api/study/board/route';

describe('room, teacher and board use one actual classroom state', () => {
  let root: string; let session: Session; let lessonId: string; let stageId: string; let statementId: string; let scenes: string[];
  const scope = () => ({ projectId: session.projectId, generation: session.generation });
  const request = (method: string, body: unknown) => new Request('http://service.local/api/study/test', {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: scope(), ...body as Record<string, unknown> }),
  });
  const query = (extra: string) => new Request(`http://service.local/api/study/test?projectId=${session.projectId}&generation=${session.generation}${extra}`);
  const createRoom = async (requestId = 'room-create') => {
    const response = await roomCreate(request('POST', { lessonId, lessonVersion: 1, requestId }));
    expect(response.status).toBe(200);
    const data = await response.json() as { data: unknown };
    return apiResponses.classroomRoomWrite.parse(data.data).room;
  };
  const open = (roomId?: string) => classroomPost(request('POST', { action: 'open', lessonId, stageId, sceneId: scenes[0], ...(roomId ? { roomId } : {}) }));
  const opened = async (roomId?: string) => {
    const response = await open(roomId); expect(response.status).toBe(200);
    return apiResponses.classroomSession.parse((await response.json() as { data: unknown }).data).session;
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-room-board-http-')); session = openProjectFromDisk(root);
    const projectId = session.projectId;
    const material = session.store.importMaterial({ projectId, displayName: '函数定义.md', materialType: 'md', rawText: '函数增大时遵守同一区间内任意两点的定义。' }).material;
    const proposal = session.store.createProposal({ projectId, name: '增函数定义', concept: '同区间任意两点', conditions: '同一区间',
      scopeStatus: 'in_syllabus', prerequisites: [], evidence: [{ materialId: material.materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }],
      acceptance: '', priority: 'medium', proposedBy: 'user' });
    const knowledgeId = session.store.applyReview({ proposalId: proposal.proposalId, decision: 'approved', expectedRevision: proposal.revision, semanticReviewed: true }).knowledgePoint!.knowledgeId;
    session.store.savePlanVersion(projectId, 1, 'confirmed', { payloadVersion: 1, goal: '定义', examDate: null, dailyMinutes: 20,
      tasks: [{ knowledgeId, name: '定义', minutes: 20, acceptance: '', evidence: [{ materialId: material.materialId, segmentId: 'S001' }] }], gaps: [], basis: '测试', confirmedTaskKnowledgeIds: [knowledgeId] });
    const bundle = session.store.buildLessonBundle(projectId, [{ knowledgeId, text: '同一区间任取 x1 < x2', conditions: '' }, { knowledgeId, text: '函数值保持相应次序', conditions: '' }], []);
    statementId = bundle.bundle.statements[0]!.statementId;
    const lesson = session.store.createLessonDraft({ projectId, lessonId: null, title: '正式定义课', bundleId: bundle.bundleId, statementIds: bundle.bundle.statements.map(row => row.statementId), questionIds: [] });
    lessonId = lesson.lessonId;
    session.store.reviewLesson({ projectId, lessonId, version: 1, decision: 'approved', note: '技术夹具人工核对' });
    session.store.publishLesson({ projectId, lessonId, version: 1 });
    const attached = attachFormalLessonDocument(session, lessonId, 1); stageId = attached.stageId; scenes = attached.scenes.map(scene => scene.sceneId);
  });
  afterEach(() => { closeProject(); rmSync(root, { recursive: true, force: true }); });

  it('room GET does not borrow an ordinary session; explicit open binds it before teaching', async () => {
    const ordinary = await opened(); const room = await createRoom();
    const before = await classroomGet(query(`&roomId=${room.roomId}&lessonId=${lessonId}`));
    expect((await before.json())).toMatchObject({ ok: true, data: { state: null } });
    expect(session.store.getClassroomRoomForSession(session.projectId, ordinary.sessionId, session.learnerUid)).toBeNull();
    const bound = await opened(room.roomId);
    expect(bound.sessionId).toBe(ordinary.sessionId);
    expect(session.store.getClassroomRoomForSession(session.projectId, bound.sessionId, session.learnerUid)?.roomId).toBe(room.roomId);
    const other = await createRoom('second'); expect((await open(other.roomId)).status).toBe(409);
  });

  it('room scene and close commands atomically update the bound session and preserve repeat receipts', async () => {
    const room = await createRoom(); const classroom = await opened(room.roomId);
    const scene = { action: 'scene', roomId: room.roomId, expectedRevision: room.revision, sceneId: scenes[1], requestId: 'room-scene' };
    expect((await roomPatch(request('PATCH', scene))).status).toBe(200);
    expect(session.store.getClassroomSession(classroom.sessionId, session.projectId)?.currentSceneId).toBe(scenes[1]);
    const before = session.store.listClassroomActions(classroom.sessionId, session.projectId);
    expect((await roomPatch(request('PATCH', scene))).status).toBe(200);
    expect(session.store.listClassroomActions(classroom.sessionId, session.projectId)).toEqual(before);
    expect((await roomPatch(request('PATCH', { action: 'close', roomId: room.roomId, expectedRevision: 2, requestId: 'room-close' }))).status).toBe(200);
    expect(session.store.getClassroomSession(classroom.sessionId, session.projectId)?.status).toBe('completed');
    expect(session.store.getOpenClassroomSession(session.projectId)).toBeNull();
  });

  it('a failed bound-session advance rolls back the room CAS and leaves no command receipt', async () => {
    const room = await createRoom(); const classroom = await opened(room.roomId);
    session.store.handBackToLearner(session.projectId, classroom.sessionId, '等待本人');
    const response = await roomPatch(request('PATCH', { action: 'scene', roomId: room.roomId, expectedRevision: 1, sceneId: scenes[1], requestId: 'waiting-scene' }));
    expect(response.status).toBe(409);
    expect(session.store.getClassroomRoom(session.projectId, room.roomId, session.learnerUid)?.revision).toBe(1);
    expect(session.store.getClassroomSession(classroom.sessionId, session.projectId)?.currentSceneId).toBe(scenes[0]);
  });

  it('actual board routes require review, use the room lease, preserve effects after reopen and reject stale reads', async () => {
    const room = await createRoom(); const classroom = await opened(room.roomId);
    const createdResponse = await boardPost(request('POST', { action: 'create', lessonId, lessonVersion: 1, sceneId: scenes[0], statementIds: [statementId], content: { kind: 'formula', text: 'x1 < x2 且 f(x1) < f(x2)' }, requestId: 'board-new' }));
    expect(createdResponse.status).toBe(200);
    const item = apiResponses.classroomBoardItem.parse((await createdResponse.json() as { data: unknown }).data).item;
    expect((await boardPost(request('POST', { action: 'play', sessionId: classroom.sessionId, itemId: item.itemId, expectedVersion: 1, expectedSeq: 0, requestId: 'too-soon' }))).status).toBe(409);
    const reviewed = await boardPost(request('POST', { action: 'review', itemId: item.itemId, expectedVersion: 1, decision: 'approved', semanticReviewed: true, note: '定义与来源核对', requestId: 'board-review' }));
    expect(reviewed.status).toBe(200);
    const lease = session.store.acquireClassroomTeacherLease({ projectId: session.projectId, roomId: room.roomId, executorId: 'another-teacher', ttlMs: 5000 }, session.learnerUid);
    const playBody = { action: 'play', sessionId: classroom.sessionId, itemId: item.itemId, expectedVersion: 2, expectedSeq: 0, requestId: 'board-play' };
    expect((await boardPost(request('POST', playBody))).status).toBe(409);
    session.store.releaseClassroomTeacherLease({ projectId: session.projectId, roomId: room.roomId, leaseId: lease.leaseId, executorId: lease.executorId, runGeneration: lease.runGeneration }, session.learnerUid);
    expect((await boardPost(request('POST', playBody))).status).toBe(200);
    expect((await boardPost(request('POST', playBody))).status).toBe(200);
    expect(session.store.classroomBoardState(session.projectId, classroom.sessionId).effects).toHaveLength(1);
    const stale = query(`&sessionId=${classroom.sessionId}`);
    closeProject(); session = openProjectFromDisk(root);
    expect((await boardGet(stale)).status).toBe(409);
    const restored = await boardGet(query(`&sessionId=${classroom.sessionId}`)); expect(restored.status).toBe(200);
    expect(apiResponses.classroomBoardContext.parse((await restored.json() as { data: unknown }).data).state.effects).toHaveLength(1);
  });

  it('教师聚焦只能指向本场景真实存在的元素，伪造元素编号被服务端拒绝', async () => {
    const room = await createRoom(); const classroom = await opened(room.roomId);
    // 场景元素编号来自该版本冻结课件，界面据此给出候选项。
    const context = await boardGet(query(`&sessionId=${classroom.sessionId}`));
    const elementIds = apiResponses.classroomBoardContext.parse((await context.json() as { data: unknown }).data).elementIds;
    expect(elementIds.length).toBeGreaterThan(0);
    const realElement = elementIds[0]!;

    const forged = await boardPost(request('POST', { action: 'create', lessonId, lessonVersion: 1, sceneId: scenes[0], statementIds: [statementId],
      content: { kind: 'focus', elementId: 'scene-forged-element', text: '聚焦到一个不存在的元素' }, requestId: 'focus-forged' }));
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect(session.store.classroomBoardState(session.projectId, classroom.sessionId).items).toHaveLength(0);

    const created = await boardPost(request('POST', { action: 'create', lessonId, lessonVersion: 1, sceneId: scenes[0], statementIds: [statementId],
      content: { kind: 'focus', elementId: realElement, text: '这里是本课的关键定义' }, requestId: 'focus-real' }));
    expect(created.status).toBe(200);
    const item = apiResponses.classroomBoardItem.parse((await created.json() as { data: unknown }).data).item;
    expect(item.content).toEqual({ kind: 'focus', elementId: realElement, text: '这里是本课的关键定义' });
    const reviewed = await boardPost(request('POST', { action: 'review', itemId: item.itemId, expectedVersion: 1, decision: 'approved', semanticReviewed: true, note: '聚焦位置与来源一致', requestId: 'focus-review' }));
    expect(reviewed.status).toBe(200);
    const played = await boardPost(request('POST', { action: 'play', sessionId: classroom.sessionId, itemId: item.itemId, expectedVersion: 2, expectedSeq: 0, requestId: 'focus-play' }));
    expect(played.status).toBe(200);
    const effects = session.store.classroomBoardState(session.projectId, classroom.sessionId).effects;
    expect(effects[0]!.item.content).toEqual({ kind: 'focus', elementId: realElement, text: '这里是本课的关键定义' });
  });

  it('公式带数学排版源码时往返保存，危险控制序列在合同层被拒', async () => {
    const room = await createRoom(); const classroom = await opened(room.roomId);
    const created = await boardPost(request('POST', { action: 'create', lessonId, lessonVersion: 1, sceneId: scenes[0], statementIds: [statementId],
      content: { kind: 'formula', text: 'x1 < x2 推出 f(x1) < f(x2)', latex: 'x_{1} < x_{2} \\Rightarrow f(x_{1}) < f(x_{2})' }, requestId: 'formula-latex' }));
    expect(created.status).toBe(200);
    const item = apiResponses.classroomBoardItem.parse((await created.json() as { data: unknown }).data).item;
    expect(item.content).toMatchObject({ kind: 'formula', latex: 'x_{1} < x_{2} \\Rightarrow f(x_{1}) < f(x_{2})' });

    // 只给纯文本也能保存：排版源码留空时降级为纯文本，不会变成空白。
    const plain = await boardPost(request('POST', { action: 'create', lessonId, lessonVersion: 1, sceneId: scenes[0], statementIds: [statementId],
      content: { kind: 'formula', text: 'f(x)=x^2' }, requestId: 'formula-plain' }));
    expect(plain.status).toBe(200);
    expect(apiResponses.classroomBoardItem.parse((await plain.json() as { data: unknown }).data).item.content).toEqual({ kind: 'formula', text: 'f(x)=x^2', latex: null });

    for (const dangerous of ['\\href{https://evil.example}{点我}', '\\includegraphics{D:/secret.png}', '\\input{/etc/passwd}']) {
      const rejected = await boardPost(request('POST', { action: 'create', lessonId, lessonVersion: 1, sceneId: scenes[0], statementIds: [statementId],
        content: { kind: 'formula', text: '危险公式', latex: dangerous }, requestId: `formula-bad-${Math.abs(dangerous.length)}` }));
      expect(rejected.status).toBe(400);
    }
    expect(session.store.classroomBoardState(session.projectId, classroom.sessionId).items).toHaveLength(2);
  });

  it('read endpoints reject stale scopes and forged owner payloads without creating a room', async () => {
    expect((await roomsGet(query('&uid=forged'))).status).toBe(400);
    const body = { lessonId, lessonVersion: 1, requestId: 'forged', ownerUid: session.learnerUid };
    expect((await roomCreate(request('POST', body))).status).toBe(400);
    expect(session.store.listLocalClassroomRooms(session.projectId, session.learnerUid)).toEqual([]);
    const stale = query(''); closeProject(); session = openProjectFromDisk(root);
    expect((await roomsGet(stale)).status).toBe(409);
  });

  it('public snapshots use plain text and exclude arbitrary HTML, answers and caller metadata', async () => {
    const room = await createRoom();
    const response = await roomsGet(query(`&roomId=${room.roomId}`)); expect(response.status).toBe(200);
    const snapshot = apiResponses.classroomRooms.parse((await response.json() as { data: unknown }).data).snapshot!;
    const slide = snapshot.scenes[0]!; expect(slide.type).toBe('slide');
    if (slide.type === 'slide') expect(slide.elements.every(element => !('html' in element) && !/<p|<h1/.test(element.text))).toBe(true);
    const db = createNodeSqliteDriver().open(projectPaths(root).databaseFile);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]); db.close();
  });
});
