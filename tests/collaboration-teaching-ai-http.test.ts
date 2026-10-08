import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COLLAB_PROTOCOL_VERSION,
  type ClassroomSharedCourseDto,
  type CollabTeachingAiCommandInput,
} from '@sew/study-contracts';
import { CollabServiceStore } from '@sew/study-storage';
import { dispatch, type CollabServiceContext } from '../apps/collab-service/src/service';

const OWNER = 'uid_10000000-0000-4000-8000-000000000001';
const MEMBER = 'uid_10000000-0000-4000-8000-000000000002';
const ROOM = 'ai-http-room';
const DIGEST = 'e'.repeat(64);
const roots: string[] = [];
const stores: CollabServiceStore[] = [];

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const snapshot: ClassroomSharedCourseDto = {
  snapshotVersion: 1,
  course: {
    lessonId: 'lesson-http',
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
          elementId: 'el-http',
          type: 'text',
          left: 0,
          top: 0,
          width: 10,
          height: 10,
          rotate: 0,
          text: '函数图像',
        },
      ],
    },
  ],
  evidence: {
    planVersion: 1,
    knowledgeVersions: [{ knowledgeId: 'k-http', revision: 1 }],
    statements: [
      {
        statementId: 'statement-http',
        knowledgeId: 'k-http',
        text: '函数描述变量关系。',
        conditions: 'x 为实数。',
        evidence: [
          { materialId: 'm-http', revision: 1, segmentId: 's-http', use: 'concept_basis' },
        ],
      },
    ],
    segments: [
      {
        materialId: 'm-http',
        revision: 1,
        segmentId: 's-http',
        fingerprint: DIGEST,
        text: '证据文本',
      },
    ],
  },
  sceneSources: [{ sceneId: 'scene_1', knowledgeIds: ['k-http'], questionId: null }],
  assets: [],
};

const setup = (store: CollabServiceStore): void => {
  store.collaboration.register({ uid: OWNER, displayName: '教师', requestId: 'reg-host' });
  store.collaboration.register({ uid: MEMBER, displayName: '同学', requestId: 'reg-member' });
  const invitation = store.collaboration.invite({
    roomId: ROOM,
    inviterUid: OWNER,
    inviteeUid: MEMBER,
    lessonId: 'lesson-http',
    lessonVersion: 1,
    snapshotDigest: DIGEST,
    requestId: 'invite-http',
  }).invitation;
  store.collaboration.decide({
    invitationId: invitation.invitationId,
    actorUid: MEMBER,
    decision: 'accepted',
    requestId: 'accept-http',
  });
  store.collaboration.setReadiness({
    roomId: ROOM,
    uid: OWNER,
    readiness: 'ready',
    requestId: 'ready-host',
  });
  store.collaboration.setReadiness({
    roomId: ROOM,
    uid: MEMBER,
    readiness: 'ready',
    requestId: 'ready-member',
  });
  store.collaboration.startRoom({ roomId: ROOM, actorUid: OWNER, requestId: 'start-http' });
  store.collaboration.uploadSnapshot({
    roomId: ROOM,
    actorUid: OWNER,
    snapshot,
    snapshotDigest: DIGEST,
    requestId: 'snapshot-http',
  });
};

const makeContext = (store: CollabServiceStore): CollabServiceContext => ({
  store,
  protocolVersion: COLLAB_PROTOCOL_VERSION,
  instanceId: 'teaching-ai-http-test',
  dev: true,
  sessions: new Map([
    [
      'host',
      {
        token: 'host',
        uid: OWNER,
        credentialId: 'host-cred',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
    [
      'member',
      {
        token: 'member',
        uid: MEMBER,
        credentialId: 'member-cred',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
  ]),
  now: () => Date.now(),
});

describe('independent collaboration teaching AI HTTP boundary', () => {
  it('binds owner/member projections to session identity and only accepts pending candidate ingress', () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-collab-ai-http-'));
    roots.push(root);
    const store = CollabServiceStore.open({ file: join(root, 'collab.db') });
    stores.push(store);
    setup(store);
    const context = makeContext(store);
    const teaching = store.collaboration.teachingView(ROOM);
    const candidateCommand: CollabTeachingAiCommandInput = {
      roomId: ROOM,
      actorUid: OWNER,
      sceneId: teaching.state.sceneId,
      expectedRevision: teaching.roomRevision,
      expectedSeq: teaching.tailSeq + 1,
      eventId: 'candidate-event',
      requestId: 'candidate-command',
      operation: {
        kind: 'record-ai-candidate',
        candidateId: 'private-candidate',
        anchorStatementId: 'statement-http',
        senderType: 'peer_ai',
        roleProfileId: 'role-http',
        peerName: 'AI同学小叶',
        body: '我认为图像体现变量关系。',
        model: 'local-gateway-model',
      },
    };
    const badIdentity = dispatch(
      context,
      'POST',
      '/collab/v1/teaching-ai/candidates',
      new URLSearchParams(),
      'Bearer member',
      JSON.stringify(candidateCommand),
    );
    expect(badIdentity.status).toBe(403);
    const candidate = dispatch(
      context,
      'POST',
      '/collab/v1/teaching-ai/candidates',
      new URLSearchParams(),
      'Bearer host',
      JSON.stringify(candidateCommand),
    );
    expect(candidate.status, JSON.stringify(candidate.body)).toBe(200);

    const forgedReview = {
      ...candidateCommand,
      requestId: 'forged-record',
      eventId: 'forged-record-event',
    };
    const rendererRecord = dispatch(
      context,
      'POST',
      '/collab/v1/teaching-ai',
      new URLSearchParams(),
      'Bearer host',
      JSON.stringify(forgedReview),
    );
    expect(rendererRecord.status).toBe(400);
    const generate = {
      ...candidateCommand,
      requestId: 'generate-http',
      eventId: 'generate-event',
      operation: { kind: 'generate-teacher-explanation', anchorStatementId: 'statement-http' },
    };
    const providerCall = dispatch(
      context,
      'POST',
      '/collab/v1/teaching-ai',
      new URLSearchParams(),
      'Bearer host',
      JSON.stringify(generate),
    );
    expect(providerCall.status).toBe(400);

    const ownerRead = dispatch(
      context,
      'GET',
      '/collab/v1/teaching-ai',
      new URLSearchParams(`roomId=${ROOM}`),
      'Bearer host',
      null,
    );
    expect(ownerRead.status).toBe(200);
    expect(JSON.stringify(ownerRead.body)).toContain('local-gateway-model');
    const memberRead = dispatch(
      context,
      'GET',
      '/collab/v1/teaching-ai',
      new URLSearchParams(`roomId=${ROOM}`),
      'Bearer member',
      null,
    );
    expect(memberRead.status).toBe(200);
    expect(JSON.stringify(memberRead.body)).not.toContain('local-gateway-model');
    expect(JSON.stringify(memberRead.body)).not.toContain('private-candidate');
    expect(JSON.stringify(memberRead.body)).not.toContain('reviewNote');
  });
});
