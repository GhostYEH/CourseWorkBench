import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyError } from '@sew/study-contracts';
import {
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';
import { commandProSession } from '../apps/learning/lib/server/pro-session-service';
import { modelConnection } from '../apps/learning/lib/server/model-connection';

describe('Pro conversation with durable records and controlled provider receipts', () => {
  let root: string;
  let session: Session;
  let bundleId: string;
  let bundleDigest: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-pro-turn-'));
    session = openProjectFromDisk(root);
    const { store, projectId } = session;
    const material = store.importMaterial({
      projectId,
      displayName: '函数.md',
      materialType: 'md',
      rawText: '同一区间内增函数的函数值随自变量增大而增大。',
    });
    const proposal = store.createProposal({
      projectId,
      name: '增函数',
      concept: '同一区间内增函数的函数值随自变量增大而增大。',
      conditions: '同一区间',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [
        {
          materialId: material.material.materialId,
          revision: 1,
          segmentId: material.segments[0]!.segmentId,
          use: 'concept_basis',
        },
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
      goal: '学习增函数',
      examDate: null,
      dailyMinutes: 60,
      tasks: [
        {
          knowledgeId,
          name: '增函数',
          minutes: 30,
          acceptance: '',
          evidence: [
            {
              materialId: material.material.materialId,
              segmentId: material.segments[0]!.segmentId,
            },
          ],
        },
      ],
      gaps: [],
      basis: '测试',
      confirmedTaskKnowledgeIds: [knowledgeId],
    });
    store.startPlanRun(projectId);
    const bundle = store.buildLessonBundle(
      projectId,
      [{ knowledgeId, text: '增函数的定义', conditions: '同一区间' }],
      [],
    );
    bundleId = bundle.bundleId;
    bundleDigest = bundle.digest;
    vi.spyOn(modelConnection, 'status').mockReturnValue({
      configured: true,
      persisted: false,
      lastTest: null,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeProject();
    rmSync(root, { recursive: true, force: true });
  });
  const scope = () => ({ projectId: session.projectId, generation: session.generation });
  const response = (text: string) => ({
    dispatched: true,
    ok: true,
    message: 'fixture provider response',
    text,
    totalTokens: 31,
    providerTokens: 31,
    requestedModel: null,
    returnedModel: null,
    elapsedMs: 1,
  });
  const create = () =>
    commandProSession({
      scope: scope(),
      action: 'create',
      requestId: 'create-pro',
      title: '函数复习',
    });

  it('stores successful multi-turn messages and replays a lost response without a second dispatch or changing the lesson run', async () => {
    const provider = vi
      .spyOn(modelConnection, 'generate')
      .mockResolvedValue(response('{"kind":"message","content":"依据冻结材料解释增函数。"}'));
    const created = await create();
    const command = {
      scope: scope(),
      action: 'send' as const,
      requestId: 'turn-1',
      sessionId: created.detail!.sessionId,
      expectedRevision: 0,
      content: '解释定义',
      bundleId,
      bundleDigest,
      skillIds: [],
    };
    const first = await commandProSession(command);
    expect(first.detail!.messages.map((item) => item.role)).toEqual(['user', 'assistant']);
    expect(session.store.getLatestRun()!.state).toBe('plan_confirmed');
    expect(
      session.store
        .listRunEvents(session.store.getLatestRun()!.runId)
        .some((event) => event.payload.type === 'draft_delta'),
    ).toBe(false);
    expect((await commandProSession(command)).replayed).toBe(true);
    expect(provider).toHaveBeenCalledTimes(1);
    await expect(commandProSession({ ...command, content: '改变同一请求意图' })).rejects.toThrow(
      StudyError,
    );
    const second = await commandProSession({
      ...command,
      requestId: 'turn-2',
      content: '继续解释',
      expectedRevision: first.detail!.revision,
    });
    expect(second.detail!.messages).toHaveLength(4);
    expect(provider.mock.calls[1]![0].some((message) => message.content.includes('解释定义'))).toBe(
      true,
    );
    expect(session.store.modelCallUsage(session.store.getLatestRun()!.runId)).toMatchObject({
      calls: 2,
      tokens: 62,
    });
  });

  it('does not run a proposed tool until explicit approval and stores the actual result', async () => {
    const provider = vi
      .spyOn(modelConnection, 'generate')
      .mockResolvedValue(
        response(
          '{"kind":"tool_request","content":"可查看待核课件。","tool":"courses.candidate.list","arguments":{}}',
        ),
      );
    const created = await create();
    const sent = await commandProSession({
      scope: scope(),
      action: 'send',
      requestId: 'tool-propose',
      sessionId: created.detail!.sessionId,
      expectedRevision: 0,
      content: '查看候选',
      bundleId,
      bundleDigest,
      skillIds: [],
    });
    expect(sent.detail!.toolCalls[0]!.status).toBe('proposed');
    expect(sent.detail!.toolCalls[0]!.result).toBeNull();
    const done = await commandProSession({
      scope: scope(),
      action: 'execute-tool',
      requestId: 'tool-approve',
      sessionId: sent.detail!.sessionId,
      expectedRevision: sent.detail!.revision,
      toolCallId: sent.detail!.toolCalls[0]!.toolCallId,
    });
    expect(done.detail!.toolCalls[0]).toMatchObject({ status: 'completed', result: '[]' });
    expect(done.detail!.messages.at(-1)?.role).toBe('tool');
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('fences an ignored-abort late provider response after cancellation while settling the paid call', async () => {
    let release!: (value: ReturnType<typeof response>) => void;
    const provider = vi.spyOn(modelConnection, 'generate').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const created = await create();
    const id = created.detail!.sessionId;
    const pending = commandProSession({
      scope: scope(),
      action: 'send',
      requestId: 'cancel-turn',
      sessionId: id,
      expectedRevision: 0,
      content: '解释定义',
      bundleId,
      bundleDigest,
      skillIds: [],
    });
    const failure = pending.catch((error) => error);
    expect(provider).toHaveBeenCalledOnce();
    const running = session.store.proSessions.get(session.projectId, session.learnerUid, id)!;
    const cancelled = await commandProSession({
      scope: scope(),
      action: 'control',
      requestId: 'cancel-control',
      sessionId: id,
      expectedRevision: running.revision,
      command: 'cancel',
    });
    release(response('{"kind":"message","content":"迟到正文不得写入。"}'));
    expect(await failure).toBeInstanceOf(StudyError);
    const latest = session.store.proSessions.get(session.projectId, session.learnerUid, id)!;
    expect(latest.messages).toHaveLength(1);
    expect(latest.revision).toBe(cancelled.detail!.revision);
    expect(session.store.modelCallUsage(session.store.getLatestRun()!.runId)).toMatchObject({
      calls: 1,
      tokens: 31,
    });
  });
});
