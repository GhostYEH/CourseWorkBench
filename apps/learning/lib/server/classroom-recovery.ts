/**
 * 四层恢复核对（《规划书》6.7，RESUME-01）。
 *
 * 这里只做「读 + 判」：把四层各自依赖的权威事实重新验一遍，给出可复核结论。
 * 三条硬约束：
 *
 * 1. **不发 provider**：恢复不是重新生成。任何一层都不触发模型调用。
 * 2. **不重复效果**：白板动作、消息、提交都按收据与去重键读回，绝不重放。
 * 3. **不静默降级**：权威事实对不上（来源失效、摘要不符、绑定漂移）时返回
 *    `blocked`，由界面明确阻断；只有临时现场（iframe 内存态）才允许 `reset`，
 *    且已提交的本人记录必须保留。
 *
 * 数据库句柄重开只能证明持久化读得回来，不能替代整应用/服务崩溃恢复；
 * 本模块的结论必须配合真实崩溃走查使用，不能据此宣称 RESUME-01 已签核。
 */

import {
  StudyError,
  classroomPeerTurnSchema,
  type RecoveryLayerResultDto,
  type RecoveryCheckpointDto,
  type RecoveryStatus,
} from '@sew/study-contracts';
import { RUNTIME_DSL_VERSION } from '@openmaic/dsl';
import { z } from 'zod';
import { classroomDocumentDigest, pblProjectSceneId } from '@sew/study-domain';
import type { Session } from './service';
import { loadRenderableDocument, type RenderableFormalDocument } from './classroom-service';
import { loadFormalInteraction } from './formal-interaction-service';
import { readPblDefinition } from './pbl-definition-store';

const layer = (
  name: RecoveryLayerResultDto['layer'],
  status: RecoveryStatus,
  reason: string,
  message: string,
  counts: { preserved?: number; discarded?: number } = {},
): RecoveryLayerResultDto => ({
  layer: name,
  status,
  reason,
  message,
  // 恢复核对永远不派发外部调用；这一项恒为 0，防止将来被误用成「重新生成」。
  providerCalls: 0,
  discarded: counts.discarded ?? 0,
  preserved: counts.preserved ?? 0,
});

const reasonOf = (error: unknown): string =>
  error instanceof StudyError
    ? typeof error.details?.['reason'] === 'string'
      ? error.details['reason']
      : error.code
    : 'unexpected_error';

const messageOf = (error: unknown): string =>
  error instanceof StudyError ? error.message : '恢复核对遇到未预期错误，已阻断该层。';

/**
 * 课件文档层。
 *
 * 复用课堂实际下发路径的校验：能通过就说明这节课可以继续渲染；
 * 撤回、来源失效、文档被改写都会在这里被拦下，而不是等渲染端崩。
 */
const checkDocument = (
  session: Session,
  stageId: string,
  sessionId: string,
): RecoveryLayerResultDto => {
  try {
    const document = loadRenderableDocument(session, stageId);
    if (!document) {
      return layer(
        'document',
        'blocked',
        'document_missing',
        '这节课还没有可下发的课件文档，请先在课程页生成并挂接。',
      );
    }
    const classroom = session.store.getClassroomSession(sessionId, session.projectId)!;
    const link = session.store.getLessonClassroomLink(classroom.lessonId, session.projectId);
    if (
      document.lessonId !== classroom.lessonId ||
      link?.lessonVersion !== classroom.lessonVersion ||
      ('scenes' in document &&
        !(document as RenderableFormalDocument).scenes.some(
          (scene) => scene.sceneId === classroom.currentSceneId,
        ))
    )
      throw new StudyError('VERSION_CONFLICT', { reason: 'recovery_document_binding_mismatch' });
    return layer(
      'document',
      'restored',
      'document_verified',
      `课件文档校验通过，共 ${document.sceneCount} 个场景。`,
      {
        preserved: document.sceneCount,
      },
    );
  } catch (error) {
    return layer('document', 'blocked', reasonOf(error), `课件文档不可用：${messageOf(error)}`);
  }
};

/**
 * 讨论与白板层。
 *
 * 只读当前序号与已执行动作。已执行的 `effects` 是权威结果，恢复时**不重放**；
 * 序号是后续动作的预期值，界面据此判断自己是否过期。
 *
 * 读取失败按 `blocked` 处理而不是 `reset`：白板动作是权威事实，读不出来说明
 * 状态已不可信（例如行被外部改写），此时「重置现场继续上课」会掩盖数据问题。
 * 只有互动现场的临时内存态才允许 `reset`。
 */
const checkBoard = (session: Session, sessionId: string): RecoveryLayerResultDto => {
  try {
    const state = session.store.classroomBoardState(session.projectId, sessionId);
    const classroom = session.store.getClassroomSession(sessionId, session.projectId)!;
    const binding = session.store.getLocalLearnerBinding(session.projectId);
    if (
      !binding ||
      binding.uid !== session.learnerUid ||
      classroom.learnerKey !== binding.learnerKey
    )
      throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'recovery_learner_mismatch' });
    const actions = session.store.listClassroomActions(sessionId, session.projectId);
    const turns = session.store.listClassroomPeerTurns(session.projectId, sessionId);
    for (const turn of turns) {
      const parsed = classroomPeerTurnSchema.safeParse(turn);
      const receipt =
        actions.find(
          (action) => action.payload.kind === 'peer_turn' && action.payload.turnId === turn.turnId,
        ) ?? null;
      const receiptPayload = receipt?.payload.kind === 'peer_turn' ? receipt.payload : null;
      if (
        !parsed.success ||
        turn.projectId !== session.projectId ||
        turn.sessionId !== sessionId ||
        !receiptPayload ||
        receiptPayload.roleProfileId !== turn.roleProfileId ||
        receiptPayload.roundIndex !== turn.roundIndex ||
        receiptPayload.peerKind !== turn.kind ||
        receipt?.sceneId !== turn.sceneId
      )
        throw new StudyError('INTERNAL', { reason: 'recovery_peer_receipt_mismatch' });
    }
    // 每条收据都必须属于本会话本项目；同学发言收据还必须指向一条真实存在的发言。
    const bindingBroken = actions.some((action) => {
      if (action.sessionId !== sessionId || action.projectId !== session.projectId) return true;
      const payload = action.payload;
      return payload.kind === 'peer_turn' && !turns.some((turn) => turn.turnId === payload.turnId);
    });
    if (bindingBroken)
      throw new StudyError('INTERNAL', { reason: 'recovery_action_binding_mismatch' });
    return layer(
      'board',
      'restored',
      'board_state_read',
      `已读回 ${turns.length} 条同学发言、${actions.length} 条动作收据；白板已执行 ${state.effects.length} 个动作，当前序号 ${state.seq}；恢复不重放。`,
      {
        preserved: state.effects.length + turns.length,
      },
    );
  } catch (error) {
    return layer(
      'board',
      'blocked',
      reasonOf(error),
      `白板状态不可读，已阻断继续上课（已提交动作保留在历史中）：${messageOf(error)}`,
    );
  }
};

/**
 * 本人作答层。
 *
 * 只统计**本人真实**提交，模拟分区与同学发言不计入；判分待定是合法状态，
 * 不是恢复失败——简答题本来就要人工或模型候选审核。
 */
const checkAttempts = (session: Session, sessionId: string): RecoveryLayerResultDto => {
  try {
    const classroom = session.store.getClassroomSession(sessionId, session.projectId);
    if (!classroom)
      return layer('attempt', 'blocked', 'session_missing', '课堂会话不存在，无法核对本人作答。');
    const lesson = session.store.getLessonVersion(
      classroom.lessonId,
      classroom.lessonVersion,
      session.projectId,
    );
    const bundle = lesson
      ? session.store.getEvidenceBundle(session.projectId, lesson.bundleId)
      : null;
    if (!lesson || !bundle) {
      return layer('attempt', 'blocked', 'bundle_missing', '课程证据包不可读，无法核对本人作答。');
    }
    const binding = session.store.getLocalLearnerBinding(session.projectId);
    if (
      !binding ||
      binding.uid !== session.learnerUid ||
      classroom.learnerKey !== binding.learnerKey
    ) {
      throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'recovery_learner_mismatch' });
    }
    if (classroom.bundleId !== bundle.bundleId)
      throw new StudyError('VERSION_CONFLICT', { reason: 'recovery_bundle_mismatch' });
    const questions = new Map(
      bundle.bundle.questions
        .filter((q) => lesson.questionIds.includes(q.questionId))
        .map((q) => [q.questionId, q]),
    );
    const sources = session.store.listClassroomSceneSources(session.projectId, classroom.stageId!);
    const stored = session.store.getClassroomDocument(session.projectId, classroom.stageId!);
    const document = stored?.document as
      | { scenes?: Array<{ id: string; content?: { questions?: Array<{ id: string }> } }> }
      | undefined;
    const attempts = session.store.listAttempts('real', 'formal');
    const receipts = attempts.map((attempt) => ({
      attempt,
      receipt: session.store.runtime.getQuizReceipt(session.projectId, attempt.idempotencyKey),
    }));
    const quizSessions = session.store.runtime
      .listSessions(session.projectId, classroom.stageId!, binding.learnerKey)
      .filter((r) => r.kind === 'quizAttempt');
    let submitted = 0,
      drafts = 0,
      pendingSubmissions = 0,
      awaitingGrading = 0;
    const seen = new Set<string>();
    for (const runtime of quizSessions) {
      if (runtime.runtimeDslVersion !== RUNTIME_DSL_VERSION)
        throw new StudyError('VERSION_CONFLICT', { reason: 'quiz_runtime_version_mismatch' });
      const records = session.store.runtime.listRecords(session.projectId, runtime.id);
      let lastPhase: string | undefined;
      for (const [index, record] of records.entries()) {
        const payload = z
          .object({
            payloadVersion: z.literal(1),
            phase: z.enum(['draft', 'submitted', 'reviewed']),
            answers: z.record(z.string(), z.string().max(10000)),
            results: z.array(z.object({ questionId: z.string() }).passthrough()).optional(),
          })
          .strict()
          .safeParse(record.payload);
        const source = record.sceneId ? sources.get(record.sceneId) : undefined;
        const question = source?.questionId ? questions.get(source.questionId) : undefined;
        const dslId = document?.scenes?.find((scene) => scene.id === record.sceneId)?.content
          ?.questions?.[0]?.id;
        if (
          !payload.success ||
          record.seq !== index ||
          !question ||
          !question.snapshot ||
          !dslId ||
          (record.subAnchor !== undefined && record.subAnchor !== dslId) ||
          record.actionIndex !== undefined ||
          records[0]?.sceneId !== record.sceneId
        ) {
          throw new StudyError('INTERNAL', { reason: 'invalid_quiz_recovery_record' });
        }
        if (
          Object.keys(payload.data.answers).some(
            (key) => key !== dslId && key !== `${dslId}:process`,
          )
        )
          throw new StudyError('INTERNAL', { reason: 'quiz_answer_binding_mismatch' });
        lastPhase = payload.data.phase;
        if (payload.data.phase !== 'reviewed') {
          if (
            payload.data.results !== undefined ||
            (runtime.status === 'completed' && index === records.length - 1)
          )
            throw new StudyError('INTERNAL', { reason: 'quiz_submission_incomplete' });
          continue;
        }
        const matched = receipts
          .filter(
            ({ receipt }) => receipt?.sessionId === runtime.id && receipt.recordId === record.id,
          )
          .map(({ attempt }) => attempt);
        const attempt = matched[0];
        const receipt =
          attempt &&
          session.store.runtime.getQuizReceipt(session.projectId, attempt.idempotencyKey);
        if (
          matched.length !== 1 ||
          !attempt ||
          !receipt ||
          receipt.questionId !== question.questionId ||
          attempt.actorType !== 'human_learner' ||
          attempt.requestedKind !== 'real' ||
          attempt.questionId !== question.questionId ||
          attempt.questionRevision !== question.revision ||
          attempt.answerVersion !== (question.snapshot.assessment?.answerVersion ?? null) ||
          attempt.answerText !== payload.data.answers[dslId] ||
          attempt.processText !== (payload.data.answers[`${dslId}:process`] ?? '') ||
          runtime.status !== 'completed' ||
          record.subAnchor !== dslId ||
          payload.data.results?.length !== 1 ||
          payload.data.results[0]?.questionId !== dslId ||
          (attempt.grading &&
            classroomDocumentDigest(payload.data.results[0]) !==
              classroomDocumentDigest({ questionId: dslId, ...attempt.grading })) ||
          seen.has(attempt.attemptId)
        ) {
          throw new StudyError('INTERNAL', { reason: 'quiz_receipt_or_version_mismatch' });
        }
        session.store.getFeedbackContext(session.projectId, session.learnerUid, attempt.attemptId);
        seen.add(attempt.attemptId);
        submitted += 1;
        if (!attempt.grading || attempt.grading.status === 'pending_review') awaitingGrading += 1;
      }
      if (runtime.status === 'completed' && lastPhase !== 'reviewed')
        throw new StudyError('INTERNAL', { reason: 'quiz_submission_incomplete' });
      if (lastPhase === 'draft' && runtime.status === 'active') drafts += 1;
      if (lastPhase === 'submitted' && runtime.status === 'active') pendingSubmissions += 1;
    }
    const unbound = receipts.filter(
      ({ attempt, receipt }) =>
        questions.has(attempt.questionId) && attempt.actorType === 'human_learner' && !receipt,
    );
    // 没有课件 Runtime 收据的作答可能来自合法独立练习；保留历史，不计课堂恢复，也不阻断课堂。
    const runtimeIds = new Set(quizSessions.map((runtime) => runtime.id));
    if (
      receipts.some(
        ({ attempt, receipt }) =>
          receipt && runtimeIds.has(receipt.sessionId) && !seen.has(attempt.attemptId),
      )
    )
      throw new StudyError('INTERNAL', { reason: 'quiz_receipt_or_version_mismatch' });
    const historyNote = unbound.length
      ? `另有 ${unbound.length} 条未绑定此课件的本人练习或旧历史，保留但不计本次恢复。`
      : '';
    return layer(
      'attempt',
      classroom.status === 'awaiting_learner' || pendingSubmissions > 0 ? 'waiting' : 'restored',
      pendingSubmissions > 0 ? 'quiz_submission_unconfirmed' : 'attempts_read',
      `当前课件的本人分区已读回 ${submitted} 条提交、${drafts} 份草稿；${pendingSubmissions} 条提交意图尚待确认，${awaitingGrading} 条待判分，草稿不计提交。${historyNote}`,
      { preserved: submitted + drafts },
    );
  } catch (error) {
    return layer('attempt', 'blocked', reasonOf(error), `本人作答核对失败：${messageOf(error)}`);
  }
};

/**
 * 互动现场层。
 *
 * 只有当前场景确实是正式互动时才需要核对：能加载就恢复现场；定义或绑定
 * 对不上则阻断权威数据，但已提交的本人记录仍按 UID/定义摘要保留在记录里。
 * 非互动场景不伪造一条「已恢复」的互动。
 */
const checkInteraction = (
  session: Session,
  stageId: string,
  sceneId: string,
): RecoveryLayerResultDto => {
  try {
    const document = loadRenderableDocument(session, stageId);
    // 演示课件没有场景类型信息，不能假装知道它是互动场景。
    const formal = document && 'scenes' in document ? (document as RenderableFormalDocument) : null;
    const scene = formal?.scenes.find((item) => item.sceneId === sceneId);
    if (formal && scene?.sceneType === 'pbl') {
      const lesson = session.store.getLessonVersion(
        formal.lessonId,
        formal.lessonVersion,
        session.projectId,
      );
      const frozen = lesson
        ? (readPblDefinition(session, formal.lessonId, formal.lessonVersion)?.frozen ?? null)
        : null;
      const documentScene = (
        (formal.document as { scenes?: Array<{ id?: string; content?: Record<string, unknown> }> })
          .scenes ?? []
      ).find((item) => item.id === sceneId);
      const content = documentScene?.content;
      const source = session.store
        .listClassroomSceneSources(session.projectId, stageId)
        .get(sceneId);
      const statementIds = frozen?.definition.statementIds ?? [];
      const expectedKnowledgeIds = lesson
        ? [
            ...new Set(
              statementIds
                .map((statementId) => {
                  const bundle = session.store.getEvidenceBundle(
                    session.projectId,
                    lesson.bundleId,
                  )?.bundle;
                  return bundle?.statements.find((item) => item.statementId === statementId)
                    ?.knowledgeId;
                })
                .filter((knowledgeId): knowledgeId is string => Boolean(knowledgeId)),
            ),
          ].sort()
        : [];
      if (
        !frozen ||
        !content ||
        content['type'] !== 'pbl' ||
        content['definitionId'] !== frozen.definition.id ||
        pblProjectSceneId(frozen.definition.id) !== sceneId ||
        classroomDocumentDigest(content['statementIds']) !==
          classroomDocumentDigest(statementIds) ||
        !source ||
        classroomDocumentDigest([...source.knowledgeIds].sort()) !==
          classroomDocumentDigest(expectedKnowledgeIds)
      ) {
        throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', {
          reason: 'recovery_pbl_binding_mismatch',
          sceneId,
        });
      }
      return layer(
        'interaction',
        'restored',
        'pbl_definition_verified',
        'PBL 场景的冻结定义与陈述来源已核验；恢复未创建任何本人提交记录。',
      );
    }
    if (!formal || !scene || scene.sceneType !== 'interactive') {
      return layer(
        'interaction',
        'restored',
        'no_interactive_scene',
        '当前场景不是正式互动，无需恢复互动现场。',
      );
    }
    const state = loadFormalInteraction(session, stageId, sceneId);
    return layer(
      'interaction',
      'restored',
      'interaction_loaded',
      `互动「${state.definition.title}」已恢复；已提交 ${state.count} 次，草稿${state.draft ? '已' : '未'}保留。`,
      {
        preserved: state.count + (state.draft ? 1 : 0),
      },
    );
  } catch (error) {
    // 此路径读取的定义、绑定、草稿和提交均已持久化，损坏不能降级为临时现场重置。
    return layer(
      'interaction',
      'blocked',
      reasonOf(error),
      `互动权威记录不可用，已阻断；历史记录保留，未重置或重放：${messageOf(error)}`,
    );
  }
};

/**
 * 一次完整的四层核对。
 *
 * `resumable` 仅在四层通过且课堂可执行时为真：等待和终止均不可自动续课，
 * 不能带着「内容可能和上次不一样」的状态继续上课。
 */
export const checkRecovery = (session: Session, sessionId: string): RecoveryCheckpointDto => {
  const classroom = session.store.getClassroomSession(sessionId, session.projectId);
  if (!classroom) throw new StudyError('NOT_FOUND', { sessionId });
  // 会话冻结的 stage 才是权威：不接受请求方另给一个 stage 去看别的课件。
  const stageId = classroom.stageId;
  if (!stageId)
    throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING', { reason: 'session_has_no_stage' });

  const layers: RecoveryLayerResultDto[] = [
    checkDocument(session, stageId, sessionId),
    checkBoard(session, sessionId),
    checkAttempts(session, sessionId),
    checkInteraction(session, stageId, classroom.currentSceneId),
  ];

  const continuation = layers.some((item) => item.status === 'blocked')
    ? ('blocked' as const)
    : classroom.status === 'completed' || classroom.status === 'cancelled'
      ? ('terminal' as const)
      : classroom.status === 'awaiting_learner' || layers.some((item) => item.status === 'waiting')
        ? ('waiting' as const)
        : ('continue' as const);
  let boardSeq: number | null = null;
  if (layers.find((item) => item.layer === 'board')?.status !== 'blocked')
    boardSeq = session.store.classroomBoardState(session.projectId, sessionId).seq;
  return {
    projectId: session.projectId,
    generation: session.generation,
    sessionId,
    uid: session.learnerUid,
    layers,
    resumable: continuation === 'continue',
    sessionStatus: classroom.status,
    continuation,
    position: { stageId, sceneId: classroom.currentSceneId, boardSeq },
    providerCalls: 0,
    checkedAt: new Date().toISOString(),
  };
};
