import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COLLAB_PROTOCOL_VERSION,
  type ClassroomSharedCourseDto,
  type CollabTeachingAiCommandInput,
} from '@sew/study-contracts';
import { CollabServiceStore, createNodeSqliteDriver } from '@sew/study-storage';
import { dispatch, type CollabServiceContext } from '../apps/collab-service/src/service';

const OWNER = 'uid_10000000-0000-4000-8000-000000000001';
const LEARNER = 'uid_10000000-0000-4000-8000-000000000002';
const DIGEST = 'd'.repeat(64);
const ROOM = 'ai-teaching-room';
const roots: string[] = [];
const stores: CollabServiceStore[] = [];

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const open = (file: string): CollabServiceStore => {
  const store = CollabServiceStore.open({ file });
  stores.push(store);
  return store;
};

const snapshot: ClassroomSharedCourseDto = {
  snapshotVersion: 1,
  course: {
    lessonId: 'lesson-1',
    lessonVersion: 1,
    title: '函数',
    stageId: 'stage',
    dslVersion: '0.11.2',
    documentDigest: DIGEST,
    bundleDigest: DIGEST,
  },
  scenes: [
    {
      sceneId: 'scene_1',
      type: 'slide',
      title: '讲解',
      order: 0,
      elements: [
        {
          elementId: 'el-1',
          type: 'text',
          left: 0,
          top: 0,
          width: 10,
          height: 10,
          rotate: 0,
          text: '函数关系',
        },
      ],
    },
    {
      sceneId: 'scene_2',
      type: 'slide',
      title: '总结',
      order: 1,
      elements: [
        {
          elementId: 'el-2',
          type: 'text',
          left: 0,
          top: 0,
          width: 10,
          height: 10,
          rotate: 0,
          text: '规律',
        },
      ],
    },
  ],
  evidence: {
    planVersion: 1,
    knowledgeVersions: [{ knowledgeId: 'k-1', revision: 1 }],
    statements: [
      {
        statementId: 'statement-1',
        knowledgeId: 'k-1',
        text: '函数描述变量关系。',
        conditions: 'x 为实数。',
        evidence: [{ materialId: 'm-1', revision: 1, segmentId: 's-1', use: 'concept_basis' }],
      },
    ],
    segments: [
      { materialId: 'm-1', revision: 1, segmentId: 's-1', fingerprint: DIGEST, text: '来源证据' },
    ],
  },
  sceneSources: [
    { sceneId: 'scene_1', knowledgeIds: ['k-1'], questionId: null },
    { sceneId: 'scene_2', knowledgeIds: ['k-1'], questionId: null },
  ],
  assets: [],
};

const setupRoom = (store: CollabServiceStore): void => {
  store.collaboration.register({ uid: OWNER, displayName: '老师', requestId: 'reg-owner' });
  store.collaboration.register({ uid: LEARNER, displayName: '同学', requestId: 'reg-learner' });
  const invitation = store.collaboration.invite({
    roomId: ROOM,
    inviterUid: OWNER,
    inviteeUid: LEARNER,
    lessonId: 'lesson-1',
    lessonVersion: 1,
    snapshotDigest: DIGEST,
    requestId: 'invite',
  }).invitation;
  store.collaboration.decide({
    invitationId: invitation.invitationId,
    actorUid: LEARNER,
    decision: 'accepted',
    requestId: 'accept',
  });
  store.collaboration.setReadiness({
    roomId: ROOM,
    uid: OWNER,
    readiness: 'ready',
    requestId: 'ready-owner',
  });
  store.collaboration.setReadiness({
    roomId: ROOM,
    uid: LEARNER,
    readiness: 'ready',
    requestId: 'ready-learner',
  });
  store.collaboration.startRoom({ roomId: ROOM, actorUid: OWNER, requestId: 'start' });
  store.collaboration.uploadSnapshot({
    roomId: ROOM,
    actorUid: OWNER,
    snapshot,
    snapshotDigest: DIGEST,
    requestId: 'snapshot',
  });
};

const aiCommand = (
  store: CollabServiceStore,
  operation: CollabTeachingAiCommandInput['operation'],
  facts: { requestId: string; eventId: string; actorUid?: string } = {
    requestId: 'ai-1',
    eventId: 'ai-event-1',
  },
): CollabTeachingAiCommandInput => {
  const view = store.collaboration.teachingView(ROOM);
  return {
    roomId: ROOM,
    actorUid: facts.actorUid ?? OWNER,
    sceneId: view.state.sceneId,
    expectedRevision: view.roomRevision,
    expectedSeq: view.tailSeq + 1,
    eventId: facts.eventId,
    requestId: facts.requestId,
    operation,
  };
};

const contextFor = (store: CollabServiceStore): CollabServiceContext => ({
  store,
  protocolVersion: COLLAB_PROTOCOL_VERSION,
  instanceId: 'ai-tests',
  dev: true,
  sessions: new Map([
    [
      'owner-token',
      {
        token: 'owner-token',
        uid: OWNER,
        credentialId: 'owner-credential',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
    [
      'learner-token',
      {
        token: 'learner-token',
        uid: LEARNER,
        credentialId: 'learner-credential',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
  ]),
  now: () => Date.now(),
});

describe('collaboration teaching AI authority storage', () => {
  it('records pending candidates, requires review, broadcasts only approved outputs, and filters member reads', () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-collab-ai-'));
    roots.push(root);
    const store = open(join(root, 'collab.db'));
    setupRoom(store);

    const candidate = aiCommand(store, {
      kind: 'record-ai-candidate',
      candidateId: 'candidate-1',
      anchorStatementId: 'statement-1',
      senderType: 'teacher_ai',
      body: '从图像可以观察函数关系。',
      model: 'local-model-1',
    });
    const recorded = store.collaboration.recordTeachingAiCandidate(candidate);
    expect(recorded.state.candidates[0]?.status).toBe('pending');
    expect(recorded.state.candidates[0]?.origin).toBe('model_generated');

    const member = store.collaboration.teachingAiView(ROOM, LEARNER);
    expect(member.state).toBeNull();
    expect(member.publicOutputs).toEqual([]);
    expect(JSON.stringify(member)).not.toContain('local-model-1');

    const context = contextFor(store);
    const ownerRead = dispatch(
      context,
      'GET',
      '/collab/v1/teaching-ai',
      new URLSearchParams('roomId=' + ROOM),
      'Bearer owner-token',
      null,
    );
    expect(ownerRead.status).toBe(200);
    const forgedRendererRecord = dispatch(
      context,
      'POST',
      '/collab/v1/teaching-ai',
      new URLSearchParams(),
      'Bearer owner-token',
      JSON.stringify(candidate),
    );
    expect(forgedRendererRecord.status).toBe(400);

    const review = aiCommand(
      store,
      {
        kind: 'review-ai-candidate',
        candidateId: 'candidate-1',
        decision: 'approved',
        note: '审核批注不可公开',
        semanticReviewed: true,
      },
      { requestId: 'review-1', eventId: 'review-event-1' },
    );
    const reviewed = store.collaboration.applyTeachingAi(review);
    expect(reviewed.state.candidates[0]?.reviewNote).toContain('不可公开');

    const broadcast = aiCommand(
      store,
      { kind: 'broadcast-ai-candidate', candidateId: 'candidate-1' },
      { requestId: 'broadcast-1', eventId: 'broadcast-event-1' },
    );
    const sent = store.collaboration.applyTeachingAi(broadcast);
    expect(sent.state.publicOutputs).toHaveLength(1);
    const publicView = store.collaboration.teachingAiView(ROOM, LEARNER);
    expect(publicView.publicOutputs[0]?.aiLabel).toBe('AI');
    expect(JSON.stringify(publicView)).not.toContain('local-model-1');
    expect(JSON.stringify(publicView)).not.toContain('不可公开');
    expect(JSON.stringify(publicView)).not.toContain('candidate-1');
  });

  it('replays the original receipt before wait/revision changes, but still denies departed members', () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-collab-ai-retry-'));
    roots.push(root);
    const store = open(join(root, 'collab.db'));
    setupRoom(store);
    const candidate = aiCommand(
      store,
      {
        kind: 'record-ai-candidate',
        candidateId: 'candidate-retry',
        anchorStatementId: 'statement-1',
        senderType: 'teacher_ai',
        body: '候选正文',
        model: 'gateway-claim',
      },
      { requestId: 'candidate-retry-request', eventId: 'candidate-retry-event' },
    );
    const original = store.collaboration.recordTeachingAiCandidate(candidate);

    const teaching = store.collaboration.teachingView(ROOM);
    store.collaboration.applyTeaching({
      roomId: ROOM,
      actorUid: OWNER,
      sceneId: teaching.state.sceneId,
      expectedRevision: teaching.roomRevision,
      expectedSeq: teaching.tailSeq + 1,
      eventId: 'wait-event',
      requestId: 'wait-request',
      operation: { kind: 'wait', targetUid: LEARNER },
    });
    const retry = store.collaboration.recordTeachingAiCandidate(candidate);
    expect(retry.deduplicated).toBe(true);
    expect(retry.event.eventId).toBe(original.event.eventId);

    store.collaboration.setReadiness({
      roomId: ROOM,
      uid: LEARNER,
      readiness: 'left',
      requestId: 'leave',
    });
    expect(() => store.collaboration.teachingAiView(ROOM, LEARNER)).toThrow();
  });

  it('persists across restart, resets at scene change, and rejects tampered authoritative JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-collab-ai-restart-'));
    roots.push(root);
    const file = join(root, 'collab.db');
    let store = open(file);
    setupRoom(store);
    const recorded = store.collaboration.recordTeachingAiCandidate(
      aiCommand(
        store,
        {
          kind: 'record-ai-candidate',
          candidateId: 'candidate-persist',
          anchorStatementId: 'statement-1',
          senderType: 'teacher_ai',
          body: '持久候选',
          model: 'model-private',
        },
        { requestId: 'persist', eventId: 'persist-event' },
      ),
    );
    const revision = recorded.roomRevision;
    store.close();
    stores.pop();

    store = open(file);
    expect(store.collaboration.teachingAiView(ROOM, OWNER).state?.candidates[0]?.candidateId).toBe(
      'candidate-persist',
    );
    const teaching = store.collaboration.teachingView(ROOM);
    const synced = store.collaboration.syncScene({
      roomId: ROOM,
      actorUid: OWNER,
      sceneId: 'scene_2',
      lessonId: 'lesson-1',
      lessonVersion: 1,
      expectedRevision: Math.max(revision, teaching.roomRevision),
      expectedSeq: teaching.tailSeq + 1,
      eventId: 'scene-change-event',
      requestId: 'scene-change-request',
    });
    expect(synced.room.currentSceneId).toBe('scene_2');
    expect(store.collaboration.teachingAiView(ROOM, OWNER).state?.candidates).toEqual([]);

    const tamper = createNodeSqliteDriver().open(file);
    tamper
      .prepare('UPDATE collab_teaching_ai_states SET state_json=? WHERE room_id=?')
      .run('{}', ROOM);
    tamper.close();
    expect(() => store.collaboration.teachingAiView(ROOM, OWNER)).toThrow();
  });

  it('uses authenticated host identity on HTTP and retains only pending-only candidate ingress', () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-collab-ai-http-'));
    roots.push(root);
    const store = open(join(root, 'collab.db'));
    setupRoom(store);
    const context = contextFor(store);
    const command = aiCommand(
      store,
      {
        kind: 'record-ai-candidate',
        candidateId: 'candidate-http',
        anchorStatementId: 'statement-1',
        senderType: 'peer_ai',
        roleProfileId: 'role-1',
        peerName: 'AI同学小林',
        body: '讨论候选',
        model: 'gateway-assertion',
      },
      { requestId: 'http-candidate', eventId: 'http-candidate-event' },
    );
    const response = dispatch(
      context,
      'POST',
      '/collab/v1/teaching-ai/candidates',
      new URLSearchParams(),
      'Bearer owner-token',
      JSON.stringify(command),
    );
    expect(response.status).toBe(200);
    const asLearner = dispatch(
      context,
      'POST',
      '/collab/v1/teaching-ai/candidates',
      new URLSearchParams(),
      'Bearer learner-token',
      JSON.stringify(command),
    );
    expect(asLearner.status).toBe(403);
    const view = dispatch(
      context,
      'GET',
      '/collab/v1/teaching-ai',
      new URLSearchParams('roomId=' + ROOM),
      'Bearer learner-token',
      null,
    );
    expect(view.status).toBe(200);
    expect(JSON.stringify(view.body)).not.toContain('gateway-assertion');
    expect(JSON.stringify(view.body)).not.toContain('candidate-http');
  });
});
