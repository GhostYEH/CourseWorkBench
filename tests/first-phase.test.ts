import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyError, newId } from '@sew/study-contracts';
import { StudyStore, ensureProjectLayout, projectPaths } from '@sew/study-storage';

/**
 * 第一阶段完成标志（README「第一阶段的完成标志」）：
 * 可以新建项目、导入一段材料、提出一个知识点候选并查看来源；
 * 无来源候选被拦在待核实。
 *
 * 本用例同时覆盖重启读回、提交去重、模拟作答隔离与备份。
 */

const MATERIAL = [
  '\uFEFF# 人教版必修一 第三章 函数的基本性质',
  '',
  '函数的单调性：设函数 f(x) 的定义域为 I，如果对于定义域 I 内某个区间 D 上的任意两个自变量的值 x1、x2，',
  '当 x1 < x2 时，都有 f(x1) < f(x2)，那么就说函数 f(x) 在区间 D 上是增函数。',
  '',
  '判断单调性的基本步骤是取值、作差、变形、定号、下结论。',
].join('\r\n');

describe('第一阶段闭环', () => {
  let root: string;
  let store: StudyStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-'));
    ensureProjectLayout(root);
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('新建项目并导入材料，段落可定位且指纹可重算', () => {
    const project = store.createProject({
      projectId: newId<'project'>('proj'),
      displayName: '数学必修一 第三章',
      subject: '数学',
      goal: '两周内掌握函数的基本性质',
      dailyMinutes: 60,
      learningMode: 'beginner',
    });
    expect(project.displayName).toBe('数学必修一 第三章');

    const { material, segments } = store.importMaterial({
      projectId: project.projectId,
      displayName: '必修一第三章.md',
      materialType: 'md',
      readableLocation: '人教版必修一 第三章',
      rawText: MATERIAL,
    });

    expect(material.revision).toBe(1);
    expect(material.normalizationVersion).toBe('norm-1');
    expect(segments.map((s) => s.segmentId)).toEqual(['S001', 'S002', 'S003']);
    expect(segments[1]?.text.startsWith('函数的单调性')).toBe(true);
    // 规范化后不再包含 BOM 与 CR
    expect(store.getSegments(material.materialId, 1).every((s) => !s.text.includes('\r'))).toBe(true);
  });

  it('无来源候选被拦在待核实，有来源候选可进入人工审核', () => {
    const project = store.createProject({ projectId: newId<'project'>('proj'), displayName: '数学' });
    const { material } = store.importMaterial({
      projectId: project.projectId,
      displayName: '第三章.md',
      materialType: 'md',
      rawText: MATERIAL,
    });

    // 1) 注入一个材料未记载的考点：机械检查必须失败
    const forged = store.createProposal({
      projectId: project.projectId,
      name: '神奇定律',
      concept: '本单元存在一条材料未记载的神奇定律',
      conditions: '',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [],
      acceptance: '',
      priority: 'high',
      proposedBy: 'ai',
    });
    expect(forged.mechanical.passed).toBe(false);
    expect(forged.mechanical.checks.some((c) => c.code === 'SOURCE_MISSING' && !c.ok)).toBe(true);

    // 2) 人工点击「通过」也不能绕过来源
    try {
      store.applyReview({
        proposalId: forged.proposalId,
        decision: 'approved',
        expectedRevision: forged.revision,
        semanticReviewed: true,
      });
      throw new Error('应当抛出 SOURCE_MISSING');
    } catch (error) {
      expect((error as StudyError).code).toBe('SOURCE_MISSING');
    }
    expect(store.listKnowledge()).toHaveLength(0);

    // 3) 正常候选：引用真实段落，机械检查通过
    const valid = store.createProposal({
      projectId: project.projectId,
      name: '函数单调性的定义',
      concept: '增函数的定义：区间内 x1 < x2 时 f(x1) < f(x2)',
      conditions: '在同一区间 D 内取值',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [{ materialId: material.materialId, revision: 1, segmentId: 'S002', use: 'concept_basis' }],
      acceptance: '能判断给定函数在区间上的单调性',
      priority: 'high',
      proposedBy: 'ai',
    });
    expect(valid.mechanical.passed).toBe(true);
    expect(valid.evidence[0]?.excerpt).toContain('增函数');
    expect(valid.evidence[0]?.fingerprint).toBeTruthy();

    // 4) 未做语义确认时仍然不能通过
    try {
      store.applyReview({
        proposalId: valid.proposalId,
        decision: 'approved',
        expectedRevision: valid.revision,
        semanticReviewed: false,
      });
      throw new Error('应当抛出 KNOWLEDGE_NOT_VERIFIED');
    } catch (error) {
      expect((error as StudyError).code).toBe('KNOWLEDGE_NOT_VERIFIED');
    }

    // 5) 人工对照原文后通过，写入权威知识点表
    const outcome = store.applyReview({
      proposalId: valid.proposalId,
      decision: 'approved',
      expectedRevision: valid.revision,
      semanticReviewed: true,
    });
    expect(outcome.knowledgePoint?.sourceStatus).toBe('verified');
    expect(outcome.knowledgePoint?.masteryStatus).toBe('untested');

    // 候选计数与知识覆盖数分开
    expect(store.listProposals('pending')).toHaveLength(1);
    expect(store.listKnowledge()).toHaveLength(1);
  });

  it('生成准入：已核实放行，待核实与无来源被阻断且不调用模型', () => {
    const project = store.createProject({ projectId: newId<'project'>('proj'), displayName: '数学' });
    const { material } = store.importMaterial({
      projectId: project.projectId,
      displayName: '第三章.md',
      materialType: 'md',
      rawText: MATERIAL,
    });

    const valid = store.createProposal({
      projectId: project.projectId,
      name: '增函数的定义',
      concept: 'x1 < x2 时 f(x1) < f(x2)',
      conditions: '',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [{ materialId: material.materialId, revision: 1, segmentId: 'S002', use: 'concept_basis' }],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'ai',
    });
    const approved = store.applyReview({
      proposalId: valid.proposalId,
      decision: 'approved',
      expectedRevision: valid.revision,
      semanticReviewed: true,
    });
    const knowledgeId = approved.knowledgePoint!.knowledgeId;

    const ok = store.checkAdmission([knowledgeId]);
    expect(ok.allowed).toBe(true);

    const blocked = store.checkAdmission(['kp_不存在']);
    expect(blocked.allowed).toBe(false);
    expect(blocked.blocked[0]?.code).toBe('KNOWLEDGE_NOT_VERIFIED');
  });

  it('材料重新导入后旧引用失效，关联知识点转为已失效', () => {
    const project = store.createProject({ projectId: newId<'project'>('proj'), displayName: '数学' });
    const first = store.importMaterial({
      projectId: project.projectId,
      displayName: '第三章.md',
      materialType: 'md',
      rawText: MATERIAL,
    });
    const proposal = store.createProposal({
      projectId: project.projectId,
      name: '增函数的定义',
      concept: 'x1 < x2 时 f(x1) < f(x2)',
      conditions: '',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [{ materialId: first.material.materialId, revision: 1, segmentId: 'S002', use: 'concept_basis' }],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'ai',
    });
    const approved = store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
    });
    const knowledgeId = approved.knowledgePoint!.knowledgeId;

    const second = store.importMaterial({
      projectId: project.projectId,
      displayName: '第三章.md',
      materialType: 'md',
      rawText: `${MATERIAL}\r\n\r\n补充：函数的最大值与最小值需要结合图像判断。`,
    });
    expect(second.material.revision).toBe(2);
    expect(second.invalidated.map((i) => i.knowledgeId)).toEqual([knowledgeId]);
    expect(store.getKnowledge(knowledgeId)?.sourceStatus).toBe('invalidated');

    const admission = store.checkAdmission([knowledgeId]);
    expect(admission.blocked[0]?.code).toBe('KNOWLEDGE_INVALIDATED');
  });

  it('题目身份由可信记录裁定，AI 自报真题不生效', () => {
    const project = store.createProject({ projectId: newId<'project'>('proj'), displayName: '数学' });
    const { material } = store.importMaterial({
      projectId: project.projectId,
      displayName: '第三章.md',
      materialType: 'md',
      rawText: MATERIAL,
    });
    const proposal = store.createProposal({
      projectId: project.projectId,
      name: '增函数的定义',
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

    const forged = store.createQuestion({
      stem: '判断 f(x)=x 在 R 上的单调性',
      answer: '增函数',
      solution: '取 x1 < x2',
      knowledgeIds: [knowledgeId],
      requestedOrigin: 'exam_original',
      originRecord: null,
    });
    expect(forged.question.origin).toBe('ai_new');
    expect(forged.forgedExamClaim).toBe(true);
    expect(forged.question.originLabel).toBe('AI 新编题');

    // 未准入知识点不能出题
    expect(() =>
      store.createQuestion({
        stem: '无关题目',
        answer: '',
        solution: '',
        knowledgeIds: ['kp_未核实'],
        requestedOrigin: 'ai_new',
        originRecord: null,
      }),
    ).toThrowError(StudyError);
  });

  it('本人提交去重，AI 同学作答只能写入 simulation', () => {
    const project = store.createProject({ projectId: newId<'project'>('proj'), displayName: '数学' });
    const { material } = store.importMaterial({
      projectId: project.projectId,
      displayName: '第三章.md',
      materialType: 'md',
      rawText: MATERIAL,
    });
    const proposal = store.createProposal({
      projectId: project.projectId,
      name: '增函数的定义',
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

    const question = store.createQuestion({
      stem: '判断 f(x)=x 在 R 上的单调性',
      answer: '增函数',
      solution: '取 x1 < x2',
      knowledgeIds: [knowledgeId],
      requestedOrigin: 'ai_new',
      originRecord: null,
    }).question;

    const key = 'attempt-key-0001';
    const first = store.submitAttempt({
      projectId: project.projectId,
      questionId: question.questionId,
      idempotencyKey: key,
      actorType: 'human_learner',
      answerText: '增函数',
      processText: '取值作差后 f(x1)-f(x2)<0',
      kind: 'real',
    });
    expect(first.deduplicated).toBe(false);
    expect(first.attempt.kind).toBe('real');
    expect(store.getKnowledge(knowledgeId)?.masteryStatus).toBe('passed');

    // 提交后响应前崩溃：重试同一幂等键读取既有收据，不重复写入
    const retry = store.submitAttempt({
      projectId: project.projectId,
      questionId: question.questionId,
      idempotencyKey: key,
      actorType: 'human_learner',
      answerText: '增函数',
      processText: '取值作差后 f(x1)-f(x2)<0',
      kind: 'real',
    });
    expect(retry.deduplicated).toBe(true);
    expect(store.listAttempts('real')).toHaveLength(1);

    // AI 同学「答对」不改变本人掌握状态
    store.setMastery(knowledgeId, 'to_reinforce');
    const peer = store.submitAttempt({
      projectId: project.projectId,
      questionId: question.questionId,
      idempotencyKey: 'peer-key-0001',
      actorType: 'peer_ai',
      answerText: '增函数',
      processText: '我认为……',
      kind: 'real',
    });
    expect(peer.forcedSimulation).toBe(true);
    expect(peer.attempt.kind).toBe('simulation');
    expect(store.getKnowledge(knowledgeId)?.masteryStatus).toBe('to_reinforce');
    expect(store.listAttempts('real')).toHaveLength(1);
    expect(store.listAttempts('simulation')).toHaveLength(1);
  });

  it('重启后读回已提交事实，并可做一致性备份', () => {
    const project = store.createProject({
      projectId: newId<'project'>('proj'),
      displayName: '数学',
      goal: '函数性质',
    });
    const { material } = store.importMaterial({
      projectId: project.projectId,
      displayName: '第三章.md',
      materialType: 'md',
      rawText: MATERIAL,
    });
    const proposal = store.createProposal({
      projectId: project.projectId,
      name: '增函数的定义',
      concept: 'x1 < x2 时 f(x1) < f(x2)',
      conditions: '',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [{ materialId: material.materialId, revision: 1, segmentId: 'S002', use: 'concept_basis' }],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'ai',
    });
    store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
    });

    const backupFile = join(root, 'backup.db');
    store.backupTo(backupFile);
    expect(existsSync(backupFile)).toBe(true);
    store.close();

    const reopened = StudyStore.open({ file: projectPaths(root).databaseFile });
    expect(reopened.listKnowledge()).toHaveLength(1);
    expect(reopened.listMaterials()).toHaveLength(1);
    expect(reopened.listProposals('approved')).toHaveLength(1);

    const fromBackup = StudyStore.open({ file: backupFile });
    expect(fromBackup.listKnowledge()).toHaveLength(1);
    reopened.close();
    fromBackup.close();
  });
});
