import { createHash } from 'node:crypto';
import {
  StudyError,
  coursewareOutputSchema,
  coursewareCandidateSchema,
  modelGenerationResultSchema,
  coursewareProposeSchema,
  type CoursewareCandidateDto,
  type CoursewareProposeInput,
  type ModelChatMessage,
  type ModelGenerationResultDto,
  type PlanElementDto,
  type PlanSceneDto,
} from '@sew/study-contracts';
import {
  assertModelCallAdmitted,
  reserveSharedModelTokens,
  sharedModelDeadlineMs,
  assertSharedModelSettlement,
  settlementMeasurement,
  coursewarePrompt,
  assertPlanGrounded,
} from '@sew/study-domain';
import {
  DEFAULT_MODEL_CALL_LIMITS,
  withExclusiveProjectModelCall,
  registerActiveProjectModelCall,
  type ModelCallDeps,
} from './model-call';
import type { ModelGenerateOutcome } from './model-connection';

export interface CoursewareGenerationResult {
  candidate: CoursewareCandidateDto | null;
  generation: ModelGenerationResultDto;
  deduplicated: boolean;
}

const resultSchema = (result: CoursewareGenerationResult): CoursewareGenerationResult => ({
  candidate: result.candidate ? coursewareCandidateSchema.parse(result.candidate) : null,
  generation: modelGenerationResultSchema.parse(result.generation),
  deduplicated: result.deduplicated,
});

const DEFAULT_ELEMENT_STYLE: PlanElementDto['style'] = {
  fontSize: 24,
  color: '#232323',
  bold: false,
  italic: false,
  align: 'left',
};

/** 场景/元素编号由服务端按 requestId + 序号派生：同一请求重试得到同一份计划。 */
const stableId = (prefix: string, requestId: string, index: number): string =>
  `${prefix}_${createHash('sha256').update(`${requestId}:${index}`).digest('hex').slice(0, 24)}`;

/**
 * 受 guard 约束的完整课件计划生成（LESSON-02 / OMA-006）。
 *
 * 复用与课程草案、陈述改写、课堂讲解、错因归因同一套入口：凭据、来源、run、预算与取消
 * 都走 `assertModelCallAdmitted`；判定不通过时一次 provider 请求都不发出。
 *
 * 模型只能决定「讲哪些已选陈述/题目、按什么顺序、每个场景怎么写」：场景编号、知识点与
 * 来源都由服务端从冻结证据包沿用，并在落库前用 `assertPlanGrounded` 复验。产物只是候选，
 * 写入待核区，不进入任何场景计划或教学；人工通过才把候选场景写成该草案版本的场景计划。
 */
export const generateCourseware = async (
  deps: ModelCallDeps,
  raw: CoursewareProposeInput,
  signal?: AbortSignal,
): Promise<CoursewareGenerationResult> =>
  withExclusiveProjectModelCall(deps.projectId, async () => {
    const input = coursewareProposeSchema.parse(raw);
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

    const previous = store.coursewareReceipt(projectId, input.requestId, 'propose', intent);
    if (previous) {
      return resultSchema({
        ...(previous.result as CoursewareGenerationResult),
        deduplicated: true,
      });
    }

    // 回执缺失时先查派发台账，绝不靠复用 nonce 再次调用 provider。旧版本失败记录可
    // 从已结算结果恢复；未结算或缺少业务结果的记录保持未知并继续占用预算。
    const priorCall = store.getModelUsageCall(projectId, input.requestId, intent);
    if (priorCall) {
      const recorded = priorCall.result;
      const existingCandidate = store.getCoursewareCandidate(
        projectId,
        `cw_${createHash('sha256').update(input.requestId).digest('hex').slice(0, 24)}`,
      );
      if (recorded && (!recorded.ok || existingCandidate)) {
        const result = resultSchema({
          candidate: recorded.ok ? existingCandidate : null,
          generation: recorded,
          deduplicated: true,
        });
        store.saveCoursewareReceipt(projectId, input.requestId, 'propose', intent, result);
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
          reason: 'courseware_base_not_draft',
        });
      }
      const bundleRow = store.getEvidenceBundle(projectId, lesson.bundleId);
      if (!bundleRow) throw new StudyError('INTERNAL', { bundleId: lesson.bundleId });
      // 记录生成候选时该版本计划的基线：审批时据此判断计划是否已被别处推进。
      const basePlan = store.getScenePlan(projectId, input.lessonId, input.version);

      const allowedStatements = bundleRow.bundle.statements.filter((item) =>
        lesson.statementIds.includes(item.statementId),
      );
      const allowedQuestions = bundleRow.bundle.questions.filter((item) =>
        lesson.questionIds.includes(item.questionId),
      );
      if (allowedStatements.length === 0 && allowedQuestions.length === 0) {
        throw new StudyError('INVALID_ARGUMENT', { reason: 'courseware_no_source_content' });
      }

      const run = store.getLatestRun();
      const connection = deps.connection.status();
      const referencedKnowledgeIds = [
        ...new Set([
          ...allowedStatements.map((item) => item.knowledgeId),
          ...allowedQuestions.flatMap((item) => item.knowledgeIds),
        ]),
      ];
      const checkFacts = (): void => {
        deps.revalidateScope?.();
        const currentLesson = store.getLessonVersion(input.lessonId, input.version, projectId);
        if (!currentLesson || currentLesson.status !== 'draft') {
          throw new StudyError('VERSION_CONFLICT', { reason: 'courseware_lesson_changed' });
        }
        if (currentLesson.bundleId !== lesson.bundleId) {
          throw new StudyError('VERSION_CONFLICT', { reason: 'courseware_bundle_changed' });
        }
        const latest = store.getLatestRun();
        if (run && (latest?.runId !== run.runId || latest.state !== run.state)) {
          throw new StudyError('VERSION_CONFLICT', { reason: 'courseware_run_changed' });
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
          throw new StudyError('VERSION_CONFLICT', { reason: 'courseware_model_changed' });
        }
      };
      checkFacts();
      if (!run) throw new StudyError('PLAN_NOT_CONFIRMED');
      if (signal?.aborted) throw new StudyError('RUN_TERMINATED', { reason: 'request_aborted' });

      const messages: ModelChatMessage[] = coursewarePrompt({
        subject: bundleRow.bundle.subject,
        statements: allowedStatements.map((item) => ({
          statementId: item.statementId,
          text: item.text,
          conditions: item.conditions,
        })),
        questions: allowedQuestions.map((item) => ({
          questionId: item.questionId,
          stem: item.snapshot?.stem ?? '',
        })),
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

      /** 模型输出 → 计划场景：编号与知识点由服务端沿用，模型只给种类/标题/正文/绑定。 */
      const buildScenes = (): PlanSceneDto[] => {
        if (!outcome.text)
          throw new StudyError('INVALID_ARGUMENT', { reason: 'courseware_generation_failed' });
        if (outcome.text.length > 20_000) {
          throw new StudyError('INVALID_ARGUMENT', { reason: 'courseware_output_too_long' });
        }
        const parsed = coursewareOutputSchema.safeParse(JSON.parse(outcome.text));
        if (!parsed.success)
          throw new StudyError('INVALID_ARGUMENT', { reason: 'courseware_output_invalid' });
        const statementsById = new Map(allowedStatements.map((item) => [item.statementId, item]));
        const questionsById = new Map(allowedQuestions.map((item) => [item.questionId, item]));
        return parsed.data.scenes.map((scene, index) => {
          const sceneId = stableId(`scene_${scene.kind}`, input.requestId, index);
          const elements: PlanElementDto[] = (scene.elements ?? []).map(
            (element, elementIndex) => ({
              elementId: stableId('el_text', input.requestId, index * 100 + elementIndex),
              kind: 'text' as const,
              text: element.text,
              assetRef: null,
              left: 90,
              top: 130 + elementIndex * 120,
              width: 820,
              height: 110,
              style: { ...DEFAULT_ELEMENT_STYLE, ...(element.style ?? {}) },
            }),
          );
          if (scene.kind === 'slide') {
            const statement = scene.statementId ? statementsById.get(scene.statementId) : undefined;
            if (!statement)
              throw new StudyError('INVALID_ARGUMENT', {
                reason: 'courseware_scene_binding_invalid',
              });
            return {
              sceneId,
              kind: 'slide' as const,
              title: scene.title,
              statementId: statement.statementId,
              questionId: null,
              knowledgeIds: [statement.knowledgeId],
              elements,
              note: scene.note ?? '',
            };
          }
          if (scene.kind === 'quiz') {
            const question = scene.questionId ? questionsById.get(scene.questionId) : undefined;
            if (!question)
              throw new StudyError('INVALID_ARGUMENT', {
                reason: 'courseware_scene_binding_invalid',
              });
            return {
              sceneId,
              kind: 'quiz' as const,
              title: scene.title,
              statementId: null,
              questionId: question.questionId,
              knowledgeIds: [...question.knowledgeIds],
              elements: [],
              note: scene.note ?? '',
            };
          }
          return {
            sceneId,
            kind: scene.kind,
            title: scene.title,
            statementId: null,
            questionId: null,
            knowledgeIds: [],
            elements: [],
            note: scene.note ?? '',
          };
        });
      };

      let candidate: CoursewareCandidateDto | null = null;
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
          throw new StudyError('INVALID_ARGUMENT', { reason: 'courseware_generation_failed' });
        }
        const scenes = buildScenes();
        // 落库前复验：场景绑定必须落在本版本已选范围内，知识点必须与服务端沿用一致。
        assertPlanGrounded(scenes, {
          bundle: bundleRow.bundle,
          statementIds: lesson.statementIds,
          questionIds: lesson.questionIds,
        });
        candidate = coursewareCandidateSchema.parse({
          candidateId: `cw_${createHash('sha256').update(input.requestId).digest('hex').slice(0, 24)}`,
          projectId,
          lessonId: input.lessonId,
          baseVersion: input.version,
          basePlanRevision: basePlan?.revision ?? 0,
          basePlanDigest: basePlan?.digest ?? null,
          origin: 'model_generated',
          status: 'pending',
          scenes,
          instruction: input.instruction,
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
            const saved = store.createCoursewareCandidate({
              candidateId: created.candidateId,
              projectId,
              lessonId: input.lessonId,
              baseVersion: input.version,
              scenes: created.scenes,
              instruction: input.instruction,
              basePlanRevision: created.basePlanRevision,
              basePlanDigest: created.basePlanDigest,
            });
            const generation = settle(true, '已保存完整课件候选，等待人工核对。');
            const result = resultSchema({ candidate: saved, generation, deduplicated: false });
            store.saveCoursewareReceipt(projectId, input.requestId, 'propose', intent, result);
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
        store.saveCoursewareReceipt(projectId, input.requestId, 'propose', intent, result);
        return result;
      });
    } catch (caught) {
      // Guard / cancellation before reservation is a definite failure. Once a call has a ledger
      // row, a missing receipt stays unknown; a crash must never authorize another dispatch.
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
      store.saveCoursewareReceipt(projectId, input.requestId, 'propose', intent, result);
      throw new StudyError(
        caught.code,
        { ...caught.details, requestId: input.requestId, receiptState: 'failed' },
        caught.message,
      );
    }
  });
