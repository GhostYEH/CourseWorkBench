import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyError, newId } from '@sew/study-contracts';
import {
  StudyStore,
  createNodeSqliteDriver,
  ensureProjectLayout,
  projectPaths,
} from '@sew/study-storage';

/**
 * F2：作答分区读取必须 fail-closed——DB 列被改写后，只有严格 'real' 才是真实作答。
 * F8：幂等命中必须比对请求声明的 kind，拒绝「同键、不同声明」的重试。
 */

const MATERIAL = [
  '# 函数性质',
  '',
  '函数 f 在区间 D 上单调递增，当 x1 < x2 时 f(x1) < f(x2)。',
  '',
  '证明时可以取值、作差、变形、定号并下结论。',
].join('\n');

describe('作答分区与幂等 kind', () => {
  let root: string;
  let store: StudyStore;
  let projectId: string;
  let questionId: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-attempt-kind-'));
    ensureProjectLayout(root);
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    projectId = newId<'project'>('proj');
    store.createProject({ projectId, displayName: '数学' });
    const { material } = store.importMaterial({
      projectId,
      displayName: '函数.md',
      materialType: 'md',
      rawText: MATERIAL,
    });
    const proposal = store.createProposal({
      projectId,
      name: '单调递增',
      concept: 'x1 < x2 时 f(x1) < f(x2)',
      conditions: '',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [{ materialId: material.materialId, revision: 1, segmentId: 'S002', use: 'concept_basis' }],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'ai',
    });
    const knowledgeId = store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
    }).knowledgePoint!.knowledgeId;
    questionId = store.createQuestion({
      stem: '判断 f 的单调性',
      answer: '递增',
      solution: '按定义',
      knowledgeIds: [knowledgeId],
      requestedOrigin: 'ai_new',
      originRecord: null,
    }).question.questionId;
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  const attempt = (over: Partial<Parameters<StudyStore['submitAttempt']>[0]>) => ({
    projectId,
    questionId,
    idempotencyKey: 'k-default',
    actorType: 'human_learner' as const,
    answerText: '递增',
    processText: '按定义',
    kind: 'real' as const,
    ...over,
  });

  it('被改写的 kind 视为 simulation（fail-closed），不再当成本人真实作答', () => {
    store.submitAttempt(attempt({ idempotencyKey: 'k-tamper' }));

    store.close();
    const raw = createNodeSqliteDriver().open(projectPaths(root).databaseFile);
    raw.prepare('UPDATE attempts SET kind = ? WHERE idempotency_key = ?').run('weird', 'k-tamper');
    raw.close();
    store = StudyStore.open({ file: projectPaths(root).databaseFile });

    const rows = store.listAttempts();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('simulation');
    expect(store.listAttempts('real')).toHaveLength(0);
    expect(store.countAttemptKinds()).toEqual({ real: 0, simulation: 0 });
  });

  it('非 human 主体的强制模拟重试：同声明幂等，不同声明冲突', () => {
    const peer = attempt({ idempotencyKey: 'k-peer', actorType: 'peer_ai', kind: 'real' });
    const first = store.submitAttempt(peer);
    expect(first.attempt.kind).toBe('simulation');
    expect(first.attempt.requestedKind).toBe('real');
    expect(first.forcedSimulation).toBe(true);

    const same = store.submitAttempt({ ...peer });
    expect(same.deduplicated).toBe(true);
    expect(same.attempt.attemptId).toBe(first.attempt.attemptId);

    expect(() => store.submitAttempt({ ...peer, kind: 'simulation' })).toThrowError(
      expect.objectContaining<Partial<StudyError>>({ code: 'VERSION_CONFLICT' }),
    );
    expect(store.listAttempts('simulation')).toHaveLength(1);
    expect(store.countAttemptKinds()).toEqual({ real: 0, simulation: 1 });
  });

  it('human 主体重试声明不同 kind 冲突', () => {
    store.submitAttempt(attempt({ idempotencyKey: 'k-human', kind: 'real' }));
    expect(store.countAttemptKinds()).toEqual({ real: 1, simulation: 0 });
    expect(() => store.submitAttempt(attempt({ idempotencyKey: 'k-human', kind: 'simulation' }))).toThrowError(
      expect.objectContaining<Partial<StudyError>>({ code: 'VERSION_CONFLICT' }),
    );
  });
});
