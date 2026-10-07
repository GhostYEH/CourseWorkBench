/**
 * 生成式教师 / AI 同学公共输出：合同形状 + 纯判定回归。
 *
 * 覆盖三件事：候选只进待核区（审核前公共输出恒空）、审核通过后才可播报
 * （pending/rejected 一律拒绝，疑似答案/评分依据/私人观察停在待核）、
 * 等待本人期间所有生成式操作暂停且没有自动继续路径；外加越权、跨场景、
 * 版本/序号并发的拒绝口径，与协议 4 既有合同互不影响。
 */
import { describe, expect, it } from 'vitest';
import {
  StudyError,
  collabTeachingOperationSchema,
  collabTeachingStateSchema,
  type ClassroomSharedCourseDto,
} from '@sew/study-contracts';
import {
  COLLAB_TEACHING_AI_CANDIDATE_LIMIT,
  COLLAB_TEACHING_AI_OUTPUT_LIMIT,
  COLLAB_TEACHING_AI_SENDER_LABEL,
  collabTeachingAiCandidateSchema,
  collabTeachingAiCommandSchema,
  collabTeachingAiOperationSchema,
  collabTeachingAiPublicOutputSchema,
  createCollabTeachingAiInitialState,
  type CollabTeachingAiCommandInput,
  type CollabTeachingAiOperation,
  type CollabTeachingAiStateDto,
} from '../packages/study-contracts/src/collaboration-teaching-ai';
import {
  assertCollabTeachingAiBodyPublicable,
  assertCollabTeachingAiStateConsistent,
  collabTeachingAiAutoResumePolicy,
  collabTeachingAiGate,
  collabTeachingAiGenerationRequest,
  collabTeachingAiPublicProjection,
  decideCollabTeachingAi,
  type CollabTeachingAiWaiting,
} from '../packages/study-domain/src/collaboration-teaching-ai';

const OWNER = 'uid_10000000-0000-4000-8000-000000000001';
const LEARNER = 'uid_10000000-0000-4000-8000-000000000002';
const STRANGER = 'uid_10000000-0000-4000-8000-000000000009';
const MEMBERS = [OWNER, LEARNER];
const DIGEST = 'd'.repeat(64);
const NOW = '2026-10-07T00:00:00.000Z';

/** 冻结共享快照：scene_1 挂 k-1，scene_2 挂 k-2，两场景各一条陈述。 */
const snapshot: ClassroomSharedCourseDto = {
  snapshotVersion: 1,
  course: {
    lessonId: 'lesson-1',
    lessonVersion: 1,
    title: '函数',
    stageId: 'stage',
    dslVersion: '0.11.2',
    documentDigest: DIGEST,
    bundleDigest: DIGEST,
  },
  scenes: [
    {
      sceneId: 'scene_1',
      type: 'slide',
      title: '讲解',
      order: 0,
      elements: [
        {
          elementId: 'el-1',
          type: 'text',
          left: 0,
          top: 0,
          width: 10,
          height: 10,
          rotate: 0,
          text: '函数图像',
        },
      ],
    },
    { sceneId: 'scene_2', type: 'slide', title: '总结', order: 1, elements: [] },
  ],
  evidence: {
    planVersion: 1,
    knowledgeVersions: [
      { knowledgeId: 'k-1', revision: 1 },
      { knowledgeId: 'k-2', revision: 1 },
    ],
    statements: [
      {
        statementId: 'statement-1',
        knowledgeId: 'k-1',
        text: '函数图像描述变量关系。',
        conditions: 'x 为实数。',
        evidence: [{ materialId: 'm-1', revision: 1, segmentId: 's-1', use: 'concept_basis' }],
      },
      {
        statementId: 'statement-2',
        knowledgeId: 'k-2',
        text: '另一场景的陈述。',
        conditions: '仅场景二。',
        evidence: [{ materialId: 'm-2', revision: 1, segmentId: 's-2', use: 'concept_basis' }],
      },
    ],
    segments: [
      { materialId: 'm-1', revision: 1, segmentId: 's-1', fingerprint: DIGEST, text: '证据文本' },
    ],
  },
  sceneSources: [
    { sceneId: 'scene_1', knowledgeIds: ['k-1'], questionId: null },
    { sceneId: 'scene_2', knowledgeIds: ['k-2'], questionId: null },
  ],
  assets: [],
};

const state = (overrides: Partial<CollabTeachingAiStateDto> = {}): CollabTeachingAiStateDto => ({
  ...createCollabTeachingAiInitialState({ roomId: 'room-1', sceneId: 'scene_1' }),
  ...overrides,
});

const facts = (
  command: CollabTeachingAiCommandInput,
  overrides: Partial<{
    state: CollabTeachingAiStateDto;
    waiting: CollabTeachingAiWaiting | null;
    roomActive: boolean;
    roomRevision: number;
    expectedTailSeq: number;
    nextSeq: number;
    activeMemberUids: readonly string[];
  }> = {},
) => ({
  command,
  state: overrides.state ?? state(),
  snapshot,
  ownerUid: OWNER,
  activeMemberUids: overrides.activeMemberUids ?? MEMBERS,
  roomActive: overrides.roomActive ?? true,
  roomRevision: overrides.roomRevision ?? 3,
  expectedTailSeq: overrides.expectedTailSeq ?? 0,
  nextSeq: overrides.nextSeq ?? 1,
  now: NOW,
  waiting: overrides.waiting ?? null,
});

const command = (
  operation: CollabTeachingAiOperation,
  overrides: Partial<CollabTeachingAiCommandInput> = {},
): CollabTeachingAiCommandInput =>
  collabTeachingAiCommandSchema.parse({
    roomId: 'room-1',
    actorUid: OWNER,
    sceneId: 'scene_1',
    expectedRevision: 3,
    expectedSeq: 1,
    eventId: 'ai-event-1',
    requestId: 'ai-request-1',
    operation,
    ...overrides,
  });

const record = (
  overrides: Partial<Extract<CollabTeachingAiOperation, { kind: 'record-ai-candidate' }>> = {},
): CollabTeachingAiOperation => ({
  kind: 'record-ai-candidate',
  candidateId: 'cand-1',
  anchorStatementId: 'statement-1',
  senderType: 'teacher_ai',
  body: '这里的图像把变量之间的对应关系画了出来，读图时先看横轴。',
  model: 'mimo-openai-compatible',
  ...overrides,
});

const generateTeacher = (
  anchorStatementId = 'statement-1',
  instruction?: string,
): CollabTeachingAiOperation => ({
  kind: 'generate-teacher-explanation',
  anchorStatementId,
  ...(instruction === undefined ? null : { instruction }),
});

const generatePeer = (anchorStatementId?: string): CollabTeachingAiOperation => ({
  kind: 'generate-peer-utterance',
  roleProfileId: 'peer-1',
  peerName: '小明',
  anchorStatementId: anchorStatementId ?? 'statement-1',
});

const review = (
  candidateId: string,
  decision: 'approved' | 'rejected',
  note = '',
): CollabTeachingAiOperation => ({
  kind: 'review-ai-candidate',
  candidateId,
  decision,
  note,
  semanticReviewed: true,
});

const broadcast = (candidateId: string): CollabTeachingAiOperation => ({
  kind: 'broadcast-ai-candidate',
  candidateId,
});

/** 走完「模型落库 → 房主审核通过」的公共前置。 */
const approved = (body?: string, candidateId = 'cand-1'): CollabTeachingAiStateDto => {
  const recorded = decideCollabTeachingAi(
    facts(command(record({ candidateId, ...(body === undefined ? null : { body }) }))),
  );
  return decideCollabTeachingAi(
    facts(command(review(candidateId, 'approved', '已核对来源与口径')), { state: recorded }),
  );
};

const expectReason = (action: () => unknown, reason: string, code?: string): void => {
  try {
    action();
  } catch (error) {
    const studyError = error as StudyError;
    expect(studyError.details?.['reason']).toBe(reason);
    if (code) expect(studyError.code).toBe(code);
    return;
  }
  throw new Error(`预期拒绝 ${reason}`);
};

describe('生成式公共输出合同形状', () => {
  it('候选与公共输出只接受受控字段，AI 标注与来源标记都是常量位', () => {
    const candidateBase = {
      candidateId: 'cand-1',
      seq: 1,
      sceneId: 'scene_1',
      anchorStatementId: 'statement-1',
      senderType: 'teacher_ai',
      body: '讲解候选正文，长度足够。',
      model: 'model-a',
      origin: 'model_generated',
      reviewNote: '',
      reviewedByUid: null as string | null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(
      collabTeachingAiCandidateSchema.safeParse({ ...candidateBase, status: 'pending' }).success,
    ).toBe(true);
    // 客户端提交的路径永远造不出「已审核」候选：origin 与 status 都是写死或受限位。
    expect(
      collabTeachingAiCandidateSchema.safeParse({
        ...candidateBase,
        status: 'pending',
        origin: 'teacher_authored',
      }).success,
    ).toBe(false);
    expect(
      collabTeachingAiCandidateSchema.safeParse({
        ...candidateBase,
        status: 'approved',
        origin: 'model_generated',
        reviewedByUid: OWNER,
      }).success,
    ).toBe(true);
    // AI 同学候选必须同时给出档案号与展示名；教师候选不携带同学身份字段。
    expect(
      collabTeachingAiCandidateSchema.safeParse({
        ...candidateBase,
        senderType: 'peer_ai',
        roleProfileId: 'peer-1',
        peerName: '小明',
        status: 'pending',
      }).success,
    ).toBe(true);
    expect(
      collabTeachingAiCandidateSchema.safeParse({
        ...candidateBase,
        senderType: 'peer_ai',
        status: 'pending',
      }).success,
    ).toBe(false);
    expect(
      collabTeachingAiCandidateSchema.safeParse({
        ...candidateBase,
        status: 'pending',
        peerName: '小明',
      }).success,
    ).toBe(false);
    // 空白正文、本地路径、超长正文都在合同层就被拒绝（collabText 同一口径）。
    expect(
      collabTeachingAiCandidateSchema.safeParse({
        ...candidateBase,
        body: '   ',
        status: 'pending',
      }).success,
    ).toBe(false);
    expect(
      collabTeachingAiCandidateSchema.safeParse({
        ...candidateBase,
        body: '见 C:\\Users\\yao\\私人笔记.txt',
        status: 'pending',
      }).success,
    ).toBe(false);
    expect(
      collabTeachingAiCandidateSchema.safeParse({
        ...candidateBase,
        body: 'x'.repeat(4001),
        status: 'pending',
      }).success,
    ).toBe(false);

    const outputBase = {
      eventId: 'ev-1',
      seq: 2,
      sceneId: 'scene_1',
      senderType: 'teacher_ai',
      candidateId: 'cand-1',
      anchorStatementId: 'statement-1',
      body: '已审核并播报的公共正文。',
      conditions: 'x 为实数。',
      createdAt: NOW,
    };
    expect(
      collabTeachingAiPublicOutputSchema.safeParse({ ...outputBase, aiLabeled: true }).success,
    ).toBe(true);
    // 公共通道里 AI 标注不可缺、不可改写；真人取值根本不存在。
    expect(collabTeachingAiPublicOutputSchema.safeParse(outputBase).success).toBe(false);
    expect(
      collabTeachingAiPublicOutputSchema.safeParse({ ...outputBase, aiLabeled: false }).success,
    ).toBe(false);
    expect(
      collabTeachingAiPublicOutputSchema.safeParse({ ...outputBase, aiLabeled: 'human_learner' })
        .success,
    ).toBe(false);
    expect(
      collabTeachingAiCommandSchema.safeParse({
        roomId: 'room-1',
        actorUid: OWNER,
        sceneId: 'scene_1',
        expectedRevision: 3,
        expectedSeq: 1,
        eventId: 'x',
        requestId: 'x',
        operation: { ...outputBase, aiLabeled: true },
      }).success,
    ).toBe(false);
    // 审核动作要显式确认语义审核，没有默认放行。
    expect(
      collabTeachingAiOperationSchema.safeParse({
        kind: 'review-ai-candidate',
        candidateId: 'cand-1',
        decision: 'approved',
        note: '',
        semanticReviewed: false,
      }).success,
    ).toBe(false);
    expect(COLLAB_TEACHING_AI_SENDER_LABEL.teacher_ai).toContain('AI');
    expect(COLLAB_TEACHING_AI_SENDER_LABEL.peer_ai).toContain('AI');
  });

  it('协议 4 既有合同没有被放宽，两个通道各自独立', () => {
    // speak/write 仍不能携带正文与发言归属；AI 通道动作不在旧联合里。
    expect(
      collabTeachingOperationSchema.safeParse({
        kind: 'speak',
        statementId: 'statement-1',
        senderType: 'teacher_ai',
      }).success,
    ).toBe(false);
    expect(
      collabTeachingOperationSchema.safeParse({
        kind: 'speak',
        statementId: 'statement-1',
        body: '模型现编正文',
      }).success,
    ).toBe(false);
    expect(
      collabTeachingOperationSchema.safeParse({
        kind: 'review-ai-candidate',
        candidateId: 'cand-1',
        decision: 'approved',
        note: '',
        semanticReviewed: true,
      }).success,
    ).toBe(false);
    expect(
      collabTeachingStateSchema.safeParse({
        schemaVersion: 1,
        roomId: 'room-1',
        sceneId: 'scene_1',
        board: { focusElementId: null, laserElementId: null },
        waiting: null,
        outputs: [],
      }).success,
    ).toBe(true);
    expect(
      collabTeachingStateSchema.safeParse({
        ...createCollabTeachingAiInitialState({ roomId: 'room-1', sceneId: 'scene_1' }),
      }).success,
    ).toBe(false);
    expect(collabTeachingAiOperationSchema.safeParse(generateTeacher('statement-1')).success).toBe(
      true,
    );
  });

  it('生成命令不能自报正文，落库命令必须挂当前场景锚点且形状受控', () => {
    expect(
      collabTeachingAiOperationSchema.safeParse({
        kind: 'generate-teacher-explanation',
        anchorStatementId: 'statement-1',
        body: '客户端想直接塞进来的正文',
      }).success,
    ).toBe(false);
    expect(
      collabTeachingAiOperationSchema.safeParse({
        kind: 'record-ai-candidate',
        candidateId: 'cand-1',
        anchorStatementId: 'statement-1',
        senderType: 'teacher_ai',
        body: '候选正文需要足够长才能通过合同。',
        model: 'model-a',
      }).success,
    ).toBe(true);
    expect(
      collabTeachingAiOperationSchema.safeParse({
        kind: 'broadcast-ai-candidate',
        candidateId: 'cand-1',
        body: '绕过待核区直接广播',
      }).success,
    ).toBe(false);
  });
});

describe('生成式调度结论与等待纪律', () => {
  const gateBase = {
    actorIsMember: true,
    actorIsOwner: true,
    roomActive: true,
    waiting: null as CollabTeachingAiWaiting | null,
    candidates: 0,
    publicOutputs: 0,
  };

  it('只有房主在活跃房间且无人等待时可以发起生成', () => {
    expect(collabTeachingAiGate(gateBase)).toEqual({ canGenerate: true, reason: null });
    expect(collabTeachingAiGate({ ...gateBase, actorIsMember: false }).reason).toBe(
      'not_room_member',
    );
    expect(collabTeachingAiGate({ ...gateBase, roomActive: false }).reason).toBe(
      'collab_room_not_active',
    );
    expect(collabTeachingAiGate({ ...gateBase, actorIsOwner: false }).reason).toBe(
      'collab_ai_owner_required',
    );
    // 结论按「成员 → 房间 → 房主 → 等待」顺序短路：更根本的先报。
    expect(
      collabTeachingAiGate({ ...gateBase, actorIsOwner: false, roomActive: false }).reason,
    ).toBe('collab_room_not_active');
  });

  it('等待本人时生成被关闭，且没有任何自动继续路径', () => {
    const waiting: CollabTeachingAiWaiting = {
      waitEventId: 'wait-1',
      sceneId: 'scene_1',
      targetUid: LEARNER,
      acknowledged: true,
    };
    // 已确认也不等于可以继续：结论仍是暂停，继续由房主显式 release-wait。
    expect(collabTeachingAiGate({ ...gateBase, waiting })).toEqual({
      canGenerate: false,
      reason: 'collab_ai_waiting_learner',
    });
    const policy = collabTeachingAiAutoResumePolicy();
    expect(policy.autoResumes).toBe(false);
    expect(policy.pauseWhileWaiting).toBe(true);
    expect(policy.resumeBy).toBe('release-wait');
    expect(policy.cancelBy).toBe('cancel-wait');
  });

  it('待核区与公共输出各自有界，达到上限后拒绝继续生产', () => {
    expect(
      collabTeachingAiGate({ ...gateBase, candidates: COLLAB_TEACHING_AI_CANDIDATE_LIMIT }).reason,
    ).toBe('collab_ai_candidate_limit');
    expect(
      collabTeachingAiGate({ ...gateBase, publicOutputs: COLLAB_TEACHING_AI_OUTPUT_LIMIT }).reason,
    ).toBe('collab_ai_output_limit');
    // 上限内仍然放行：边界是「满」而不是「非空」。
    expect(
      collabTeachingAiGate({
        ...gateBase,
        candidates: COLLAB_TEACHING_AI_CANDIDATE_LIMIT - 1,
        publicOutputs: COLLAB_TEACHING_AI_OUTPUT_LIMIT - 1,
      }).canGenerate,
    ).toBe(true);
  });

  it('服务在调用模型之前就拿不到请求形状，因此不会白跑一次生成', () => {
    const gate = collabTeachingAiGate({
      ...gateBase,
      waiting: {
        waitEventId: 'wait-1',
        sceneId: 'scene_1',
        targetUid: LEARNER,
        acknowledged: false,
      },
    });
    expectReason(
      () =>
        collabTeachingAiGenerationRequest({
          command: command(generateTeacher()),
          state: state(),
          snapshot,
          gate,
        }),
      'collab_ai_waiting_learner',
      'CLASSROOM_AWAITING_LEARNER',
    );
  });

  it('生成只返回请求要素并原样返回状态，正文必须由服务端另发 record 落库', () => {
    const before = state();
    const result = decideCollabTeachingAi(facts(command(generatePeer()), { state: before }));
    expect(result).toBe(before);
    expect(result.candidates).toEqual([]);
    expect(result.publicOutputs).toEqual([]);
    const gate = collabTeachingAiGate(gateBase);
    expect(
      collabTeachingAiGenerationRequest({
        command: command(generatePeer()),
        state: before,
        snapshot,
        gate,
      }),
    ).toMatchObject({
      sceneId: 'scene_1',
      senderType: 'peer_ai',
      anchorStatementId: 'statement-1',
      anchorKnowledgeId: 'k-1',
      roleProfileId: 'peer-1',
      peerName: '小明',
      requestId: 'ai-request-1',
    });
    expect(
      collabTeachingAiGenerationRequest({
        command: command(generateTeacher('statement-1', '用图像对比讲清单调性')),
        state: before,
        snapshot,
        gate,
      }).instruction,
    ).toBe('用图像对比讲清单调性');
    expectReason(
      () =>
        collabTeachingAiGenerationRequest({
          command: command(record()),
          state: before,
          snapshot,
          gate,
        }),
      'collab_ai_not_a_generation_operation',
    );
    expectReason(
      () =>
        collabTeachingAiGenerationRequest({
          command: command(generateTeacher('statement-2')),
          state: before,
          snapshot,
          gate,
        }),
      'collab_statement_not_in_scene',
    );
  });
});

describe('候选只进待核区', () => {
  it('模型候选以 pending 落待核区，公共输出恒空', () => {
    const next = decideCollabTeachingAi(facts(command(record())));
    expect(next.candidates).toHaveLength(1);
    expect(next.candidates[0]).toMatchObject({
      candidateId: 'cand-1',
      seq: 1,
      sceneId: 'scene_1',
      origin: 'model_generated',
      status: 'pending',
      reviewNote: '',
      reviewedByUid: null,
    });
    expect(next.publicOutputs).toEqual([]);
  });

  it('AI 同学候选与教师候选必须区分身份字段，混用一律拒绝', () => {
    const peer = decideCollabTeachingAi(
      facts(command(record({ senderType: 'peer_ai', roleProfileId: 'peer-1', peerName: '小明' }))),
    );
    expect(peer.candidates[0]).toMatchObject({
      senderType: 'peer_ai',
      roleProfileId: 'peer-1',
      peerName: '小明',
    });
    expectReason(
      () => decideCollabTeachingAi(facts(command(record({ senderType: 'peer_ai' })))),
      'collab_ai_peer_identity_missing',
    );
    expectReason(
      () => decideCollabTeachingAi(facts(command(record({ roleProfileId: 'peer-1' })))),
      'collab_ai_sender_fields_mismatch',
    );
  });

  it('锚点必须属于当前场景的冻结已审核陈述，重复落库按已有候选拒绝', () => {
    expectReason(
      () => decideCollabTeachingAi(facts(command(record({ anchorStatementId: 'statement-2' })))),
      'collab_statement_not_in_scene',
    );
    const pendingRecord = decideCollabTeachingAi(facts(command(record())));
    expectReason(
      () => decideCollabTeachingAi(facts(command(record()), { state: pendingRecord })),
      'collab_ai_candidate_exists',
    );
  });

  it('待核区满后只挡落库，房主仍可继续审核处理积压', () => {
    const full = state({
      candidates: Array.from({ length: COLLAB_TEACHING_AI_CANDIDATE_LIMIT }, (_, index) => ({
        candidateId: `cand-full-${index}`,
        seq: index + 1,
        sceneId: 'scene_1',
        anchorStatementId: 'statement-1',
        senderType: 'teacher_ai' as const,
        body: `第 ${index + 1} 条待核候选正文，够长即可。`,
        model: 'model-a',
        origin: 'model_generated' as const,
        status: 'pending' as const,
        reviewNote: '',
        reviewedByUid: null,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    });
    expectReason(
      () =>
        decideCollabTeachingAi(
          facts(command(record({ candidateId: 'cand-overflow' })), { state: full }),
        ),
      'collab_ai_candidate_limit',
      'BUDGET_EXCEEDED',
    );
    const reviewed = decideCollabTeachingAi(
      facts(command(review('cand-full-0', 'approved')), { state: full }),
    );
    expect(reviewed.candidates[0]?.status).toBe('approved');
  });
});

describe('人工审核后才可公共播报', () => {
  it('未审核与被否决的候选都进不了公共输出', () => {
    const pending = decideCollabTeachingAi(facts(command(record())));
    expectReason(
      () => decideCollabTeachingAi(facts(command(broadcast('cand-1')), { state: pending })),
      'collab_ai_candidate_not_approved',
      'CLASSROOM_LESSON_NOT_REVIEWED',
    );
    const rejected = decideCollabTeachingAi(
      facts(command(review('cand-1', 'rejected', '口径不准，不播')), { state: pending }),
    );
    expect(rejected.candidates[0]).toMatchObject({
      status: 'rejected',
      reviewNote: '口径不准，不播',
    });
    expectReason(
      () => decideCollabTeachingAi(facts(command(broadcast('cand-1')), { state: rejected })),
      'collab_ai_candidate_not_approved',
    );
    expectReason(
      () => decideCollabTeachingAi(facts(command(broadcast('cand-missing')), { state: rejected })),
      'collab_ai_candidate_not_found',
    );
  });

  it('审核通过后才播报；正文与适用条件由服务端从候选/快照读出', () => {
    const approvedState = approved();
    expect(approvedState.candidates[0]).toMatchObject({
      status: 'approved',
      reviewNote: '已核对来源与口径',
      reviewedByUid: OWNER,
    });
    // 审核通过本身不产生任何公共输出。
    expect(approvedState.publicOutputs).toEqual([]);
    const broadcasted = decideCollabTeachingAi(
      facts(command(broadcast('cand-1'), { eventId: 'ai-broadcast-1' }), {
        state: approvedState,
        nextSeq: 7,
      }),
    );
    expect(broadcasted.publicOutputs).toHaveLength(1);
    expect(broadcasted.publicOutputs[0]).toMatchObject({
      eventId: 'ai-broadcast-1',
      seq: 7,
      sceneId: 'scene_1',
      senderType: 'teacher_ai',
      aiLabeled: true,
      candidateId: 'cand-1',
      anchorStatementId: 'statement-1',
      body: approvedState.candidates[0]?.body,
      conditions: 'x 为实数。',
      createdAt: NOW,
    });
    // 已下结论的候选不能被再次审核改写，避免「播完再偷偷改」。
    expectReason(
      () =>
        decideCollabTeachingAi(
          facts(command(review('cand-1', 'approved', '再改一次'), { requestId: 're-review' }), {
            state: approvedState,
          }),
        ),
      'collab_ai_candidate_already_reviewed',
    );
    // 播报不改动候选区。
    expect(broadcasted.candidates).toEqual(approvedState.candidates);
  });

  it('疑似答案/评分依据/私人观察可以留在待核供审核，但拒绝播报', () => {
    for (const body of [
      '先看图，答案：B。评分依据：答对得 3 分。',
      '私人观察：该同学掌握状态=较差，别播',
      'Hint: answer = 2x + 1; rubric: 每步 1 分',
    ]) {
      const pending = decideCollabTeachingAi(facts(command(record({ body }))));
      // 待核区允许留存这类正文——房主审核时必须看得见原样。
      expect(pending.candidates[0]?.body).toBe(body);
      const reviewed = decideCollabTeachingAi(
        facts(command(review('cand-1', 'approved', '内容可留档')), { state: pending }),
      );
      expect(reviewed.candidates[0]?.status).toBe('approved');
      expectReason(
        () => decideCollabTeachingAi(facts(command(broadcast('cand-1')), { state: reviewed })),
        'collab_ai_public_output_not_publishable',
        'CLASSROOM_LESSON_NOT_REVIEWED',
      );
    }
    expect(() =>
      assertCollabTeachingAiBodyPublicable('函数图像描述变量之间的对应关系。'),
    ).not.toThrow();
  });

  it('公共输出满后只挡播报，审核积压仍可继续', () => {
    const approvedState = approved();
    const filledBody = approvedState.candidates[0]?.body ?? '';
    const filled = {
      ...approvedState,
      candidates: [
        ...approvedState.candidates,
        {
          candidateId: 'cand-2',
          seq: 2,
          sceneId: 'scene_1',
          anchorStatementId: 'statement-1',
          senderType: 'teacher_ai' as const,
          body: '另一条等待处理的候选正文。',
          model: 'model-a',
          origin: 'model_generated' as const,
          status: 'pending' as const,
          reviewNote: '',
          reviewedByUid: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      publicOutputs: Array.from({ length: COLLAB_TEACHING_AI_OUTPUT_LIMIT }, (_, index) => ({
        eventId: `out-${index}`,
        seq: index + 1,
        sceneId: 'scene_1',
        senderType: 'teacher_ai' as const,
        aiLabeled: true as const,
        candidateId: 'cand-1',
        anchorStatementId: 'statement-1',
        body: filledBody,
        conditions: 'x 为实数。',
        createdAt: NOW,
      })),
    };
    expectReason(
      () => decideCollabTeachingAi(facts(command(broadcast('cand-1')), { state: filled })),
      'collab_ai_output_limit',
      'BUDGET_EXCEEDED',
    );
    const reviewed = decideCollabTeachingAi(
      facts(command(review('cand-2', 'rejected', '先否决积压')), { state: filled }),
    );
    expect(reviewed.candidates.find((item) => item.candidateId === 'cand-2')?.status).toBe(
      'rejected',
    );
  });
});

describe('等待本人期间整条生成式通道暂停', () => {
  const waiting: CollabTeachingAiWaiting = {
    waitEventId: 'wait-1',
    sceneId: 'scene_1',
    targetUid: LEARNER,
    acknowledged: false,
  };

  it('生成/落库/审核/播报在等待期间一律阻断（含目标已确认的情形）', () => {
    const operations: CollabTeachingAiOperation[] = [
      generateTeacher(),
      generatePeer(),
      record(),
      review('cand-1', 'approved'),
      broadcast('cand-1'),
    ];
    for (const operation of operations) {
      expectReason(
        () => decideCollabTeachingAi(facts(command(operation), { waiting })),
        'collab_ai_waiting_learner',
        'CLASSROOM_AWAITING_LEARNER',
      );
      expectReason(
        () =>
          decideCollabTeachingAi(
            facts(command(operation), { waiting: { ...waiting, acknowledged: true } }),
          ),
        'collab_ai_waiting_learner',
      );
    }
  });

  it('等待解除（取消等待）后同一命令可正常落库', () => {
    // 房主取消等待后状态里的 waiting 变为 null，判定不再阻断。
    const next = decideCollabTeachingAi(facts(command(record()), { waiting: null }));
    expect(next.candidates).toHaveLength(1);
  });
});

describe('越权、跨场景与并发口径', () => {
  it('成员不是房主就不能发起任何生成式操作', () => {
    const operations: CollabTeachingAiOperation[] = [
      generateTeacher(),
      generatePeer(),
      record(),
      review('cand-1', 'approved'),
      broadcast('cand-1'),
    ];
    for (const operation of operations) {
      expectReason(
        () => decideCollabTeachingAi(facts(command(operation, { actorUid: LEARNER }))),
        'collab_ai_owner_required',
        'ROLE_PERMISSION_DENIED',
      );
    }
  });

  it('非成员、房间结束、跨场景命令按既有错误码拒绝', () => {
    expectReason(
      () => decideCollabTeachingAi(facts(command(record()), { activeMemberUids: [LEARNER] })),
      'not_room_member',
    );
    expectReason(
      () => decideCollabTeachingAi(facts(command(record(), { actorUid: STRANGER }))),
      'not_room_member',
    );
    expectReason(
      () => decideCollabTeachingAi(facts(command(record()), { roomActive: false })),
      'collab_room_not_active',
      'RUN_TERMINATED',
    );
    expectReason(
      () => decideCollabTeachingAi(facts(command(record(), { sceneId: 'scene_2' }))),
      'collab_teaching_ai_scene_mismatch',
      'VERSION_CONFLICT',
    );
    // scene_2 只挂 k-2：把 scene_1 的陈述当锚点属于跨场景知识引用。
    expectReason(
      () =>
        decideCollabTeachingAi(
          facts(command(generateTeacher('statement-1'), { sceneId: 'scene_2' }), {
            state: state({ sceneId: 'scene_2' }),
          }),
        ),
      'collab_statement_not_in_scene',
    );
  });

  it('版本与序号过期按乐观并发拒绝，命令字段必须完整', () => {
    expectReason(
      () => decideCollabTeachingAi(facts(command(record()), { roomRevision: 4 })),
      'collab_room_revision_mismatch',
    );
    expectReason(
      () =>
        decideCollabTeachingAi(
          facts(command(record(), { expectedSeq: 4 }), { expectedTailSeq: 2 }),
        ),
      'collab_event_seq_mismatch',
    );
    const stale = collabTeachingAiCommandSchema.safeParse({
      roomId: 'room-1',
      actorUid: OWNER,
      sceneId: 'scene_1',
      expectedRevision: 3,
      // 缺 expectedSeq
      eventId: 'ai-event-1',
      requestId: 'ai-request-1',
      operation: record(),
    });
    expect(stale.success).toBe(false);
    expect(
      collabTeachingAiCommandSchema.safeParse({
        ...command(record()),
        senderType: 'human_learner',
      }).success,
    ).toBe(false);
  });

  it('跨场景候选既不能审核也不能播报', () => {
    const otherScene = state({
      candidates: [
        {
          candidateId: 'cand-old',
          seq: 1,
          sceneId: 'scene_other',
          anchorStatementId: 'statement-1',
          senderType: 'teacher_ai',
          body: '旧场景留下的候选正文。',
          model: 'model-a',
          origin: 'model_generated',
          status: 'approved',
          reviewNote: '旧场景已审核',
          reviewedByUid: OWNER,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });
    expectReason(
      () => decideCollabTeachingAi(facts(command(broadcast('cand-old')), { state: otherScene })),
      'collab_ai_candidate_scene_mismatch',
    );
    expectReason(
      () =>
        decideCollabTeachingAi(
          facts(command(review('cand-old', 'rejected'), { requestId: 'old-review' }), {
            state: otherScene,
          }),
        ),
      // 审核先按场景错位拒绝：旧场景候选在本场景既不可播也不可在本场景改判。
      'collab_ai_candidate_scene_mismatch',
    );
  });

  it('伪造的公共输出（没有已审核候选支撑）在读侧即被判为不一致', () => {
    const forged: CollabTeachingAiStateDto = {
      ...createCollabTeachingAiInitialState({ roomId: 'room-1', sceneId: 'scene_1' }),
      publicOutputs: [
        {
          eventId: 'forged',
          seq: 1,
          sceneId: 'scene_1',
          senderType: 'teacher_ai',
          aiLabeled: true,
          candidateId: 'never-reviewed',
          anchorStatementId: 'statement-1',
          body: '未经审核就写进公共通道的正文',
          conditions: '',
          createdAt: NOW,
        },
      ],
    };
    expectReason(
      () => assertCollabTeachingAiStateConsistent(forged),
      'collab_ai_output_not_reviewed',
    );
    expectReason(
      () => collabTeachingAiPublicProjection(forged, snapshot),
      'collab_ai_output_not_reviewed',
      'INTERNAL',
    );
    expectReason(
      () =>
        decideCollabTeachingAi(
          facts(command(record({ candidateId: 'cand-x' })), { state: forged }),
        ),
      'collab_ai_output_not_reviewed',
    );
  });

  it('正文被改写后的已播候选同样按不一致处理', () => {
    const approvedState = approved();
    const broadcasted = decideCollabTeachingAi(
      facts(command(broadcast('cand-1')), { state: approvedState }),
    );
    const tampered = {
      ...broadcasted,
      candidates: broadcasted.candidates.map((item) => ({
        ...item,
        body: '审核之后偷偷改写的正文',
      })),
    };
    expectReason(
      () =>
        decideCollabTeachingAi(facts(command(review('cand-2', 'rejected')), { state: tampered })),
      'collab_ai_output_not_reviewed',
    );
    expectReason(
      () => collabTeachingAiPublicProjection(tampered, snapshot),
      'collab_ai_output_not_reviewed',
    );
  });
});

describe('公开投影去答案、去评分依据、去私人观察', () => {
  it('投影只给白名单字段并写死 AI 标注', () => {
    const approvedState = approved();
    const broadcasted = decideCollabTeachingAi(
      facts(command(broadcast('cand-1'), { eventId: 'ai-broadcast-1' }), { state: approvedState }),
    );
    const items = collabTeachingAiPublicProjection(broadcasted, snapshot);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      seq: 1,
      eventId: 'ai-broadcast-1',
      senderType: 'teacher_ai',
      aiLabel: 'AI',
      displayName: null,
      body: broadcasted.publicOutputs[0]?.body,
      anchorStatementId: 'statement-1',
      conditions: 'x 为实数。',
    });
    const serialized = JSON.stringify(items);
    // 模型标识、待核状态、审核批注、审核人与可回写编号都不进公共通道。
    for (const forbidden of [
      'mimo-openai-compatible',
      'model_generated',
      '已核对来源与口径',
      'cand-1',
      OWNER,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('同学发言保留展示名并与教师输出区分，快照缺失时沿用播报时的条件', () => {
    const recorded = decideCollabTeachingAi(
      facts(command(record({ senderType: 'peer_ai', roleProfileId: 'peer-1', peerName: '小明' }))),
    );
    const approvedState = decideCollabTeachingAi(
      facts(command(review('cand-1', 'approved', '同意公开发言'), { requestId: 'peer-approve' }), {
        state: recorded,
      }),
    );
    const broadcasted = decideCollabTeachingAi(
      facts(command(broadcast('cand-1'), { requestId: 'peer-broadcast' }), {
        state: approvedState,
      }),
    );
    const items = collabTeachingAiPublicProjection(broadcasted, null);
    expect(items[0]).toMatchObject({ senderType: 'peer_ai', aiLabel: 'AI', displayName: '小明' });
    expect(items[0]?.conditions).toBe('x 为实数。');
    expect(collabTeachingAiPublicProjection(state(), snapshot)).toEqual([]);
  });

  it('投影前再次公开性判定：直接写进状态的答案正文也播不出去', () => {
    const leakBody = '本题正确答案：B。';
    const leaky = {
      ...createCollabTeachingAiInitialState({ roomId: 'room-1', sceneId: 'scene_1' }),
      candidates: [
        {
          candidateId: 'cand-leak',
          seq: 1,
          sceneId: 'scene_1',
          anchorStatementId: 'statement-1',
          senderType: 'teacher_ai' as const,
          body: leakBody,
          model: 'model-a',
          origin: 'model_generated' as const,
          status: 'approved' as const,
          reviewNote: '',
          reviewedByUid: OWNER,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      publicOutputs: [
        {
          eventId: 'out-leak',
          seq: 2,
          sceneId: 'scene_1',
          senderType: 'teacher_ai' as const,
          aiLabeled: true as const,
          candidateId: 'cand-leak',
          anchorStatementId: 'statement-1',
          body: leakBody,
          conditions: '',
          createdAt: NOW,
        },
      ],
    };
    expectReason(
      () => collabTeachingAiPublicProjection(leaky, snapshot),
      'collab_ai_public_output_not_publishable',
    );
  });
});
