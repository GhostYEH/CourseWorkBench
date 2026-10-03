import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyError, newId } from '@sew/study-contracts';
import { StudyStore, ensureProjectLayout, projectPaths } from '@sew/study-storage';
import {
  clearAttemptIdempotencyKey,
  getAttemptIdempotencyKey,
  type AttemptSubmissionStorage,
} from '../apps/learning/lib/attempt-submission';

const MATERIAL = [
  '# 函数性质',
  '',
  '函数 f 在区间 D 上单调递增，当 x1 < x2 时 f(x1) < f(x2)。',
  '',
  '证明时可以取值、作差、变形、定号并下结论。',
].join('\n');

describe('SQLite 作答完整性', () => {
  let root: string;
  let store: StudyStore;
  let projectId: string;
  let questionId: string;
  let secondQuestionId: string;
  let knowledgeId: string;
  let base: {
    projectId: string;
    questionId: string;
    actorType: 'human_learner' | 'teacher_ai' | 'peer_ai' | 'system';
    answerText: string;
    processText: string;
    kind: 'real' | 'simulation';
    idempotencyKey: string;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-attempt-'));
    ensureProjectLayout(root);
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    projectId = newId<'project'>('proj');
    store.createProject({ projectId, displayName: '数学' });
    const { material } = store.importMaterial({ projectId, displayName: '函数.md', materialType: 'md', rawText: MATERIAL });
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
      proposedBy: 'user',
    });
    knowledgeId = store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
    }).knowledgePoint!.knowledgeId;
    questionId = store.createQuestion({
      stem: '判断 f 的单调性',
      answer: '递增',
      solution: '比较函数值',
      knowledgeIds: [knowledgeId],
      requestedOrigin: 'ai_new',
      originRecord: null,
    }).question.questionId;
    secondQuestionId = store.createQuestion({
      stem: '说明单调递增的条件',
      answer: '递增',
      solution: '按定义判断',
      knowledgeIds: [knowledgeId],
      requestedOrigin: 'ai_new',
      originRecord: null,
    }).question.questionId;
    base = {
      projectId,
      questionId,
      actorType: 'human_learner',
      answerText: '递增',
      processText: '按定义比较',
      kind: 'real',
      idempotencyKey: 'integrity-test-key',
    };
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('同一语义可重复读取收据；不同语义复用键发生冲突', () => {
    const first = store.submitAttempt(base);
    const retry = store.submitAttempt({ ...base });
    expect(first.deduplicated).toBe(false);
    expect(retry.deduplicated).toBe(true);
    expect(retry.attempt.attemptId).toBe(first.attempt.attemptId);
    expect(() => store.submitAttempt({ ...base, answerText: '下降' })).toThrowError(
      expect.objectContaining<Partial<StudyError>>({ code: 'VERSION_CONFLICT' }),
    );
    expect(() => store.submitAttempt({ ...base, questionId: secondQuestionId })).toThrowError(
      expect.objectContaining<Partial<StudyError>>({ code: 'VERSION_CONFLICT' }),
    );
    expect(() => store.submitAttempt({ ...base, actorType: 'peer_ai' })).toThrowError(
      expect.objectContaining<Partial<StudyError>>({ code: 'VERSION_CONFLICT' }),
    );
  });

  it('同长度不同答案使用不同稳定键并独立落库', async () => {
    const values = new Map<string, string>();
    const storage: AttemptSubmissionStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
    const context = {
      lessonId: 'lesson-1', projectId, generation: 1, questionId, actorType: 'human_learner', kind: 'real',
      processText: '按定义比较',
    };
    const submissionA = { ...context, answerText: '递增' };
    const keyA = await getAttemptIdempotencyKey(submissionA, storage);
    // 重载模块以清空页内 Map，确保恢复来自 sessionStorage 而不是同一份内存。
    vi.resetModules();
    const reloadedHelper = await import('../apps/learning/lib/attempt-submission');
    const keyAAfterReload = await reloadedHelper.getAttemptIdempotencyKey(submissionA, storage);
    expect(keyA).toBe(keyAAfterReload);
    const first = store.submitAttempt({ ...base, idempotencyKey: keyA });
    expect(first.deduplicated).toBe(false);
    await clearAttemptIdempotencyKey(submissionA, keyA, storage);
    const redoKey = await getAttemptIdempotencyKey(submissionA, storage);
    expect(redoKey).not.toBe(keyA);
    const redo = store.submitAttempt({ ...base, idempotencyKey: redoKey });
    expect(redo.deduplicated).toBe(false);
    const submissionB = { ...context, answerText: '下降' };
    const keyB = await getAttemptIdempotencyKey(submissionB, storage);
    expect(keyB).not.toBe(keyA);
    const second = store.submitAttempt({ ...base, answerText: '下降', idempotencyKey: keyB });
    expect(second.deduplicated).toBe(false);
    expect(store.listAttempts('real')).toHaveLength(3);
  });

  it('sessionStorage 读写失败时在本页内存中稳定重用键', async () => {
    const unavailableStorage: AttemptSubmissionStorage = {
      getItem: () => { throw new Error('storage read blocked'); },
      setItem: () => { throw new Error('storage write blocked'); },
      removeItem: () => { throw new Error('storage remove blocked'); },
    };
    const submission = {
      lessonId: 'lesson-storage-fallback',
      projectId,
      generation: 1,
      questionId,
      actorType: 'human_learner',
      kind: 'real',
      answerText: '递增',
      processText: '按定义比较',
    };
    const firstKey = await getAttemptIdempotencyKey(submission, unavailableStorage);
    const retryKey = await getAttemptIdempotencyKey(submission, unavailableStorage);
    expect(retryKey).toBe(firstKey);
    expect(store.submitAttempt({ ...base, idempotencyKey: firstKey }).deduplicated).toBe(false);
    expect(store.submitAttempt({ ...base, idempotencyKey: retryKey }).deduplicated).toBe(true);

    await clearAttemptIdempotencyKey(submission, firstKey, unavailableStorage);
    const nextSubmissionKey = await getAttemptIdempotencyKey(submission, unavailableStorage);
    expect(nextSubmissionKey).not.toBe(firstKey);
  });

  it('模拟角色隔离且同一强制模拟重试保留 forcedSimulation 结果', () => {
    const peerInput = { ...base, actorType: 'peer_ai' as const };
    const first = store.submitAttempt(peerInput);
    const retry = store.submitAttempt({ ...peerInput });
    expect(first.attempt.kind).toBe('simulation');
    expect(first.forcedSimulation).toBe(true);
    expect(retry.deduplicated).toBe(true);
    expect(retry.forcedSimulation).toBe(true);
    expect(store.listAttempts('real')).toHaveLength(0);
    expect(store.listAttempts('simulation')).toHaveLength(1);
  });

  it('材料更新阻止新作答，但旧收据重试仍可无副作用读取', () => {
    const receipt = store.submitAttempt(base);
    store.importMaterial({
      projectId,
      displayName: '函数.md',
      materialType: 'md',
      rawText: MATERIAL.replace('单调递增', '单调递减'),
    });
    expect(() => store.submitAttempt({ ...base, idempotencyKey: 'new-after-material-change' })).toThrowError(
      expect.objectContaining<Partial<StudyError>>({ code: 'KNOWLEDGE_NOT_VERIFIED' }),
    );
    const retry = store.submitAttempt(base);
    expect(retry.deduplicated).toBe(true);
    expect(retry.attempt.attemptId).toBe(receipt.attempt.attemptId);
    expect(store.listAttempts('real')).toHaveLength(1);
    expect(store.getKnowledge(knowledgeId)?.masteryStatus).toBe('passed');
  });
});
