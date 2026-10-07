import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COLLAB_PROTOCOL_VERSION,
  StudyError,
  collabTeachingStateSchema,
  type ClassroomSharedCourseDto,
  type CollabTeachingCommandInput,
} from '@sew/study-contracts';
import { CollabServiceStore, createNodeSqliteDriver } from '@sew/study-storage';
import { dispatch, type CollabServiceContext } from '../apps/collab-service/src/service';
import { canonicalJson, fingerprintOf } from '@sew/study-domain';

const OWNER = 'uid_10000000-0000-4000-8000-000000000001';
const LEARNER = 'uid_10000000-0000-4000-8000-000000000002';
const DIGEST = 'd'.repeat(64);
const ROOM = 'teaching-room';
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
          text: '函数图像',
        },
        {
          elementId: 'el-alt',
          type: 'text',
          left: 10,
          top: 0,
          width: 10,
          height: 10,
          rotate: 0,
          text: '另一个元素',
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
          text: '变化规律',
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
        text: '函数图像描述变量关系。',
        conditions: 'x 为实数。',
        evidence: [{ materialId: 'm-1', revision: 1, segmentId: 's-1', use: 'concept_basis' }],
      },
    ],
    segments: [
      { materialId: 'm-1', revision: 1, segmentId: 's-1', fingerprint: DIGEST, text: '证据文本' },
    ],
  },
  sceneSources: [
    { sceneId: 'scene_1', knowledgeIds: ['k-1'], questionId: null },
    { sceneId: 'scene_2', knowledgeIds: ['k-1'], questionId: null },
  ],
  assets: [],
};

const activeRoom = (store: CollabServiceStore, start = true) => {
  store.collaboration.register({ uid: OWNER, displayName: '老师', requestId: 'reg-owner' });
  store.collaboration.register({ uid: LEARNER, displayName: '同学', requestId: 'reg-learner' });
  const invite = store.collaboration.invite({
    roomId: ROOM,
    inviterUid: OWNER,
    inviteeUid: LEARNER,
    lessonId: 'lesson-1',
    lessonVersion: 1,
    snapshotDigest: DIGEST,
    requestId: 'invite',
  }).invitation;
  store.collaboration.decide({
    invitationId: invite.invitationId,
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
  const room = start
    ? store.collaboration.startRoom({ roomId: ROOM, actorUid: OWNER, requestId: 'start' }).room
    : store.collaboration.getRoom(ROOM)!;
  store.collaboration.uploadSnapshot({
    roomId: ROOM,
    actorUid: OWNER,
    snapshot,
    snapshotDigest: DIGEST,
    requestId: 'snapshot',
  });
  return room;
};

const command = (
  overrides: Partial<CollabTeachingCommandInput> = {},
): CollabTeachingCommandInput => ({
  roomId: ROOM,
  actorUid: OWNER,
  sceneId: 'scene_1',
  expectedRevision: 2,
  expectedSeq: 1,
  eventId: 'teaching-event-1',
  requestId: 'teaching-request-1',
  operation: { kind: 'focus', elementId: 'el-1' },
  ...overrides,
});

const expectReason = (action: () => unknown, reason: string): void => {
  try {
    action();
  } catch (error) {
    expect((error as StudyError).details?.['reason']).toBe(reason);
    return;
  }
  throw new Error(`预期拒绝 ${reason}`);
};

describe('collaboration teaching authoritative storage', () => {
  it('binds HTTP reads/writes to the session and rejects forged teacher events on the legacy route', () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-teaching-'));
    roots.push(root);
    const store = open(join(root, 'collab.db'));
    const room = activeRoom(store);
    const context: CollabServiceContext = {
      store,
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      instanceId: 'teaching-test',
      dev: true,
      sessions: new Map([
        [
          'owner-token',
          {
            token: 'owner-token',
            uid: OWNER,
            credentialId: 'cred-owner',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      ]),
      now: () => Date.now(),
    };
    const read = dispatch(
      context,
      'GET',
      '/collab/v1/teaching',
      new URLSearchParams({ roomId: ROOM }),
      'Bearer owner-token',
      null,
    );
    expect(read.status).toBe(200);
    const forged = dispatch(
      context,
      'POST',
      '/collab/v1/events',
      new URLSearchParams(),
      'Bearer owner-token',
      JSON.stringify({
        roomId: ROOM,
        eventId: 'forged-event',
        kind: 'teacher_output',
        actorUid: OWNER,
        summary: 'answer=private',
        expectedSeq: 1,
        requestId: 'forged-request',
      }),
    );
    expect(forged.status).toBe(400);
    expect(JSON.stringify(forged.body)).not.toContain('answer=private');
    const mismatched = dispatch(
      context,
      'POST',
      '/collab/v1/teaching',
      new URLSearchParams(),
      'Bearer owner-token',
      JSON.stringify(command({ actorUid: LEARNER, expectedRevision: room.revision })),
    );
    expect(mismatched.status).toBe(403);
    const malformed = dispatch(
      context,
      'POST',
      '/collab/v1/teaching',
      new URLSearchParams(),
      'Bearer owner-token',
      '{',
    );
    expect(malformed.status).toBe(400);
    const applied = dispatch(
      context,
      'POST',
      '/collab/v1/teaching',
      new URLSearchParams(),
      'Bearer owner-token',
      JSON.stringify(command({ expectedRevision: room.revision })),
    );
    expect(applied.status).toBe(200);
    expect(store.collaboration.listEvents(ROOM, 0).events.map((event) => event.kind)).toEqual([
      'board_action',
    ]);
  });

  it('applies structured actions, validates scene/revision/sequence, and returns the same receipt on retry', () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-teaching-'));
    roots.push(root);
    const store = open(join(root, 'collab.db'));
    const room = activeRoom(store);
    expect(store.collaboration.teachingView(ROOM).state.sceneId).toBe('scene_1');

    const first = store.collaboration.applyTeaching(command({ expectedRevision: room.revision }));
    expect(first.event.kind).toBe('board_action');
    expect(first.roomRevision).toBe(room.revision + 1);
    expect(first.state.board.focusElementId).toBe('el-1');
    expect(first.deduplicated).toBe(false);
    const retry = store.collaboration.applyTeaching(command({ expectedRevision: room.revision }));
    expect(retry).toEqual({ ...first, deduplicated: true });
    expectReason(
      () => store.collaboration.applyTeaching(command({ operation: { kind: 'clear-board' } })),
      'collab_request_reused',
    );
    expect(store.collaboration.listEvents(ROOM, 0).events).toHaveLength(1);
    expectReason(
      () =>
        store.collaboration.applyTeaching(
          command({
            expectedRevision: first.roomRevision + 1,
            requestId: 'stale-revision',
            expectedSeq: 2,
          }),
        ),
      'collab_room_revision_mismatch',
    );
    expectReason(
      () =>
        store.collaboration.applyTeaching(
          command({
            sceneId: 'wrong-scene',
            expectedRevision: first.roomRevision,
            expectedSeq: 2,
            requestId: 'wrong-scene',
          }),
        ),
      'collab_teaching_scene_mismatch',
    );
    expectReason(
      () =>
        store.collaboration.applyTeaching(
          command({ expectedRevision: first.roomRevision, expectedSeq: 3, requestId: 'wrong-seq' }),
        ),
      'collab_event_seq_mismatch',
    );
    expectReason(
      () =>
        store.collaboration.applyTeaching(
          command({
            actorUid: LEARNER,
            expectedRevision: first.roomRevision,
            expectedSeq: 2,
            requestId: 'peer-focus',
          }),
        ),
      'collab_teacher_owner_required',
    );
    expectReason(
      () =>
        store.collaboration.applyTeaching(
          command({
            operation: { kind: 'focus', elementId: 'other' },
            expectedRevision: first.roomRevision,
            expectedSeq: 2,
            requestId: 'bad-el',
          }),
        ),
      'collab_element_not_in_scene',
    );
    const moved = store.collaboration.syncScene({
      roomId: ROOM,
      actorUid: OWNER,
      sceneId: 'scene_2',
      lessonId: 'lesson-1',
      lessonVersion: 1,
      expectedRevision: first.roomRevision,
      expectedSeq: 2,
      eventId: 'move-scene',
      requestId: 'move-scene',
    });
    expect(moved.room.currentSceneId).toBe('scene_2');
    expect(store.collaboration.teachingView(ROOM).state.board).toEqual({
      focusElementId: null,
      laserElementId: null,
      contents: [],
    });
  });

  it('speaks only a scene-linked frozen statement and enforces wait, acknowledge, cancel and release rules', () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-teaching-'));
    roots.push(root);
    const store = open(join(root, 'collab.db'));
    const room = activeRoom(store);
    const speak = store.collaboration.applyTeaching(
      command({
        operation: { kind: 'speak', statementId: 'statement-1' },
        expectedRevision: room.revision,
        requestId: 'speak',
        eventId: 'speak-event',
      }),
    );
    expect(speak.state.outputs[0]?.body).toBe('函数图像描述变量关系。');
    expect(speak.state.outputs[0]?.conditions).toBe('x 为实数。');
    expect(speak.event.kind).toBe('teacher_output');
    expectReason(
      () =>
        store.collaboration.applyTeaching(
          command({
            operation: { kind: 'speak', statementId: 'arbitrary' },
            expectedRevision: speak.roomRevision,
            expectedSeq: 2,
            requestId: 'arbitrary',
          }),
        ),
      'collab_statement_not_in_scene',
    );

    const waiting = store.collaboration.applyTeaching(
      command({
        operation: { kind: 'wait', targetUid: LEARNER },
        expectedRevision: speak.roomRevision,
        expectedSeq: 2,
        requestId: 'wait',
        eventId: 'wait-event',
      }),
    );
    expect(waiting.state.waiting?.targetUid).toBe(LEARNER);
    expectReason(
      () =>
        store.collaboration.applyTeaching(
          command({
            operation: { kind: 'undo-board', actionEventId: 'some-action' },
            expectedRevision: waiting.roomRevision,
            expectedSeq: 3,
            requestId: 'undo-during-wait',
          }),
        ),
      'collab_teaching_waiting',
    );
    expectReason(
      () =>
        store.collaboration.applyTeaching(
          command({
            operation: { kind: 'wait', targetUid: LEARNER },
            expectedRevision: waiting.roomRevision,
            expectedSeq: 3,
            requestId: 'second-wait',
          }),
        ),
      'collab_teaching_waiting',
    );
    expectReason(
      () =>
        store.collaboration.applyTeaching(
          command({
            actorUid: OWNER,
            operation: { kind: 'acknowledge', waitEventId: 'wrong-event' },
            expectedRevision: waiting.roomRevision,
            expectedSeq: 3,
            requestId: 'wrong-ack',
          }),
        ),
      'collab_wait_acknowledgement_denied',
    );
    expectReason(
      () =>
        store.collaboration.syncScene({
          roomId: ROOM,
          actorUid: OWNER,
          sceneId: 'scene-1',
          lessonId: 'lesson-1',
          lessonVersion: 1,
          expectedRevision: waiting.roomRevision,
          expectedSeq: 3,
          eventId: 'scene-while-waiting',
          requestId: 'scene-while-waiting',
        }),
      'collab_scene_sync_waiting',
    );
    expectReason(
      () =>
        store.collaboration.applyTeaching(
          command({
            operation: { kind: 'release-wait', waitEventId: 'wait-event' },
            expectedRevision: waiting.roomRevision,
            expectedSeq: 3,
            requestId: 'premature-release',
          }),
        ),
      'collab_wait_not_acknowledged',
    );
    const ack = store.collaboration.applyTeaching(
      command({
        actorUid: LEARNER,
        operation: { kind: 'acknowledge', waitEventId: 'wait-event' },
        expectedRevision: waiting.roomRevision,
        expectedSeq: 3,
        requestId: 'ack',
        eventId: 'ack-event',
      }),
    );
    expect(ack.state.waiting?.acknowledged).toBe(true);
    const released = store.collaboration.applyTeaching(
      command({
        operation: { kind: 'release-wait', waitEventId: 'wait-event' },
        expectedRevision: ack.roomRevision,
        expectedSeq: 4,
        requestId: 'release',
        eventId: 'release-event',
      }),
    );
    expect(released.state.waiting).toBeNull();
    const focus = store.collaboration.applyTeaching(
      command({
        operation: { kind: 'focus', elementId: 'el-1' },
        expectedRevision: released.roomRevision,
        expectedSeq: 5,
        requestId: 'focus-before-sync',
        eventId: 'focus-before-sync',
      }),
    );
    const moved = store.collaboration.syncScene({
      roomId: ROOM,
      actorUid: OWNER,
      sceneId: 'scene_2',
      lessonId: 'lesson-1',
      lessonVersion: 1,
      expectedRevision: focus.roomRevision,
      expectedSeq: 6,
      eventId: 'scene-after-teaching',
      requestId: 'scene-after-teaching',
    });
    expect(moved.room.currentSceneId).toBe('scene_2');
    const movedView = store.collaboration.teachingView(ROOM);
    expect(movedView.state.board).toEqual({
      focusElementId: null,
      laserElementId: null,
      contents: [],
    });
    expect(movedView.state.outputs).toHaveLength(1);
    expect(movedView.state.outputs[0]?.conditions).toBe('x 为实数。');

    const waitingAgain = store.collaboration.applyTeaching(
      command({
        operation: { kind: 'wait', targetUid: LEARNER },
        expectedRevision: moved.room.revision,
        expectedSeq: 7,
        requestId: 'wait-again',
        eventId: 'wait-event-2',
        sceneId: 'scene_2',
      }),
    );
    store.collaboration.setReadiness({
      roomId: ROOM,
      uid: LEARNER,
      readiness: 'left',
      requestId: 'leave',
    });
    const cancelled = store.collaboration.applyTeaching(
      command({
        operation: { kind: 'cancel-wait', waitEventId: 'wait-event-2' },
        expectedRevision: waitingAgain.roomRevision,
        expectedSeq: 8,
        requestId: 'cancel-wait',
        eventId: 'cancel-event',
        sceneId: 'scene_2',
      }),
    );
    expect(cancelled.state.waiting).toBeNull();
  });

  it('undoes and replays current-scene board actions from a captured baseline without deleting event history', () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-teaching-'));
    roots.push(root);
    const store = open(join(root, 'collab.db'));
    const room = activeRoom(store);
    let revision = room.revision;
    let seq = 1;
    const apply = (operation: CollabTeachingCommandInput['operation'], tag: string) => {
      const result = store.collaboration.applyTeaching(
        command({
          operation,
          expectedRevision: revision,
          expectedSeq: seq,
          eventId: `board-${tag}`,
          requestId: `board-request-${tag}`,
        }),
      );
      revision = result.roomRevision;
      seq += 1;
      return result;
    };

    const focus = apply({ kind: 'focus', elementId: 'el-1' }, 'focus');
    expect(focus.state.board.history?.baseline).toEqual({
      focusElementId: null,
      laserElementId: null,
    });
    expect(focus.state.board.history?.actions[0]).toMatchObject({
      eventId: 'board-focus',
      kind: 'focus',
      elementId: 'el-1',
      applied: true,
    });
    const clear = apply({ kind: 'clear-board' }, 'clear');
    expect(clear.state.board).toMatchObject({ focusElementId: null, laserElementId: null });
    expect(clear.state.board.history?.actions).toHaveLength(2);
    const duplicateHistory = structuredClone(clear.state);
    duplicateHistory.board.history!.actions[1]!.eventId =
      duplicateHistory.board.history!.actions[0]!.eventId;
    expect(collabTeachingStateSchema.safeParse(duplicateHistory).success).toBe(false);
    const unorderedHistory = structuredClone(clear.state);
    unorderedHistory.board.history!.actions[1]!.seq =
      unorderedHistory.board.history!.actions[0]!.seq;
    expect(collabTeachingStateSchema.safeParse(unorderedHistory).success).toBe(false);
    const invalidShape = structuredClone(clear.state);
    invalidShape.board.history!.actions[1]!.elementId = 'unexpected';
    expect(collabTeachingStateSchema.safeParse(invalidShape).success).toBe(false);
    const undoClear = apply({ kind: 'undo-board', actionEventId: 'board-clear' }, 'undo-clear');
    expect(undoClear.state.board.focusElementId).toBe('el-1');
    expect(undoClear.state.board.history?.actions[1]?.applied).toBe(false);
    expectReason(
      () => apply({ kind: 'undo-board', actionEventId: 'board-clear' }, 'undo-clear-twice'),
      'collab_board_action_already_undone',
    );
    const undoFocus = apply({ kind: 'undo-board', actionEventId: 'board-focus' }, 'undo-focus');
    expect(undoFocus.state.board.focusElementId).toBeNull();
    const replayFocus = apply(
      { kind: 'replay-board', actionEventId: 'board-focus' },
      'replay-focus',
    );
    expect(replayFocus.state.board.focusElementId).toBe('el-1');
    expectReason(
      () => apply({ kind: 'replay-board', actionEventId: 'board-focus' }, 'replay-focus-twice'),
      'collab_board_action_already_applied',
    );
    const replayClear = apply(
      { kind: 'replay-board', actionEventId: 'board-clear' },
      'replay-clear',
    );
    expect(replayClear.state.board.focusElementId).toBeNull();
    const undoFocusAgain = apply(
      { kind: 'undo-board', actionEventId: 'board-focus' },
      'undo-focus-again',
    );
    expect(undoFocusAgain.state.board.focusElementId).toBeNull();
    const newerFocus = apply({ kind: 'focus', elementId: 'el-alt' }, 'newer-focus');
    expect(newerFocus.state.board.focusElementId).toBe('el-alt');
    const replayOlderFocus = apply(
      { kind: 'replay-board', actionEventId: 'board-focus' },
      'replay-older-focus',
    );
    expect(replayOlderFocus.state.board.focusElementId).toBe('el-alt');
    expectReason(
      () =>
        apply({ kind: 'replay-board', actionEventId: 'board-focus' }, 'replay-older-focus-twice'),
      'collab_board_action_already_applied',
    );
    expectReason(
      () => apply({ kind: 'undo-board', actionEventId: 'old-scene-action' }, 'unknown-action'),
      'collab_board_action_not_found',
    );
    expect(store.collaboration.listEvents(ROOM, 0).events).toHaveLength(seq - 1);
    expect(store.collaboration.listEvents(ROOM, 0).events[1]?.summary).toContain(
      '教师清除白板标记',
    );
    expect(store.collaboration.listEvents(ROOM, 0).events[2]?.summary).toContain('board-clear');
    expect(store.collaboration.listEvents(ROOM, 0).events[3]?.summary).toContain('board-focus');
  });

  it('preserves legacy v1 digests without history, rejects inconsistent history, and caps retained actions at 200', () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-teaching-'));
    roots.push(root);
    const file = join(root, 'collab.db');
    let store = open(file);
    const room = activeRoom(store);
    const raw = createNodeSqliteDriver().open(file);
    const legacy = {
      schemaVersion: 1,
      roomId: ROOM,
      sceneId: 'scene_1',
      board: { focusElementId: 'el-1', laserElementId: null },
      waiting: null,
      outputs: [],
    };
    raw
      .prepare(
        'INSERT INTO collab_teaching_states (room_id, scene_id, state_json, state_digest, updated_at) VALUES (?,?,?,?,?)',
      )
      .run(
        ROOM,
        'scene_1',
        JSON.stringify(legacy),
        fingerprintOf(canonicalJson(legacy)),
        new Date().toISOString(),
      );
    raw.close();
    expect(store.collaboration.teachingView(ROOM).state.board.history).toBeUndefined();

    const legacyClear = store.collaboration.applyTeaching(
      command({
        operation: { kind: 'clear-board' },
        expectedRevision: room.revision,
        expectedSeq: 1,
        eventId: 'legacy-clear',
        requestId: 'legacy-clear',
      }),
    );
    expect(legacyClear.state.board.history?.baseline).toEqual({
      focusElementId: 'el-1',
      laserElementId: null,
    });
    const legacyUndo = store.collaboration.applyTeaching(
      command({
        operation: { kind: 'undo-board', actionEventId: 'legacy-clear' },
        expectedRevision: legacyClear.roomRevision,
        expectedSeq: 2,
        eventId: 'legacy-clear-undo',
        requestId: 'legacy-clear-undo',
      }),
    );
    expect(legacyUndo.state.board.focusElementId).toBe('el-1');
    const moved = store.collaboration.syncScene({
      roomId: ROOM,
      actorUid: OWNER,
      sceneId: 'scene_2',
      lessonId: 'lesson-1',
      lessonVersion: 1,
      expectedRevision: legacyUndo.roomRevision,
      expectedSeq: 3,
      eventId: 'legacy-sync',
      requestId: 'legacy-sync',
    });
    expectReason(
      () =>
        store.collaboration.applyTeaching(
          command({
            sceneId: 'scene_2',
            operation: { kind: 'undo-board', actionEventId: 'legacy-clear' },
            expectedRevision: moved.room.revision,
            expectedSeq: 4,
            requestId: 'old-scene-action',
          }),
        ),
      'collab_board_action_not_found',
    );

    let revision = moved.room.revision;
    for (let seq = 4; seq <= 203; seq += 1) {
      const result = store.collaboration.applyTeaching(
        command({
          sceneId: 'scene_2',
          operation: { kind: seq % 2 === 0 ? 'focus' : 'laser', elementId: 'el-2' },
          expectedRevision: revision,
          expectedSeq: seq,
          eventId: `bounded-event-${seq}`,
          requestId: `bounded-request-${seq}`,
        }),
      );
      revision = result.roomRevision;
    }
    expect(store.collaboration.teachingView(ROOM).state.board.history?.actions).toHaveLength(200);
    expectReason(
      () =>
        store.collaboration.applyTeaching(
          command({
            sceneId: 'scene_2',
            operation: { kind: 'clear-board' },
            expectedRevision: revision,
            expectedSeq: 204,
            eventId: 'overflow-event',
            requestId: 'overflow-request',
          }),
        ),
      'collab_board_action_limit',
    );
    const undo = store.collaboration.applyTeaching(
      command({
        sceneId: 'scene_2',
        operation: { kind: 'undo-board', actionEventId: 'bounded-event-203' },
        expectedRevision: revision,
        expectedSeq: 204,
        eventId: 'bounded-undo',
        requestId: 'bounded-undo',
      }),
    );
    expect(undo.state.board.history?.actions).toHaveLength(200);

    const inconsistent = { ...undo.state, board: { ...undo.state.board, focusElementId: null } };
    const db = createNodeSqliteDriver().open(file);
    db.prepare(
      'UPDATE collab_teaching_states SET state_json=?, state_digest=? WHERE room_id=?',
    ).run(JSON.stringify(inconsistent), fingerprintOf(canonicalJson(inconsistent)), ROOM);
    db.close();
    expectReason(
      () => store.collaboration.teachingView(ROOM),
      'collab_board_history_state_mismatch',
    );
  });

  it('rejects teaching while the room is not active and validates current member before replay', () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-teaching-'));
    roots.push(root);
    const store = open(join(root, 'collab.db'));
    const room = activeRoom(store, false);
    expectReason(
      () => store.collaboration.applyTeaching(command({ expectedRevision: room.revision })),
      'collab_room_not_active',
    );

    const started = store.collaboration.startRoom({
      roomId: ROOM,
      actorUid: OWNER,
      requestId: 'start-later',
    }).room;
    const waiting = store.collaboration.applyTeaching(
      command({
        operation: { kind: 'wait', targetUid: LEARNER },
        expectedRevision: started.revision,
        requestId: 'member-replay-wait',
        eventId: 'member-replay-wait',
      }),
    );
    const ack = store.collaboration.applyTeaching(
      command({
        actorUid: LEARNER,
        operation: { kind: 'acknowledge', waitEventId: 'member-replay-wait' },
        expectedRevision: waiting.roomRevision,
        expectedSeq: 2,
        requestId: 'member-replay-ack',
        eventId: 'member-replay-ack',
      }),
    );
    store.collaboration.setReadiness({
      roomId: ROOM,
      uid: LEARNER,
      readiness: 'left',
      requestId: 'member-replay-leave',
    });
    expectReason(
      () =>
        store.collaboration.applyTeaching(
          command({
            actorUid: LEARNER,
            operation: { kind: 'acknowledge', waitEventId: 'member-replay-wait' },
            expectedRevision: waiting.roomRevision,
            expectedSeq: 2,
            requestId: 'member-replay-ack',
            eventId: 'member-replay-ack',
          }),
        ),
      'not_room_member',
    );
    expect(ack.state.waiting?.acknowledged).toBe(true);
  });

  it('keeps teaching event, state, revision and receipt atomic; survives restart and rejects corruption', () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-teaching-'));
    roots.push(root);
    const file = join(root, 'collab.db');
    let store = open(file);
    const room = activeRoom(store);
    const raw = createNodeSqliteDriver().open(file);
    raw.exec(
      "CREATE TRIGGER fail_teaching_event BEFORE INSERT ON collab_room_events BEGIN SELECT RAISE(ABORT, 'forced rollback'); END",
    );
    expect(() =>
      store.collaboration.applyTeaching(command({ expectedRevision: room.revision })),
    ).toThrow();
    raw.exec('DROP TRIGGER fail_teaching_event');
    expect(store.collaboration.teachingView(ROOM).roomRevision).toBe(room.revision);
    expect(store.collaboration.listEvents(ROOM, 0).events).toHaveLength(0);
    raw.close();

    const first = store.collaboration.applyTeaching(command({ expectedRevision: room.revision }));
    const filePath = store.databaseFile;
    stores.splice(stores.indexOf(store), 1);
    store.close();
    store = open(filePath);
    expect(store.collaboration.teachingView(ROOM).state).toEqual(first.state);
    expect(
      store.collaboration.applyTeaching(command({ expectedRevision: room.revision })).deduplicated,
    ).toBe(true);

    const db = createNodeSqliteDriver().open(filePath);
    db.prepare("UPDATE collab_teaching_states SET state_json='{}' WHERE room_id=?").run(ROOM);
    db.close();
    expectReason(() => store.collaboration.teachingView(ROOM), 'collab_teaching_state_corrupt');
    const digestDb = createNodeSqliteDriver().open(filePath);
    digestDb
      .prepare('UPDATE collab_teaching_states SET state_json=?, state_digest=? WHERE room_id=?')
      .run(JSON.stringify(first.state), 'f'.repeat(64), ROOM);
    digestDb.close();
    expectReason(
      () => store.collaboration.teachingView(ROOM),
      'collab_teaching_state_identity_or_digest_mismatch',
    );
  });

  it('writes and erases public board content, replaying history and refusing off-scene statements', () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-teaching-'));
    roots.push(root);
    const store = open(join(root, 'collab.db'));
    const room = activeRoom(store);

    const written = store.collaboration.applyTeaching(
      command({
        operation: {
          kind: 'write',
          statementId: 'statement-1',
          content: { kind: 'text', text: '板书：函数图像' },
        },
        expectedRevision: room.revision,
        requestId: 'write-1',
        eventId: 'write-1',
      }),
    );
    expect(written.state.board.contents).toHaveLength(1);
    expect(written.state.board.contents?.[0]?.statementId).toBe('statement-1');
    expect(written.state.board.history?.actions).toHaveLength(1);
    expect(written.state.board.history?.actions[0]?.kind).toBe('write');

    // 撤销只翻生效位：内容消失，动作仍在历史里。
    const undone = store.collaboration.applyTeaching(
      command({
        operation: { kind: 'undo-board', actionEventId: 'write-1' },
        expectedRevision: written.roomRevision,
        expectedSeq: 2,
        requestId: 'undo-write-1',
        eventId: 'undo-write-1',
      }),
    );
    expect(undone.state.board.contents).toHaveLength(0);
    expect(
      undone.state.board.history?.actions.find((item) => item.eventId === 'write-1')?.applied,
    ).toBe(false);

    // 重放按原序恢复内容。
    const replayed = store.collaboration.applyTeaching(
      command({
        operation: { kind: 'replay-board', actionEventId: 'write-1' },
        expectedRevision: undone.roomRevision,
        expectedSeq: 3,
        requestId: 'replay-write-1',
        eventId: 'replay-write-1',
      }),
    );
    expect(replayed.state.board.contents).toHaveLength(1);

    // erase 移除已写内容，记录 targetEventId；重复 erase 拒绝。
    const erased = store.collaboration.applyTeaching(
      command({
        operation: { kind: 'erase', actionEventId: 'write-1' },
        expectedRevision: replayed.roomRevision,
        expectedSeq: 4,
        requestId: 'erase-write-1',
        eventId: 'erase-write-1',
      }),
    );
    expect(erased.state.board.contents).toHaveLength(0);
    expect(
      erased.state.board.history?.actions.find((item) => item.eventId === 'erase-write-1')
        ?.targetEventId,
    ).toBe('write-1');
    expectReason(
      () =>
        store.collaboration.applyTeaching(
          command({
            operation: { kind: 'erase', actionEventId: 'write-1' },
            expectedRevision: erased.roomRevision,
            expectedSeq: 5,
            requestId: 'erase-write-2',
            eventId: 'erase-write-2',
          }),
        ),
      'collab_board_content_already_erased',
    );
    expectReason(
      () =>
        store.collaboration.applyTeaching(
          command({
            operation: { kind: 'erase', actionEventId: 'event_not_written' },
            expectedRevision: erased.roomRevision,
            expectedSeq: 5,
            requestId: 'erase-missing',
            eventId: 'erase-missing',
          }),
        ),
      'collab_board_action_not_found',
    );

    // 内容必须挂在当前场景的已审核陈述上。
    expectReason(
      () =>
        store.collaboration.applyTeaching(
          command({
            operation: {
              kind: 'write',
              statementId: 'statement-unknown',
              content: { kind: 'text', text: '凭空内容' },
            },
            expectedRevision: erased.roomRevision,
            expectedSeq: 5,
            requestId: 'write-unknown',
            eventId: 'write-unknown',
          }),
        ),
      'collab_statement_not_in_scene',
    );

    // 切场景清空公共白板内容。
    const moved = store.collaboration.syncScene({
      roomId: ROOM,
      actorUid: OWNER,
      sceneId: 'scene_2',
      lessonId: 'lesson-1',
      lessonVersion: 1,
      expectedRevision: erased.roomRevision,
      expectedSeq: 5,
      eventId: 'move-after-board',
      requestId: 'move-after-board',
    });
    expect(moved.room.currentSceneId).toBe('scene_2');
    expect(store.collaboration.teachingView(ROOM).state.board.contents).toEqual([]);
  });
});
