import {
  StudyError,
  collabTeachingStateSchema,
  type CollabTeachingCommandInput,
  type CollabTeachingStateDto,
  type ClassroomSharedCourseDto,
} from '@sew/study-contracts';

type Board = CollabTeachingStateDto['board'];
type BoardHistory = NonNullable<Board['history']>;
type BoardAction = BoardHistory['actions'][number];

const applyBoardAction = (
  board: Pick<Board, 'focusElementId' | 'laserElementId'>,
  action: Pick<BoardAction, 'kind' | 'elementId'>,
): Pick<Board, 'focusElementId' | 'laserElementId'> => {
  switch (action.kind) {
    case 'focus':
      return { ...board, focusElementId: action.elementId ?? null };
    case 'laser':
      return { ...board, laserElementId: action.elementId ?? null };
    case 'clear-board':
      return { focusElementId: null, laserElementId: null };
  }
};

const replayBoardHistory = (
  history: BoardHistory,
): Pick<Board, 'focusElementId' | 'laserElementId'> =>
  history.actions
    .filter((action) => action.applied)
    .reduce((board, action) => applyBoardAction(board, action), { ...history.baseline });

/** Validate the materialized shared board against its retained current-scene action history. */
export const assertCollabBoardHistoryConsistent = (board: Board): void => {
  if (!board.history) return;
  const replayed = replayBoardHistory(board.history);
  if (
    replayed.focusElementId !== board.focusElementId ||
    replayed.laserElementId !== board.laserElementId
  ) {
    throw new StudyError('INTERNAL', { reason: 'collab_board_history_state_mismatch' });
  }
};

/** Pure authorization and state transition for shared teacher/board actions. */
export const decideCollabTeaching = (facts: {
  command: CollabTeachingCommandInput;
  state: CollabTeachingStateDto;
  snapshot: ClassroomSharedCourseDto;
  ownerUid: string;
  activeMemberUids: readonly string[];
  roomActive: boolean;
  roomRevision: number;
  expectedTailSeq: number;
  nextSeq: number;
  now: string;
}): CollabTeachingStateDto => {
  const { command, state, snapshot } = facts;
  if (!facts.activeMemberUids.includes(command.actorUid)) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'not_room_member' });
  }
  if (!facts.roomActive)
    throw new StudyError('RUN_TERMINATED', { reason: 'collab_room_not_active' });
  if (command.sceneId !== state.sceneId) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_teaching_scene_mismatch' });
  }
  if (command.expectedRevision !== facts.roomRevision) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_room_revision_mismatch' });
  }
  if (command.expectedSeq !== facts.expectedTailSeq + 1) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_event_seq_mismatch' });
  }

  const operation = command.operation;
  const isAcknowledge = operation.kind === 'acknowledge';
  if (!isAcknowledge && command.actorUid !== facts.ownerUid) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'collab_teacher_owner_required' });
  }
  if (
    state.waiting &&
    !['acknowledge', 'release-wait', 'cancel-wait', 'clear-board'].includes(operation.kind)
  ) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_teaching_waiting' });
  }
  assertCollabBoardHistoryConsistent(state.board);

  let next = state;
  switch (operation.kind) {
    case 'speak': {
      const sceneKnowledge =
        snapshot.sceneSources.find((source) => source.sceneId === state.sceneId)?.knowledgeIds ??
        [];
      const statement = snapshot.evidence.statements.find(
        (item) => item.statementId === operation.statementId,
      );
      if (!statement || !sceneKnowledge.includes(statement.knowledgeId)) {
        throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_statement_not_in_scene' });
      }
      if (state.outputs.length >= 200) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_teaching_output_limit' });
      }
      next = collabTeachingStateSchema.parse({
        ...state,
        outputs: [
          ...state.outputs,
          {
            eventId: command.eventId,
            seq: facts.nextSeq,
            sceneId: state.sceneId,
            statementId: statement.statementId,
            body: statement.text,
            conditions: statement.conditions,
            source: 'reviewed_statement',
            createdAt: facts.now,
          },
        ],
      });
      break;
    }
    case 'focus':
    case 'laser': {
      const scene = snapshot.scenes.find((item) => item.sceneId === state.sceneId);
      if (
        scene?.type !== 'slide' ||
        !scene.elements.some((element) => element.elementId === operation.elementId)
      ) {
        throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_element_not_in_scene' });
      }
      const history: BoardHistory = state.board.history ?? {
        baseline: {
          focusElementId: state.board.focusElementId,
          laserElementId: state.board.laserElementId,
        },
        actions: [],
      };
      if (history.actions.length >= 200) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_board_action_limit' });
      }
      const action: BoardAction = {
        eventId: command.eventId,
        seq: facts.nextSeq,
        kind: operation.kind,
        elementId: operation.elementId,
        applied: true,
      };
      const nextHistory: BoardHistory = { ...history, actions: [...history.actions, action] };
      next = collabTeachingStateSchema.parse({
        ...state,
        board: { ...replayBoardHistory(nextHistory), history: nextHistory },
      });
      break;
    }
    case 'clear-board': {
      const history: BoardHistory = state.board.history ?? {
        baseline: {
          focusElementId: state.board.focusElementId,
          laserElementId: state.board.laserElementId,
        },
        actions: [],
      };
      if (history.actions.length >= 200) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_board_action_limit' });
      }
      const nextHistory: BoardHistory = {
        ...history,
        actions: [
          ...history.actions,
          {
            eventId: command.eventId,
            seq: facts.nextSeq,
            kind: 'clear-board',
            applied: true,
          },
        ],
      };
      next = collabTeachingStateSchema.parse({
        ...state,
        board: { ...replayBoardHistory(nextHistory), history: nextHistory },
      });
      break;
    }
    case 'undo-board':
    case 'replay-board': {
      const history = state.board.history;
      const index =
        history?.actions.findIndex((action) => action.eventId === operation.actionEventId) ?? -1;
      if (!history || index < 0) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_board_action_not_found' });
      }
      const target = history.actions[index];
      if (!target)
        throw new StudyError('INTERNAL', { reason: 'collab_board_history_index_invalid' });
      if (operation.kind === 'undo-board' && !target.applied) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_board_action_already_undone' });
      }
      if (operation.kind === 'replay-board' && target.applied) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_board_action_already_applied' });
      }
      const actions = history.actions.map((action, actionIndex) =>
        actionIndex === index ? { ...action, applied: operation.kind === 'replay-board' } : action,
      );
      const nextHistory: BoardHistory = { ...history, actions };
      next = collabTeachingStateSchema.parse({
        ...state,
        board: { ...replayBoardHistory(nextHistory), history: nextHistory },
      });
      break;
    }
    case 'wait':
      if (state.waiting)
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_wait_already_active' });
      if (
        !facts.activeMemberUids.includes(operation.targetUid) ||
        operation.targetUid === command.actorUid
      ) {
        throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_wait_target_invalid' });
      }
      next = collabTeachingStateSchema.parse({
        ...state,
        waiting: {
          waitEventId: command.eventId,
          sceneId: state.sceneId,
          targetUid: operation.targetUid,
          acknowledged: false,
        },
      });
      break;
    case 'acknowledge':
      if (
        !state.waiting ||
        state.waiting.waitEventId !== operation.waitEventId ||
        state.waiting.targetUid !== command.actorUid
      ) {
        throw new StudyError('ROLE_PERMISSION_DENIED', {
          reason: 'collab_wait_acknowledgement_denied',
        });
      }
      if (state.waiting.acknowledged)
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_wait_already_acknowledged' });
      next = collabTeachingStateSchema.parse({
        ...state,
        waiting: { ...state.waiting, acknowledged: true },
      });
      break;
    case 'release-wait':
      if (
        !state.waiting ||
        state.waiting.waitEventId !== operation.waitEventId ||
        !state.waiting.acknowledged
      ) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_wait_not_acknowledged' });
      }
      next = collabTeachingStateSchema.parse({ ...state, waiting: null });
      break;
    case 'cancel-wait':
      if (!state.waiting || state.waiting.waitEventId !== operation.waitEventId) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_wait_event_mismatch' });
      }
      next = collabTeachingStateSchema.parse({ ...state, waiting: null });
      break;
  }
  return next;
};
