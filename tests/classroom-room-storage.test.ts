import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_LOCAL_LEARNER_KEY, classroomRoomCreateSchema, classroomRoomCommandSchema, classroomSharedCourseSchema,
  type ClassroomTeacherLeaseDto,
} from '@sew/study-contracts';
import { classroomDocumentDigest } from '@sew/study-domain';
import { StudyStore, createNodeSqliteDriver } from '@sew/study-storage';
import { buildFormalLessonDocument } from '../apps/learning/lib/classroom/formal-lesson-document';

const UID = 'uid_10000000-0000-4000-8000-000000000001';
const OTHER = 'uid_10000000-0000-4000-8000-000000000002';
const roots: string[] = [];
const stores: StudyStore[] = [];
afterEach(() => {
  vi.useRealTimers();
  stores.splice(0).forEach(store => store.close());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sew-classroom-room-')); roots.push(root);
  const file = join(root, 'study.db');
  let store = StudyStore.open({ file }); stores.push(store);
  const projectId = 'p';
  store.createProject({ projectId, displayName: '数学', subject: '数学' });
  store.bindLocalLearner(projectId, UID);
  const imported = store.importMaterial({ projectId, displayName: '本课来源', materialType: 'txt', readableLocation: 'D:/private/original.txt',
    rawText: '增函数在区间内任取两点时函数值随自变量增大。\n\n私人材料库中的另一段，与本课无关。' });
  const materialId = imported.material.materialId;
  const proposal = store.createProposal({ projectId, name: '增函数', concept: '函数值随自变量增大', conditions: '同一区间', scopeStatus: 'in_syllabus',
    prerequisites: [], evidence: [{ materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }], acceptance: '', priority: 'medium', proposedBy: 'user' });
  const knowledgeId = store.applyReview({ proposalId: proposal.proposalId, decision: 'approved', expectedRevision: proposal.revision, semanticReviewed: true }).knowledgePoint!.knowledgeId;
  const question = store.createQuestion({ stem: '哪个描述符合增函数？', answer: '私有正确答案内容', solution: '私有评分解析内容', knowledgeIds: [knowledgeId], requestedOrigin: 'ai_new', originRecord: null,
    assessment: { schemaVersion: 1, type: 'single', options: [{ value: 'A', label: '同区间同步增大' }, { value: 'B', label: '始终递减' }], correctAnswers: ['A'], rubric: '私有给分点', maxScore: 2, answerVersion: 1 } }).question;
  store.savePlanVersion(projectId, 1, 'confirmed', { payloadVersion: 1, goal: '掌握增函数', examDate: null, dailyMinutes: 40,
    tasks: [{ knowledgeId, name: '增函数', minutes: 20, acceptance: '', evidence: [{ materialId, segmentId: 'S001' }] }], gaps: [], basis: '核实材料', confirmedTaskKnowledgeIds: [knowledgeId] });
  const bundle = store.buildLessonBundle(projectId, [{ knowledgeId, text: '函数值随自变量增大', conditions: '同一区间' }], [question.questionId]);
  const lesson = store.createLessonDraft({ projectId, lessonId: null, title: '增函数课堂', bundleId: bundle.bundleId, statementIds: bundle.bundle.statements.map(statement => statement.statementId), questionIds: [question.questionId] });
  store.reviewLesson({ projectId, lessonId: lesson.lessonId, version: 1, decision: 'approved', note: '核对原文' });
  store.publishLesson({ projectId, lessonId: lesson.lessonId, version: 1 });
  const document = buildFormalLessonDocument({ bundle: bundle.bundle, bundleDigest: bundle.digest, lessonId: lesson.lessonId, lessonVersion: 1, title: lesson.title,
    frozenAt: bundle.frozenAt, statementIds: lesson.statementIds, questionIds: lesson.questionIds });
  const attach = (value: unknown = document.document): void => {
    const digest = classroomDocumentDigest(value);
    store.saveClassroomDocument({ projectId, lessonId: lesson.lessonId, stageId: document.stageId, dslVersion: document.dslVersion, document: value, digest, sceneCount: document.scenes.length,
      scenes: document.scenes.map(scene => ({ sceneId: scene.sceneId, knowledgeIds: scene.knowledgeIds, questionId: scene.questionId })), reviewedBy: 'local_user', reviewNote: '核对课件', recordScope: 'formal' });
    store.attachLessonDocument({ projectId, lessonId: lesson.lessonId, version: 1, stageId: document.stageId, documentDigest: digest });
  };
  attach();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  store.putClassroomAsset(projectId, 'asset_one', 'image/png', { privateAnswer: '私人资产元数据', path: 'D:/secret/key', apiKey: 'never-share-this-key' }, bytes);
  store.putClassroomAssetBinding(projectId, document.stageId, document.scenes[0]!.sceneId, 'illustration', 'asset_one');
  store.submitAttempt({ projectId, questionId: question.questionId, idempotencyKey: 'private-answer', kind: 'real', actorType: 'human_learner', answerText: 'B', processText: '本人私有过程' });
  const create = (requestId = 'room-create') => store.createLocalClassroomRoom({ projectId, lessonId: lesson.lessonId, lessonVersion: 1, requestId }, UID);
  const sql = (callback: (db: ReturnType<ReturnType<typeof createNodeSqliteDriver>['open']>) => void) => {
    const db = createNodeSqliteDriver().open(file); try { callback(db); } finally { db.close(); }
  };
  const reopen = () => {
    store.close(); stores.splice(stores.indexOf(store), 1);
    store = StudyStore.open({ file }); stores.push(store); return store;
  };
  return { get store() { return store; }, projectId, file, materialId, knowledgeId, lesson, bundle, document, bytes, create, sql, reopen, attach };
}
const leaseCheck = (roomId: string, lease: ClassroomTeacherLeaseDto) => ({ projectId: 'p', roomId, leaseId: lease.leaseId, executorId: lease.executorId, runGeneration: lease.runGeneration });

describe('ROOM-01 frozen local room authority', () => {
  it('freezes only public lesson content, necessary evidence and asset identities without personal records, paths or metadata', () => {
    const f = fixture(); const { room } = f.create();
    expect(room).toMatchObject({ mode: 'local_single', ownerUid: UID, revision: 1, status: 'ready', runGeneration: 0 });
    expect(room.members).toEqual([{ uid: UID, role: 'owner', identityAuthority: 'local_only', status: 'joined', canControl: true }]);
    const snapshot = f.store.readClassroomRoomSnapshot('p', room.roomId, UID);
    expect(classroomSharedCourseSchema.parse(snapshot)).toEqual(snapshot);
    const json = JSON.stringify(snapshot);
    for (const excluded of ['私有正确答案内容', '私有评分解析内容', '私有给分点', '本人原始私有答案', '本人私有过程', '私人资产元数据', 'never-share-this-key', 'D:/private', 'D:/secret', '私人材料库中的另一段']) expect(json).not.toContain(excluded);
    expect(snapshot.evidence.segments).toHaveLength(1);
    expect(snapshot.assets[0]).not.toHaveProperty('metadata');
    const quiz = snapshot.scenes.find(scene => scene.type === 'quiz');
    expect(quiz?.type === 'quiz' && quiz.questions[0]).toEqual({ questionId: f.lesson.questionIds[0], type: 'single', stem: '哪个描述符合增函数？', options: [{ value: 'A', label: '同区间同步增大' }, { value: 'B', label: '始终递减' }] });
    expect(f.store.readClassroomRoomAsset('p', room.roomId, UID, 'asset_one')?.bytes).toEqual(f.bytes);
  });

  it('deduplicates creation while detecting nonce/intent collisions and client identity forgery', () => {
    const f = fixture(); const initial = f.create();
    expect(f.create()).toEqual({ ...initial, deduplicated: true });
    expect(f.store.listLocalClassroomRooms('p', UID)).toHaveLength(1);
    expect(() => f.store.createLocalClassroomRoom({ projectId: 'p', lessonId: f.lesson.lessonId, lessonVersion: 2, requestId: 'room-create' }, UID)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    expect(classroomRoomCreateSchema.safeParse({ scope: { projectId: 'p', generation: 1 }, lessonId: f.lesson.lessonId, lessonVersion: 1, requestId: 'forged', ownerUid: OTHER }).success).toBe(false);
    expect(classroomRoomCommandSchema.safeParse({ action: 'scene', scope: { projectId: 'p', generation: 1 }, roomId: initial.room.roomId, expectedRevision: 1, sceneId: initial.room.currentSceneId, requestId: 'forged', uid: OTHER }).success).toBe(false);
  });

  it('rejects every room read, asset read, command and lease from a different local identity or project', () => {
    const f = fixture(); const { room } = f.create();
    for (const action of [
      () => f.store.getClassroomRoom('p', room.roomId, OTHER),
      () => f.store.readClassroomRoomSnapshot('p', room.roomId, OTHER),
      () => f.store.readClassroomRoomAsset('p', room.roomId, OTHER, 'asset_one'),
      () => f.store.listLocalClassroomRooms('p', OTHER),
      () => f.store.setClassroomRoomScene({ projectId: 'p', roomId: room.roomId, expectedRevision: 1, sceneId: room.currentSceneId, requestId: 'forged' }, OTHER),
      () => f.store.closeClassroomRoom({ projectId: 'p', roomId: room.roomId, expectedRevision: 1, requestId: 'forged' }, OTHER),
      () => f.store.acquireClassroomTeacherLease({ projectId: 'p', roomId: room.roomId, executorId: 'forged', ttlMs: 1000 }, OTHER),
      () => f.store.getClassroomRoom('other-project', room.roomId, UID),
    ]) expect(action).toThrowError(expect.objectContaining({ code: 'PROJECT_NOT_AUTHORIZED' }));
  });

  it('rejects an outdated requested version and unsupported shared scene types without partially creating a room', () => {
    const f = fixture();
    expect(() => f.store.createLocalClassroomRoom({ projectId: 'p', lessonId: f.lesson.lessonId, lessonVersion: 2, requestId: 'old-version' }, UID)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    const unsupported = { ...f.document.document, scenes: f.document.document.scenes.map((scene, index) => index === 0 ? { ...scene, type: 'interactive', content: { type: 'interactive', html: '<p>unsupported</p>' } } : scene) };
    f.attach(unsupported);
    expect(() => f.create()).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(f.store.listLocalClassroomRooms('p', UID)).toEqual([]);
  });

  it.each(['<a href="file:///C:/private/answer.txt">source</a>', '<img src="https://uncontrolled.example/x">',
    '<script>fetch("https://uncontrolled.example/x")</script>', '<a href="javascript:alert(1)">source</a>',
    '<span style="background:url(https://uncontrolled.example/x)">source</span>'])('rejects unsafe resource or executable markup in a public slide: %s', markup => {
    const f = fixture(); const source = structuredClone(f.document.document);
    const first = source.scenes[0]!;
    if (first.type !== 'slide') throw new Error('fixture slide missing');
    const element = first.content.canvas.elements[0]!;
    if (element.type !== 'text') throw new Error('fixture text missing');
    element.content = markup;
    f.attach(source);
    expect(() => f.create()).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(f.store.listLocalClassroomRooms('p', UID)).toEqual([]);
  });

  it('keeps the frozen snapshot when a newer draft or publication appears and refuses drifting teaching actions', () => {
    const f = fixture(); const { room } = f.create(); const snapshot = f.store.readClassroomRoomSnapshot('p', room.roomId, UID);
    const draft = f.store.createLessonDraft({ projectId: 'p', lessonId: f.lesson.lessonId, title: '新草案', bundleId: f.bundle.bundleId, statementIds: f.lesson.statementIds, questionIds: f.lesson.questionIds });
    expect(f.store.readClassroomRoomSnapshot('p', room.roomId, UID)).toEqual(snapshot);
    f.store.reviewLesson({ projectId: 'p', lessonId: draft.lessonId, version: draft.version, decision: 'approved', note: '新版本审核' });
    f.store.publishLesson({ projectId: 'p', lessonId: draft.lessonId, version: draft.version });
    expect(f.store.readClassroomRoomSnapshot('p', room.roomId, UID)).toEqual(snapshot);
    expect(() => f.store.setClassroomRoomScene({ projectId: 'p', roomId: room.roomId, expectedRevision: 1, sceneId: room.currentSceneId, requestId: 'late-scene' }, UID)).toThrowError(expect.objectContaining({ code: 'CLASSROOM_LESSON_NOT_REVIEWED' }));
  });

  it('blocks new room teaching and creation after source invalidation while allowing an explicit close', () => {
    const f = fixture(); const { room } = f.create();
    const before = f.store.readClassroomRoomSnapshot('p', room.roomId, UID);
    f.store.importMaterial({ projectId: 'p', displayName: '本课来源', materialType: 'txt', rawText: '来源已变更，旧版本需重新核对。' });
    expect(() => f.create('invalid-source')).toThrow();
    expect(() => f.store.acquireClassroomTeacherLease({ projectId: 'p', roomId: room.roomId, executorId: 'new-teacher', ttlMs: 1000 }, UID)).toThrow();
    expect(() => f.store.setClassroomRoomScene({ projectId: 'p', roomId: room.roomId, expectedRevision: 1, sceneId: room.currentSceneId, requestId: 'invalid-source' }, UID)).toThrow();
    expect(f.store.readClassroomRoomSnapshot('p', room.roomId, UID)).toEqual(before);
    expect(f.store.closeClassroomRoom({ projectId: 'p', roomId: room.roomId, expectedRevision: 1, requestId: 'close-invalid' }, UID).room.status).toBe('ended');
  });

  it('owns independent resource bytes so changes to the original asset never change the frozen room', () => {
    const f = fixture(); const { room } = f.create();
    f.sql(db => db.prepare('UPDATE classroom_assets SET bytes=?,metadata_json=? WHERE project_id=? AND asset_id=?').run(new Uint8Array([99]), JSON.stringify({ path: 'D:/changed' }), 'p', 'asset_one'));
    expect(f.store.readClassroomRoomAsset('p', room.roomId, UID, 'asset_one')?.bytes).toEqual(f.bytes);
    expect(f.store.readClassroomRoomSnapshot('p', room.roomId, UID).assets[0]?.byteLength).toBe(4);
  });

  it('rejects corrupt snapshot JSON, snapshot identity and member authorities rather than accepting a fallback', () => {
    const f = fixture(); const { room } = f.create();
    f.sql(db => db.prepare('UPDATE classroom_rooms SET snapshot_json=?').run('{broken'));
    expect(() => f.store.readClassroomRoomSnapshot('p', room.roomId, UID)).toThrowError(expect.objectContaining({ code: 'INTERNAL' }));
    f.sql(db => db.prepare('UPDATE classroom_room_members SET member_json=?').run(JSON.stringify({ ...room.members[0], identityAuthority: 'online_authenticated' })));
    expect(() => f.store.getClassroomRoom('p', room.roomId, UID)).toThrowError(expect.objectContaining({ code: 'INTERNAL' }));
  });

  it('detects valid-schema snapshot changes by the frozen digest and rejects unexpected private fields', () => {
    const f = fixture(); const { room } = f.create();
    const snapshot = f.store.readClassroomRoomSnapshot('p', room.roomId, UID);
    expect(classroomSharedCourseSchema.safeParse({ ...snapshot, privateAnswers: ['do not share'] }).success).toBe(false);
    const changed = { ...snapshot, course: { ...snapshot.course, title: '篡改后的课程名' } };
    f.sql(db => db.prepare('UPDATE classroom_rooms SET snapshot_json=?').run(JSON.stringify(changed)));
    expect(() => f.store.readClassroomRoomSnapshot('p', room.roomId, UID)).toThrowError(expect.objectContaining({ code: 'INTERNAL', details: { reason: 'room_snapshot_digest_mismatch' } }));
  });

  it('rejects modified resource bytes before exposing the snapshot or acquiring a teacher lease', () => {
    const f = fixture(); const { room } = f.create();
    f.sql(db => db.prepare('UPDATE classroom_room_assets SET bytes=?').run(new Uint8Array([9, 9, 9, 9])));
    expect(() => f.store.readClassroomRoomSnapshot('p', room.roomId, UID)).toThrowError(expect.objectContaining({ code: 'INTERNAL' }));
    expect(() => f.store.readClassroomRoomAsset('p', room.roomId, UID, 'asset_one')).toThrowError(expect.objectContaining({ code: 'INTERNAL' }));
    expect(() => f.store.acquireClassroomTeacherLease({ projectId: 'p', roomId: room.roomId, executorId: 'teacher', ttlMs: 1000 }, UID)).toThrowError(expect.objectContaining({ code: 'INTERNAL' }));
  });

  it('rolls back creation, member and resource copies if the receipt cannot be saved', () => {
    const f = fixture();
    f.sql(db => db.exec("CREATE TRIGGER fail_room_receipt BEFORE INSERT ON classroom_room_receipts BEGIN SELECT RAISE(ABORT,'failed'); END;"));
    expect(() => f.create()).toThrow();
    expect(f.store.listLocalClassroomRooms('p', UID)).toEqual([]);
    f.sql(db => { for (const table of ['classroom_rooms', 'classroom_room_members', 'classroom_room_assets', 'classroom_room_receipts']) expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]); });
  });

  it('uses CAS and receipts for scene changes, rolls back failed commands and closes the room without late execution', () => {
    const f = fixture(); const { room } = f.create();
    const sceneId = f.document.scenes[1]!.sceneId;
    const command = { projectId: 'p', roomId: room.roomId, expectedRevision: 1, sceneId, requestId: 'advance' };
    const advanced = f.store.setClassroomRoomScene(command, UID);
    expect(advanced.room).toMatchObject({ revision: 2, currentSceneId: sceneId, status: 'active' });
    expect(f.store.setClassroomRoomScene(command, UID)).toEqual({ ...advanced, deduplicated: true });
    expect(() => f.store.setClassroomRoomScene({ ...command, sceneId: room.currentSceneId }, UID)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    expect(() => f.store.setClassroomRoomScene({ ...command, requestId: 'stale' }, UID)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    f.sql(db => db.exec("CREATE TRIGGER fail_scene_receipt BEFORE INSERT ON classroom_room_receipts WHEN NEW.action='scene' BEGIN SELECT RAISE(ABORT,'failed'); END;"));
    expect(() => f.store.setClassroomRoomScene({ ...command, expectedRevision: 2, requestId: 'fault' }, UID)).toThrow();
    expect(f.store.getClassroomRoom('p', room.roomId, UID)).toEqual(advanced.room);
    const closed = f.store.closeClassroomRoom({ projectId: 'p', roomId: room.roomId, expectedRevision: 2, requestId: 'close' }, UID);
    expect(closed.room).toMatchObject({ revision: 3, status: 'ended', runGeneration: 1 });
    expect(() => f.store.setClassroomRoomScene({ ...command, expectedRevision: 3, requestId: 'late' }, UID)).toThrowError(expect.objectContaining({ code: 'RUN_TERMINATED' }));
    expect(() => f.store.acquireClassroomTeacherLease({ projectId: 'p', roomId: room.roomId, executorId: 'late', ttlMs: 1000 }, UID)).toThrowError(expect.objectContaining({ code: 'RUN_TERMINATED' }));
  });

  it('maintains one teacher lease, renews it, and rejects an expired executor after takeover', () => {
    const f = fixture(); const { room } = f.create();
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
    const first = f.store.acquireClassroomTeacherLease({ projectId: 'p', roomId: room.roomId, executorId: 'teacher-one', ttlMs: 1000 }, UID);
    expect(f.store.acquireClassroomTeacherLease({ projectId: 'p', roomId: room.roomId, executorId: 'teacher-one', ttlMs: 2000 }, UID)).toEqual(first);
    expect(() => f.store.acquireClassroomTeacherLease({ projectId: 'p', roomId: room.roomId, executorId: 'teacher-two', ttlMs: 1000 }, UID)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    const renewed = f.store.renewClassroomTeacherLease({ ...leaseCheck(room.roomId, first), ttlMs: 2000 }, UID);
    expect(renewed.runGeneration).toBe(1);
    vi.advanceTimersByTime(2001);
    expect(() => f.store.assertClassroomTeacherLease(leaseCheck(room.roomId, first), UID)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    const next = f.store.acquireClassroomTeacherLease({ projectId: 'p', roomId: room.roomId, executorId: 'teacher-two', ttlMs: 1000 }, UID);
    expect(next.runGeneration).toBe(2);
    expect(next.leaseId).not.toBe(first.leaseId);
    expect(() => f.store.releaseClassroomTeacherLease(leaseCheck(room.roomId, first), UID)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    f.store.releaseClassroomTeacherLease(leaseCheck(room.roomId, next), UID);
    expect(() => f.store.assertClassroomTeacherLease(leaseCheck(room.roomId, next), UID)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    expect(f.store.acquireClassroomTeacherLease({ projectId: 'p', roomId: room.roomId, executorId: 'teacher-three', ttlMs: 1000 }, UID).runGeneration).toBe(3);
  });

  it('binds one exact lesson session to one room, preserves it on reopen and prevents a second room from sharing it', () => {
    const f = fixture(); const { room } = f.create();
    const session = f.store.openClassroomSession({ projectId: 'p', lessonId: f.lesson.lessonId, stageId: f.document.stageId, learnerKey: LEGACY_LOCAL_LEARNER_KEY, sceneId: room.currentSceneId });
    expect(f.store.bindClassroomRoomSession('p', room.roomId, session.sessionId, UID)).toEqual(room);
    expect(f.store.bindClassroomRoomSession('p', room.roomId, session.sessionId, UID)).toEqual(room);
    expect(f.store.getClassroomRoomForSession('p', session.sessionId, UID)).toEqual(room);
    const second = f.create('second-room').room;
    expect(() => f.store.bindClassroomRoomSession('p', second.roomId, session.sessionId, UID)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    expect(() => f.store.bindClassroomRoomSession('p', room.roomId, 'missing-session', UID)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    f.reopen();
    expect(f.store.getClassroomRoomForSession('p', session.sessionId, UID)).toEqual(room);
  });

  it('preserves snapshot, independent asset bytes, receipts and lease generation after database restart', () => {
    const f = fixture(); const created = f.create(); const { room } = created;
    const snapshot = f.store.readClassroomRoomSnapshot('p', room.roomId, UID);
    const lease = f.store.acquireClassroomTeacherLease({ projectId: 'p', roomId: room.roomId, executorId: 'teacher', ttlMs: 120000 }, UID);
    f.reopen();
    expect(f.store.readClassroomRoomSnapshot('p', room.roomId, UID)).toEqual(snapshot);
    expect(f.store.readClassroomRoomAsset('p', room.roomId, UID, 'asset_one')?.bytes).toEqual(f.bytes);
    expect(f.create()).toEqual({ ...created, deduplicated: true });
    expect(f.store.assertClassroomTeacherLease(leaseCheck(room.roomId, lease), UID)).toEqual(lease);
  });

  it('revokes an in-flight teacher executor when the room closes', () => {
    const f = fixture(); const { room } = f.create();
    const lease = f.store.acquireClassroomTeacherLease({ projectId: 'p', roomId: room.roomId, executorId: 'teacher', ttlMs: 120000 }, UID);
    f.store.closeClassroomRoom({ projectId: 'p', roomId: room.roomId, expectedRevision: 1, requestId: 'end-during-teacher' }, UID);
    expect(() => f.store.assertClassroomTeacherLease(leaseCheck(room.roomId, lease), UID)).toThrowError(expect.objectContaining({ code: 'RUN_TERMINATED' }));
    expect(f.store.getClassroomRoom('p', room.roomId, UID)?.runGeneration).toBe(2);
  });

  it('applies v20 non-destructively to an existing project while keeping identity, personal submissions and course bytes', () => {
    const f = fixture();
    let before: unknown[] = [];
    f.sql(db => {
      before = ['learner_identity_bindings', 'attempts', 'lesson_versions', 'classroom_documents', 'classroom_assets']
        .map(table => db.prepare(`SELECT * FROM ${table}`).all());
      db.exec('DROP TABLE classroom_room_session_bindings; DROP TABLE classroom_room_receipts; DROP TABLE classroom_room_assets; DROP TABLE classroom_room_members; DROP TABLE classroom_rooms; DELETE FROM schema_migrations WHERE version=20;');
    });
    f.reopen();
    f.sql(db => {
      expect(['learner_identity_bindings', 'attempts', 'lesson_versions', 'classroom_documents', 'classroom_assets']
        .map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
      expect(db.prepare('SELECT version FROM schema_migrations WHERE version=20').get()).toEqual({ version: 20 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });
    expect(f.create().room.course.lessonVersion).toBe(1);
  });
});
