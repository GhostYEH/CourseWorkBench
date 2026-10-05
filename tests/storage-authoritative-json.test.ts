import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyError, newId } from '@sew/study-contracts';
import { buildWorkbenchState } from '../apps/learning/lib/server/state';
import {
  StudyStore,
  createNodeSqliteDriver,
  ensureProjectLayout,
  projectPaths,
} from '@sew/study-storage';

/**
 * F3：`questions.knowledge_ids_json` 是准入判断的输入。损坏时必须可诊断地失败
 * （StudyError('INTERNAL')），不能静默降级为 `[]` 让 checkAdmission 放行。
 */

const MATERIAL = [
  '# 函数性质',
  '',
  '函数 f 在区间 D 上单调递增，当 x1 < x2 时 f(x1) < f(x2)。',
  '',
  '证明时可以取值、作差、变形、定号并下结论。',
].join('\n');

describe('权威 JSON 列：knowledge_ids_json 损坏即拒绝', () => {
  let root: string;
  let store: StudyStore;
  let questionId: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-auth-json-'));
    ensureProjectLayout(root);
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    const projectId = newId<'project'>('proj');
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
      evidence: [
        { materialId: material.materialId, revision: 1, segmentId: 'S002', use: 'concept_basis' },
      ],
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

  const corruptKnowledgeIds = (): void => {
    const dbFile = projectPaths(root).databaseFile;
    store.close();
    const raw = createNodeSqliteDriver().open(dbFile);
    raw
      .prepare('UPDATE questions SET knowledge_ids_json = ? WHERE question_id = ?')
      .run('["kp_1",', questionId);
    raw.close();
    store = StudyStore.open({ file: dbFile });
  };

  it('读取损坏的 knowledge_ids_json 抛 INTERNAL 且带 context', () => {
    corruptKnowledgeIds();
    try {
      store.getQuestion(questionId);
      throw new Error('应当抛出 INTERNAL');
    } catch (error) {
      expect(error).toBeInstanceOf(StudyError);
      expect((error as StudyError).code).toBe('INTERNAL');
      expect(String((error as StudyError).details?.context)).toContain('knowledge_ids_json');
    }
  });

  it('提交作答时损坏列使准入不可用，而不是静默通过', () => {
    corruptKnowledgeIds();
    try {
      store.submitAttempt({
        projectId: 'proj_unused',
        questionId,
        idempotencyKey: 'corrupt-key',
        actorType: 'human_learner',
        answerText: '递增',
        processText: '按定义',
        kind: 'real',
      });
      throw new Error('应当抛出 INTERNAL');
    } catch (error) {
      expect(error).toBeInstanceOf(StudyError);
      expect((error as StudyError).code).toBe('INTERNAL');
    }
    expect(store.countRows('attempts')).toBe(0);
  });

  it('工作台统计仍拒绝损坏的题目权威列', () => {
    corruptKnowledgeIds();
    expect(() =>
      buildWorkbenchState({
        store,
        projectId: 'statistics',
        displayName: '测试',
        displayPath: root,
        generation: 1,
        openedAt: new Date(0).toISOString(),
        learnerUid: 'uid_10000000-0000-4000-8000-000000000001',
        formatVersion: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INTERNAL' }));
  });
});
