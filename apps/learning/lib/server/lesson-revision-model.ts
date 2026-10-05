import { createHash } from 'node:crypto';
import {
  StudyError,
  statementRevisionOutputSchema,
  statementRevisionCandidateSchema,
  modelGenerationResultSchema,
  statementRevisionProposeSchema,
  type ModelChatMessage,
  type ModelGenerationResultDto,
  type StatementRevisionCandidateDto,
  type StatementRevisionProposeInput,
} from '@sew/study-contracts';
import {
  assertModelCallAdmitted,
  reserveSharedModelTokens,
  sharedModelDeadlineMs,
  assertSharedModelSettlement,
  settlementMeasurement,
  findBundleStatement,
  statementRevisionPrompt,
} from '@sew/study-domain';
import {
  DEFAULT_MODEL_CALL_LIMITS,
  withExclusiveProjectModelCall,
  registerActiveProjectModelCall,
  type ModelCallDeps,
} from './model-call';
import type { ModelGenerateOutcome } from './model-connection';

export interface StatementRevisionResult {
  candidate: StatementRevisionCandidateDto | null;
  generation: ModelGenerationResultDto;
  deduplicated: boolean;
}

/** 候选生成结果里对外的响应形状（与 `apiResponses.lessonRevisionPropose` 一致）。 */
const revisionResultSchema = (result: StatementRevisionResult): StatementRevisionResult => ({
  candidate: result.candidate ? statementRevisionCandidateSchema.parse(result.candidate) : null,
  generation: modelGenerationResultSchema.parse(result.generation),
  deduplicated: result.deduplicated,
});

/**
 * 受 guard 约束的陈述正文改写候选生成（LESSON-02）。
 *
 * 复用与课程草案、课堂讲解、错因归因同一套入口：凭据、来源、run、预算与取消都走
 * `assertModelCallAdmitted`；判定不通过时一次 provider 请求都不发出。模型输出只是候选，
 * 写入待核区，不进入任何课程版本；通过人工处置才会派生新草案版本。
 */
export const generateStatementRevision = async (
  deps: ModelCallDeps,
  raw: StatementRevisionProposeInput,
  signal?: AbortSignal,
): Promise<StatementRevisionResult> =>
  withExclusiveProjectModelCall(deps.projectId, async () => {
    const input = statementRevisionProposeSchema.parse(raw);
    const { store, projectId } = deps;
    if (input.scope.projectId !== projectId) throw new StudyError('PROJECT_NOT_AUTHORIZED');
    deps.revalidateScope?.();
    const limits = deps.limits ?? DEFAULT_MODEL_CALL_LIMITS;
    const intent = createHash('sha256')
      .update(
        JSON.stringify({
          lessonId: input.lessonId,
          version: input.version,
          statementId: input.statementId,
          instruction: input.instruction,
        }),
      )
      .digest('hex');

    // 幂等：同 requestId 与意图重试返回既有候选，不重复调用或堆出第二条候选。
    const previous = store.statementRevisionReceipt(projectId, input.requestId, 'propose', intent);
    if (previous) {
      return revisionResultSchema({
        ...(previous.result as StatementRevisionResult),
        deduplicated: true,
      });
    }

    const lesson = store.getLessonVersion(input.lessonId, input.version, projectId);
    if (!lesson)
      throw new StudyError('NOT_FOUND', { lessonId: input.lessonId, version: input.version });
    if (lesson.status !== 'draft') {
      throw new StudyError('STEP_ALREADY_COMMITTED', {
        status: lesson.status,
        reason: 'revision_base_not_draft',
      });
    }
    const bundleRow = store.getEvidenceBundle(projectId, lesson.bundleId);
    if (!bundleRow) throw new StudyError('INTERNAL', { bundleId: lesson.bundleId });
    // 只允许改写本版本实际选中的陈述：否则派生新版本时会把被排除的场景加回来。
    if (!lesson.statementIds.includes(input.statementId)) {
      throw new StudyError('INVALID_ARGUMENT', {
        reason: 'revision_statement_not_in_version',
        statementId: input.statementId,
      });
    }
    const statement = findBundleStatement(bundleRow.bundle, input.statementId);

    const run = store.getLatestRun();
    const connection = deps.connection.status();
    const checkFacts = (): void => {
      deps.revalidateScope?.();
      const currentLesson = store.getLessonVersion(input.lessonId, input.version, projectId);
      if (!currentLesson || currentLesson.status !== 'draft') {
        throw new StudyError('VERSION_CONFLICT', { reason: 'revision_lesson_changed' });
      }
      if (currentLesson.bundleId !== lesson.bundleId) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'revision_bundle_changed' });
      }
      const latest = store.getLatestRun();
      if (run && (latest?.runId !== run.runId || latest.state !== run.state)) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'revision_run_changed' });
      }
      assertModelCallAdmitted({
        purpose: 'statement_revision',
        run: latest ? { state: latest.state, frozen: latest.frozen } : null,
        currentKnowledgeTableDigest: store.knowledgeTableDigest(),
        referencedKnowledgeIds: [statement.knowledgeId],
        admittedKnowledgeIds: new Set(
          store.checkAdmission([statement.knowledgeId], 'formal').admitted,
        ),
        lesson: null,
        usage: latest
          ? store.modelCallUsage(latest.runId, undefined, input.requestId)
          : { calls: 0, tokens: 0, activeElapsedMs: 0 },
        limits,
      });
      const currentConnection = deps.connection.status();
      if (!currentConnection.configured) throw new StudyError('MODEL_NOT_CONFIGURED');
      if (
        currentConnection.model !== connection.model ||
        currentConnection.provider !== connection.provider
      ) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'revision_model_changed' });
      }
    };
    checkFacts();
    if (!run) throw new StudyError('PLAN_NOT_CONFIRMED');
    if (signal?.aborted) throw new StudyError('RUN_TERMINATED', { reason: 'request_aborted' });

    const messages: ModelChatMessage[] = statementRevisionPrompt({
      subject: bundleRow.bundle.subject,
      statement,
      instruction: input.instruction,
    });
    const usage = store.modelCallUsage(run.runId);
    const reservation = reserveSharedModelTokens(messages, limits.maxTokens - usage.tokens);
    const deadline = sharedModelDeadlineMs(limits, usage);
    const startedAt = performance.now();
    store.startModelUsageCall(
      {
        projectId,
        runId: run.runId,
        requestId: input.requestId,
        purpose: 'statement_revision',
        intent,
        sessionId: null,
        roundIndex: null,
        roleProfileId: null,
        peerTurnIndex: null,
        reservedTokens: reservation.reservedTokens,
        provider: connection.provider ?? null,
        requestedModel: connection.model ?? null,
      },
      limits,
    );
    const controller = new AbortController();
    const unregister = registerActiveProjectModelCall(projectId, controller);
    const abort = (): void => controller.abort('请求已取消');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort('共享执行时间已用满'), deadline);
    let outcome: ModelGenerateOutcome;
    try {
      outcome = await deps.connection.generate(messages, {
        maxTokens: reservation.maxTokens,
        signal: controller.signal,
      });
    } catch {
      outcome = {
        dispatched: true,
        ok: false,
        message: '调用失败，用量未知',
        text: null,
        totalTokens: 0,
        providerTokens: null,
        elapsedMs: 0,
        requestedModel: connection.model ?? null,
      };
    } finally {
      clearTimeout(timer);
      unregister();
      signal?.removeEventListener('abort', abort);
    }
    // 任何 await 之后不再触碰可能已被替换或关闭的数据库；未确认的旧调用保留其预占。
    deps.revalidateScope?.();
    const elapsedMs = Math.max(
      Math.round(outcome.elapsedMs),
      Math.ceil(performance.now() - startedAt),
    );
    const measurement = settlementMeasurement({
      dispatched: outcome.dispatched,
      providerTokens: outcome.providerTokens ?? null,
      estimatedTokens:
        outcome.dispatched && outcome.providerTokens === undefined && outcome.totalTokens > 0
          ? outcome.totalTokens
          : null,
    });
    const accounted = measurement.accountedTokens;
    const generationResult = (
      ok: boolean,
      message: string,
      state: 'started' | 'completed' | 'failed',
    ): ModelGenerationResultDto => {
      const current = store.modelCallUsage(run.runId);
      return modelGenerationResultSchema.parse({
        requestId: input.requestId,
        callState: state,
        providerTokens: outcome.providerTokens ?? null,
        estimatedCost: null,
        pendingExplanationId: null,
        ok,
        message,
        ...(outcome.text !== null ? { text: outcome.text } : {}),
        totalTokens: accounted ?? 0,
        ...(outcome.requestedModel !== null ? { requestedModel: outcome.requestedModel } : {}),
        ...(outcome.returnedModel ? { returnedModel: outcome.returnedModel } : {}),
        elapsedMs,
        usage: {
          callsUsed: current.calls,
          tokensUsed: current.tokens,
          maxCalls: limits.maxCalls,
          maxTokens: limits.maxTokens,
        },
        remainingCalls: Math.max(0, limits.maxCalls - current.calls),
        remainingTokens: Math.max(0, limits.maxTokens - current.tokens),
      });
    };

    let candidate: StatementRevisionCandidateDto | null = null;
    let failure: unknown;
    try {
      if (controller.signal.aborted || signal?.aborted) {
        throw new StudyError('RUN_TERMINATED', { reason: 'request_aborted' });
      }
      checkFacts();
      assertSharedModelSettlement(
        limits,
        store.modelCallUsage(run.runId, undefined, input.requestId),
        accounted ?? reservation.reservedTokens,
        elapsedMs,
      );
      if (!outcome.dispatched || !outcome.ok || !outcome.text) {
        throw new StudyError('INVALID_ARGUMENT', { reason: 'revision_generation_failed' });
      }
      if (outcome.text.length > 8_000) {
        throw new StudyError('INVALID_ARGUMENT', { reason: 'revision_output_too_long' });
      }
      const parsed = statementRevisionOutputSchema.safeParse(JSON.parse(outcome.text));
      if (!parsed.success)
        throw new StudyError('INVALID_ARGUMENT', { reason: 'revision_output_invalid' });
      candidate = statementRevisionCandidateSchema.parse({
        candidateId: `rev_${createHash('sha256').update(input.requestId).digest('hex').slice(0, 24)}`,
        projectId,
        lessonId: input.lessonId,
        baseVersion: input.version,
        statementId: input.statementId,
        knowledgeId: statement.knowledgeId,
        origin: 'model_generated',
        status: 'pending',
        proposedText: parsed.data.text,
        proposedConditions: parsed.data.conditions ?? statement.conditions,
        evidence: statement.evidence,
        instruction: input.instruction,
        note: '',
        reviewedBy: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch (caught) {
      failure = caught;
    }

    const settle = (ok: boolean, message: string): ModelGenerationResultDto => {
      if (outcome.dispatched) {
        store.appendNextRunEvent(run.runId, {
          type: 'model_call',
          purpose: 'statement_revision',
          requestId: input.requestId,
          usageSource: 'model',
          ok,
          totalTokens: accounted ?? 0,
          message,
        });
      }
      store.settleModelUsageCall(projectId, input.requestId, {
        state: ok ? 'completed' : 'failed',
        accountedTokens: accounted,
        providerTokens: outcome.providerTokens ?? null,
        tokenMeasurement: measurement.measurement,
        returnedModel: outcome.returnedModel ?? null,
        elapsedMs,
        result: null,
      });
      const generation = generationResult(ok, message, ok ? 'completed' : 'failed');
      store.saveModelUsageCallResult(projectId, input.requestId, generation);
      return generation;
    };

    if (!failure && candidate) {
      const created = candidate;
      try {
        return store.transaction(() => {
          checkFacts();
          const saved = store.createStatementRevision({
            candidateId: created.candidateId,
            projectId,
            lessonId: input.lessonId,
            baseVersion: input.version,
            statementId: input.statementId,
            knowledgeId: statement.knowledgeId,
            proposedText: created.proposedText,
            proposedConditions: created.proposedConditions,
            evidence: statement.evidence,
            instruction: input.instruction,
          });
          const generation = settle(true, '已保存陈述改写候选，等待人工核对。');
          const result = revisionResultSchema({
            candidate: saved,
            generation,
            deduplicated: false,
          });
          store.saveStatementRevisionReceipt(projectId, input.requestId, 'propose', intent, result);
          return result;
        });
      } catch (caught) {
        failure = caught;
      }
    }

    const reason = failure instanceof StudyError ? failure.message : '模型响应格式无效';
    return store.transaction(() => {
      const generation = settle(false, `候选未保存：${reason}`.slice(0, 500));
      return revisionResultSchema({ candidate: null, generation, deduplicated: false });
    });
  });
