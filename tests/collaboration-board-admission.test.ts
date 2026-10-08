import { describe, expect, it } from 'vitest';
import {
  StudyError,
  collabTeachingOperationSchema,
  collabTeachingStateSchema,
  type ClassroomSharedCourseDto,
  type CollabTeachingCommandInput,
  type CollabTeachingStateDto,
} from '@sew/study-contracts';
import { decideCollabTeaching } from '@sew/study-domain';

const OWNER = 'uid_10000000-0000-4000-8000-000000000001';
const LEARNER = 'uid_10000000-0000-4000-8000-000000000002';
const TEXT = { kind: 'text' as const, text: '变量每增加 1，函数值增加 2。' };
const ALTERED = { kind: 'text' as const, text: '变量每增加 1，函数值增加 200。' };

const snapshot: ClassroomSharedCourseDto = {
  snapshotVersion: 1,
  course: {
    lessonId: 'lesson-1',
    lessonVersion: 1,
    title: '一次函数',
    stageId: 'stage',
    dslVersion: '0.11.2',
    documentDigest: 'd'.repeat(64),
    bundleDigest: 'd'.repeat(64),
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
          text: '函数',
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
          text: '总结',
        },
      ],
    },
  ],
  evidence: {
    planVersion: 1,
    knowledgeVersions: [
      { knowledgeId: 'k-1', revision: 1 },
      { knowledgeId: 'k-2', revision: 1 },
    ],
    statements: [
      {
        statementId: 'statement-1',
        knowledgeId: 'k-1',
        text: '一次函数斜率为 2。',
        conditions: '',
        evidence: [],
      },
      {
        statementId: 'statement-2',
        knowledgeId: 'k-2',
        text: '无关陈述。',
        conditions: '',
        evidence: [],
      },
    ],
    segments: [],
  },
  sceneSources: [
    { sceneId: 'scene_1', knowledgeIds: ['k-1'], questionId: null },
    { sceneId: 'scene_2', knowledgeIds: ['k-1'], questionId: null },
  ],
  assets: [],
};

const stateFor = (overrides: Partial<CollabTeachingStateDto> = {}): CollabTeachingStateDto =>
  collabTeachingStateSchema.parse({
    schemaVersion: 1,
    roomId: 'room-1',
    sceneId: 'scene_1',
    board: { focusElementId: null, laserElementId: null },
    waiting: null,
    outputs: [],
    ...overrides,
  });

const commandFor = (
  operation: CollabTeachingCommandInput['operation'],
  overrides: Partial<CollabTeachingCommandInput> = {},
): CollabTeachingCommandInput => ({
  roomId: 'room-1',
  actorUid: OWNER,
  sceneId: 'scene_1',
  expectedRevision: 1,
  expectedSeq: 1,
  eventId: 'event-1',
  requestId: 'request-1',
  operation,
  ...overrides,
});

const decide = (
  operation: CollabTeachingCommandInput['operation'],
  options: {
    state?: CollabTeachingStateDto;
    actorUid?: string;
    sceneId?: string;
    activeMemberUids?: string[];
    eventId?: string;
    seq?: number;
  } = {},
): CollabTeachingStateDto => {
  const state = options.state ?? stateFor();
  const sceneId = options.sceneId ?? state.sceneId;
  const seq = options.seq ?? 1;
  return decideCollabTeaching({
    command: commandFor(operation, {
      actorUid: options.actorUid ?? OWNER,
      sceneId,
      expectedSeq: seq,
      eventId: options.eventId ?? 'event-1',
    }),
    state,
    snapshot,
    ownerUid: OWNER,
    activeMemberUids: options.activeMemberUids ?? [OWNER, LEARNER],
    roomActive: true,
    roomRevision: 1,
    expectedTailSeq: seq - 1,
    nextSeq: seq,
    now: '2026-10-07T00:00:00.000Z',
  });
};

const review = (content = TEXT) =>
  decide(
    { kind: 'review-board-content', statementId: 'statement-1', content, semanticReviewed: true },
    { state: stateFor(), sceneId: 'scene_1', eventId: 'review-1' },
  );

const write = (reviewEventId: string, content = TEXT, statementId = 'statement-1') =>
  ({ kind: 'write', reviewEventId, statementId, content }) as const;

describe('collaboration public board admission', () => {
  it('requires an explicit active owner review before write and binds the receipt to exact scene, statement and content', () => {
    expect(() => decide(write('forged'))).toThrow(StudyError);
    expect(() => decide(write('review-1'), { actorUid: LEARNER })).toThrow(StudyError);
    expect(() => decide(write('review-1'), { activeMemberUids: [LEARNER] })).toThrow(StudyError);
    expect(() =>
      decide(
        {
          kind: 'review-board-content',
          statementId: 'statement-1',
          content: TEXT,
          semanticReviewed: true,
        },
        { actorUid: LEARNER },
      ),
    ).toThrow(StudyError);

    const reviewed = review();
    expect(reviewed.board.reviewedContents).toEqual([
      {
        eventId: 'review-1',
        seq: 1,
        statementId: 'statement-1',
        content: TEXT,
        reviewerUid: OWNER,
        sceneId: 'scene_1',
      },
    ]);
    expect(() => decide(write('review-1', ALTERED), { state: reviewed })).toThrow(StudyError);
    expect(() =>
      decide(write('review-1'), {
        state: reviewed,
        sceneId: 'scene_2',
      }),
    ).toThrow(StudyError);
    expect(() => decide(write('review-1', TEXT, 'statement-2'), { state: reviewed })).toThrow(
      StudyError,
    );

    const written = decide(write('review-1'), { state: reviewed, eventId: 'write-1', seq: 2 });
    expect(written.board.contents?.[0]).toMatchObject({
      eventId: 'write-1',
      statementId: 'statement-1',
      content: TEXT,
      reviewEventId: 'review-1',
    });
    expect(written.board.reviewedContents).toEqual(reviewed.board.reviewedContents);
    expect(written.board.history?.actions[0]?.reviewEventId).toBe('review-1');
  });

  it('refuses review while waiting and rejects a claim without literal human-review confirmation', () => {
    const waiting = stateFor({
      waiting: {
        waitEventId: 'wait-1',
        sceneId: 'scene_1',
        targetUid: LEARNER,
        acknowledged: false,
      },
    });
    expect(() =>
      decide(
        {
          kind: 'review-board-content',
          statementId: 'statement-1',
          content: TEXT,
          semanticReviewed: true,
        },
        { state: waiting },
      ),
    ).toThrow(StudyError);
    expect(() =>
      collabTeachingOperationSchema.parse({
        kind: 'review-board-content',
        statementId: 'statement-1',
        content: TEXT,
        semanticReviewed: false,
      }),
    ).toThrow();
  });

  it('keeps legacy v1 board actions readable and never invents review receipts for them', () => {
    const legacy = stateFor({
      board: {
        focusElementId: null,
        laserElementId: null,
        contents: [{ eventId: 'old-write', seq: 1, statementId: 'statement-1', content: TEXT }],
        history: {
          baseline: { focusElementId: null, laserElementId: null },
          actions: [
            {
              eventId: 'old-write',
              seq: 1,
              kind: 'write',
              statementId: 'statement-1',
              content: TEXT,
              applied: true,
            },
          ],
        },
      },
    });
    expect(legacy.board.reviewedContents).toBeUndefined();
    expect(legacy.board.contents?.[0]?.reviewEventId).toBeUndefined();
    const replayed = decide({ kind: 'undo-board', actionEventId: 'old-write' }, { state: legacy });
    expect(replayed.board.reviewedContents).toBeUndefined();
    expect(replayed.board.contents).toEqual([]);
    expect(replayed.board.history?.actions[0]).toMatchObject({
      eventId: 'old-write',
      applied: false,
    });
    expect(() => decide(write('old-write'), { state: legacy })).toThrow(StudyError);
  });
});
