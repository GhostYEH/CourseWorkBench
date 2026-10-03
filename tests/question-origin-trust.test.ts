import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyError, newId } from '@sew/study-contracts';
import { StudyStore, ensureProjectLayout, projectPaths } from '@sew/study-storage';

/**
 * 真题身份必须由服务端权威记录派生，请求方不能自报。
 * 只有经 `verifyMaterialAsExam` 核实的材料版本才授予 exam_original。
 */

const MATERIAL = [
  '# 真题材料',
  '',
  '设函数 f(x) 在区间 D 上单调递增，当 x1 < x2 时 f(x1) < f(x2)。',
  '',
  '判断时取值、作差、变形、定号并下结论。',
].join('\n');

describe('真题来源权威表', () => {
  let root: string;
  let store: StudyStore;
  let projectId: string;
  let materialId: string;
  let knowledgeId: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-origin-'));
    ensureProjectLayout(root);
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    projectId = newId<'project'>('proj');
    store.createProject({ projectId, displayName: '数学' });
    const { material } = store.importMaterial({
      projectId,
      displayName: '真题.md',
      materialType: 'md',
      rawText: MATERIAL,
    });
    materialId = material.materialId;
    const proposal = store.createProposal({
      projectId,
      name: '单调递增',
      concept: 'x1 < x2 时 f(x1) < f(x2)',
      conditions: '',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [{ materialId, revision: 1, segmentId: 'S002', use: 'concept_basis' }],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'ai',
    });
    knowledgeId = store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
    }).knowledgePoint!.knowledgeId;
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  const originRecord = () => ({
    materialId,
    revision: 1,
    questionNumber: '12',
    rewrittenFrom: null,
    rewriteNote: '',
  });

  const askExamOriginal = () =>
    store.createQuestion({
      stem: '判断 f 的单调性',
      answer: '递增',
      solution: '按定义',
      knowledgeIds: [knowledgeId],
      requestedOrigin: 'exam_original',
      originRecord: originRecord(),
    });

  it('未核实材料不能授予真题身份，核实后才可以', () => {
    expect(store.isMaterialVerifiedAsExam(materialId, 1)).toBe(false);

    const untrusted = askExamOriginal();
    expect(untrusted.question.origin).toBe('material_original');
    expect(untrusted.downgraded).toBe(true);
    expect(untrusted.forgedExamClaim).toBe(true);

    const verified = store.verifyMaterialAsExam({ materialId, revision: 1, note: '人工比对真题卷' });
    expect(verified.materialId).toBe(materialId);
    expect(verified.revision).toBe(1);
    expect(store.isMaterialVerifiedAsExam(materialId, 1)).toBe(true);

    const trusted = askExamOriginal();
    expect(trusted.question.origin).toBe('exam_original');
    expect(trusted.downgraded).toBe(false);
    expect(trusted.forgedExamClaim).toBe(false);
  });

  it('核实未登记的 (materialId, revision) 抛 NOT_FOUND', () => {
    try {
      store.verifyMaterialAsExam({ materialId, revision: 99 });
      throw new Error('应当抛出 NOT_FOUND');
    } catch (error) {
      expect(error).toBeInstanceOf(StudyError);
      expect((error as StudyError).code).toBe('NOT_FOUND');
    }
    expect(store.isMaterialVerifiedAsExam(materialId, 99)).toBe(false);
  });

  it('重复核实幂等，不产生重复行', () => {
    store.verifyMaterialAsExam({ materialId, revision: 1, note: '第一次' });
    store.verifyMaterialAsExam({ materialId, revision: 1, note: '第二次' });
    expect(store.countRows('questions')).toBe(0);
    expect(store.isMaterialVerifiedAsExam(materialId, 1)).toBe(true);
    expect(askExamOriginal().question.origin).toBe('exam_original');
  });

  it('未登记的 (materialId, revision) 不能授予材料原题 / 材料改写身份', () => {
    const forgedOriginal = store.createQuestion({
      stem: '伪造材料原题',
      answer: 'A',
      solution: '按材料',
      knowledgeIds: [knowledgeId],
      requestedOrigin: 'material_original',
      originRecord: {
        materialId: 'mat_fake',
        revision: 999,
        questionNumber: '12',
        rewrittenFrom: null,
        rewriteNote: '',
      },
    });
    expect(forgedOriginal.question.origin).toBe('ai_new');
    expect(forgedOriginal.downgraded).toBe(true);

    const forgedRewrite = store.createQuestion({
      stem: '伪造材料改写',
      answer: 'A',
      solution: '按材料',
      knowledgeIds: [knowledgeId],
      requestedOrigin: 'material_rewrite',
      originRecord: {
        materialId: 'mat_fake',
        revision: 999,
        questionNumber: '12',
        rewrittenFrom: 'S001',
        rewriteNote: '换数',
      },
    });
    expect(forgedRewrite.question.origin).toBe('ai_new');
    expect(forgedRewrite.downgraded).toBe(true);
  });

  it('登记后的材料版本可合法授予材料原题身份', () => {
    const granted = store.createQuestion({
      stem: '材料原题',
      answer: 'A',
      solution: '按材料',
      knowledgeIds: [knowledgeId],
      requestedOrigin: 'material_original',
      originRecord: originRecord(),
    });
    expect(granted.question.origin).toBe('material_original');
    expect(granted.downgraded).toBe(false);
    expect(granted.forgedExamClaim).toBe(false);
  });

  it('伪装真题标记与请求身份落库，供评测区分', () => {
    const forged = askExamOriginal();
    expect(forged.question.forgedExamClaim).toBe(true);
    expect(forged.question.requestedOrigin).toBe('exam_original');

    const legit = store.createQuestion({
      stem: '合法新编题',
      answer: 'A',
      solution: '自编',
      knowledgeIds: [knowledgeId],
      requestedOrigin: 'ai_new',
      originRecord: null,
    });
    expect(legit.question.forgedExamClaim).toBe(false);
    expect(legit.question.requestedOrigin).toBe('ai_new');

    const reloaded = store.listQuestions().find((q) => q.questionId === forged.question.questionId);
    expect(reloaded?.forgedExamClaim).toBe(true);
    expect(reloaded?.requestedOrigin).toBe('exam_original');
  });
});
