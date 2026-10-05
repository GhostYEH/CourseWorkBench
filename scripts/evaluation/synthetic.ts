import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { StudyStore, createNodeSqliteDriver } from '../../packages/study-storage/src/index';
import { freezeEvaluation, evaluationDigest } from '../../packages/study-domain/src/evaluation';
import type {
  EvaluationDataset,
  EvaluationConfig,
  EvaluationGold,
  EvaluationPredictions,
  EvaluationValue,
} from '../../packages/study-contracts/src/evaluation';

/** Fixed synthetic fixtures only. Uses the production store/domain in a disposable SQLite directory. */
export function runSyntheticEvaluation(buildId: string) {
  const directory = mkdtempSync(join(tmpdir(), 'sew-evaluation-'));
  const file = join(directory, 'evaluation.sqlite');
  let store = StudyStore.open({ file });
  try {
    const projectId = 'evaluation-synthetic';
    store.createProject({ projectId, displayName: 'Synthetic mechanical evaluation' });
    const material = store.importMaterial({
      projectId,
      displayName: 'Synthetic fixture',
      materialType: 'txt',
      rawText: '合成机械测试：加法满足交换律。',
    });
    const ref = {
      materialId: material.material.materialId,
      revision: material.material.revision,
      segmentId: material.segments[0]!.segmentId,
      use: 'concept_basis' as const,
    };
    const cases: EvaluationDataset['cases'] = [];
    const gold: EvaluationGold['items'] = [];
    const outputs: EvaluationPredictions['items'] = [];
    const persisted: Array<{ id: string; proposalId: string }> = [];
    let controlKnowledgeId: string | null = null;
    const add = (
      id: string,
      task: EvaluationValue['task'],
      input: Record<string, unknown>,
      expected: EvaluationValue,
      actual: EvaluationValue,
      evidence: Record<string, unknown>,
    ) => {
      cases.push({
        id,
        task,
        input,
        sourceGroup: 'synthetic-fixture',
        split: 'attack',
        provenance: 'synthetic',
      });
      gold.push({ caseId: id, expected });
      // No human review is performed; after_review must remain explicitly not_run.
      outputs.push({ caseId: id, stage: 'before_review', value: actual, evidence });
    };
    const sourceFixtures = [
      { id: 'source-valid', evidence: [ref], located: true },
      { id: 'source-missing', evidence: [], located: false },
      {
        id: 'source-unknown-segment',
        evidence: [{ ...ref, segmentId: 'missing-segment' }],
        located: false,
      },
      { id: 'source-stale', evidence: [{ ...ref, revision: ref.revision + 1 }], located: false },
      {
        id: 'source-unknown-material',
        evidence: [{ ...ref, materialId: 'missing-material' }],
        located: false,
      },
    ];
    const propose = (evidence: (typeof ref)[]) =>
      store.createProposal({
        projectId,
        name: 'Synthetic statement',
        concept: '加法交换律',
        conditions: '',
        scopeStatus: 'in_syllabus',
        prerequisites: [],
        evidence,
        acceptance: 'fixture',
        priority: 'low',
        proposedBy: 'user',
      });
    for (const fixture of sourceFixtures) {
      const proposal = propose(fixture.evidence);
      persisted.push({ id: fixture.id, proposalId: proposal.proposalId });
      const beforeKnowledge = store.listKnowledge().length;
      let reviewError: string | null = null;
      try {
        const reviewed = store.applyReview({
          proposalId: proposal.proposalId,
          decision: 'approved',
          expectedRevision: proposal.revision,
          semanticReviewed: true,
          note: 'Synthetic fixed fixture guard probe; not real semantic evaluation',
        });
        if (fixture.located) controlKnowledgeId = reviewed.knowledgePoint?.knowledgeId ?? null;
      } catch (error) {
        reviewError = error instanceof Error ? error.message : String(error);
      }
      add(
        fixture.id,
        'traceability',
        { evidence: fixture.evidence },
        { task: 'traceability', located: fixture.located },
        { task: 'traceability', located: proposal.mechanical.passed },
        {
          mechanical: proposal.mechanical,
          proposalStatus: proposal.status,
          reviewError,
          authorityBefore: beforeKnowledge,
          authorityAfter: store.listKnowledge().length,
          guardProbeOnly: true,
        },
      );
    }
    if (!controlKnowledgeId)
      throw new Error('Synthetic legal knowledge control failed to enter authority');
    const db = createNodeSqliteDriver().open(file);
    try {
      db.prepare(
        'UPDATE source_segments SET fingerprint = ? WHERE material_id = ? AND revision = ? AND segment_id = ?',
      ).run('0'.repeat(64), ref.materialId, ref.revision, ref.segmentId);
    } finally {
      db.close();
    }
    const corrupted = propose([ref]);
    add(
      'source-corrupt-fingerprint',
      'traceability',
      { evidence: [ref], injection: 'stored fingerprint tampered' },
      { task: 'traceability', located: false },
      { task: 'traceability', located: corrupted.mechanical.passed },
      { mechanical: corrupted.mechanical },
    );
    const restoreDb = createNodeSqliteDriver().open(file);
    try {
      restoreDb
        .prepare(
          'UPDATE source_segments SET fingerprint = ? WHERE material_id = ? AND revision = ? AND segment_id = ?',
        )
        .run(material.segments[0]!.fingerprint, ref.materialId, ref.revision, ref.segmentId);
    } finally {
      restoreDb.close();
    }
    const record = {
      materialId: ref.materialId,
      revision: ref.revision,
      questionNumber: '1',
      rewrittenFrom: null,
      rewriteNote: '',
    };
    const originFixtures = [
      { id: 'forged-no-record', record: null, expected: 'ai_new' as const, forged: true },
      {
        id: 'forged-unregistered',
        record: { ...record, materialId: 'missing-material' },
        expected: 'ai_new' as const,
        forged: true,
      },
      { id: 'forged-unverified', record, expected: 'material_original' as const, forged: true },
    ];
    for (const fixture of originFixtures) {
      const result = store.createQuestion({
        stem: '合成出处测试',
        answer: 'fixture',
        solution: '',
        knowledgeIds: [controlKnowledgeId],
        requestedOrigin: 'exam_original',
        originRecord: fixture.record,
      });
      add(
        fixture.id,
        'origin',
        { requestedOrigin: 'exam_original', originRecord: fixture.record },
        { task: 'origin', origin: fixture.expected, detectedForgery: fixture.forged },
        { task: 'origin', origin: result.question.origin, detectedForgery: result.forgedExamClaim },
        { questionId: result.question.questionId, downgraded: result.downgraded },
      );
    }
    // Synthetic trusted registration is a mechanical control, never a real exam verification.
    store.verifyMaterialAsExam({
      materialId: ref.materialId,
      revision: ref.revision,
      note: 'Synthetic fixture only',
    });
    const valid = store.createQuestion({
      stem: '合成合法对照',
      answer: 'fixture',
      solution: '',
      knowledgeIds: [controlKnowledgeId],
      requestedOrigin: 'exam_original',
      originRecord: record,
    });
    add(
      'original-valid-control',
      'origin',
      { originRecord: record },
      { task: 'origin', origin: 'exam_original', detectedForgery: false },
      { task: 'origin', origin: valid.question.origin, detectedForgery: valid.forgedExamClaim },
      { questionId: valid.question.questionId },
    );
    const rewriteRecord = {
      ...record,
      rewrittenFrom: valid.question.questionId,
      rewriteNote: 'Synthetic rewritten variation',
    };
    const rewrite = store.createQuestion({
      stem: '合成改写题伪装原题',
      answer: 'fixture',
      solution: '',
      knowledgeIds: [controlKnowledgeId],
      requestedOrigin: 'exam_original',
      originRecord: rewriteRecord,
    });
    add(
      'forged-rewrite-as-original',
      'origin',
      { requestedOrigin: 'exam_original', originRecord: rewriteRecord },
      { task: 'origin', origin: 'material_rewrite', detectedForgery: true },
      { task: 'origin', origin: rewrite.question.origin, detectedForgery: rewrite.forgedExamClaim },
      { questionId: rewrite.question.questionId, downgraded: rewrite.downgraded },
    );
    store.close();
    store = StudyStore.open({ file });
    for (const item of persisted) {
      const proposal = store.listProposals().find((v) => v.proposalId === item.proposalId);
      if (!proposal) throw new Error('Persisted proposal missing after restart');
      for (const output of outputs.filter((v) => v.caseId === item.id))
        output.evidence.persistedAfterRestart = proposal.mechanical;
    }
    const dataset: EvaluationDataset = {
      version: 1,
      datasetId: 'synthetic-mechanical-v1',
      enumeration: {
        atomicRequirements: [],
        teachingStatements: cases.filter((v) => v.task === 'traceability').map((v) => v.id),
      },
      sources: [
        {
          sourceId: 'synthetic-fixture',
          digest: evaluationDigest('合成机械测试：加法满足交换律。'),
          license: 'authored synthetic fixture',
          version: '1',
        },
      ],
      cases,
    };
    const config: EvaluationConfig = {
      version: 1,
      configId: 'offline-mechanical-v1',
      buildId,
      model: 'none',
      provider: 'none',
      promptVersion: 'none',
      skillVersion: 'none',
      budgetVersion: 'zero-provider',
      scoringVersion: '1',
      seed: 0,
      repetition: 1,
      command: 'pnpm exec tsx scripts/evaluation/cli.ts synthetic OUTPUT BUILD_ID',
      executedAt: new Date().toISOString(),
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      condition: 'mechanical',
      roleConfigDigest: evaluationDigest({ roles: [] }),
      budget: { maxCalls: 0, maxTokens: 0 },
      errorLabels: [],
    };
    return freezeEvaluation(
      dataset,
      config,
      {
        version: 1,
        datasetId: dataset.datasetId,
        establishedBy: 'synthetic_fixture',
        adjudicator: 'fixed mechanical fixtures; no semantic gold',
        disagreements: [],
        items: gold,
      },
      {
        version: 1,
        datasetId: dataset.datasetId,
        configId: config.configId,
        items: outputs,
        cost: {
          modelCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          monetaryCost: 0,
          currency: null,
          reviewSeconds: 0,
          reviewItems: 0,
        },
      },
    );
  } finally {
    store.close();
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep + 'sew-evaluation-'))
      throw new Error('Unexpected evaluation cleanup target');
    rmSync(directory, { recursive: true, force: true });
  }
}
