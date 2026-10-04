import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiResponses } from '@sew/study-contracts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeProject, openProjectFromDisk, type Session } from '../apps/learning/lib/server/service';
import { attachFormalLessonDocument } from '../apps/learning/lib/server/classroom-service';
import { POST as roomCreate } from '../apps/learning/app/api/study/rooms/route';
import { POST as classroomPost } from '../apps/learning/app/api/study/classroom/route';

describe('AI peers use the actual room lease and scoped API', () => {
  let root: string; let session: Session; let lessonId: string; let stageId: string; let scenes: string[];
  const scope = () => ({ projectId: session.projectId, generation: session.generation });
  const request = (method: string, body: unknown) => new Request('http://service.local/api/study/test', {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: scope(), ...body as Record<string, unknown> }),
  });
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
    const lesson = session.store.createLessonDraft({ projectId, lessonId: null, title: '正式定义课', bundleId: bundle.bundleId, statementIds: bundle.bundle.statements.map(row => row.statementId), questionIds: [] });
    lessonId = lesson.lessonId;
    session.store.reviewLesson({ projectId, lessonId, version: 1, decision: 'approved', note: '技术夹具人工核对' });
    session.store.publishLesson({ projectId, lessonId, version: 1 });
    const attached = attachFormalLessonDocument(session, lessonId, 1); stageId = attached.stageId; scenes = attached.scenes.map(scene => scene.sceneId);
  });
  afterEach(() => { closeProject(); rmSync(root, { recursive: true, force: true }); });


  it('peer settings and new turns serialize with the room teacher lease and return authoritative UI state', async () => {
    const peer = session.store.createRoleProfile('peer', { name: 'Peer', persona: 'questions', explanation: 'concise' });
    const room = await createRoom(); const classroom = await opened(room.roomId);
    const settings = { action: 'set-peers', sessionId: classroom.sessionId, enabled: true, engagement: 'active' };
    const lease = session.store.acquireClassroomTeacherLease({ projectId: session.projectId, roomId: room.roomId,
      executorId: 'other-executor', ttlMs: 60000 }, session.learnerUid);
    expect((await classroomPost(request('POST', settings))).status).toBe(409);
    expect(session.store.getClassroomSession(classroom.sessionId, session.projectId)?.peersEnabled).toBe(false);
    const turnBody = { action: 'peer-turn', sessionId: classroom.sessionId, roleProfileId: peer.profileId, kind: 'question', requestId: 'peerturnlease1' };
    expect((await classroomPost(request('POST', turnBody))).status).toBe(409);
    expect(session.store.listClassroomPeerTurns(session.projectId, classroom.sessionId)).toHaveLength(0);
    session.store.releaseClassroomTeacherLease({ projectId: session.projectId, roomId: room.roomId, leaseId: lease.leaseId,
      executorId: lease.executorId, runGeneration: lease.runGeneration }, session.learnerUid);
    const enabled = await classroomPost(request('POST', settings)); expect(enabled.status).toBe(200);
    expect(apiResponses.classroomPeer.parse((await enabled.json()).data).session.peersEnabled).toBe(true);
    const spoken = await classroomPost(request('POST', turnBody)); expect(spoken.status).toBe(200);
    const first = apiResponses.classroomPeer.parse((await spoken.json()).data);
    expect(first.session.roundPeerTurns).toBe(1); expect(first.peers.turnsThisRound).toBe(1);
    expect(first.turn).toMatchObject({ actorType: 'peer_ai', partition: 'simulation', roleProfileId: peer.profileId });
    const retried = await classroomPost(request('POST', turnBody)); expect(retried.status).toBe(200);
    expect(apiResponses.classroomPeer.parse((await retried.json()).data).turn).toEqual(first.turn);
    const disabled = await classroomPost(request('POST', { ...settings, enabled: false })); expect(disabled.status).toBe(200);
    expect(apiResponses.classroomPeer.parse((await disabled.json()).data).session.peersEnabled).toBe(false);
    expect((await classroomPost(request('POST', { ...turnBody, requestId: 'peerdisabled1' }))).status).toBe(403);
    expect(session.store.listClassroomPeerTurns(session.projectId, classroom.sessionId)).toHaveLength(1);
  });

  it('stale project generation cannot change peers or write a turn after reopen', async () => {
    const peer = session.store.createRoleProfile('peer', { name: 'Peer', persona: 'questions', explanation: 'concise' });
    const classroom = await opened();
    const staleSettings = request('POST', { action: 'set-peers', sessionId: classroom.sessionId, enabled: true });
    const staleTurn = request('POST', { action: 'peer-turn', sessionId: classroom.sessionId,
      roleProfileId: peer.profileId, kind: 'question', requestId: 'peerstale1' });
    closeProject(); session = openProjectFromDisk(root);
    expect((await classroomPost(staleSettings)).status).toBe(409);
    expect((await classroomPost(staleTurn)).status).toBe(409);
    expect(session.store.getClassroomSession(classroom.sessionId, session.projectId)?.peersEnabled).toBe(false);
    expect(session.store.listClassroomPeerTurns(session.projectId, classroom.sessionId)).toHaveLength(0);
  });
});
