import { describe, expect, it } from 'vitest';
import {
  StudyError,
  formatSegmentId,
  type EvidenceRefInput,
} from '@sew/study-contracts';
import {
  answerDisplayPolicy,
  checkAdmission,
  computeInvalidation,
  decideAttempt,
  decideProposal,
  fingerprintOf,
  normalizeMaterial,
  normalizeText,
  resolveQuestionOrigin,
  runMechanicalCheck,
  splitSegments,
  type KnowledgeRecord,
} from '@sew/study-domain';

const material = normalizeMaterial(
  '\uFEFF第一章 函数\r\n\r\n函数是刻画变量关系的工具。\r\n\r\n单调性用于比较大小。\r\n',
);

const registry = new Map(
  material.segments.map((s) => [`mat_1|1|${s.segmentId}`, { materialId: 'mat_1', revision: 1, ...s }]),
);
const lookupSegment = (m: string, r: number, s: string) => registry.get(`${m}|${r}|${s}`);
const currentRevisions = { mat_1: 1 };

const evidence = (segmentId: string): EvidenceRefInput => ({
  materialId: 'mat_1',
  revision: 1,
  segmentId,
  use: 'concept_basis',
});

describe('材料规范化与指纹', () => {
  it('移除开头 BOM 并把换行统一为 LF', () => {
    expect(normalizeText('\uFEFFa\r\nb\rc')).toBe('a\nb\nc');
  });

  it('按空行切分段落并给出稳定编号', () => {
    expect(material.segments.map((s) => s.segmentId)).toEqual([
      formatSegmentId(1),
      formatSegmentId(2),
      formatSegmentId(3),
    ]);
    expect(splitSegments(normalizeText('A\n\n\n\nB')).map((s) => s.text)).toEqual(['A', 'B']);
  });

  it('同一文本重算指纹一致，改动内容指纹改变', () => {
    expect(fingerprintOf(material.segments[1]!.text)).toBe(material.segments[1]!.fingerprint);
    expect(fingerprintOf('单调性用于比较大小')).not.toBe(material.segments[2]!.fingerprint);
  });
});

describe('机械检查', () => {
  it('无来源候选被拦在待核实', () => {
    const result = runMechanicalCheck({
      evidence: [],
      lookupSegment,
      currentRevisions,
      knownKnowledgeIds: new Set(),
      prerequisites: [],
    });
    expect(result.passed).toBe(false);
    expect(result.checks.some((c) => c.code === 'SOURCE_MISSING' && !c.ok)).toBe(true);
  });

  it('引用可定位时通过，并返回原文摘录', () => {
    const result = runMechanicalCheck({
      evidence: [evidence('S002')],
      lookupSegment,
      currentRevisions,
      knownKnowledgeIds: new Set(),
      prerequisites: [],
    });
    expect(result.passed).toBe(true);
    expect(result.excerpts[0]?.excerpt).toBe('函数是刻画变量关系的工具。');
  });

  it('引用旧版本或不存在段落时阻断', () => {
    const stale = runMechanicalCheck({
      evidence: [evidence('S001')],
      lookupSegment,
      currentRevisions: { mat_1: 2 },
      knownKnowledgeIds: new Set(),
      prerequisites: [],
    });
    expect(stale.passed).toBe(false);
    expect(stale.checks.some((c) => c.code === 'SOURCE_REVISION_STALE' && !c.ok)).toBe(true);

    const missing = runMechanicalCheck({
      evidence: [evidence('S999')],
      lookupSegment,
      currentRevisions,
      knownKnowledgeIds: new Set(),
      prerequisites: [],
    });
    expect(missing.checks.some((c) => c.code === 'SOURCE_SEGMENT_NOT_FOUND' && !c.ok)).toBe(true);
  });

  it('指纹被改写时判定不一致', () => {
    const tampered = new Map(registry);
    const key = 'mat_1|1|S002';
    const segment = tampered.get(key)!;
    tampered.set(key, { ...segment, text: '被改写的正文' });
    const result = runMechanicalCheck({
      evidence: [evidence('S002')],
      lookupSegment: (m, r, s) => tampered.get(`${m}|${r}|${s}`),
      currentRevisions,
      knownKnowledgeIds: new Set(),
      prerequisites: [],
    });
    expect(result.passed).toBe(false);
    expect(result.checks.some((c) => c.code === 'SOURCE_FINGERPRINT_MISMATCH' && !c.ok)).toBe(true);
  });
});

describe('审核决策', () => {
  const passing = runMechanicalCheck({
    evidence: [evidence('S002')],
    lookupSegment,
    currentRevisions,
    knownKnowledgeIds: new Set(),
    prerequisites: [],
  });

  it('机械通过但未做语义确认时不能升级为已核实', () => {
    expect(() =>
      decideProposal({
        decision: 'approved',
        expectedRevision: 0,
        currentRevision: 0,
        mechanical: passing,
        semanticReviewed: false,
      }),
    ).toThrowError(StudyError);
  });

  it('机械不通过时人工点击通过也不能绕过来源', () => {
    const failing = runMechanicalCheck({
      evidence: [],
      lookupSegment,
      currentRevisions,
      knownKnowledgeIds: new Set(),
      prerequisites: [],
    });
    try {
      decideProposal({
        decision: 'approved',
        expectedRevision: 0,
        currentRevision: 0,
        mechanical: failing,
        semanticReviewed: true,
      });
      throw new Error('应当抛出 SOURCE_MISSING');
    } catch (error) {
      expect(error).toBeInstanceOf(StudyError);
      expect((error as StudyError).code).toBe('SOURCE_MISSING');
    }
  });

  it('过期版本提交失败', () => {
    try {
      decideProposal({
        decision: 'approved',
        expectedRevision: 0,
        currentRevision: 3,
        mechanical: passing,
        semanticReviewed: true,
      });
      throw new Error('应当抛出 VERSION_CONFLICT');
    } catch (error) {
      expect((error as StudyError).code).toBe('VERSION_CONFLICT');
    }
  });

  it('通过后应创建权威知识点', () => {
    const result = decideProposal({
      decision: 'approved',
      expectedRevision: 1,
      currentRevision: 1,
      mechanical: passing,
      semanticReviewed: true,
    });
    expect(result.status).toBe('approved');
    expect(result.createsKnowledgePoint).toBe(true);
  });
});

describe('生成准入', () => {
  const record = (over: Partial<KnowledgeRecord>): KnowledgeRecord => ({
    knowledgeId: 'kp_1',
    name: '单调性',
    sourceStatus: 'verified',
    scopeStatus: 'in_syllabus',
    prerequisites: [],
    evidence: [{ materialId: 'mat_1', revision: 1 }],
    ...over,
  });

  it('已核实且范围合规时放行', () => {
    const table = new Map([['kp_1', record({})]]);
    expect(checkAdmission({ knowledgeIds: ['kp_1'], table, currentRevisions }).allowed).toBe(true);
  });

  it('待核实、已失效、范围待核分别给出对应错误码', () => {
    const table = new Map([
      ['kp_pending', record({ knowledgeId: 'kp_pending', sourceStatus: 'pending' })],
      ['kp_invalid', record({ knowledgeId: 'kp_invalid', sourceStatus: 'invalidated' })],
      ['kp_scope', record({ knowledgeId: 'kp_scope', scopeStatus: 'scope_pending' })],
    ]);
    const result = checkAdmission({
      knowledgeIds: ['kp_pending', 'kp_invalid', 'kp_scope'],
      table,
      currentRevisions,
    });
    expect(result.allowed).toBe(false);
    expect(result.blocked.map((b) => b.code)).toEqual([
      'KNOWLEDGE_NOT_VERIFIED',
      'KNOWLEDGE_INVALIDATED',
      'KNOWLEDGE_SCOPE_INVALID',
    ]);
  });

  it('材料更新后旧版本引用不能进入生成', () => {
    const table = new Map([['kp_1', record({})]]);
    const result = checkAdmission({ knowledgeIds: ['kp_1'], table, currentRevisions: { mat_1: 2 } });
    expect(result.blocked[0]?.code).toBe('SOURCE_REVISION_STALE');
  });

  it('必要前置不满足时阻断，但不影响其他任务', () => {
    const table = new Map([
      ['kp_child', record({ knowledgeId: 'kp_child', prerequisites: ['kp_missing'] })],
      ['kp_ok', record({ knowledgeId: 'kp_ok' })],
    ]);
    const result = checkAdmission({
      knowledgeIds: ['kp_child', 'kp_ok'],
      table,
      currentRevisions,
    });
    expect(result.admitted).toEqual(['kp_ok']);
    expect(result.blocked[0]?.code).toBe('PREREQUISITE_UNSATISFIED');
  });

  it('材料版本变化时命中受影响知识点', () => {
    const impacts = computeInvalidation(
      [{ knowledgeId: 'kp_1', name: '单调性', sourceStatus: 'verified', evidence: [{ materialId: 'mat_1', revision: 1 }] }],
      { mat_1: 2 },
    );
    expect(impacts).toEqual([
      { knowledgeId: 'kp_1', name: '单调性', affectedMaterialIds: ['mat_1'] },
    ]);
  });
});

describe('题目身份', () => {
  it('AI 新编题自称真题时被降级，并记为伪装尝试', () => {
    const resolution = resolveQuestionOrigin('exam_original', null, {
      materialRegistered: false,
      materialVerifiedAsExam: false,
    });
    expect(resolution.origin).toBe('ai_new');
    expect(resolution.downgraded).toBe(true);
    expect(resolution.forgedExamClaim).toBe(true);
  });

  it('材料未经核实为真题时只保留材料原题身份', () => {
    const resolution = resolveQuestionOrigin(
      'exam_original',
      {
        materialId: 'mat_1',
        revision: 1,
        questionNumber: '12',
        rewrittenFrom: null,
        rewriteNote: '',
      },
      { materialRegistered: true, materialVerifiedAsExam: false },
    );
    expect(resolution.origin).toBe('material_original');
    expect(resolution.downgraded).toBe(true);
    expect(resolution.forgedExamClaim).toBe(true);
  });

  it('缺少可信核实记录时，即使请求自报也不得授予真题身份', () => {
    const record = {
      materialId: 'mat_1',
      revision: 1,
      questionNumber: '12',
      rewrittenFrom: null,
      rewriteNote: '',
    };
    // 记录存在但服务端权威事实为 false：必须降级，不能是 exam_original。
    const untrusted = resolveQuestionOrigin('exam_original', record, {
      materialRegistered: true,
      materialVerifiedAsExam: false,
    });
    expect(untrusted.origin).not.toBe('exam_original');
    expect(untrusted.origin).toBe('material_original');
    expect(untrusted.downgraded).toBe(true);

    // 只有权威事实为 true 时才授予真题身份。
    const trusted = resolveQuestionOrigin('exam_original', record, {
      materialRegistered: true,
      materialVerifiedAsExam: true,
    });
    expect(trusted.origin).toBe('exam_original');
    expect(trusted.downgraded).toBe(false);
    expect(trusted.forgedExamClaim).toBe(false);
  });

  it('有可信记录时保留真题身份', () => {
    const resolution = resolveQuestionOrigin(
      'exam_original',
      {
        materialId: 'mat_1',
        revision: 1,
        questionNumber: '12',
        rewrittenFrom: null,
        rewriteNote: '',
      },
      { materialRegistered: true, materialVerifiedAsExam: true },
    );
    expect(resolution.origin).toBe('exam_original');
    expect(resolution.downgraded).toBe(false);
  });

  it('改写题未绑定原题时降级为新编题', () => {
    const resolution = resolveQuestionOrigin(
      'material_rewrite',
      {
        materialId: 'mat_1',
        revision: 1,
        questionNumber: '12',
        rewrittenFrom: null,
        rewriteNote: '',
      },
      { materialRegistered: true, materialVerifiedAsExam: false },
    );
    expect(resolution.origin).toBe('ai_new');
    expect(resolution.downgraded).toBe(true);
  });

  it('引用未登记材料时，材料原题与材料改写都降级为新编题', () => {
    const record = {
      materialId: 'mat_fake',
      revision: 999,
      questionNumber: '12',
      rewrittenFrom: 'S001',
      rewriteNote: '换数',
    };
    const materialOriginal = resolveQuestionOrigin('material_original', record, {
      materialRegistered: false,
      materialVerifiedAsExam: false,
    });
    expect(materialOriginal.origin).toBe('ai_new');
    expect(materialOriginal.downgraded).toBe(true);

    const rewrite = resolveQuestionOrigin('material_rewrite', record, {
      materialRegistered: false,
      materialVerifiedAsExam: false,
    });
    expect(rewrite.origin).toBe('ai_new');
    expect(rewrite.downgraded).toBe(true);

    // 未登记材料冒充真题同样降级为 ai_new 并记为伪装尝试。
    const forgedExam = resolveQuestionOrigin('exam_original', record, {
      materialRegistered: false,
      materialVerifiedAsExam: false,
    });
    expect(forgedExam.origin).toBe('ai_new');
    expect(forgedExam.forgedExamClaim).toBe(true);

    // 登记后：未绑定改写原题的记录才授予材料原题；绑定了原题的按记录派生为材料改写。
    const grantedOriginal = resolveQuestionOrigin(
      'material_original',
      { ...record, rewrittenFrom: null },
      { materialRegistered: true, materialVerifiedAsExam: false },
    );
    expect(grantedOriginal.origin).toBe('material_original');
    expect(grantedOriginal.downgraded).toBe(false);

    const grantedRewrite = resolveQuestionOrigin('material_rewrite', record, {
      materialRegistered: true,
      materialVerifiedAsExam: false,
    });
    expect(grantedRewrite.origin).toBe('material_rewrite');
    expect(grantedRewrite.downgraded).toBe(false);

    // 自报「材料原题」但权威记录已绑定原题：不授予原题身份，只保留材料改写。
    const claimOriginal = resolveQuestionOrigin('material_original', record, {
      materialRegistered: true,
      materialVerifiedAsExam: false,
    });
    expect(claimOriginal.origin).toBe('material_rewrite');
    expect(claimOriginal.downgraded).toBe(true);
    expect(claimOriginal.forgedExamClaim).toBe(false);

    // 自报「真题原题」同样按记录降为材料改写，并记为伪装尝试。
    const claimExam = resolveQuestionOrigin('exam_original', record, {
      materialRegistered: true,
      materialVerifiedAsExam: false,
    });
    expect(claimExam.origin).toBe('material_rewrite');
    expect(claimExam.downgraded).toBe(true);
    expect(claimExam.forgedExamClaim).toBe(true);
    expect(claimExam.originDetail).toContain('主要变化：换数');
  });
});

describe('作答分区与去重', () => {
  it('AI 同学的「真实」作答被强制写入 simulation，且不产生掌握', () => {
    const decision = decideAttempt(
      { questionId: 'q_1', actorType: 'peer_ai', kind: 'real', answerText: 'x=1', processText: '因为……' },
      'x=1',
    );
    expect(decision.kind).toBe('simulation');
    expect(decision.forcedSimulation).toBe(true);
    expect(decision.masteryAfter).toBeNull();
    expect(decision.masteryUpdateAllowed).toBe(false);
  });

  it('本人答对进入已通过验收，答错进入待补', () => {
    const correct = decideAttempt(
      { questionId: 'q_1', actorType: 'human_learner', kind: 'real', answerText: ' x = 1。', processText: '过程' },
      'x=1',
    );
    expect(correct.masteryAfter).toBe('passed');

    const wrong = decideAttempt(
      { questionId: 'q_1', actorType: 'human_learner', kind: 'real', answerText: 'x=2', processText: '过程' },
      'x=1',
    );
    expect(wrong.masteryAfter).toBe('to_reinforce');
  });

  it('只有答案没有过程时保留待确认', () => {
    const decision = decideAttempt(
      { questionId: 'q_1', actorType: 'human_learner', kind: 'real', answerText: 'x=2', processText: '  ' },
      'x=1',
    );
    expect(decision.attributionStatus).toBe('pending_process');
  });

  it('未作答不产生掌握状态', () => {
    const decision = decideAttempt(
      { questionId: 'q_1', actorType: 'human_learner', kind: 'real', answerText: '', processText: '' },
      'x=1',
    );
    expect(decision.masteryAfter).toBeNull();
    expect(decision.masteryUpdateAllowed).toBe(false);
  });

  it('答案展示规则：提交前与版本不一致一律不展示，简答待判分不给评分依据', () => {
    const base = {
      submissionQuestionRevision: 2,
      submissionAnswerVersion: 1,
      currentQuestionRevision: 2,
      currentAnswerVersion: 1,
      gradingStatus: 'correct' as const,
    };
    // 没有本人提交 → 一律不展示。
    expect(answerDisplayPolicy({ ...base, hasPersonalSubmission: false })).toEqual({
      showReference: false,
      showRubric: false,
      showGradingBasis: false,
      reason: 'no_personal_submission',
    });
    // 题目版本被改写 → 拒绝用新版本答案给旧提交「补结论」。
    expect(
      answerDisplayPolicy({ ...base, hasPersonalSubmission: true, currentQuestionRevision: 3 }).reason,
    ).toBe('question_version_mismatch');
    // 答案版本变化 → 同样拒绝。
    expect(
      answerDisplayPolicy({ ...base, hasPersonalSubmission: true, currentAnswerVersion: 2 }).reason,
    ).toBe('answer_version_mismatch');
    // 已判分：三样都可展示。
    expect(answerDisplayPolicy({ ...base, hasPersonalSubmission: true })).toEqual({
      showReference: true,
      showRubric: true,
      showGradingBasis: true,
      reason: null,
    });
    // 待判分：可看参考答案与评分标准，但**不展示评分依据**（不暗示一个还没作出的结论）。
    expect(
      answerDisplayPolicy({ ...base, hasPersonalSubmission: true, gradingStatus: 'pending_review' }),
    ).toEqual({
      showReference: true,
      showRubric: true,
      showGradingBasis: false,
      reason: null,
    });
  });
});
