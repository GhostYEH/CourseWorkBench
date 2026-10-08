import {
  StudyError,
  collabTeachingStateSchema,
  type CollabTeachingCommandInput,
  type CollabTeachingStateDto,
  type CollabBoardContentDto,
  type ClassroomSharedCourseDto,
} from '@sew/study-contracts';

type Board = CollabTeachingStateDto['board'];
type BoardHistory = NonNullable<Board['history']>;
type BoardAction = BoardHistory['actions'][number];
type BoardReviewedContent = NonNullable<Board['reviewedContents']>[number];
type BoardWriteContent = Extract<
  CollabTeachingCommandInput['operation'],
  { kind: 'write' }
>['content'];
/** 生效白板：生效位 + 按序重放得到的内容列表。 */
interface BoardState {
  focusElementId: string | null;
  laserElementId: string | null;
  contents: CollabBoardContentDto[];
}

const EMPTY_CONTENTS: CollabBoardContentDto[] = [];

const boardContents = (board: Pick<Board, 'contents'>): CollabBoardContentDto[] =>
  board.contents ?? EMPTY_CONTENTS;

/** 生效白板 = 基线 + 按 seq 顺序重放所有 applied 动作；撤销只是把某条置为不生效。 */
const applyBoardAction = (board: BoardState, action: BoardAction): BoardState => {
  switch (action.kind) {
    case 'focus':
      return { ...board, focusElementId: action.elementId ?? null };
    case 'laser':
      return { ...board, laserElementId: action.elementId ?? null };
    case 'clear-board':
      return { ...board, focusElementId: null, laserElementId: null };
    case 'write':
      return {
        ...board,
        contents: [
          ...board.contents,
          {
            eventId: action.eventId,
            seq: action.seq,
            statementId: action.statementId ?? '',
            content: action.content!,
            ...(action.reviewEventId ? { reviewEventId: action.reviewEventId } : {}),
          },
        ],
      };
    case 'erase':
      return {
        ...board,
        contents: board.contents.filter((content) => content.eventId !== action.targetEventId),
      };
  }
};

const replayBoardHistory = (history: BoardHistory): BoardState =>
  history.actions
    .filter((action) => action.applied)
    .reduce<BoardState>((board, action) => applyBoardAction(board, action), {
      focusElementId: history.baseline.focusElementId,
      laserElementId: history.baseline.laserElementId,
      contents: [],
    });

const sameContents = (left: CollabBoardContentDto[], right: CollabBoardContentDto[]): boolean =>
  left.length === right.length &&
  left.every((content, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      content.eventId === other.eventId &&
      content.seq === other.seq &&
      content.statementId === other.statementId &&
      content.reviewEventId === other.reviewEventId &&
      stableJson(content.content) === stableJson(other.content)
    );
  });

/** Validate the materialized shared board against its retained current-scene action history. */
export const assertCollabBoardHistoryConsistent = (
  board: Board,
  context?: { sceneId: string; ownerUid: string },
): void => {
  if (board.history) {
    const replayed = replayBoardHistory(board.history);
    if (
      replayed.focusElementId !== board.focusElementId ||
      replayed.laserElementId !== board.laserElementId ||
      !sameContents(replayed.contents, boardContents(board))
    ) {
      throw new StudyError('INTERNAL', { reason: 'collab_board_history_state_mismatch' });
    }
  }
  const reviewed = board.reviewedContents ?? [];
  const reviewedById = new Map(reviewed.map((item) => [item.eventId, item]));
  if (reviewedById.size !== reviewed.length) {
    throw new StudyError('INTERNAL', { reason: 'collab_board_review_receipt_duplicate' });
  }
  const actionEventIds = new Set((board.history?.actions ?? []).map((item) => item.eventId));
  const actionSeqs = new Set((board.history?.actions ?? []).map((item) => item.seq));
  if (reviewed.some((item) => actionEventIds.has(item.eventId) || actionSeqs.has(item.seq))) {
    throw new StudyError('INTERNAL', { reason: 'collab_board_review_action_identity_collision' });
  }
  if (
    context &&
    reviewed.some(
      (item) => item.sceneId !== context.sceneId || item.reviewerUid !== context.ownerUid,
    )
  ) {
    throw new StudyError('INTERNAL', { reason: 'collab_board_review_receipt_scope_mismatch' });
  }
  for (const action of board.history?.actions ?? []) {
    if (action.kind !== 'write' || !action.reviewEventId) continue;
    const receipt = reviewedById.get(action.reviewEventId);
    if (
      !receipt ||
      (context !== undefined && receipt.sceneId !== context.sceneId) ||
      (context !== undefined && receipt.reviewerUid !== context.ownerUid) ||
      receipt.statementId !== action.statementId ||
      stableJson(receipt.content) !== stableJson(action.content)
    ) {
      throw new StudyError('INTERNAL', { reason: 'collab_board_review_receipt_mismatch' });
    }
  }
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
};

/** 读取当前场景的动作历史；旧状态没有历史时用当前生效位作基线补一个空历史。 */
const historyOf = (state: CollabTeachingStateDto): BoardHistory =>
  state.board.history ?? {
    baseline: {
      focusElementId: state.board.focusElementId,
      laserElementId: state.board.laserElementId,
    },
    actions: [],
  };

/** Keep the separately persisted human-review ledger when materializing board history. */
const boardFromHistory = (state: CollabTeachingStateDto, history: BoardHistory): Board => ({
  ...replayBoardHistory(history),
  ...(state.board.reviewedContents ? { reviewedContents: state.board.reviewedContents } : {}),
  history,
});

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
  assertCollabBoardHistoryConsistent(state.board, {
    sceneId: state.sceneId,
    ownerUid: facts.ownerUid,
  });

  /** 只接受当前场景知识点关联的冻结已审核陈述：正文/内容不凭空产生。 */
  const requireSceneStatement = (statementId: string) => {
    const sceneKnowledge =
      snapshot.sceneSources.find((source) => source.sceneId === state.sceneId)?.knowledgeIds ?? [];
    const statement = snapshot.evidence.statements.find((item) => item.statementId === statementId);
    if (!statement || !sceneKnowledge.includes(statement.knowledgeId)) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_statement_not_in_scene' });
    }
    return statement;
  };

  const requireReviewReceipt = (
    reviewEventId: string,
    statementId: string,
    content: BoardWriteContent,
  ): BoardReviewedContent => {
    const receipt = (state.board.reviewedContents ?? []).find(
      (item) => item.eventId === reviewEventId,
    );
    if (
      !receipt ||
      receipt.sceneId !== state.sceneId ||
      receipt.statementId !== statementId ||
      receipt.reviewerUid !== facts.ownerUid ||
      stableJson(receipt.content) !== stableJson(content)
    ) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_board_review_receipt_required' });
    }
    return receipt;
  };

  let next = state;
  switch (operation.kind) {
    case 'speak': {
      const statement = requireSceneStatement(operation.statementId);
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
      const history = historyOf(state);
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
        board: boardFromHistory(state, nextHistory),
      });
      break;
    }
    case 'clear-board': {
      const history = historyOf(state);
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
        board: boardFromHistory(state, nextHistory),
      });
      break;
    }
    case 'review-board-content': {
      requireSceneStatement(operation.statementId);
      const reviewedContents = state.board.reviewedContents ?? [];
      if (reviewedContents.length >= 200) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_board_review_limit' });
      }
      const receipt: BoardReviewedContent = {
        eventId: command.eventId,
        seq: facts.nextSeq,
        statementId: operation.statementId,
        content: operation.content,
        reviewerUid: command.actorUid,
        sceneId: state.sceneId,
      };
      next = collabTeachingStateSchema.parse({
        ...state,
        board: { ...state.board, reviewedContents: [...reviewedContents, receipt] },
      });
      break;
    }
    case 'write': {
      requireSceneStatement(operation.statementId);
      requireReviewReceipt(operation.reviewEventId, operation.statementId, operation.content);
      const history = historyOf(state);
      if (history.actions.length >= 200) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_board_action_limit' });
      }
      const action: BoardAction = {
        eventId: command.eventId,
        seq: facts.nextSeq,
        kind: 'write',
        statementId: operation.statementId,
        content: operation.content,
        reviewEventId: operation.reviewEventId,
        applied: true,
      };
      const nextHistory: BoardHistory = { ...history, actions: [...history.actions, action] };
      next = collabTeachingStateSchema.parse({
        ...state,
        board: boardFromHistory(state, nextHistory),
      });
      break;
    }
    case 'erase': {
      const history = historyOf(state);
      const target = history.actions.find(
        (action) => action.eventId === operation.actionEventId && action.kind === 'write',
      );
      if (!target || !target.applied) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_board_action_not_found' });
      }
      // 同一条内容已被某条生效的 erase 擦除时不再重复擦除；撤销该 erase 后即可再次擦除。
      if (
        history.actions.some(
          (action) =>
            action.kind === 'erase' &&
            action.applied &&
            action.targetEventId === operation.actionEventId,
        )
      ) {
        throw new StudyError('VERSION_CONFLICT', {
          reason: 'collab_board_content_already_erased',
        });
      }
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
            kind: 'erase',
            targetEventId: operation.actionEventId,
            applied: true,
          },
        ],
      };
      next = collabTeachingStateSchema.parse({
        ...state,
        board: boardFromHistory(state, nextHistory),
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
        board: boardFromHistory(state, nextHistory),
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
