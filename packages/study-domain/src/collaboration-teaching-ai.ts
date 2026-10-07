/**
 * 生成式教师 / AI 同学公共输出的纯判定（OMA-029 剩余项，协议 4 之上的**新增**通道）。
 *
 * 这一层回答四件事，不碰数据库、不碰 HTTP、也不调用模型：
 * 1. 此刻能不能发起生成（调度结论 `collabTeachingAiGate`）——等待本人期间一律不许，
 *    服务必须**先问判定再调模型**，所以不存在「模型跑完才发现该停下等人」的空转；
 * 2. 生成产物往哪写（`record-ai-candidate` 只落待核区，来源与状态由本层写死为
 *    `model_generated` / `pending`；未审核候选永远进不了公共 outputs）；
 * 3. 待核候选怎么变公共（只有房主人工审核 approved 后，`broadcast-ai-candidate`
 *    才把正文从候选读出追加进 `publicOutputs`，调用方提交不了任何正文）；
 * 4. 公开投影给外面看什么（白名单字段：不带模型标识、审核批注、私人观察、
 *    答案与评分依据；AI 标注在投影里写死为 `'AI'`）。
 *
 * 与 `collaboration-teaching.ts` 的分工：那条通道的形状与语义一个字节都没改；这里的
 * `waiting` 只是**结构化读取**协议 4 的等待位。两个通道的输出流各自独立、各自有界。
 */
import {
  StudyError,
  COLLAB_TEACHING_AI_CANDIDATE_LIMIT,
  COLLAB_TEACHING_AI_OUTPUT_LIMIT,
  collabTeachingAiCandidateSchema,
  collabTeachingAiPublicOutputSchema,
  collabTeachingAiStateSchema,
  type ClassroomSharedCourseDto,
  type CollabTeachingAiCandidateDto,
  type CollabTeachingAiCommandInput,
  type CollabTeachingAiGateDto,
  type CollabTeachingAiGateReason,
  type CollabTeachingAiSenderType,
  type CollabTeachingAiStateDto,
} from '@sew/study-contracts';

/** 协议 4 等待位的结构化读取（不引入其类型，也不改写其语义）。 */
export interface CollabTeachingAiWaiting {
  readonly waitEventId: string;
  readonly sceneId: string;
  readonly targetUid: string;
  readonly acknowledged: boolean;
}

const sceneStatementOrThrow = (
  snapshot: ClassroomSharedCourseDto,
  sceneId: string,
  statementId: string,
) => {
  const sceneKnowledge =
    snapshot.sceneSources.find((source) => source.sceneId === sceneId)?.knowledgeIds ?? [];
  const statement = snapshot.evidence.statements.find((item) => item.statementId === statementId);
  if (!statement || !sceneKnowledge.includes(statement.knowledgeId)) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_statement_not_in_scene' });
  }
  return statement;
};

/**
 * 调度结论：界面与服务共用同一份判定（与 `peerSchedule` 同惯例）。
 *
 * `canGenerate` 为 false 时服务**不得**发起模型调用：等待本人、非房主、非成员、
 * 房间已结束、待核区或公共输出满了，都只是「此刻不再生产新内容」，不是系统故障。
 */
export const collabTeachingAiGate = (facts: {
  actorIsMember: boolean;
  actorIsOwner: boolean;
  roomActive: boolean;
  waiting: CollabTeachingAiWaiting | null;
  candidates: number;
  publicOutputs: number;
}): CollabTeachingAiGateDto => {
  const refuse = (reason: CollabTeachingAiGateReason): CollabTeachingAiGateDto => ({
    canGenerate: false,
    reason,
  });
  if (!facts.actorIsMember) return refuse('not_room_member');
  if (!facts.roomActive) return refuse('collab_room_not_active');
  if (!facts.actorIsOwner) return refuse('collab_ai_owner_required');
  if (facts.waiting) return refuse('collab_ai_waiting_learner');
  if (facts.candidates >= COLLAB_TEACHING_AI_CANDIDATE_LIMIT)
    return refuse('collab_ai_candidate_limit');
  if (facts.publicOutputs >= COLLAB_TEACHING_AI_OUTPUT_LIMIT)
    return refuse('collab_ai_output_limit');
  return { canGenerate: true, reason: null };
};

/** 把拒绝原因映射回与协议 4 同风格的错误码；调度循环据此停下来，而不是空转重试。 */
export const collabTeachingAiGateError = (reason: CollabTeachingAiGateReason): StudyError => {
  switch (reason) {
    case 'not_room_member':
    case 'collab_ai_owner_required':
      return new StudyError('ROLE_PERMISSION_DENIED', { reason });
    case 'collab_room_not_active':
      return new StudyError('RUN_TERMINATED', { reason });
    case 'collab_ai_waiting_learner':
      return new StudyError('CLASSROOM_AWAITING_LEARNER', { reason });
    case 'collab_ai_candidate_limit':
    case 'collab_ai_output_limit':
      return new StudyError('BUDGET_EXCEEDED', { reason });
  }
};

/**
 * 等待期间的续播规则：没有自动路径。
 *
 * `acknowledged` 只表示目标本人已确认，**不等于**可以继续：继续必须由房主显式
 * `release-wait`，中止由房主 `cancel-wait`。这里刻意返回字面量而不是布尔开关，
 * 「等待中要不要自动继续/自动播报」不是一个可配置项——所以也不会空转。
 */
export const collabTeachingAiAutoResumePolicy = (): {
  autoResumes: false;
  pauseWhileWaiting: true;
  resumeBy: 'release-wait';
  cancelBy: 'cancel-wait';
} => ({
  autoResumes: false,
  pauseWhileWaiting: true,
  resumeBy: 'release-wait',
  cancelBy: 'cancel-wait',
});

/** 发起生成时服务真正带给模型的要素；判定不通过即抛错，调用方拿不到请求形状。 */
export interface CollabTeachingAiGenerationRequest {
  readonly sceneId: string;
  readonly senderType: CollabTeachingAiSenderType;
  readonly anchorStatementId: string;
  readonly anchorKnowledgeId: string;
  readonly instruction: string | null;
  readonly roleProfileId: string | null;
  readonly peerName: string | null;
  readonly requestId: string;
}

/**
 * 校验「这次生成可以被发起」并返回模型请求要素。
 *
 * 生成命令**不产生任何公共正文**：它可以安全重放，产物必须由服务另发
 * `record-ai-candidate` 落待核区。等待期间这里直接拒绝，因此调度循环在
 * **调用模型之前**就停下来，而不是调完之后丢弃结果。
 */
export const collabTeachingAiGenerationRequest = (facts: {
  command: CollabTeachingAiCommandInput;
  state: CollabTeachingAiStateDto;
  snapshot: ClassroomSharedCourseDto;
  gate: CollabTeachingAiGateDto;
}): CollabTeachingAiGenerationRequest => {
  const operation = facts.command.operation;
  if (
    operation.kind !== 'generate-teacher-explanation' &&
    operation.kind !== 'generate-peer-utterance'
  ) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_ai_not_a_generation_operation' });
  }
  if (!facts.gate.canGenerate) {
    // 形状上 canGenerate=false 必带原因码；缺码属于接入方伪造的调度结论。
    if (facts.gate.reason === null) {
      throw new StudyError('INTERNAL', { reason: 'collab_ai_gate_reason_missing' });
    }
    throw collabTeachingAiGateError(facts.gate.reason);
  }
  const anchor = sceneStatementOrThrow(
    facts.snapshot,
    facts.state.sceneId,
    operation.anchorStatementId,
  );
  const peer = operation.kind === 'generate-peer-utterance';
  return {
    sceneId: facts.state.sceneId,
    senderType: peer ? 'peer_ai' : 'teacher_ai',
    anchorStatementId: anchor.statementId,
    anchorKnowledgeId: anchor.knowledgeId,
    instruction: operation.instruction ?? null,
    roleProfileId: peer ? operation.roleProfileId : null,
    peerName: peer ? operation.peerName : null,
    requestId: facts.command.requestId,
  };
};

const toCandidate = (
  operation: Extract<CollabTeachingAiCommandInput['operation'], { kind: 'record-ai-candidate' }>,
  facts: { seq: number; sceneId: string; now: string },
): CollabTeachingAiCandidateDto =>
  collabTeachingAiCandidateSchema.parse({
    candidateId: operation.candidateId,
    seq: facts.seq,
    sceneId: facts.sceneId,
    anchorStatementId: operation.anchorStatementId,
    senderType: operation.senderType,
    roleProfileId: operation.roleProfileId,
    peerName: operation.peerName,
    body: operation.body,
    model: operation.model,
    /** 待核区候选的来源标记由本层写死：客户端提交的路径造不出已审核候选。 */
    origin: 'model_generated',
    status: 'pending',
    reviewNote: '',
    reviewedByUid: null,
    createdAt: facts.now,
    updatedAt: facts.now,
  });

const findCandidate = (
  state: CollabTeachingAiStateDto,
  candidateId: string,
): CollabTeachingAiCandidateDto => {
  const candidate = state.candidates.find((item) => item.candidateId === candidateId);
  if (!candidate)
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_ai_candidate_not_found' });
  return candidate;
};

/** 读侧完整性：公共输出必须逐条对应一个**已审核通过**、同场景同来源同正文的候选。 */
export const assertCollabTeachingAiStateConsistent = (state: CollabTeachingAiStateDto): void => {
  state.publicOutputs.forEach((output) => {
    const candidate = state.candidates.find((item) => item.candidateId === output.candidateId);
    if (
      !candidate ||
      candidate.status !== 'approved' ||
      candidate.sceneId !== output.sceneId ||
      candidate.senderType !== output.senderType ||
      candidate.anchorStatementId !== output.anchorStatementId ||
      candidate.body !== output.body
    ) {
      throw new StudyError('INTERNAL', { reason: 'collab_ai_output_not_reviewed' });
    }
  });
};

/**
 * 模型正文里不能进公共通道的内容：答案、评分依据与私人观察。
 *
 * 待核区出现这些片段是正常现象（模型会顺手写出练习答案或评分点），审核时房主
 * 需要看见；但一旦要播报或投影，本层宁可整条拒绝也不做「打码后广播」——界面按
 * `pending` 语义走人工处理，而不是报错弹窗。
 */
const PUBLIC_LEAK_PATTERN = new RegExp(
  [
    '(?:答案|正确答案|评分依据|得分点|给分点|扣分点|私人观察|教师私人|掌握状态|掌握结论|掌握评分)\\s*[:：=]',
    '\\b(?:answer|solution key|rubric|reward model|reward signal|mastery score|mastery state)\\s*[:=]',
  ].join('|'),
  'i',
);

/** 公开性判定：命中疑似答案/评分依据/私人观察即拒绝进入公共通道。 */
export const assertCollabTeachingAiBodyPublicable = (body: string): void => {
  if (PUBLIC_LEAK_PATTERN.test(body)) {
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', {
      reason: 'collab_ai_public_output_not_publishable',
    });
  }
};

/**
 * 公开投影的一条：界面对端与公共讨论流只读这个形状。
 *
 * 刻意不含 `model` / `origin` / `status` / `reviewNote` / `reviewedByUid` / `candidateId`：
 * 待核区内部状态、审核批注与可回写编号不进公共通道；`aiLabel` 写死 `'AI'`。
 */
export interface CollabTeachingAiPublicItem {
  readonly seq: number;
  readonly eventId: string;
  readonly senderType: CollabTeachingAiSenderType;
  readonly aiLabel: 'AI';
  readonly displayName: string | null;
  readonly body: string;
  readonly anchorStatementId: string;
  readonly conditions: string;
}

/** 把已播报的公共输出投影为公开形状（白名单字段 + 写死的 AI 标注）。 */
export const collabTeachingAiPublicProjection = (
  state: CollabTeachingAiStateDto,
  snapshot: ClassroomSharedCourseDto | null,
): CollabTeachingAiPublicItem[] => {
  assertCollabTeachingAiStateConsistent(state);
  return state.publicOutputs.map((output) => {
    assertCollabTeachingAiBodyPublicable(output.body);
    const conditions =
      snapshot?.evidence.statements.find((item) => item.statementId === output.anchorStatementId)
        ?.conditions ?? output.conditions;
    return {
      seq: output.seq,
      eventId: output.eventId,
      senderType: output.senderType,
      aiLabel: 'AI' as const,
      displayName: output.peerName ?? null,
      body: output.body,
      anchorStatementId: output.anchorStatementId,
      conditions,
    };
  });
};

/**
 * 纯授权与状态转换。
 *
 * 前置校验顺序与协议 4 同源（成员 → 房间 → 场景 → 版本 → 序号 → 房主 → 等待），
 * 因此「等本人期间不空转」在这里表现为对**所有**生成式操作（含审核与播报）的阻断。
 * 限额按操作定向：待核区满只挡落库、公共输出满只挡播报，人工审核随时可以继续，
 * 让房主能把积压处理干净而不是被整体卡死。
 */
export const decideCollabTeachingAi = (facts: {
  command: CollabTeachingAiCommandInput;
  state: CollabTeachingAiStateDto;
  snapshot: ClassroomSharedCourseDto;
  ownerUid: string;
  activeMemberUids: readonly string[];
  roomActive: boolean;
  roomRevision: number;
  expectedTailSeq: number;
  nextSeq: number;
  now: string;
  /** 协议 4 的等待位（null 表示当前没有等待）。 */
  waiting: CollabTeachingAiWaiting | null;
}): CollabTeachingAiStateDto => {
  const { command, state, snapshot } = facts;
  const actorIsMember = facts.activeMemberUids.includes(command.actorUid);
  const actorIsOwner = command.actorUid === facts.ownerUid;
  if (!actorIsMember) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'not_room_member' });
  }
  if (!facts.roomActive) {
    throw new StudyError('RUN_TERMINATED', { reason: 'collab_room_not_active' });
  }
  if (command.sceneId !== state.sceneId) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_teaching_ai_scene_mismatch' });
  }
  if (command.expectedRevision !== facts.roomRevision) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_room_revision_mismatch' });
  }
  if (command.expectedSeq !== facts.expectedTailSeq + 1) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'collab_event_seq_mismatch' });
  }
  // 生成式通道没有成员自助动作：一切操作都由房主直接发起，或以房主身份走服务落库路径。
  if (!actorIsOwner) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'collab_ai_owner_required' });
  }
  // 与协议 4 的等待阻断更严格一档：这里连审核与播报也暂停，等待期间没有任何自动路径。
  if (facts.waiting) {
    throw new StudyError('CLASSROOM_AWAITING_LEARNER', { reason: 'collab_ai_waiting_learner' });
  }
  assertCollabTeachingAiStateConsistent(state);

  const gate = collabTeachingAiGate({
    actorIsMember: true,
    actorIsOwner: true,
    roomActive: true,
    waiting: null,
    candidates: state.candidates.length,
    publicOutputs: state.publicOutputs.length,
  });

  const operation = command.operation;
  switch (operation.kind) {
    case 'generate-teacher-explanation':
    case 'generate-peer-utterance': {
      // 生成只校验并返回请求要素；不产生任何公共正文，产物必须经 record 落待核区。
      collabTeachingAiGenerationRequest({ command, state, snapshot, gate });
      return state;
    }
    case 'record-ai-candidate': {
      if (state.candidates.length >= COLLAB_TEACHING_AI_CANDIDATE_LIMIT)
        throw collabTeachingAiGateError('collab_ai_candidate_limit');
      // 教师输出与 AI 同学发言必须区分：peer 候选同时给出档案号与展示名，教师候选不带。
      if (
        operation.senderType === 'peer_ai' &&
        (operation.roleProfileId === undefined || operation.peerName === undefined)
      ) {
        throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_ai_peer_identity_missing' });
      }
      if (
        operation.senderType === 'teacher_ai' &&
        (operation.roleProfileId !== undefined || operation.peerName !== undefined)
      ) {
        throw new StudyError('INVALID_ARGUMENT', { reason: 'collab_ai_sender_fields_mismatch' });
      }
      if (state.candidates.some((item) => item.candidateId === operation.candidateId)) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_ai_candidate_exists' });
      }
      // 正文来自模型，来源仍要挂得住：锚点必须属于当前场景知识点的冻结已审核陈述。
      sceneStatementOrThrow(snapshot, state.sceneId, operation.anchorStatementId);
      const candidate = toCandidate(operation, {
        seq: facts.nextSeq,
        sceneId: state.sceneId,
        now: facts.now,
      });
      return collabTeachingAiStateSchema.parse({
        ...state,
        candidates: [...state.candidates, candidate],
      });
    }
    case 'review-ai-candidate': {
      const candidate = findCandidate(state, operation.candidateId);
      if (candidate.sceneId !== state.sceneId) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_ai_candidate_scene_mismatch' });
      }
      if (candidate.status !== 'pending') {
        throw new StudyError('VERSION_CONFLICT', {
          reason: 'collab_ai_candidate_already_reviewed',
        });
      }
      const reviewed = collabTeachingAiCandidateSchema.parse({
        ...candidate,
        status: operation.decision,
        reviewNote: operation.note,
        reviewedByUid: command.actorUid,
        updatedAt: facts.now,
      });
      return collabTeachingAiStateSchema.parse({
        ...state,
        candidates: state.candidates.map((item) =>
          item.candidateId === reviewed.candidateId ? reviewed : item,
        ),
      });
    }
    case 'broadcast-ai-candidate': {
      if (state.publicOutputs.length >= COLLAB_TEACHING_AI_OUTPUT_LIMIT)
        throw collabTeachingAiGateError('collab_ai_output_limit');
      const candidate = findCandidate(state, operation.candidateId);
      // 未审核（pending）与被否决（rejected）的候选都进不了公共 outputs。
      if (candidate.status !== 'approved') {
        throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', {
          reason: 'collab_ai_candidate_not_approved',
          status: candidate.status,
        });
      }
      if (candidate.sceneId !== state.sceneId) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'collab_ai_candidate_scene_mismatch' });
      }
      // 播报时点复验锚点仍在当前场景（与协议 4 的 speak 同一纪律）。
      const anchor = sceneStatementOrThrow(snapshot, state.sceneId, candidate.anchorStatementId);
      assertCollabTeachingAiBodyPublicable(candidate.body);
      const output = collabTeachingAiPublicOutputSchema.parse({
        eventId: command.eventId,
        seq: facts.nextSeq,
        sceneId: state.sceneId,
        senderType: candidate.senderType,
        // 公共通道里 AI 标注是合同级常量：不存在「AI 自称真人」的写入路径。
        aiLabeled: true,
        roleProfileId: candidate.roleProfileId,
        peerName: candidate.peerName,
        candidateId: candidate.candidateId,
        anchorStatementId: candidate.anchorStatementId,
        body: candidate.body,
        conditions: anchor.conditions,
        createdAt: facts.now,
      });
      return collabTeachingAiStateSchema.parse({
        ...state,
        publicOutputs: [...state.publicOutputs, output],
      });
    }
  }
};
