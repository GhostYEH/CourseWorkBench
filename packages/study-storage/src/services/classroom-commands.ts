import {
  StudyError,
  newId,
  type ClassroomPeerTurnDto,
  type ExplanationCardDto,
  type ModelCallPurpose,
  type PeerEngagement,
} from '@sew/study-contracts';
import {
  assertCardGrounded,
  assertCardPlayable,
  assertClassroomBudget,
  assertPeerTurnAllowed,
  assertSessionActive,
  buildStepKey,
  nextPlayableCard,
} from '@sew/study-domain';
import type { LessonRepository } from '../repositories/lessons';
import type { RoleRepository } from '../repositories/roles';
import type { RunsRepository } from '../repositories/runs';
import type { TeachingRepository } from '../repositories/teaching';
import type { ClassroomSessionRow, ExplanationRow } from '../repositories/types';
import type { StudyStore } from '../store';

interface ClassroomCommandDeps extends Pick<
  StudyStore,
  'transaction' | 'assertClassroomSessionReady' | 'classroomBoardStatementIds' | 'checkAdmission'
> {
  teaching: TeachingRepository;
  runs: RunsRepository;
  roles: RoleRepository;
  lessons: LessonRepository;
  requireSession: (sessionId: string, projectId: string) => ClassroomSessionRow;
  toCard: (row: ExplanationRow) => ExplanationCardDto;
}

/** Stateful teaching commands own their receipt and transaction protocol; StudyStore remains the stable facade. */
export class ClassroomCommands {
  constructor(private readonly deps: ClassroomCommandDeps) {}

  setClassroomPeers(
    projectId: string,
    sessionId: string,
    input: {
      enabled: boolean;
      engagement?: PeerEngagement;
    },
  ): ClassroomSessionRow {
    const session = this.deps.requireSession(sessionId, projectId);
    assertSessionActive(session.status);
    if (input.enabled) {
      const peers = this.deps.roles.list('formal').filter((profile) => profile.kind === 'peer');
      if (peers.length === 0) {
        throw new StudyError('INVALID_ARGUMENT', { reason: 'no_peer_profile_configured' });
      }
    }
    return this.deps.teaching.updateSession(sessionId, projectId, {
      peersEnabled: input.enabled,
      ...(input.engagement ? { peersEngagement: input.engagement } : {}),
    });
  }

  recordClassroomPeerTurn(input: {
    projectId: string;
    sessionId: string;
    roleProfileId: string;
    kind: 'question' | 'discussion' | 'example';
    text: string;
    statementIds: string[];
    reviewedExampleId: string | null;
    /** 稳定请求 ID：同一次发言重试读回既有结果。 */
    requestId: string;
  }): { turn: ClassroomPeerTurnDto; deduplicated: boolean } {
    return this.deps.transaction(() => {
      const session = this.deps.requireSession(input.sessionId, input.projectId);
      const stepKey = buildStepKey(
        'classroom-peer-turn',
        input.projectId,
        session.sessionId,
        input.requestId,
      );
      const existing = this.deps.teaching.getReceipt(stepKey);
      if (existing) {
        const receipt = existing.payload;
        // 重试必须落在同一个「谁、以什么方式开口」上：换了同学或换了发言方式就不是同一次请求。
        if (
          receipt.kind !== 'peer_turn' ||
          receipt.roleProfileId !== input.roleProfileId ||
          receipt.peerKind !== input.kind
        ) {
          throw new StudyError('VERSION_CONFLICT', { reason: 'peer_turn_context_changed' });
        }
        const turn = this.deps.teaching
          .listPeerTurns(input.sessionId, input.projectId)
          .find((item) => item.turnId === receipt.turnId);
        if (!turn) throw new StudyError('INTERNAL', { reason: 'peer_turn_receipt_without_turn' });
        if (
          turn.text !== input.text ||
          turn.reviewedExampleId !== input.reviewedExampleId ||
          JSON.stringify(turn.statementIds) !== JSON.stringify(input.statementIds)
        ) {
          throw new StudyError('VERSION_CONFLICT', { reason: 'peer_turn_context_changed' });
        }
        return { turn, deduplicated: true };
      }
      const profile = this.deps.roles.get(input.roleProfileId, 'formal');
      if (!profile || profile.kind !== 'peer')
        throw new StudyError('NOT_FOUND', { roleProfileId: input.roleProfileId });
      // 轮内实际条数才是权威：会话计数列可能因外部改写而偏低，不能作为放行依据。
      const actualTurns = this.deps.teaching.peerTurnCount(
        input.sessionId,
        input.projectId,
        session.roundIndex,
      );
      assertPeerTurnAllowed({
        sessionStatus: session.status,
        peersEnabled: session.peersEnabled,
        engagement: session.peersEngagement,
        roundPeerTurns: Math.max(actualTurns, session.roundPeerTurns),
        roleKind: profile.kind,
        actorType: 'peer_ai',
        partition: 'simulation',
      });
      const ready = this.deps.assertClassroomSessionReady(input.projectId, input.sessionId);
      const allowed = session.stageId
        ? this.deps.classroomBoardStatementIds(input.projectId, input.sessionId)
        : ready.lesson.statementIds;
      if (
        input.statementIds.length === 0 ||
        input.statementIds.some((id) => !allowed.includes(id))
      ) {
        throw new StudyError('SOURCE_MISSING', { reason: 'peer_statement_outside_scene' });
      }
      if (input.kind === 'example') {
        const card = this.deps.teaching
          .listCards(session.lessonId, session.lessonVersion, input.projectId)
          .find((item) => item.explanationId === input.reviewedExampleId);
        if (
          !card ||
          card.status !== 'approved' ||
          card.sceneId !== session.currentSceneId ||
          input.statementIds.some((id) => !card.statementIds.includes(id))
        ) {
          throw new StudyError('SOURCE_MISSING', { reason: 'no_reviewed_example_in_scene' });
        }
      }
      // 发言行、轮内计数与收据必须在同一个事务里：任一步失败都不能留下半条发言，
      // 否则「同学已经说过话」和「收据说没说过」会互相矛盾，重试还会再多一条。
      let created: ClassroomPeerTurnDto | null = null;
      // 编号先生成，收据与发言行共用同一个 turnId：重试时才能按收据精确读回那一条。
      const turnId = newId<string>('peer');
      this.deps.teaching.recordAction(
        {
          stepKey,
          sessionId: session.sessionId,
          projectId: input.projectId,
          sceneId: session.currentSceneId,
          payload: {
            kind: 'peer_turn',
            roleProfileId: input.roleProfileId,
            turnId,
            roundIndex: session.roundIndex,
            peerKind: input.kind,
          },
        },
        () => {
          created = this.deps.teaching.createPeerTurn({
            projectId: input.projectId,
            sessionId: input.sessionId,
            sceneId: session.currentSceneId,
            roundIndex: session.roundIndex,
            roleProfileId: input.roleProfileId,
            peerName: profile.name,
            kind: input.kind,
            text: input.text,
            statementIds: input.statementIds,
            reviewedExampleId: input.reviewedExampleId,
            turnId,
          });
          this.deps.teaching.updateSession(session.sessionId, input.projectId, {
            roundPeerTurns: Math.max(actualTurns, session.roundPeerTurns) + 1,
          });
        },
      );
      if (!created) throw new StudyError('INTERNAL', { reason: 'peer_turn_not_committed' });
      return { turn: created, deduplicated: false };
    });
  }

  playNextExplanation(
    projectId: string,
    sessionId: string,
    requestId: string,
  ): {
    card: ExplanationCardDto | null;
    deduplicated: boolean;
    session: ClassroomSessionRow;
    playedIds: string[];
  } {
    const session = this.deps.teaching.getSession(sessionId, projectId);
    if (!session) throw new StudyError('NOT_FOUND', { sessionId });
    assertSessionActive(session.status);
    if (session.status === 'awaiting_learner') {
      throw new StudyError('CLASSROOM_AWAITING_LEARNER', { reason: 'awaiting_learner' });
    }
    this.deps.assertClassroomSessionReady(projectId, sessionId);
    const stepKey = buildStepKey('classroom-play-request', projectId, sessionId, requestId);
    const existing = this.deps.teaching.getReceipt(stepKey);
    if (existing) {
      if (existing.sceneId !== session.currentSceneId) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'play_request_context_changed' });
      }
      if (existing.payload.kind === 'queue_empty') {
        return {
          card: null,
          deduplicated: true,
          session,
          playedIds: this.deps.teaching.playedCardIds(sessionId, projectId),
        };
      }
      if (existing.payload.kind !== 'card_played')
        throw new StudyError('INTERNAL', { reason: 'play_receipt_invalid' });
      const saved = this.deps.teaching.getCard(existing.payload.explanationId, projectId);
      if (!saved) throw new StudyError('INTERNAL', { reason: 'played_card_missing' });
      return {
        card: this.deps.toCard(saved),
        deduplicated: true,
        session,
        playedIds: this.deps.teaching.playedCardIds(sessionId, projectId),
      };
    }
    const cards = this.deps.teaching.listCards(session.lessonId, session.lessonVersion, projectId);
    const played = new Set(this.deps.teaching.playedCardIds(sessionId, projectId));
    const next = nextPlayableCard(
      cards.map((card) => this.deps.toCard(card)),
      played,
      session.currentSceneId,
    );
    if (!next) {
      this.deps.teaching.recordAction(
        {
          stepKey,
          sessionId,
          projectId,
          sceneId: session.currentSceneId,
          payload: {
            kind: 'queue_empty',
            sceneId: session.currentSceneId,
            roundIndex: session.roundIndex,
          },
        },
        () => undefined,
      );
      return { card: null, deduplicated: false, session, playedIds: [...played] };
    }
    const bundle = this.deps.lessons.getBundle(session.bundleId, projectId);
    if (!bundle) throw new StudyError('INTERNAL', { bundleId: session.bundleId });
    const knowledgeIds = assertCardGrounded(next.statementIds, bundle.bundle);
    assertCardPlayable(
      { cardStatus: next.status, sessionStatus: session.status, knowledgeIds },
      new Set(this.deps.checkAdmission(knowledgeIds, 'formal').admitted),
    );
    const { deduplicated } = this.deps.teaching.recordAction(
      {
        stepKey,
        sessionId,
        projectId,
        sceneId: next.sceneId,
        payload: {
          kind: 'card_played',
          explanationId: next.explanationId,
          sceneId: next.sceneId,
          position: next.position,
          origin: next.origin,
        },
      },
      () => undefined,
    );
    const playedIds = this.deps.teaching.playedCardIds(sessionId, projectId);
    return {
      card: next,
      deduplicated,
      session: this.deps.requireSession(sessionId, projectId),
      playedIds,
    };
  }

  handBackToLearner(projectId: string, sessionId: string, reason: string): ClassroomSessionRow {
    const session = this.deps.requireSession(sessionId, projectId);
    assertSessionActive(session.status);
    const stepKey = buildStepKey(
      'classroom-handback',
      projectId,
      sessionId,
      `r${session.roundIndex}`,
    );
    this.deps.teaching.recordAction(
      {
        stepKey,
        sessionId,
        projectId,
        sceneId: session.currentSceneId,
        payload: { kind: 'handback', reason, roundIndex: session.roundIndex },
      },
      () => {
        this.deps.teaching.updateSession(sessionId, projectId, {
          status: 'awaiting_learner',
          awaitingReason: reason,
        });
        if (session.runId) this.deps.runs.updateRunState(session.runId, 'awaiting_answer');
      },
    );
    return this.deps.requireSession(sessionId, projectId);
  }

  markLearnerAnswered(projectId: string, sessionId: string): ClassroomSessionRow {
    const session = this.deps.requireSession(sessionId, projectId);
    assertSessionActive(session.status);
    // 只有正在等待本人的会话才需要「作答归来」，否则等于凭空造一次作答记录。
    if (session.status !== 'awaiting_learner') {
      throw new StudyError('INVALID_ARGUMENT', {
        reason: 'not_awaiting_learner',
        status: session.status,
      });
    }
    const roundIndex = session.roundIndex + 1;
    const stepKey = buildStepKey(
      'classroom-answered',
      projectId,
      sessionId,
      `r${session.roundIndex}`,
    );
    this.deps.teaching.recordAction(
      {
        stepKey,
        sessionId,
        projectId,
        sceneId: session.currentSceneId,
        payload: {
          kind: 'learner_answered',
          roundIndex: session.roundIndex,
          sceneId: session.currentSceneId,
        },
      },
      () => {
        this.deps.teaching.updateSession(sessionId, projectId, {
          status: 'in_class',
          awaitingReason: '',
          roundIndex,
          roundCalls: 0,
          roundPeerTurns: 0,
        });
        if (session.runId) this.deps.runs.updateRunState(session.runId, 'collecting_feedback');
      },
    );
    return this.deps.requireSession(sessionId, projectId);
  }

  advanceClassroomScene(
    projectId: string,
    sessionId: string,
    sceneId: string,
    requestId: string,
  ): {
    session: ClassroomSessionRow;
    deduplicated: boolean;
  } {
    const session = this.deps.requireSession(sessionId, projectId);
    assertSessionActive(session.status);
    if (session.status === 'awaiting_learner') {
      throw new StudyError('CLASSROOM_AWAITING_LEARNER', { reason: 'awaiting_learner' });
    }
    const stepKey = buildStepKey('classroom-scene-request', projectId, sessionId, requestId);
    const existing = this.deps.teaching.getReceipt(stepKey);
    if (existing) {
      if (existing.payload.kind !== 'scene_advanced' || existing.payload.toSceneId !== sceneId) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'scene_request_context_changed' });
      }
      return { session, deduplicated: true };
    }
    if (sceneId === session.currentSceneId) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'scene_already_current' });
    }
    const roundIndex = session.roundIndex + 1;
    const { deduplicated } = this.deps.teaching.recordAction(
      {
        stepKey,
        sessionId,
        projectId,
        sceneId,
        payload: {
          kind: 'scene_advanced',
          fromSceneId: session.currentSceneId,
          toSceneId: sceneId,
          roundIndex: session.roundIndex,
        },
      },
      () => {
        this.deps.teaching.updateSession(sessionId, projectId, {
          currentSceneId: sceneId,
          roundIndex,
          roundCalls: 0,
          roundPeerTurns: 0,
        });
      },
    );
    return { session: this.deps.requireSession(sessionId, projectId), deduplicated };
  }

  closeClassroomSession(
    projectId: string,
    sessionId: string,
    status: 'completed' | 'cancelled',
    reason: string,
  ): ClassroomSessionRow {
    const session = this.deps.requireSession(sessionId, projectId);
    assertSessionActive(session.status);
    const stepKey = buildStepKey('classroom-close', projectId, sessionId, status);
    this.deps.teaching.recordAction(
      {
        stepKey,
        sessionId,
        projectId,
        sceneId: session.currentSceneId,
        payload: { kind: 'session_closed', status, reason },
      },
      () => {
        this.deps.teaching.updateSession(sessionId, projectId, { status, awaitingReason: reason });
        if (session.runId)
          this.deps.runs.updateRunState(
            session.runId,
            status === 'completed' ? 'completed' : 'cancelled',
            reason,
          );
      },
    );
    return this.deps.requireSession(sessionId, projectId);
  }

  noteClassroomModelCall(input: {
    projectId: string;
    sessionId: string;
    purpose: ModelCallPurpose;
    ok: boolean;
    totalTokens: number;
    callId?: string;
    expectedRoundIndex?: number;
    expectedSceneId?: string;
    /** A dispatched result whose frozen context is obsolete: account, never resume teaching. */
    discarded?: boolean;
    limits?: { maxCallsPerRound?: number; maxPeerTurnsPerRound?: number; maxLessonCalls?: number };
  }): ClassroomSessionRow {
    const session = this.deps.requireSession(input.sessionId, input.projectId);
    const stepKey = input.callId
      ? buildStepKey('classroom-model-attempt', input.projectId, session.sessionId, input.callId)
      : buildStepKey(
          'classroom-model',
          input.projectId,
          session.sessionId,
          `r${session.roundIndex}`,
          session.roundCalls + 1,
        );
    const existing = this.deps.teaching.getReceipt(stepKey);
    if (existing) {
      if (existing.payload.kind !== 'model_call' || existing.payload.purpose !== input.purpose) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'model_call_context_changed' });
      }
      return session;
    }
    if (!input.discarded) {
      assertSessionActive(session.status);
      assertClassroomBudget(
        {
          roundCalls: session.roundCalls,
          roundPeerTurns: session.roundPeerTurns,
          lessonCalls: session.lessonCalls,
          peersEnabled: session.peersEnabled,
          ...input.limits,
        },
        'model_call',
      );
    }
    this.deps.teaching.recordAction(
      {
        stepKey,
        sessionId: session.sessionId,
        projectId: input.projectId,
        sceneId: input.expectedSceneId ?? session.currentSceneId,
        payload: {
          kind: 'model_call',
          purpose: input.purpose,
          roundIndex: input.expectedRoundIndex ?? session.roundIndex,
          ok: input.ok,
          totalTokens: input.totalTokens,
        },
      },
      () => {
        this.deps.teaching.updateSession(session.sessionId, input.projectId, {
          roundCalls:
            input.expectedRoundIndex === undefined ||
            input.expectedRoundIndex === session.roundIndex
              ? session.roundCalls + 1
              : session.roundCalls,
          lessonCalls: session.lessonCalls + 1,
        });
      },
    );
    return this.deps.requireSession(session.sessionId, input.projectId);
  }
}
