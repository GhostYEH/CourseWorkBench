import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StudyError, type CollabTeachingAiCommandInput } from '@sew/study-contracts';
import { CollabServiceStore, StudyStore } from '@sew/study-storage';
import { classroomDocumentDigest } from '@sew/study-domain';
import { buildFormalLessonDocument } from '../apps/learning/lib/classroom/formal-lesson-document';
import type { ModelGenerateOutcome } from '../apps/learning/lib/server/model-connection';
import type { CollabAiModelDeps } from '../apps/learning/lib/server/collab-teaching-ai-model';
import { generateCollabTeachingAi } from '../apps/learning/lib/server/collab-teaching-ai-model';

const OWNER = 'uid_10000000-0000-4000-8000-000000000001';
const MEMBER = 'uid_10000000-0000-4000-8000-000000000002';
const roots: string[] = [];
const studies = new Set<StudyStore>();
const collaborations = new Set<CollabServiceStore>();

afterEach(() => {
  for (const store of studies) store.close();
  for (const store of collaborations) store.close();
  studies.clear();
  collaborations.clear();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const providerOutcome = (overrides: Partial<ModelGenerateOutcome> = {}): ModelGenerateOutcome => ({
  dispatched: true,
  ok: true,
  message: 'mock provider completed',
  text: '从已审核陈述可以看出，函数在同一区间内随自变量变化。',
  totalTokens: 90,
  providerTokens: 90,
  requestedModel: 'fixture-model',
  returnedModel: 'fixture-model',
  elapsedMs: 10,
  ...overrides,
});

const mockProvider = () =>
  vi.fn<CollabAiModelDeps['connection']['generate']>(async () => providerOutcome());

function fixture(options: { noRun?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sew-collab-teaching-ai-model-'));
  roots.push(root);
  const projectId = 'collab-ai-project';
  const studyFile = join(root, 'study.sqlite');
  const collabFile = join(root, 'collab.sqlite');
  let store = StudyStore.open({ file: studyFile });
  studies.add(store);
  store.createProject({ projectId, displayName: '数学', subject: '数学' });
  store.bindLocalLearner(projectId, OWNER);

  const material = store.importMaterial({
    projectId,
    displayName: '课程来源',
    materialType: 'txt',
    readableLocation: 'D:/private/class-source.txt',
    rawText: '增函数在同一区间内，函数值随自变量增大。',
  }).material;
  const proposal = store.createProposal({
    projectId,
    name: '增函数',
    concept: '函数值随自变量增大',
    conditions: '同一区间',
    scopeStatus: 'in_syllabus',
    prerequisites: [],
    evidence: [
      { materialId: material.materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' },
    ],
    acceptance: '',
    priority: 'medium',
    proposedBy: 'user',
  });
  const knowledgeId = store.applyReview({
    proposalId: proposal.proposalId,
    decision: 'approved',
    expectedRevision: proposal.revision,
    semanticReviewed: true,
  }).knowledgePoint!.knowledgeId;
  store.savePlanVersion(projectId, 1, 'confirmed', {
    payloadVersion: 1,
    goal: '依据来源讲解增函数',
    examDate: null,
    dailyMinutes: 30,
    tasks: [
      {
        knowledgeId,
        name: '增函数',
        minutes: 30,
        acceptance: '',
        evidence: [{ materialId: material.materialId, segmentId: 'S001' }],
      },
    ],
    gaps: [],
    basis: '已审核来源',
    confirmedTaskKnowledgeIds: [knowledgeId],
  });
  if (!options.noRun) store.startPlanRun(projectId);
  const question = store.createQuestion({
    stem: '说明增函数的条件',
    answer: 'PRIVATE_ANSWER_should_not_enter_prompt',
    solution: 'PRIVATE_RUBRIC_should_not_enter_prompt',
    knowledgeIds: [knowledgeId],
    requestedOrigin: 'ai_new',
    originRecord: null,
    assessment: {
      schemaVersion: 1,
      type: 'single',
      options: [
        { value: 'A', label: '同区间递增' },
        { value: 'B', label: '始终递减' },
      ],
      correctAnswers: ['A'],
      rubric: '私有评分依据',
      maxScore: 2,
      answerVersion: 1,
    },
  }).question;
  const bundle = store.buildLessonBundle(
    projectId,
    [{ knowledgeId, text: '函数值随自变量增大', conditions: '同一区间' }],
    [question.questionId],
  );
  const lesson = store.createLessonDraft({
    projectId,
    lessonId: null,
    title: '增函数正式课堂',
    bundleId: bundle.bundleId,
    statementIds: bundle.bundle.statements.map((item) => item.statementId),
    questionIds: [question.questionId],
  });
  store.reviewLesson({
    projectId,
    lessonId: lesson.lessonId,
    version: 1,
    decision: 'approved',
    note: '核实来源',
  });
  store.publishLesson({ projectId, lessonId: lesson.lessonId, version: 1 });
  const formal = buildFormalLessonDocument({
    bundle: bundle.bundle,
    bundleDigest: bundle.digest,
    lessonId: lesson.lessonId,
    lessonVersion: 1,
    title: lesson.title,
    frozenAt: bundle.frozenAt,
    statementIds: lesson.statementIds,
    questionIds: lesson.questionIds,
  });
  const documentDigest = classroomDocumentDigest(formal.document);
  store.saveClassroomDocument({
    projectId,
    lessonId: lesson.lessonId,
    stageId: formal.stageId,
    dslVersion: formal.dslVersion,
    document: formal.document,
    digest: documentDigest,
    sceneCount: formal.document.scenes.length,
    scenes: formal.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      knowledgeIds: scene.knowledgeIds,
      questionId: scene.questionId,
    })),
    reviewedBy: 'local_user',
    reviewNote: '核对公共投影',
    recordScope: 'formal',
  });
  store.attachLessonDocument({
    projectId,
    lessonId: lesson.lessonId,
    version: 1,
    stageId: formal.stageId,
    documentDigest,
  });
  const localRoom = store.createLocalClassroomRoom(
    { projectId, lessonId: lesson.lessonId, lessonVersion: 1, requestId: 'local-room' },
    OWNER,
  ).room;
  const snapshot = store.readClassroomRoomSnapshot(projectId, localRoom.roomId, OWNER);

  const collab = CollabServiceStore.open({ file: collabFile });
  collaborations.add(collab);
  collab.collaboration.register({ uid: OWNER, displayName: '教师', requestId: 'register-owner' });
  collab.collaboration.register({ uid: MEMBER, displayName: '同学', requestId: 'register-member' });
  const roomId = 'collab-ai-room';
  collab.collaboration.createRoom({
    roomId,
    ownerUid: OWNER,
    lessonId: lesson.lessonId,
    lessonVersion: 1,
    snapshotDigest: snapshot.course.documentDigest,
    currentSceneId: snapshot.scenes[0]!.sceneId,
    requestId: 'create-collab-room',
  });
  const invitation = collab.collaboration.invite({
    roomId,
    inviterUid: OWNER,
    inviteeUid: MEMBER,
    lessonId: lesson.lessonId,
    lessonVersion: 1,
    snapshotDigest: snapshot.course.documentDigest,
    requestId: 'invite-member',
  }).invitation;
  collab.collaboration.decide({
    invitationId: invitation.invitationId,
    actorUid: MEMBER,
    decision: 'accepted',
    requestId: 'accept-member',
  });
  collab.collaboration.setReadiness({
    roomId,
    uid: OWNER,
    readiness: 'ready',
    requestId: 'owner-ready',
  });
  collab.collaboration.setReadiness({
    roomId,
    uid: MEMBER,
    readiness: 'ready',
    requestId: 'member-ready',
  });
  collab.collaboration.startRoom({ roomId, actorUid: OWNER, requestId: 'start-collab-room' });
  collab.collaboration.uploadSnapshot({
    roomId,
    actorUid: OWNER,
    snapshot,
    snapshotDigest: snapshot.course.documentDigest,
    requestId: 'upload-snapshot',
  });
  const anchorStatementId = snapshot.evidence.statements[0]!.statementId;
  const peer = store.createRoleProfile('peer', {
    name: '小林',
    persona: '认真讨论',
    explanation: 'concise',
  });

  let sequence = 0;
  const command = (
    overrides: Partial<CollabTeachingAiCommandInput> = {},
  ): CollabTeachingAiCommandInput => {
    const teaching = collab.collaboration.teachingView(roomId);
    return {
      roomId,
      actorUid: OWNER,
      sceneId: teaching.state.sceneId,
      expectedRevision: teaching.roomRevision,
      expectedSeq: teaching.tailSeq + 1,
      eventId: `model-event-${++sequence}`,
      requestId: `model-request-${sequence}`,
      operation: { kind: 'generate-teacher-explanation', anchorStatementId },
      ...overrides,
    };
  };
  const deps = (
    input: CollabTeachingAiCommandInput,
    overrides: Partial<CollabAiModelDeps> = {},
  ): CollabAiModelDeps => ({
    store,
    projectId,
    connection: {
      status: () => ({
        configured: true,
        persisted: false,
        lastTest: null,
        provider: 'openai-compatible',
        model: 'fixture-model',
      }),
      generate: mockProvider(),
    },
    readAuthority: async () => {
      const room = collab.collaboration.getRoom(roomId)!;
      const snapshotView = collab.collaboration.snapshotView(roomId);
      return {
        room,
        snapshot: snapshotView.snapshot!,
        view: collab.collaboration.teachingAiView(roomId, input.actorUid),
      };
    },
    recordCandidate: async (candidate) => collab.collaboration.recordTeachingAiCandidate(candidate),
    ...overrides,
  });
  const waitForMember = () => {
    const teaching = collab.collaboration.teachingView(roomId);
    collab.collaboration.applyTeaching({
      roomId,
      actorUid: OWNER,
      sceneId: teaching.state.sceneId,
      expectedRevision: teaching.roomRevision,
      expectedSeq: teaching.tailSeq + 1,
      eventId: `wait-event-${++sequence}`,
      requestId: `wait-request-${sequence}`,
      operation: { kind: 'wait', targetUid: MEMBER },
    });
  };
  const reopen = () => {
    store.close();
    studies.delete(store);
    store = StudyStore.open({ file: studyFile });
    studies.add(store);
    return store;
  };
  return {
    store,
    collab,
    projectId,
    roomId,
    snapshot,
    lesson,
    knowledgeId,
    anchorStatementId,
    peer,
    command,
    deps,
    waitForMember,
    reopen,
  };
}

describe('generated collaboration teaching AI uses the real project store and shared usage ledger', () => {
  it.each([
    'waiting',
    'non-owner',
    'unconfigured',
    'no-run',
    'invalid-role',
    'source-drift',
    'anchor-drift',
    'shared-budget',
  ] as const)(
    '%s rejects before provider dispatch and before recording a candidate',
    async (reason) => {
      const f = fixture({ noRun: reason === 'no-run' });
      const input = f.command(
        reason === 'non-owner'
          ? {
              actorUid: MEMBER,
              operation: {
                kind: 'generate-teacher-explanation',
                anchorStatementId: f.anchorStatementId,
              },
            }
          : reason === 'invalid-role'
            ? {
                operation: {
                  kind: 'generate-peer-utterance',
                  anchorStatementId: f.anchorStatementId,
                  roleProfileId: 'missing-role',
                  peerName: '不存在的同学',
                },
              }
            : {},
      );
      const provider = mockProvider();
      const recordCandidate = vi.fn(async (candidate: CollabTeachingAiCommandInput) =>
        f.collab.collaboration.recordTeachingAiCandidate(candidate),
      );
      let authoritySnapshot = f.snapshot;
      if (reason === 'source-drift')
        authoritySnapshot = {
          ...f.snapshot,
          course: { ...f.snapshot.course, documentDigest: 'a'.repeat(64) },
        };
      if (reason === 'anchor-drift')
        authoritySnapshot = {
          ...f.snapshot,
          evidence: {
            ...f.snapshot.evidence,
            statements: f.snapshot.evidence.statements.map((statement) =>
              statement.statementId === f.anchorStatementId
                ? { ...statement, text: '被替换的外部锚点正文' }
                : statement,
            ),
          },
        };
      const connectionStatus = () => ({
        configured: reason !== 'unconfigured',
        persisted: false,
        lastTest: null,
        provider: 'openai-compatible' as const,
        model: 'fixture-model',
      });
      const deps = f.deps(input, {
        connection: { status: connectionStatus, generate: provider },
        recordCandidate,
        readAuthority: async () => ({
          room: f.collab.collaboration.getRoom(f.roomId)!,
          snapshot: authoritySnapshot,
          view: f.collab.collaboration.teachingAiView(f.roomId, input.actorUid),
        }),
        ...(reason === 'shared-budget'
          ? { limits: { maxCalls: 1, maxTokens: 5000, maxWallClockMs: 60_000 } }
          : {}),
      });
      if (reason === 'waiting') f.waitForMember();
      if (reason === 'shared-budget') {
        const runId = f.store.getLatestRun()!.runId;
        f.store.startModelUsageCall(
          {
            projectId: f.projectId,
            runId,
            requestId: 'prior-budget-call',
            purpose: 'lesson_draft',
            intent: 'b'.repeat(64),
            reservedTokens: 1,
            sessionId: null,
            roundIndex: null,
            roleProfileId: null,
            peerTurnIndex: null,
            provider: 'openai-compatible',
            requestedModel: 'fixture-model',
          },
          { maxCalls: 1, maxTokens: 5000, maxWallClockMs: 60_000 },
        );
        f.store.settleModelUsageCall(f.projectId, 'prior-budget-call', {
          state: 'completed',
          accountedTokens: 1,
          providerTokens: 1,
          tokenMeasurement: 'actual',
          returnedModel: 'fixture-model',
          elapsedMs: 1,
          result: null,
        });
      }
      await expect(generateCollabTeachingAi(deps, input)).rejects.toBeInstanceOf(StudyError);
      expect(provider).not.toHaveBeenCalled();
      expect(recordCandidate).not.toHaveBeenCalled();
      expect(
        f.store
          .listModelUsageCalls(f.projectId)
          .filter((call) => call.requestId === input.requestId),
      ).toEqual([]);
    },
  );

  it('successful teacher generation records a pending candidate in the real collaboration store and never publishes it', async () => {
    const f = fixture();
    const input = f.command();
    const provider = mockProvider();
    const result = await generateCollabTeachingAi(
      f.deps(input, {
        connection: {
          status: () => ({
            configured: true,
            persisted: false,
            lastTest: null,
            provider: 'openai-compatible',
            model: 'fixture-model',
          }),
          generate: provider,
        },
      }),
      input,
    );
    expect(provider).toHaveBeenCalledTimes(1);
    const prompt = JSON.stringify(provider.mock.calls[0]?.[0]);
    expect(prompt).toContain('函数值随自变量增大');
    expect(prompt).not.toContain('PRIVATE_ANSWER_should_not_enter_prompt');
    expect(prompt).not.toContain('PRIVATE_RUBRIC_should_not_enter_prompt');
    expect(result.state.candidates).toHaveLength(1);
    expect(result.state.candidates[0]).toMatchObject({
      status: 'pending',
      origin: 'model_generated',
      senderType: 'teacher_ai',
      model: 'fixture-model',
    });
    expect(result.state.publicOutputs).toEqual([]);
    expect(f.collab.collaboration.teachingAiView(f.roomId, MEMBER).publicOutputs).toEqual([]);
    expect(f.store.modelCallUsage(f.store.getLatestRun()!.runId)).toMatchObject({
      calls: 1,
      tokens: 90,
    });

    const read = f.collab.collaboration.teachingView(f.roomId);
    const candidateId = result.state.candidates[0]!.candidateId;
    const reviewed = f.collab.collaboration.applyTeachingAi({
      roomId: f.roomId,
      actorUid: OWNER,
      sceneId: read.state.sceneId,
      expectedRevision: read.roomRevision,
      expectedSeq: read.tailSeq + 1,
      eventId: 'human-review-event',
      requestId: 'human-review-request',
      operation: {
        kind: 'review-ai-candidate',
        candidateId,
        decision: 'approved',
        note: '已核实来源',
        semanticReviewed: true,
      },
    });
    expect(reviewed.state.publicOutputs).toEqual([]);
    const afterReview = f.collab.collaboration.teachingView(f.roomId);
    f.collab.collaboration.applyTeachingAi({
      roomId: f.roomId,
      actorUid: OWNER,
      sceneId: afterReview.state.sceneId,
      expectedRevision: afterReview.roomRevision,
      expectedSeq: afterReview.tailSeq + 1,
      eventId: 'human-broadcast-event',
      requestId: 'human-broadcast-request',
      operation: { kind: 'broadcast-ai-candidate', candidateId },
    });
    const ownerAfter = f.collab.collaboration.teachingAiView(f.roomId, OWNER);
    const memberAfter = f.collab.collaboration.teachingAiView(f.roomId, MEMBER);
    expect(ownerAfter.state?.publicOutputs).toHaveLength(1);
    expect(ownerAfter.publicOutputs).toEqual(memberAfter.publicOutputs);
    expect(ownerAfter.publicOutputs[0]).toMatchObject({ aiLabel: 'AI', senderType: 'teacher_ai' });
  });

  it('retries a completed provider result after remote ACK loss with the same candidate receipt and only one provider call', async () => {
    const f = fixture();
    const input = f.command();
    const provider = mockProvider();
    let loseAck = true;
    const recordCandidate = vi.fn(async (candidate: CollabTeachingAiCommandInput) => {
      const result = f.collab.collaboration.recordTeachingAiCandidate(candidate);
      if (loseAck) {
        loseAck = false;
        throw new Error('remote_ack_lost_after_commit');
      }
      return result;
    });
    const deps = f.deps(input, {
      connection: {
        status: () => ({
          configured: true,
          persisted: false,
          lastTest: null,
          provider: 'openai-compatible',
          model: 'fixture-model',
        }),
        generate: provider,
      },
      recordCandidate,
    });
    await expect(generateCollabTeachingAi(deps, input)).rejects.toThrow(
      'remote_ack_lost_after_commit',
    );
    const retried = await generateCollabTeachingAi(deps, input);
    expect(retried.deduplicated).toBe(true);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(recordCandidate).toHaveBeenCalledTimes(2);
    expect(retried.state.candidates).toHaveLength(1);
    expect(retried.state.publicOutputs).toEqual([]);
  });

  it.each(['scope', 'request-abort'] as const)(
    'cancels a pending pretransaction candidate write on %s and later re-registers from the completed local ledger',
    async (cancelKind) => {
      const f = fixture();
      const input = f.command();
      const provider = mockProvider();
      let scopeValid = true;
      let firstRemoteWrite = true;
      let remoteStartedResolve: () => void = () => undefined;
      const remoteStarted = new Promise<void>((resolve) => {
        remoteStartedResolve = resolve;
      });
      const recordCandidate = vi.fn(
        async (candidate: CollabTeachingAiCommandInput, signal?: AbortSignal) => {
          if (firstRemoteWrite) {
            firstRemoteWrite = false;
            remoteStartedResolve();
            if (!signal) throw new Error('remote candidate request omitted its abort signal');
            await new Promise<void>((_resolve, reject) => {
              if (signal.aborted) {
                reject(new StudyError('RUN_TERMINATED', { reason: 'request_aborted' }));
                return;
              }
              signal.addEventListener(
                'abort',
                () => reject(new StudyError('RUN_TERMINATED', { reason: 'request_aborted' })),
                { once: true },
              );
            });
          }
          // The test models a remote handler that has not started its transaction until
          // after the cancellable request window; abort therefore means no remote commit.
          if (signal?.aborted) {
            throw new StudyError('RUN_TERMINATED', { reason: 'request_aborted' });
          }
          return f.collab.collaboration.recordTeachingAiCandidate(candidate);
        },
      );
      const deps = f.deps(input, {
        connection: {
          status: () => ({
            configured: true,
            persisted: false,
            lastTest: null,
            provider: 'openai-compatible',
            model: 'fixture-model',
          }),
          generate: provider,
        },
        recordCandidate,
        ...(cancelKind === 'scope'
          ? {
              revalidateScope: () => {
                if (!scopeValid) throw new StudyError('PROJECT_NOT_AUTHORIZED');
              },
            }
          : {}),
      });
      const controller = new AbortController();
      const pending = generateCollabTeachingAi(
        deps,
        input,
        cancelKind === 'request-abort' ? controller.signal : undefined,
      );
      await remoteStarted;
      if (cancelKind === 'scope') scopeValid = false;
      else controller.abort();
      await expect(pending).rejects.toBeInstanceOf(StudyError);

      expect(recordCandidate).toHaveBeenCalledTimes(1);
      expect(recordCandidate.mock.calls[0]?.[1]?.aborted).toBe(true);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(f.store.getModelUsageCall(f.projectId, input.requestId)).toMatchObject({
        state: 'completed',
        accountedTokens: 90,
        tokenMeasurement: 'actual',
      });
      expect(f.store.modelCallUsage(f.store.getLatestRun()!.runId)).toMatchObject({
        calls: 1,
        tokens: 90,
      });
      expect(f.collab.collaboration.teachingAiView(f.roomId, OWNER).state?.candidates).toEqual([]);

      scopeValid = true;
      const retried = await generateCollabTeachingAi(
        f.deps(input, {
          connection: deps.connection,
          recordCandidate,
        }),
        input,
      );
      expect(retried.state.candidates).toHaveLength(1);
      expect(retried.state.candidates[0]?.candidateId).toMatch(/^ai_/);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(recordCandidate).toHaveBeenCalledTimes(2);
      expect(f.store.modelCallUsage(f.store.getLatestRun()!.runId)).toMatchObject({
        calls: 1,
        tokens: 90,
      });
    },
  );

  it('generates a peer candidate only for the exact configured formal peer profile', async () => {
    const f = fixture();
    const input = f.command({
      operation: {
        kind: 'generate-peer-utterance',
        anchorStatementId: f.anchorStatementId,
        roleProfileId: f.peer.profileId,
        peerName: f.peer.name,
      },
    });
    const provider = mockProvider();
    const result = await generateCollabTeachingAi(
      f.deps(input, {
        connection: {
          status: () => ({
            configured: true,
            persisted: false,
            lastTest: null,
            provider: 'openai-compatible',
            model: 'fixture-model',
          }),
          generate: provider,
        },
      }),
      input,
    );
    expect(provider).toHaveBeenCalledTimes(1);
    expect(result.state.candidates[0]).toMatchObject({
      status: 'pending',
      senderType: 'peer_ai',
      roleProfileId: f.peer.profileId,
      peerName: f.peer.name,
    });
    expect(result.state.publicOutputs).toEqual([]);
  });

  it('rejects a changed intent that reuses a requestId without another provider dispatch', async () => {
    const f = fixture();
    const input = f.command();
    const provider = mockProvider();
    const deps = f.deps(input, {
      connection: {
        status: () => ({
          configured: true,
          persisted: false,
          lastTest: null,
          provider: 'openai-compatible',
          model: 'fixture-model',
        }),
        generate: provider,
      },
    });
    await generateCollabTeachingAi(deps, input);
    const changed = {
      ...input,
      operation: {
        kind: 'generate-teacher-explanation' as const,
        anchorStatementId: f.anchorStatementId,
        instruction: '改为输出另一种内容',
      },
    };
    await expect(generateCollabTeachingAi(deps, changed)).rejects.toMatchObject({
      details: { reason: 'model_nonce_reused' },
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('does not repeat a model call whose local ledger remains started/unknown after scope loss', async () => {
    const f = fixture();
    const input = f.command();
    let scopeValid = true;
    const provider = vi.fn(async () => {
      scopeValid = false;
      return providerOutcome();
    });
    const deps = f.deps(input, {
      connection: {
        status: () => ({
          configured: true,
          persisted: false,
          lastTest: null,
          provider: 'openai-compatible',
          model: 'fixture-model',
        }),
        generate: provider,
      },
      revalidateScope: () => {
        if (!scopeValid) throw new StudyError('PROJECT_NOT_AUTHORIZED');
      },
    });
    await expect(generateCollabTeachingAi(deps, input)).rejects.toMatchObject({
      code: 'PROJECT_NOT_AUTHORIZED',
    });
    expect(f.store.getModelUsageCall(f.projectId, input.requestId)).toMatchObject({
      state: 'started',
      result: null,
    });
    f.reopen();
    const retryDeps = f.deps(input, { connection: deps.connection });
    await expect(generateCollabTeachingAi(retryDeps, input)).rejects.toMatchObject({
      details: { reason: 'collab_ai_model_outcome_unknown' },
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(f.collab.collaboration.teachingAiView(f.roomId, OWNER).state?.candidates).toEqual([]);
  });

  it('keeps a dispatched provider failure at unknown usage and does not record a candidate', async () => {
    const f = fixture();
    const input = f.command();
    const provider = vi.fn(async () => {
      throw new Error('provider reply lost');
    });
    const recordCandidate = vi.fn(async (candidate: CollabTeachingAiCommandInput) =>
      f.collab.collaboration.recordTeachingAiCandidate(candidate),
    );
    const deps = f.deps(input, {
      connection: {
        status: () => ({
          configured: true,
          persisted: false,
          lastTest: null,
          provider: 'openai-compatible',
          model: 'fixture-model',
        }),
        generate: provider,
      },
      recordCandidate,
    });
    await expect(generateCollabTeachingAi(deps, input)).rejects.toMatchObject({
      details: { reason: 'collab_ai_generation_failed' },
    });
    expect(f.store.getModelUsageCall(f.projectId, input.requestId)).toMatchObject({
      state: 'failed',
      accountedTokens: null,
      tokenMeasurement: 'unknown',
    });
    expect(f.store.modelCallUsage(f.store.getLatestRun()!.runId).tokens).toBeGreaterThan(0);
    expect(recordCandidate).not.toHaveBeenCalled();
  });

  it('aborts without candidate registration and blocks late results after waiting or scene change', async () => {
    for (const changed of ['abort', 'waiting', 'scene'] as const) {
      const f = fixture();
      const input = f.command();
      const recordCandidate = vi.fn(async (candidate: CollabTeachingAiCommandInput) =>
        f.collab.collaboration.recordTeachingAiCandidate(candidate),
      );
      const controller = new AbortController();
      const provider = vi.fn(async () => {
        if (changed === 'abort') controller.abort();
        if (changed === 'waiting') f.waitForMember();
        if (changed === 'scene') {
          const teaching = f.collab.collaboration.teachingView(f.roomId);
          const sceneId = f.snapshot.scenes[1]!.sceneId;
          f.collab.collaboration.syncScene({
            roomId: f.roomId,
            actorUid: OWNER,
            sceneId,
            lessonId: f.lesson.lessonId,
            lessonVersion: 1,
            expectedRevision: teaching.roomRevision,
            expectedSeq: teaching.tailSeq + 1,
            eventId: `scene-${changed}`,
            requestId: `scene-request-${changed}`,
          });
        }
        return providerOutcome();
      });
      const deps = f.deps(input, {
        connection: {
          status: () => ({
            configured: true,
            persisted: false,
            lastTest: null,
            provider: 'openai-compatible',
            model: 'fixture-model',
          }),
          generate: provider,
        },
        recordCandidate,
      });
      await expect(generateCollabTeachingAi(deps, input, controller.signal)).rejects.toBeInstanceOf(
        StudyError,
      );
      expect(provider).toHaveBeenCalledTimes(1);
      expect(recordCandidate).not.toHaveBeenCalled();
      expect(f.collab.collaboration.teachingAiView(f.roomId, OWNER).state?.candidates).toEqual([]);
    }
  });

  it('the authority watchdog aborts a provider that is still running after the room enters waiting', async () => {
    const f = fixture();
    const input = f.command();
    const recordCandidate = vi.fn(async (candidate: CollabTeachingAiCommandInput) =>
      f.collab.collaboration.recordTeachingAiCandidate(candidate),
    );
    const provider = vi.fn<CollabAiModelDeps['connection']['generate']>(
      (_messages, options) =>
        new Promise((_resolve, reject) => {
          f.waitForMember();
          const signal = options?.signal;
          if (!signal) {
            reject(new Error('provider signal missing'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('watchdog aborted provider')), {
            once: true,
          });
        }),
    );
    const deps = f.deps(input, {
      connection: {
        status: () => ({
          configured: true,
          persisted: false,
          lastTest: null,
          provider: 'openai-compatible',
          model: 'fixture-model',
        }),
        generate: provider,
      },
      recordCandidate,
    });
    await expect(generateCollabTeachingAi(deps, input)).rejects.toBeInstanceOf(StudyError);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user' }),
      ]),
    );
    expect(recordCandidate).not.toHaveBeenCalled();
    expect(f.store.getModelUsageCall(f.projectId, input.requestId)).toMatchObject({
      state: 'failed',
      tokenMeasurement: 'unknown',
    });
  });
});
