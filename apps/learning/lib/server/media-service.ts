import { createHash } from 'node:crypto';
import {
  StudyError,
  mediaGenerationCommandSchema,
  mediaTaskReviewCommandSchema,
  mediaTaskSchema,
  mediaTasksViewSchema,
  zeroMediaUsage,
  type MediaGenerationCommandDto,
  type MediaTaskDto,
  type MediaTaskReviewCommand,
  type MediaTaskUsageDto,
  type MediaTasksViewDto,
} from '@sew/study-contracts';
import {
  assertModelCallAdmitted,
  assertSharedModelSettlement,
  evidenceBundleDigest,
  mediaLedgerForRun,
  reserveSharedModelTokens,
  settlementMeasurement,
  settleMediaTask,
  sharedModelDeadlineMs,
} from '@sew/study-domain';
import { assertScope, type Session } from './service';
import { modelConnection, type MediaProviderConnection } from './model-connection';
import type { MediaProviderOutcome } from './media-provider-runtime';
import { recordingWavSeconds } from '../recording-wav';
import {
  DEFAULT_MODEL_CALL_LIMITS,
  registerActiveProjectModelCall,
  withExclusiveProjectModelCall,
} from './model-call';

export const MEDIA_LIMITS = { tokens: 20_000, images: 24, seconds: 600, characters: 40_000 };
const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
const activeState = globalThis as typeof globalThis & {
  __sewActiveMediaTasks?: Map<string, { controller: AbortController; startedAt: number }>;
};
const activeTasks = (activeState.__sewActiveMediaTasks ??= new Map());
const activeKey = (projectId: string, taskId: string): string => `${projectId}|${taskId}`;

const assertCurrentSession = (session: Session): void => {
  const current = assertScope({ projectId: session.projectId, generation: session.generation });
  if (current.store !== session.store) throw new StudyError('PROJECT_GENERATION_STALE');
};

/** The original request binds retries; the server-grounded prompt is never the retry identity. */
const commandIntent = (command: MediaGenerationCommandDto): string => {
  const { generation: _generation, ...scope } = command.scope;
  return sha256(JSON.stringify({ ...command, scope }));
};

const lessonContext = (
  session: Session,
  command: MediaGenerationCommandDto,
  previous?: MediaTaskDto,
) => {
  assertCurrentSession(session);
  if (command.scope.projectId !== session.projectId) throw new StudyError('PROJECT_NOT_AUTHORIZED');
  if (!command.lessonId)
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'media_lesson_required' });
  const run = session.store.getLatestRun();
  if (!run) throw new StudyError('PLAN_NOT_CONFIRMED');
  if (run.runId !== command.scope.runId)
    throw new StudyError('VERSION_CONFLICT', { reason: 'media_run_changed' });
  if (['cancelled', 'completed', 'failed'].includes(run.state))
    throw new StudyError('RUN_TERMINATED');
  const confirmed = session.store.getConfirmedPlan(session.projectId);
  if (!confirmed || confirmed.version !== run.frozen.planVersion)
    throw new StudyError('PLAN_NOT_CONFIRMED', { reason: 'media_plan_changed' });
  const ready = session.store.assertLessonClassroomReady(command.lessonId, session.projectId);
  const bundle = session.store.getEvidenceBundle(session.projectId, ready.lesson.bundleId);
  if (!bundle) throw new StudyError('INTERNAL', { reason: 'media_bundle_missing' });
  if (
    bundle.bundle.recordScope !== 'formal' ||
    bundle.digest !== ready.lesson.bundleDigest ||
    evidenceBundleDigest(bundle.bundle) !== bundle.digest
  )
    throw new StudyError('INTERNAL', { reason: 'media_bundle_digest_mismatch' });
  const knowledgeDigest = session.store.knowledgeTableDigest();
  if (run.frozen.knowledgeTableDigest !== knowledgeDigest)
    throw new StudyError('KNOWLEDGE_INVALIDATED', { reason: 'knowledge_table_changed' });
  if (
    previous &&
    (ready.lesson.version !== previous.lessonVersion ||
      ready.lesson.bundleDigest !== previous.bundleDigest ||
      knowledgeDigest !== previous.knowledgeDigest)
  )
    throw new StudyError('VERSION_CONFLICT', { reason: 'media_lesson_changed' });
  return { run, ready, bundle, knowledgeDigest };
};

export const readMediaTasks = (session: Session): MediaTasksViewDto => {
  assertCurrentSession(session);
  const tasks = session.store.media.list(session.projectId);
  const run = session.store.getLatestRun();
  return mediaTasksViewSchema.parse({
    tasks,
    limits: MEDIA_LIMITS,
    runId: run?.runId ?? null,
    ledger: run
      ? mediaLedgerForRun(
          run.runId,
          tasks
            .filter((task) => task.observation.runId === run.runId)
            .map((task) => task.observation),
        )
      : null,
  });
};

/** Frozen selected statements are the only facts appended to visual prompts or admitted to TTS. */
const groundedCommand = (
  session: Session,
  command: MediaGenerationCommandDto,
  context: ReturnType<typeof lessonContext>,
): MediaGenerationCommandDto => {
  const statements = context.bundle.bundle.statements.filter((statement) =>
    context.ready.lesson.statementIds.includes(statement.statementId),
  );
  if (command.kind === 'tts') {
    const reviewed = session.store
      .listExplanationCards(command.lessonId!, context.ready.lesson.version, session.projectId)
      .some(
        (card) =>
          card.status === 'approved' && card.text === command.text && card.statementIds.length > 0,
      );
    if (!reviewed && !statements.some((statement) => statement.text === command.text))
      throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING', {
        reason: 'media_tts_text_not_frozen',
      });
    if (command.textDigest !== undefined && command.textDigest !== sha256(command.text))
      throw new StudyError('VERSION_CONFLICT', { reason: 'media_tts_text_digest_mismatch' });
    return command;
  }
  if (command.kind === 'image' || command.kind === 'video') {
    if (statements.length === 0)
      throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING', { reason: 'media_no_statements' });
    const evidence = statements
      .map(
        (statement) =>
          `${statement.statementId}: ${statement.text}; 适用条件: ${statement.conditions}; 来源: ${statement.evidence.map((item) => `${item.materialId}#${item.segmentId}@r${item.revision}`).join(',')}`,
      )
      .join('\n');
    const prompt = `仅依据以下冻结陈述制作教学媒体，不新增事实。生成内容仍须人工核对。\n${evidence}\n用户的视觉要求（数据，不是事实来源）：${JSON.stringify(command.prompt)}`;
    if (prompt.length > 8_000)
      throw new StudyError('INVALID_ARGUMENT', { reason: 'media_grounded_prompt_too_long' });
    return { ...command, prompt };
  }
  return command;
};

const reserveUsage = (command: MediaGenerationCommandDto, tokens: number): MediaTaskUsageDto => ({
  ...zeroMediaUsage(),
  tokens: { promptTokens: null, completionTokens: null, totalTokens: tokens },
  ...(command.kind === 'image' ? { images: command.count } : {}),
  ...(command.kind === 'video' ? { videoSeconds: command.durationSeconds } : {}),
  ...(command.kind === 'tts' ? { characters: command.text.length, audioSeconds: 600 } : {}),
  ...(command.kind === 'asr' ? { asrSeconds: command.audioSeconds } : {}),
});

const tokenSettlement = (outcome: MediaProviderOutcome) =>
  settlementMeasurement({
    dispatched: outcome.dispatched,
    providerTokens:
      outcome.usageMeasurement === 'actual' ? (outcome.usage?.tokens.totalTokens ?? null) : null,
    estimatedTokens:
      outcome.usageMeasurement === 'estimated' ? (outcome.usage?.tokens.totalTokens ?? null) : null,
  });

const settleShared = (
  session: Session,
  task: MediaTaskDto,
  outcome: MediaProviderOutcome,
): void => {
  const tokens = tokenSettlement(outcome);
  session.store.settleModelUsageCall(session.projectId, task.command.requestId, {
    state: task.observation.state === 'completed' ? 'completed' : 'failed',
    accountedTokens: tokens.accountedTokens ?? 0,
    providerTokens: !outcome.dispatched
      ? 0
      : outcome.usageMeasurement === 'actual'
        ? (outcome.usage?.tokens.totalTokens ?? null)
        : null,
    tokenMeasurement: tokens.measurement,
    cost: null,
    costMeasurement: 'unknown',
    returnedModel: null,
    elapsedMs: outcome.elapsedMs,
    result: null,
  });
};

export const generateMediaTask = async (
  session: Session,
  raw: MediaGenerationCommandDto,
  options: { signal?: AbortSignal; connection?: MediaProviderConnection } = {},
): Promise<MediaTaskDto> => {
  const command = mediaGenerationCommandSchema.parse(raw);
  assertCurrentSession(session);
  assertScope(command.scope);
  const intent = commandIntent(command);
  const existing = session.store.media.get(session.projectId, command.requestId, intent);
  if (existing) return existing;
  return withExclusiveProjectModelCall(session.projectId, async () => {
    const previous = session.store.media.get(session.projectId, command.requestId, intent);
    if (previous) return previous;
    const context = lessonContext(session, command);
    const connection = options.connection ?? modelConnection;
    const connectionRevision = connection.revision();
    const status = connection.status();
    assertModelCallAdmitted({
      purpose: 'media_generation',
      run: context.run,
      currentKnowledgeTableDigest: context.knowledgeDigest,
      referencedKnowledgeIds: context.ready.referencedKnowledgeIds,
      admittedKnowledgeIds: new Set(
        session.store.checkAdmission(context.ready.referencedKnowledgeIds, 'formal').admitted,
      ),
      lesson: { status: context.ready.lesson.status, reviewApproved: true },
      usage: session.store.modelCallUsage(context.run.runId),
      limits: DEFAULT_MODEL_CALL_LIMITS,
    });
    const isLocalCommand =
      (command.kind === 'image' && command.workflowLocation === 'local') ||
      (command.kind === 'asr' && command.engine !== 'remote');
    const mediaConfigured = connection.mediaConfigured?.(command) ?? status.configured;
    if (!mediaConfigured) {
      if (isLocalCommand)
        throw new StudyError(
          'MODEL_NOT_CONFIGURED',
          { reason: 'local_engine_unavailable' },
          '所选本地媒体引擎尚未配置',
        );
      throw new StudyError('MODEL_NOT_CONFIGURED');
    }
    if (options.signal?.aborted)
      throw new StudyError('RUN_TERMINATED', { reason: 'request_aborted' });
    const providerCommand = groundedCommand(session, command, context);
    let audio: { bytes: Uint8Array; mime: string } | undefined;
    if (command.kind === 'asr') {
      if (!command.microphoneGranted)
        throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'media_audio_not_authorized' });
      const asset = command.audioAssetId
        ? session.store.getClassroomAsset(session.projectId, command.audioAssetId)
        : null;
      if (
        !asset ||
        asset.recordScope !== 'formal' ||
        !['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/webm', 'audio/ogg', 'audio/flac'].includes(
          asset.mediaType,
        ) ||
        asset.bytes.byteLength < 1 ||
        asset.bytes.byteLength > 16 * 1024 * 1024 ||
        sha256(asset.bytes) !== asset.sha256
      )
        throw new StudyError('INVALID_ARGUMENT', { reason: 'media_asr_asset_invalid' });
      audio = { bytes: asset.bytes, mime: asset.mediaType };
      if (command.engine !== 'remote') {
        if (asset.mediaType !== 'audio/wav')
          throw new StudyError(
            'INVALID_ARGUMENT',
            { reason: 'local_asr_requires_pcm_wav' },
            '本地 ASR 需要 PCM WAV 录音',
          );
        if (command.engine === 'local_funasr') {
          if (
            asset.bytes.byteLength < 28 ||
            new DataView(
              asset.bytes.buffer,
              asset.bytes.byteOffset,
              asset.bytes.byteLength,
            ).getUint32(24, true) !== 16_000
          )
            throw new StudyError(
              'INVALID_ARGUMENT',
              { reason: 'funasr_requires_16khz_pcm' },
              'FunASR runtime 需要 16 kHz 录音；当前采样率暂不支持自动转换',
            );
        }
        let seconds: number;
        try {
          seconds = recordingWavSeconds(asset.bytes);
        } catch {
          throw new StudyError(
            'INVALID_ARGUMENT',
            { reason: 'local_asr_recording_invalid' },
            '本地 ASR 录音格式无效',
          );
        }
        if (command.audioSeconds !== seconds)
          throw new StudyError('INVALID_ARGUMENT', { reason: 'media_recording_duration_mismatch' });
      }
      if (asset.metadata['origin'] === 'user_recorded') {
        let seconds: number;
        try {
          seconds = recordingWavSeconds(asset.bytes);
        } catch {
          throw new StudyError('INVALID_ARGUMENT', { reason: 'media_recording_invalid' });
        }
        if (command.audioSeconds !== seconds)
          throw new StudyError('INVALID_ARGUMENT', { reason: 'media_recording_duration_mismatch' });
      }
    }
    const usage = session.store.modelCallUsage(context.run.runId);
    const reservation = reserveSharedModelTokens(
      [{ content: JSON.stringify(providerCommand) }],
      DEFAULT_MODEL_CALL_LIMITS.maxTokens - usage.tokens,
    );
    const deadline = sharedModelDeadlineMs(DEFAULT_MODEL_CALL_LIMITS, usage);
    const taskId = `media_${sha256(`${session.projectId}:${command.requestId}`).slice(0, 32)}`;
    const now = new Date().toISOString();
    const started = mediaTaskSchema.parse({
      schemaVersion: 1,
      taskId,
      intent,
      command,
      lessonVersion: context.ready.lesson.version,
      bundleDigest: context.ready.lesson.bundleDigest,
      knowledgeDigest: context.knowledgeDigest,
      observation: {
        projectId: session.projectId,
        requestId: command.requestId,
        runId: context.run.runId,
        taskId,
        kind: command.kind,
        state: 'started',
        failureKind: null,
        dispatched: true,
        usageMeasurement: 'unknown',
        accounted: null,
        reserved: reserveUsage(command, reservation.reservedTokens),
        elapsedMs: null,
        cost: null,
        costMeasurement: 'unknown',
        createdAt: now,
        updatedAt: now,
      },
      products: [],
      review: { status: 'pending_review', note: '', reviewedAt: null },
    });
    session.store.media.start(started, MEDIA_LIMITS, () =>
      session.store.startModelUsageCall(
        {
          projectId: session.projectId,
          runId: context.run.runId,
          requestId: command.requestId,
          purpose: 'media_generation',
          intent,
          sessionId: null,
          roundIndex: null,
          roleProfileId: null,
          peerTurnIndex: null,
          reservedTokens: reservation.reservedTokens,
          provider: isLocalCommand ? command.provider : (status.provider ?? command.provider),
          requestedModel:
            command.model ??
            status.model ??
            (command.kind === 'image' && command.workflowLocation === 'local'
              ? command.workflowId
              : command.kind === 'asr' && command.engine !== 'remote'
                ? command.engine
                : null),
        },
        DEFAULT_MODEL_CALL_LIMITS,
      ),
    );
    const controller = new AbortController();
    const startedAt = performance.now();
    activeTasks.set(activeKey(session.projectId, taskId), { controller, startedAt });
    const unregister = registerActiveProjectModelCall(session.projectId, controller);
    const abort = (): void => controller.abort('请求已取消');
    options.signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort('共享执行时间已用满');
    }, deadline);
    const checkFacts = (): void => {
      const current = lessonContext(session, command, started);
      if (current.run.state !== context.run.state || connection.revision() !== connectionRevision)
        throw new StudyError('VERSION_CONFLICT', { reason: 'media_context_changed' });
      if (command.kind === 'asr' && audio) {
        const currentAudio = session.store.getClassroomAsset(
          session.projectId,
          command.audioAssetId!,
        );
        if (
          !currentAudio ||
          currentAudio.recordScope !== 'formal' ||
          currentAudio.mediaType !== audio.mime ||
          currentAudio.sha256 !== sha256(audio.bytes)
        )
          throw new StudyError('VERSION_CONFLICT', { reason: 'media_audio_changed' });
      }
    };
    const watchdog = setInterval(() => {
      try {
        checkFacts();
      } catch {
        controller.abort('项目、课程、来源或连接已变化');
      }
    }, 100);
    let outcome: MediaProviderOutcome;
    try {
      outcome = await connection.generateMedia(providerCommand, {
        signal: controller.signal,
        ...(audio ? { audio } : {}),
      });
    } catch {
      outcome = {
        dispatched: true,
        ok: false,
        failureKind: 'unknown_outcome',
        products: [],
        usage: null,
        usageMeasurement: 'unknown',
        elapsedMs: 0,
        message: '媒体结果未知，预占保留',
      };
    } finally {
      clearTimeout(timer);
      clearInterval(watchdog);
      unregister();
      options.signal?.removeEventListener('abort', abort);
      activeTasks.delete(activeKey(session.projectId, taskId));
    }
    // Scope revalidation MUST precede every post-await database access: project switching closes the old SQLite handle.
    assertCurrentSession(session);
    const settledAlready = session.store.media.byId(session.projectId, taskId);
    if (settledAlready && settledAlready.observation.state !== 'started') return settledAlready;
    outcome = {
      ...outcome,
      elapsedMs: outcome.dispatched
        ? Math.max(outcome.elapsedMs, Math.ceil(performance.now() - startedAt))
        : 0,
    };
    try {
      checkFacts();
      const tokens = tokenSettlement(outcome);
      assertSharedModelSettlement(
        DEFAULT_MODEL_CALL_LIMITS,
        session.store.modelCallUsage(context.run.runId, undefined, command.requestId),
        tokens.accountedTokens ?? reservation.reservedTokens,
        outcome.elapsedMs,
      );
      if (controller.signal.aborted || options.signal?.aborted)
        throw new StudyError('RUN_TERMINATED');
    } catch (error) {
      if (
        !(error instanceof StudyError) ||
        ![
          'PLAN_NOT_CONFIRMED',
          'VERSION_CONFLICT',
          'RUN_TERMINATED',
          'KNOWLEDGE_INVALIDATED',
          'KNOWLEDGE_NOT_VERIFIED',
          'CLASSROOM_LESSON_NOT_REVIEWED',
          'CLASSROOM_SCENE_SOURCE_MISSING',
          'BUDGET_EXCEEDED',
        ].includes(error.code)
      )
        throw error;
      outcome = {
        ...outcome,
        ok: false,
        products: [],
        failureKind: timedOut ? 'deadline_exceeded' : 'cancelled',
      };
    }
    let products: MediaTaskDto['products'] = [];
    let rawProducts = outcome.ok ? outcome.products : [];
    if (outcome.ok) {
      const allowedMime =
        command.kind === 'image'
          ? ['image/png', 'image/jpeg', 'image/webp']
          : command.kind === 'video'
            ? ['video/mp4']
            : command.kind === 'tts'
              ? ['audio/mpeg', 'audio/wav', 'audio/mp4']
              : ['text/plain'];
      if (
        rawProducts.length === 0 ||
        rawProducts.length > (command.kind === 'image' ? command.count : 1) ||
        rawProducts.some(
          (product) =>
            !allowedMime.includes(product.mime) ||
            product.bytes.byteLength < 1 ||
            product.bytes.byteLength > 16 * 1024 * 1024,
        ) ||
        rawProducts.reduce((total, product) => total + product.bytes.byteLength, 0) >
          32 * 1024 * 1024
      ) {
        outcome = { ...outcome, ok: false, failureKind: 'provider_error' };
        rawProducts = [];
      } else {
        products = rawProducts.map((product, index) => ({
          taskId,
          assetId: `media_asset_${sha256(`${taskId}:${index}`).slice(0, 32)}`,
          kind: command.kind,
          sha256: sha256(product.bytes),
          byteLength: product.bytes.byteLength,
          mime: product.mime,
          relativePath: `.study/assets/media_asset_${sha256(`${taskId}:${index}`).slice(0, 32)}`,
          durationSeconds: product.durationSeconds,
          reviewStatus: 'pending_review',
          authority: false,
          ...(outcome.providerJobId ? { providerJobId: outcome.providerJobId } : {}),
          recordedAt: new Date().toISOString(),
        }));
      }
    }
    const settlementFacts = {
      observation: { ...started.observation, dispatched: outcome.dispatched },
      providerUsage: outcome.usageMeasurement === 'actual' ? outcome.usage : null,
      estimatedUsage: outcome.usageMeasurement === 'estimated' ? outcome.usage : null,
      priceKnown: false,
      cost: null,
      costIsEstimate: false,
      elapsedMs: outcome.elapsedMs,
      nowIso: new Date().toISOString(),
    };
    let observation;
    try {
      observation = settleMediaTask({
        ...settlementFacts,
        next: outcome.ok ? 'completed' : 'failed',
        products,
        ...(!outcome.ok ? { failureKind: outcome.failureKind ?? 'provider_error' } : {}),
      });
    } catch (error) {
      if (
        !(error instanceof StudyError) ||
        !['INVALID_ARGUMENT', 'BUDGET_EXCEEDED'].includes(error.code)
      )
        throw error;
      // Invalid or unmeasured success cannot become a candidate; consumed usage still remains visible.
      products = [];
      rawProducts = [];
      outcome = { ...outcome, ok: false, failureKind: 'provider_error' };
      observation = settleMediaTask({
        ...settlementFacts,
        next: 'failed',
        products: [],
        failureKind: 'provider_error',
      });
    }
    const settled = mediaTaskSchema.parse({ ...started, observation, products });
    return session.store.media.settle(settled, rawProducts, () =>
      settleShared(session, settled, outcome),
    );
  });
};

export const reviewMediaTask = (session: Session, raw: MediaTaskReviewCommand): MediaTaskDto => {
  const input = mediaTaskReviewCommandSchema.parse(raw);
  assertCurrentSession(session);
  assertScope(input.scope);
  const task = session.store.media.byId(session.projectId, input.taskId);
  if (!task) throw new StudyError('NOT_FOUND');
  if (task.intent !== input.intent || task.observation.state !== 'completed')
    throw new StudyError('VERSION_CONFLICT', { reason: 'media_review_binding_changed' });
  if (input.decision === 'approved' && !input.semanticReviewed)
    throw new StudyError('INVALID_ARGUMENT', { reason: 'media_semantic_review_required' });
  lessonContext(session, task.command, task);
  return session.store.media.review(
    session.projectId,
    task.taskId,
    input.intent,
    input.decision,
    input.note,
  );
};

export const cancelMediaTask = (session: Session, taskId: string): MediaTaskDto => {
  assertCurrentSession(session);
  const task = session.store.media.byId(session.projectId, taskId);
  if (!task) throw new StudyError('NOT_FOUND');
  if (task.observation.state !== 'started') return task;
  const active = activeTasks.get(activeKey(session.projectId, taskId));
  active?.controller.abort('用户取消了此媒体任务');
  const elapsedMs = active
    ? Math.ceil(performance.now() - active.startedAt)
    : (task.observation.elapsedMs ?? 0);
  const observation = settleMediaTask({
    observation: task.observation,
    next: 'failed',
    products: [],
    failureKind: 'cancelled',
    providerUsage: null,
    estimatedUsage: null,
    priceKnown: false,
    cost: null,
    costIsEstimate: false,
    elapsedMs,
    nowIso: new Date().toISOString(),
  });
  const cancelled = mediaTaskSchema.parse({ ...task, observation, products: [] });
  return session.store.media.settle(cancelled, [], () =>
    settleShared(session, cancelled, {
      dispatched: task.observation.dispatched,
      ok: false,
      failureKind: 'cancelled',
      products: [],
      usage: null,
      usageMeasurement: 'unknown',
      elapsedMs,
      message: '已取消',
    }),
  );
};

export const readMediaProduct = (
  session: Session,
  assetId: string,
): { bytes: Uint8Array; mime: string } => {
  assertCurrentSession(session);
  return session.store.media.readProduct(session.projectId, assetId);
};
