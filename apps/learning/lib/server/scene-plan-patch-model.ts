import { createHash } from 'node:crypto';
import {
  StudyError,
  modelGenerationResultSchema,
  scenePlanPatchOutputSchema,
  scenePlanPatchCandidateSchema,
  scenePlanPatchProposeSchema,
  type ModelChatMessage,
  type ModelGenerationResultDto,
  type ScenePlanPatchCandidateDto,
  type ScenePlanPatchProposeInput,
} from '@sew/study-contracts';
import {
  assertModelCallAdmitted,
  reserveSharedModelTokens,
  sharedModelDeadlineMs,
  assertSharedModelSettlement,
  settlementMeasurement,
  applyScenePlanPatch,
  scenePlanPatchPrompt,
} from '@sew/study-domain';
import {
  DEFAULT_MODEL_CALL_LIMITS,
  withExclusiveProjectModelCall,
  registerActiveProjectModelCall,
  type ModelCallDeps,
} from './model-call';
import { approvedFormalLessonImageRefs } from './formal-lesson-assets';
import type { ModelGenerateOutcome } from './model-connection';

export interface ScenePlanPatchGenerationResult {
  candidate: ScenePlanPatchCandidateDto | null;
  generation: ModelGenerationResultDto;
  deduplicated: boolean;
}

const resultSchema = (result: ScenePlanPatchGenerationResult): ScenePlanPatchGenerationResult => ({
  candidate: result.candidate ? scenePlanPatchCandidateSchema.parse(result.candidate) : null,
  generation: modelGenerationResultSchema.parse(result.generation),
  deduplicated: result.deduplicated,
});

/**
 * 受 guard 约束的受限场景计划补丁候选生成（LESSON-02 / OMA-023）。
 *
 * 复用与课程草案、陈述改写、完整课件同一套入口：凭据、来源、run、预算与取消都走
 * `assertModelCallAdmitted`；判定不通过时一次 provider 请求都不发出。模型输出经**合同层**
 * 收口为受限操作，再经**领域层**逐条判定可应用性——越界、未知场景/元素、未审核图片一律记为
 * 被拒绝。产物只落待核候选，不写入任何计划；人工逐项审核通过才按 save-scene-plan 写回。
 */
export const generateScenePlanPatch = async (
  deps: ModelCallDeps,
  raw: ScenePlanPatchProposeInput,
  signal?: AbortSignal,
): Promise<ScenePlanPatchGenerationResult> =>
  withExclusiveProjectModelCall(deps.projectId, async () => {
    const input = scenePlanPatchProposeSchema.parse(raw);
    const { store, projectId } = deps;
    if (input.scope.projectId !== projectId) throw new StudyError('PROJECT_NOT_AUTHORIZED');
    deps.revalidateScope?.();
    const limits = deps.limits ?? DEFAULT_MODEL_CALL_LIMITS;
    const intent = createHash('sha256')
      .update(
        JSON.stringify({
          lessonId: input.lessonId,
          version: input.version,
          instruction: input.instruction,
        }),
      )
      .digest('hex');

    const previous = store.scenePlanPatchReceipt(projectId, input.requestId, 'propose', intent);
    if (previous && previous.state === 'completed') {
      return resultSchema({
        ...(previous.result as ScenePlanPatchGenerationResult),
        deduplicated: true,
      });
    }
    if (previous) {
      throw new StudyError(
        (previous.errorCode as StudyError['code'] | null) ?? 'VERSION_CONFLICT',
        {
          reason: previous.errorReason ?? 'scene_plan_patch_result_unknown',
          requestId: input.requestId,
          receiptState: previous.state,
        },
        previous.message,
      );
    }

    const priorCall = store.getModelUsageCall(projectId, input.requestId, intent);
    if (priorCall) {
      const recorded = priorCall.result;
      const existingCandidate = store.getScenePlanPatchCandidate(
        projectId,
        `sp_${createHash('sha256').update(input.requestId).digest('hex').slice(0, 24)}`,
      );
      if (recorded && (!recorded.ok || existingCandidate)) {
        const result = resultSchema({
          candidate: recorded.ok ? existingCandidate : null,
          generation: recorded,
          deduplicated: true,
        });
        store.saveScenePlanPatchReceipt({
          projectId,
          requestId: input.requestId,
          action: 'propose',
          intent,
          state: 'completed',
          result,
          message: '',
        });
        return result;
      }
      const usage = store.modelCallUsage(priorCall.runId);
      return resultSchema({
        candidate: null,
        deduplicated: true,
        generation: {
          requestId: input.requestId,
          callState: 'started',
          ok: false,
          message:
            '此调用已派发但结果未能确认；额度已保留，不会重发 provider。请查阅用量记录后再核对回执。',
          totalTokens: priorCall.accountedTokens ?? 0,
          providerTokens: priorCall.providerTokens,
          estimatedCost: null,
          elapsedMs: priorCall.elapsedMs ?? 0,
          pendingExplanationId: null,
          usage: {
            callsUsed: usage.calls,
            tokensUsed: usage.tokens,
            maxCalls: limits.maxCalls,
            maxTokens: limits.maxTokens,
          },
          remainingCalls: Math.max(0, limits.maxCalls - usage.calls),
          remainingTokens: Math.max(0, limits.maxTokens - usage.tokens),
        },
      });
    }

    try {
      const lesson = store.getLessonVersion(input.lessonId, input.version, projectId);
      if (!lesson)
        throw new StudyError('NOT_FOUND', { lessonId: input.lessonId, version: input.version });
      if (lesson.status !== 'draft') {
        throw new StudyError('STEP_ALREADY_COMMITTED', {
          status: lesson.status,
          reason: 'scene_plan_patch_base_not_draft',
        });
      }
      const bundleRow = store.getEvidenceBundle(projectId, lesson.bundleId);
      if (!bundleRow) throw new StudyError('INTERNAL', { bundleId: lesson.bundleId });
      // 补丁只能作用在**已存在的计划**上：没有计划时先由确定性骨架或完整课件候选建立计划。
      const basePlan = store.getScenePlan(projectId, input.lessonId, input.version);
      if (!basePlan) {
        throw new StudyError('NOT_FOUND', {
          reason: 'scene_plan_patch_requires_plan',
          lessonId: input.lessonId,
          version: input.version,
        });
      }
      const approvedAssetRefs = approvedFormalLessonImageRefs(deps, input.lessonId, bundleRow.digest);
      const referencedKnowledgeIds = [
        ...new Set([
          ...bundleRow.bundle.statements
            .filter((statement) => lesson.statementIds.includes(statement.statementId))
            .map((statement) => statement.knowledgeId),
          ...bundleRow.bundle.questions
            .filter((question) => lesson.questionIds.includes(question.questionId))
            .flatMap((question) => question.knowledgeIds),
        ]),
      ];

      const run = store.getLatestRun();
      const connection = deps.connection.status();
      const checkFacts = (): void => {
        deps.revalidateScope?.();
        const currentLesson = store.getLessonVersion(input.lessonId, input.version, projectId);
        if (!currentLesson || currentLesson.status !== 'draft') {
          throw new StudyError('VERSION_CONFLICT', { reason: 'scene_plan_patch_lesson_changed' });
        }
        if (currentLesson.bundleId !== lesson.bundleId) {
          throw new StudyError('VERSION_CONFLICT', { reason: 'scene_plan_patch_bundle_changed' });
        }
        const latest = store.getLatestRun();
        if (run && (latest?.runId !== run.runId || latest.state !== run.state)) {
          throw new StudyError('VERSION_CONFLICT', { reason: 'scene_plan_patch_run_changed' });
        }
        assertModelCallAdmitted({
          purpose: 'courseware_generation',
          run: latest ? { state: latest.state, frozen: latest.frozen } : null,
          currentKnowledgeTableDigest: store.knowledgeTableDigest(),
          referencedKnowledgeIds,
          admittedKnowledgeIds: new Set(
            store.checkAdmission(referencedKnowledgeIds, 'formal').admitted,
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
          throw new StudyError('VERSION_CONFLICT', { reason: 'scene_plan_patch_model_changed' });
        }
      };
      checkFacts();
      if (!run) throw new StudyError('PLAN_NOT_CONFIRMED');
      if (signal?.aborted) throw new StudyError('RUN_TERMINATED', { reason: 'request_aborted' });

      const messages: ModelChatMessage[] = scenePlanPatchPrompt({
        subject: bundleRow.bundle.subject,
        instruction: input.instruction,
        scenes: basePlan.scenes,
        approvedAssetRefs: [...approvedAssetRefs],
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
          purpose: 'courseware_generation',
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
          route: 'courseware',
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

      let candidate: ScenePlanPatchCandidateDto | null = null;
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
          throw new StudyError('INVALID_ARGUMENT', { reason: 'scene_plan_patch_generation_failed' });
        }
        if (outcome.text.length > 20_000) {
          throw new StudyError('INVALID_ARGUMENT', { reason: 'scene_plan_patch_output_too_long' });
        }
        const parsed = scenePlanPatchOutputSchema.safeParse(JSON.parse(outcome.text));
        if (!parsed.success)
          throw new StudyError('INVALID_ARGUMENT', { reason: 'scene_plan_patch_output_invalid' });
        // 候选编号由 requestId 派生：元素编号种子统一用 candidateId，保证生成、只读预览与
        // 落库应用三处得到**同一份**元素编号与摘要（否则审核者看到的计划与写入结果会不一致）。
        const candidateId = `sp_${createHash('sha256').update(input.requestId).digest('hex').slice(0, 24)}`;
        // 逐条判定可应用性；落库前至少要有一条**可应用**操作，避免把纯无效补丁存成候选。
        const applied = applyScenePlanPatch(basePlan.scenes, parsed.data.ops, {
          approvedAssetRefs,
          nextElementId: (opIndex) =>
            `el_text_${createHash('sha256')
              .update(`${candidateId}:${opIndex}`)
              .digest('hex')
              .slice(0, 24)}`,
        });
        if (applied.results.every((result) => result.status === 'rejected')) {
          throw new StudyError('INVALID_ARGUMENT', { reason: 'scene_plan_patch_no_applicable_op' });
        }
        candidate = scenePlanPatchCandidateSchema.parse({
          candidateId,
          projectId,
          lessonId: input.lessonId,
          baseVersion: input.version,
          basePlanRevision: basePlan.revision,
          basePlanDigest: basePlan.digest,
          origin: 'model_generated',
          status: 'pending',
          instruction: input.instruction,
          ops: parsed.data.ops,
          note: '',
          reviewedBy: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } catch (caught) {
        failure = caught;
      }

      const settle = (ok: boolean, message: string, unknown = false): ModelGenerationResultDto => {
        if (outcome.dispatched) {
          store.appendNextRunEvent(run.runId, {
            type: 'model_call',
            purpose: 'courseware_generation',
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
        const generation = generationResult(
          ok,
          message,
          unknown ? 'started' : ok ? 'completed' : 'failed',
        );
        store.saveModelUsageCallResult(projectId, input.requestId, generation);
        return generation;
      };

      if (!failure && candidate) {
        const created = candidate;
        try {
          return store.transaction(() => {
            checkFacts();
            deps.verifyExecutionLease?.();
            const saved = store.createScenePlanPatchCandidate({
              candidateId: created.candidateId,
              projectId,
              lessonId: input.lessonId,
              baseVersion: input.version,
              ops: created.ops,
              instruction: input.instruction,
              basePlanRevision: created.basePlanRevision,
              basePlanDigest: created.basePlanDigest,
            });
            const generation = settle(true, '已保存受限补丁候选，等待逐项人工核对。');
            const result = resultSchema({ candidate: saved, generation, deduplicated: false });
            store.saveScenePlanPatchReceipt({
              projectId,
              requestId: input.requestId,
              action: 'propose',
              intent,
              state: 'completed',
              result,
              message: '',
            });
            return result;
          });
        } catch (caught) {
          failure = caught;
        }
      }

      const reason = failure instanceof StudyError ? failure.message : '模型响应格式无效';
      return store.transaction(() => {
        const unknown =
          outcome.dispatched &&
          !outcome.ok &&
          !outcome.text &&
          outcome.providerTokens == null &&
          !controller.signal.aborted &&
          !signal?.aborted;
        const generation = settle(
          false,
          unknown
            ? '调用已派发但结果未能确认；候选未保存，额度已保留，不会自动重发 provider。'
            : `候选未保存：${reason}`.slice(0, 500),
          unknown,
        );
        const result = resultSchema({ candidate: null, generation, deduplicated: false });
        store.saveScenePlanPatchReceipt({
          projectId,
          requestId: input.requestId,
          action: 'propose',
          intent,
          state: unknown ? 'unknown' : 'failed',
          result,
          message: generation.message,
          errorCode: unknown ? 'INTERNAL' : 'INVALID_ARGUMENT',
          errorReason: unknown ? 'scene_plan_patch_result_unknown' : 'scene_plan_patch_not_saved',
        });
        return result;
      });
    } catch (caught) {
      if (
        !(caught instanceof StudyError) ||
        caught.code === 'INTERNAL' ||
        store.getModelUsageCall(projectId, input.requestId, intent)
      )
        throw caught;
      deps.revalidateScope?.();
      const latest = store.getLatestRun();
      const usage = latest ? store.modelCallUsage(latest.runId) : { calls: 0, tokens: 0 };
      const result = resultSchema({
        candidate: null,
        deduplicated: false,
        generation: {
          requestId: input.requestId,
          callState: 'failed',
          ok: false,
          message: caught.message.slice(0, 500),
          totalTokens: 0,
          providerTokens: null,
          estimatedCost: null,
          elapsedMs: 0,
          pendingExplanationId: null,
          usage: {
            callsUsed: usage.calls,
            tokensUsed: usage.tokens,
            maxCalls: limits.maxCalls,
            maxTokens: limits.maxTokens,
          },
          remainingCalls: Math.max(0, limits.maxCalls - usage.calls),
          remainingTokens: Math.max(0, limits.maxTokens - usage.tokens),
        },
      });
      store.saveScenePlanPatchReceipt({
        projectId,
        requestId: input.requestId,
        action: 'propose',
        intent,
        state: 'failed',
        result,
        message: result.generation.message,
        errorCode: caught.code,
        errorReason: typeof caught.details?.['reason'] === 'string' ? caught.details['reason'] : null,
      });
      throw new StudyError(
        caught.code,
        { ...caught.details, requestId: input.requestId, receiptState: 'failed' },
        caught.message,
      );
    }
  });
