import { createHash } from 'node:crypto';
import {
  StudyError,
  directorCommandSchema,
  directorStateSchema,
  type DirectorCommandDto,
  type DirectorStateDto,
  type DirectorStepDto,
} from '@sew/study-contracts';
import {
  assertDirectorContinuable,
  directorCandidateDigest,
  directorCurrentStep,
  nextPlayableCard,
} from '@sew/study-domain';
import { assertScope, type Session } from './service';
import { loadRenderableFormalDocument } from './classroom-service';
import { assertRecoveryExecution } from './classroom-recovery-guard';
import { withRoomTeacher } from './room-teacher';
import { generateGuarded } from './model-call';
import { modelConnection, type createModelConnectionRuntime } from './model-connection';

type DirectorConnection = Pick<
  ReturnType<typeof createModelConnectionRuntime>,
  'status' | 'generate' | 'revision'
>;
const globals = globalThis as typeof globalThis & {
  __sewActiveDirectors?: Map<string, AbortController>;
};
const active = (globals.__sewActiveDirectors ??= new Map());
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = (session: Session, sessionId: string): string =>
  `${session.projectId}|${sessionId}`;
const learnerKey = (session: Session): string => `director:${session.learnerUid}`;
const storageKey = (sessionId: string): string => `director:${sessionId}`;

const assertCurrent = (session: Session): void => {
  const latest = assertScope({ projectId: session.projectId, generation: session.generation });
  if (latest.store !== session.store) throw new StudyError('PROJECT_GENERATION_STALE');
};
const ownClassroom = (session: Session, sessionId: string) => {
  assertCurrent(session);
  const classroom = session.store.getClassroomSession(sessionId, session.projectId);
  if (!classroom) throw new StudyError('NOT_FOUND');
  const binding = session.store.getLocalLearnerBinding(session.projectId);
  if (!binding || binding.uid !== session.learnerUid || binding.learnerKey !== classroom.learnerKey)
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'director_learner_mismatch' });
  const room = session.store.getClassroomRoomForSession(
    session.projectId,
    sessionId,
    session.learnerUid,
  );
  if (room && room.ownerUid !== session.learnerUid)
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'director_teacher_required' });
  return classroom;
};
const readSaved = (session: Session, sessionId: string): DirectorStateDto | null => {
  ownClassroom(session, sessionId);
  const raw = session.store.classroomKV.get(
    session.projectId,
    learnerKey(session),
    storageKey(sessionId),
  );
  if (raw === null) return null;
  const parsed = directorStateSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.projectId !== session.projectId ||
    parsed.data.sessionId !== sessionId ||
    parsed.data.learnerUid !== session.learnerUid
  )
    throw new StudyError('INTERNAL', { reason: 'director_persisted_state_invalid' });
  return parsed.data;
};
const save = (session: Session, state: DirectorStateDto): DirectorStateDto => {
  const value = directorStateSchema.parse({ ...state, updatedAt: new Date().toISOString() });
  session.store.classroomKV.set(
    session.projectId,
    learnerKey(session),
    storageKey(state.sessionId),
    value,
  );
  const receipt = value.receipts.at(-1);
  if (receipt)
    session.store.classroomKV.set(
      session.projectId,
      learnerKey(session),
      `director:request:${state.sessionId}:${receipt.requestId}`,
      { ...receipt, directorId: state.directorId },
    );
  return value;
};

/** Read-only restart: an orphaned dispatch is displayed as unknown, never replayed or rewritten. */
export const readDirector = (session: Session, sessionId: string): DirectorStateDto | null => {
  const state = readSaved(session, sessionId);
  if (
    !state ||
    active.has(identity(session, sessionId)) ||
    !state.steps.some((step) => step.state === 'started')
  )
    return state;
  return directorStateSchema.parse({
    ...state,
    state: ['stopped', 'paused'].includes(state.state) ? state.state : 'unknown',
    steps: state.steps.map((step) =>
      step.state === 'started' ? { ...step, state: 'unknown' } : step,
    ),
    message: '原调用已登记，但执行结果未确认。读取和继续均不会重发；新调用需停止后明确新建调度。',
  });
};

const context = (session: Session, state: DirectorStateDto) => {
  const classroom = ownClassroom(session, state.sessionId);
  const run = session.store.getLatestRun();
  if (!run || run.runId !== state.runId || ['completed', 'failed', 'cancelled'].includes(run.state))
    throw new StudyError('RUN_TERMINATED', { reason: 'director_run_changed' });
  const plan = session.store.getConfirmedPlan(session.projectId);
  if (!plan || plan.version !== run.frozen.planVersion) throw new StudyError('PLAN_NOT_CONFIRMED');
  const ready = session.store.assertLessonClassroomReady(state.lessonId, session.projectId);
  const document = loadRenderableFormalDocument(session, state.lessonId);
  if (
    !document ||
    document.stageId !== state.stageId ||
    document.digest !== state.documentDigest ||
    document.lessonVersion !== state.lessonVersion ||
    ready.lesson.version !== state.lessonVersion ||
    ready.lesson.bundleDigest !== state.bundleDigest ||
    classroom.stageId !== state.stageId ||
    classroom.lessonVersion !== state.lessonVersion ||
    classroom.runId !== state.runId ||
    classroom.currentSceneId !== state.sceneIds[state.sceneIndex]
  )
    throw new StudyError('VERSION_CONFLICT', { reason: 'director_context_changed' });
  if (run.frozen.knowledgeTableDigest !== session.store.knowledgeTableDigest())
    throw new StudyError('KNOWLEDGE_INVALIDATED');
  if (state.roleDigest !== hash(session.store.listRoleProfiles('formal')))
    throw new StudyError('VERSION_CONFLICT', { reason: 'director_roles_changed' });
  return { classroom, document, ready, run };
};

const start = (
  session: Session,
  input: DirectorCommandDto,
  receipt: { requestId: string; intent: string },
): DirectorStateDto => {
  const classroom = ownClassroom(session, input.sessionId);
  if (classroom.status !== 'in_class')
    throw new StudyError(
      classroom.status === 'awaiting_learner' ? 'CLASSROOM_AWAITING_LEARNER' : 'RUN_TERMINATED',
    );
  session.store.assertClassroomSessionReady(session.projectId, classroom.sessionId);
  assertRecoveryExecution(session, classroom.sessionId);
  const document = loadRenderableFormalDocument(session, classroom.lessonId);
  if (!document || document.stageId !== classroom.stageId || document.scenes.length > 48)
    throw new StudyError('INVALID_ARGUMENT', { reason: 'director_formal_document_required' });
  const run = session.store.getLatestRun();
  if (
    !run ||
    run.runId !== classroom.runId ||
    ['completed', 'failed', 'cancelled'].includes(run.state)
  )
    throw new StudyError('RUN_TERMINATED');
  if (run.frozen.knowledgeTableDigest !== session.store.knowledgeTableDigest())
    throw new StudyError('KNOWLEDGE_INVALIDATED');
  const lesson = session.store.getLessonVersion(
    classroom.lessonId,
    classroom.lessonVersion,
    session.projectId,
  )!;
  const bundle = session.store.getEvidenceBundle(session.projectId, classroom.bundleId)!;
  const profiles = session.store.listRoleProfiles('formal');
  const peers = classroom.peersEnabled
    ? profiles.filter((profile) => profile.kind === 'peer').slice(0, 2)
    : [];
  const currentIndex = document.scenes.findIndex(
    (scene) => scene.sceneId === classroom.currentSceneId,
  );
  if (currentIndex < 0) throw new StudyError('VERSION_CONFLICT');
  const scenes = document.scenes.slice(currentIndex);
  const directorId = `director_${hash({ sessionId: input.sessionId, requestId: input.requestId }).slice(0, 28)}`;
  const steps: DirectorStepDto[] = scenes.flatMap((scene) => {
    const statementIds = bundle.bundle.statements
      .filter(
        (statement) =>
          lesson.statementIds.includes(statement.statementId) &&
          scene.knowledgeIds.includes(statement.knowledgeId),
      )
      .map((statement) => statement.statementId);
    if (scene.sceneType === 'slide' && statementIds.length === 0)
      throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING');
    const roles =
      scene.sceneType === 'slide'
        ? [
            {
              role: 'teacher' as const,
              profileId: profiles.find((profile) => profile.kind === 'teacher')?.profileId ?? null,
              name: 'AI 教师',
            },
            ...peers.map((peer) => ({
              role: 'peer' as const,
              profileId: peer.profileId,
              name: peer.name,
            })),
          ]
        : [{ role: 'learner' as const, profileId: null, name: '本人' }];
    return roles.map((role, index) => {
      const stepId = `ds_${hash({ directorId, sceneId: scene.sceneId, index }).slice(0, 28)}`;
      return {
        stepId,
        sceneId: scene.sceneId,
        sceneType: scene.sceneType,
        role: role.role,
        roleProfileId: role.profileId,
        roleName: role.name,
        statementIds,
        state: 'queued' as const,
        generationRequestId: `dg_${hash(stepId).slice(0, 28)}`,
        candidate: null,
      };
    });
  });
  const now = new Date().toISOString();
  return save(session, {
    schemaVersion: 1,
    directorId,
    projectId: session.projectId,
    learnerUid: session.learnerUid,
    sessionId: input.sessionId,
    runId: run.runId,
    lessonId: classroom.lessonId,
    lessonVersion: classroom.lessonVersion,
    bundleDigest: lesson.bundleDigest,
    documentDigest: document.digest,
    roleDigest: hash(profiles),
    stageId: document.stageId,
    sceneIds: scenes.map((scene) => scene.sceneId),
    sceneIndex: 0,
    state: 'ready',
    steps,
    message:
      '调度已保存。每次继续只执行一项；教师内容需审核，冻结内容模拟同学始终属于 simulation。',
    receipts: [receipt],
    createdAt: now,
    updatedAt: now,
  });
};

const assertCandidate = (
  session: Session,
  state: DirectorStateDto,
  step: DirectorStepDto,
): void => {
  const candidate = step.candidate;
  if (
    !candidate ||
    directorCandidateDigest(state, step, candidate.text, candidate.explanationId) !==
      candidate.digest
  )
    throw new StudyError('VERSION_CONFLICT', { reason: 'director_candidate_changed' });
  const allowed = session.store.classroomBoardStatementIds(session.projectId, state.sessionId);
  if (step.statementIds.length < 1 || step.statementIds.some((id) => !allowed.includes(id)))
    throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING');
  if (step.role === 'teacher') {
    const card = candidate.explanationId
      ? session.store.getExplanation(candidate.explanationId, session.projectId)
      : null;
    if (
      !card ||
      card.text !== candidate.text ||
      card.sceneId !== step.sceneId ||
      card.lessonId !== state.lessonId ||
      card.lessonVersion !== state.lessonVersion ||
      (candidate.review === 'approved' &&
        (card.status !== 'approved' || hash(card.statementIds) !== hash(step.statementIds)))
    )
      throw new StudyError('VERSION_CONFLICT', { reason: 'director_card_changed' });
  }
};

export const commandDirector = async (
  session: Session,
  raw: DirectorCommandDto,
  options: { signal?: AbortSignal; connection?: DirectorConnection } = {},
): Promise<DirectorStateDto> => {
  const input = directorCommandSchema.parse(raw);
  assertCurrent(session);
  assertScope(input.scope);
  const receipt = {
    requestId: input.requestId,
    intent: hash({ ...input, scope: { projectId: input.scope.projectId } }),
  };
  let dispatch: { state: DirectorStateDto; step: DirectorStepDto } | null = null;
  const result = session.store.transaction(() => {
    const state = readSaved(session, input.sessionId);
    const durableReceipt = session.store.classroomKV.get<{ intent: string; directorId: string }>(
      session.projectId,
      learnerKey(session),
      `director:request:${input.sessionId}:${input.requestId}`,
    );
    if (durableReceipt) {
      if (durableReceipt.intent !== receipt.intent)
        throw new StudyError('VERSION_CONFLICT', { reason: 'director_request_reused' });
      if (state?.directorId === durableReceipt.directorId) return state;
      const historical = session.store.classroomKV.get(
        session.projectId,
        learnerKey(session),
        `director:history:${durableReceipt.directorId}`,
      );
      const parsed = directorStateSchema.safeParse(historical);
      if (
        !parsed.success ||
        parsed.data.projectId !== session.projectId ||
        parsed.data.sessionId !== input.sessionId ||
        parsed.data.learnerUid !== session.learnerUid
      )
        throw new StudyError('INTERNAL', { reason: 'director_receipt_invalid' });
      return parsed.data;
    }
    const previous = state?.receipts.find((item) => item.requestId === input.requestId);
    if (previous) {
      if (previous.intent !== receipt.intent)
        throw new StudyError('VERSION_CONFLICT', { reason: 'director_request_reused' });
      return state!;
    }
    if (input.action === 'start') {
      if (state && !['stopped', 'completed'].includes(state.state))
        throw new StudyError('VERSION_CONFLICT', { reason: 'director_already_started' });
      if (state)
        session.store.classroomKV.set(
          session.projectId,
          learnerKey(session),
          `director:history:${state.directorId}`,
          state,
        );
      return withRoomTeacher(session, input.sessionId, () => start(session, input, receipt));
    }
    if (!state) throw new StudyError('NOT_FOUND');
    if (input.action === 'pause' || input.action === 'stop') {
      if (['stopped', 'completed'].includes(state.state)) throw new StudyError('RUN_TERMINATED');
      active.get(identity(session, input.sessionId))?.abort('调度已暂停或停止');
      state.state = input.action === 'stop' ? 'stopped' : 'paused';
      state.message =
        input.action === 'stop'
          ? '调度已停止，已派发请求不会重发。新调用必须明确新建调度。'
          : '调度已暂停，继续需人工操作。';
      state.receipts.push(receipt);
      return save(session, state);
    }
    const facts = context(session, state);
    assertRecoveryExecution(session, state.sessionId);
    const step = directorCurrentStep(state);
    if (input.action === 'review') {
      if (['stopped', 'completed'].includes(state.state)) throw new StudyError('RUN_TERMINATED');
      if (!step || step.stepId !== input.stepId || step.state !== 'pending_review')
        throw new StudyError('VERSION_CONFLICT', { reason: 'director_review_step_changed' });
      assertCandidate(session, state, step);
      if (step.candidate!.digest !== input.candidateDigest)
        throw new StudyError('VERSION_CONFLICT', { reason: 'director_review_digest_changed' });
      if (input.decision === 'approved' && !input.semanticReviewed)
        throw new StudyError('INVALID_ARGUMENT', { reason: 'director_semantic_review_required' });
      return withRoomTeacher(session, state.sessionId, () => {
        if (step.role === 'teacher') {
          if (input.decision === 'approved')
            session.store.updateExplanationDraft({
              projectId: session.projectId,
              explanationId: step.candidate!.explanationId!,
              statementIds: step.statementIds,
            });
          session.store.reviewExplanation({
            projectId: session.projectId,
            explanationId: step.candidate!.explanationId!,
            decision: input.decision,
            note: input.note,
          });
        }
        step.candidate!.review = input.decision;
        step.candidate!.reviewNote = input.note;
        step.state = input.decision;
        state!.state = 'ready';
        state!.message =
          input.decision === 'approved'
            ? '候选已人工审核；继续才会交给课堂。'
            : '候选已拒绝；继续将跳过该项。';
        state!.receipts.push(receipt);
        return save(session, state!);
      });
    }
    assertDirectorContinuable(state, facts.classroom.status);
    return withRoomTeacher(session, state.sessionId, () => {
      state!.receipts.push(receipt);
      if (!step) {
        if (state!.sceneIndex + 1 >= state!.sceneIds.length) {
          session.store.closeClassroomSession(
            session.projectId,
            state!.sessionId,
            'completed',
            '已完成人工审核调度队列',
          );
          state!.state = 'completed';
          state!.message = '当前调度队列已完成。';
        } else {
          const nextScene = state!.sceneIds[state!.sceneIndex + 1]!;
          session.store.advanceClassroomScene(
            session.projectId,
            state!.sessionId,
            nextScene,
            `${state!.directorId}:scene:${state!.sceneIndex + 1}`,
          );
          state!.sceneIndex += 1;
          state!.state = 'ready';
          state!.message = '已切换到下一场景，继续执行下一项。';
        }
      } else if (step.role === 'learner') {
        if (step.state === 'awaiting_learner') {
          step.state = 'delivered';
          state!.state = 'ready';
          state!.message = '本人已在课堂确认作答，继续推进。';
        } else {
          session.store.handBackToLearner(
            session.projectId,
            state!.sessionId,
            '该场景需要本人作答，Director 停止讲解',
          );
          step.state = 'awaiting_learner';
          state!.state = 'awaiting_learner';
          state!.message = '等待本人作答；调度不会调用模型或跳过本人。';
        }
      } else if (step.state === 'rejected') {
        step.state = 'skipped';
        state!.state = 'ready';
        state!.message = '已跳过被拒绝的候选。';
      } else if (step.state === 'approved') {
        assertCandidate(session, state!, step);
        if (step.role === 'teacher') {
          const queue = session.store.classroomState(session.projectId, state!.sessionId);
          const next = nextPlayableCard(queue.cards, new Set(queue.playedIds), step.sceneId);
          if (next?.explanationId !== step.candidate!.explanationId)
            throw new StudyError(
              'VERSION_CONFLICT',
              { reason: 'director_play_queue_changed' },
              '当前还有先前审核的讲解卡，请在课堂处理队列后再继续。',
            );
          const played = session.store.playNextExplanation(
            session.projectId,
            state!.sessionId,
            `${step.stepId}:deliver`,
          );
          if (played.card?.explanationId !== step.candidate!.explanationId)
            throw new StudyError('INTERNAL');
        } else {
          session.store.recordClassroomPeerTurn({
            projectId: session.projectId,
            sessionId: state!.sessionId,
            roleProfileId: step.roleProfileId!,
            kind: 'discussion',
            text: step.candidate!.text,
            statementIds: step.statementIds,
            reviewedExampleId: null,
            requestId: `${step.stepId}:deliver`,
          });
        }
        step.state = 'delivered';
        state!.state = 'ready';
        state!.message = '已将审核内容交给当前课堂，未触发下一次调用。';
      } else if (step.role === 'peer') {
        const bundle = session.store.getEvidenceBundle(
          session.projectId,
          facts.classroom.bundleId,
        )!;
        const statement = bundle.bundle.statements.find(
          (item) => item.statementId === step.statementIds[0],
        );
        if (!statement) throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING');
        const text = `（${step.roleName}·冻结内容的模拟同学）我复述已冻结陈述：${statement.text}`;
        if (text.length > 4000)
          throw new StudyError('INVALID_ARGUMENT', { reason: 'director_peer_text_too_long' });
        step.candidate = {
          text,
          explanationId: null,
          digest: directorCandidateDigest(state!, step, text, null),
          review: 'pending',
          reviewNote: '',
        };
        step.state = 'pending_review';
        state!.state = 'awaiting_review';
        state!.message = '冻结内容模拟同学的候选已保存；等待人工核对。';
      } else {
        step.state = 'started';
        state!.state = 'running';
        state!.message = '教师调用已登记。结果未确认时不重派。';
        dispatch = { state: state!, step };
      }
      return save(session, state!);
    });
  });
  if (!dispatch) return result;
  const execution = dispatch as { state: DirectorStateDto; step: DirectorStepDto };
  const controller = new AbortController();
  const key = identity(session, input.sessionId);
  active.set(key, controller);
  const abort = (): void => controller.abort('请求已取消');
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const connection = options.connection ?? modelConnection;
  const revision = connection.revision();
  const watchdog = setInterval(() => {
    try {
      context(session, execution.state);
      if (connection.revision() !== revision) throw new StudyError('VERSION_CONFLICT');
    } catch {
      controller.abort('课程、来源、身份或连接已变化');
    }
  }, 100);
  let generation: Awaited<ReturnType<typeof generateGuarded>> | null = null;
  let failure: unknown = null;
  try {
    generation = await generateGuarded(
      {
        store: session.store,
        projectId: session.projectId,
        learnerUid: session.learnerUid,
        connection,
        revalidateScope: () => assertCurrent(session),
        verifyClassroom: (id) => {
          context(session, execution.state);
          assertRecoveryExecution(session, id);
        },
      },
      {
        scope: input.scope,
        purpose: 'teaching_prompt',
        requestId: execution.step.generationRequestId,
        lessonId: execution.state.lessonId,
        bundleId: session.store.getClassroomSession(input.sessionId, session.projectId)!.bundleId,
        instruction: `仅围绕当前场景 ${execution.step.sceneId} 的冻结陈述 ${execution.step.statementIds.join(',')} 写教学讲解候选。不得声称已审核，不涉及其他场景或新事实。`,
      },
      controller.signal,
    );
  } catch (error) {
    failure = error;
  } finally {
    clearInterval(watchdog);
    options.signal?.removeEventListener('abort', abort);
    if (active.get(key) === controller) active.delete(key);
  }
  assertCurrent(session);
  if (failure !== null && (!(failure instanceof StudyError) || failure.code === 'INTERNAL'))
    throw failure;
  return session.store.transaction(() => {
    const state = readSaved(session, input.sessionId)!;
    // A new director cannot consume a late result from the one explicitly stopped.
    if (state.directorId !== execution.state.directorId) return state;
    const step = state.steps.find((item) => item.stepId === execution.step.stepId)!;
    let stale = controller.signal.aborted || ['paused', 'stopped'].includes(state.state);
    try {
      context(session, state);
    } catch (error) {
      if (!(error instanceof StudyError) || error.code === 'INTERNAL') throw error;
      stale = true;
    }
    if (!stale && generation?.ok && generation.pendingExplanationId) {
      const card = session.store.getExplanation(generation.pendingExplanationId, session.projectId);
      if (!card || card.sceneId !== step.sceneId || card.status !== 'draft')
        throw new StudyError('INTERNAL', { reason: 'director_generation_card_mismatch' });
      step.candidate = {
        text: card.text,
        explanationId: card.explanationId,
        digest: directorCandidateDigest(state, step, card.text, card.explanationId),
        review: 'pending',
        reviewNote: '',
      };
      step.state = 'pending_review';
      state.state = 'awaiting_review';
      state.message = '教师候选已保存；人工核对冻结来源后才能用于课堂。';
    } else {
      const usage = session.store.getModelUsageCall(session.projectId, step.generationRequestId);
      step.state =
        usage?.state === 'started' || usage?.tokenMeasurement === 'unknown' ? 'unknown' : 'failed';
      if (!['stopped', 'paused'].includes(state.state))
        state.state = step.state === 'unknown' ? 'unknown' : 'paused';
      state.message =
        failure instanceof StudyError && failure.code === 'BUDGET_EXCEEDED'
          ? '本 run 的共享额度已用满，调度已暂停。'
          : '本次任务未完成或已停止。预占与原调用记录保留，继续不会重发；新调用需停止后明确新建调度。';
    }
    return save(session, state);
  });
};
