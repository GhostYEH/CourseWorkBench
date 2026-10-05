import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  evaluationDigest,
  freezeEvaluation,
  recomputeEvaluation,
  verifyFrozenEvaluation,
  assertEvaluationComparable,
} from '../packages/study-domain/src/evaluation';
import type {
  EvaluationDataset,
  EvaluationConfig,
  EvaluationGold,
  EvaluationPredictions,
  EvaluationValue,
} from '../packages/study-contracts/src/evaluation';
import { runSyntheticEvaluation } from '../scripts/evaluation/synthetic';

function fixture() {
  const rows: Array<{ id: string; expected: EvaluationValue; actual?: EvaluationValue }> = [
    {
      id: 'coverage-1',
      expected: { task: 'coverage', covered: true },
      actual: { task: 'coverage', covered: true },
    },
    { id: 'coverage-2', expected: { task: 'coverage', covered: true } },
    {
      id: 'statement-1',
      expected: { task: 'traceability', located: true },
      actual: { task: 'traceability', located: true },
    },
    { id: 'statement-2', expected: { task: 'traceability', located: true } },
    {
      id: 'diagnosis-1',
      expected: { task: 'diagnosis', decision: 'attribute', errors: ['concept', 'arithmetic'] },
      actual: { task: 'diagnosis', decision: 'attribute', errors: ['concept'] },
    },
    {
      id: 'diagnosis-2',
      expected: { task: 'diagnosis', decision: 'attribute', errors: ['arithmetic'] },
      actual: { task: 'diagnosis', decision: 'abstain', errors: [] },
    },
    {
      id: 'diagnosis-3',
      expected: { task: 'diagnosis', decision: 'refuse', errors: [] },
      actual: { task: 'diagnosis', decision: 'refuse', errors: [] },
    },
    {
      id: 'forged',
      expected: { task: 'origin', origin: 'ai_new', detectedForgery: true },
      actual: { task: 'origin', origin: 'ai_new', detectedForgery: true },
    },
    {
      id: 'original',
      expected: { task: 'origin', origin: 'exam_original', detectedForgery: false },
    },
  ];
  const dataset: EvaluationDataset = {
    version: 1,
    datasetId: 'fixture',
    enumeration: {
      atomicRequirements: ['coverage-1', 'coverage-2'],
      teachingStatements: ['statement-1', 'statement-2'],
    },
    sources: [],
    cases: rows.map((r) => ({
      id: r.id,
      sourceGroup: r.id,
      split: 'test',
      provenance: 'synthetic',
      task: r.expected.task,
      input: {},
    })),
  };
  const config: EvaluationConfig = {
    version: 1,
    configId: 'test',
    buildId: 'test',
    model: 'none',
    provider: 'none',
    promptVersion: '1',
    skillVersion: '1',
    budgetVersion: '1',
    scoringVersion: '1',
    seed: 1,
    repetition: 1,
    command: 'vitest',
    executedAt: '2026-10-05T00:00:00.000Z',
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    condition: 'mechanical',
    roleConfigDigest: evaluationDigest({}),
    budget: { maxCalls: 0, maxTokens: 0 },
    errorLabels: ['concept', 'arithmetic'],
  };
  const gold: EvaluationGold = {
    version: 1,
    datasetId: dataset.datasetId,
    establishedBy: 'synthetic_fixture',
    adjudicator: 'test fixture',
    disagreements: [],
    items: rows.map((r) => ({ caseId: r.id, expected: r.expected })),
  };
  const predictions: EvaluationPredictions = {
    version: 1,
    datasetId: dataset.datasetId,
    configId: config.configId,
    items: rows.flatMap((r) =>
      r.actual
        ? [{ caseId: r.id, stage: 'before_review' as const, value: r.actual, evidence: {} }]
        : [],
    ),
    cost: {
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      monetaryCost: null,
      currency: null,
      reviewSeconds: 12,
      reviewItems: 1,
    },
  };
  return { dataset, config, gold, predictions };
}
const score = (f: ReturnType<typeof fixture>) =>
  recomputeEvaluation(f.dataset, f.config, f.gold, f.predictions);

describe('frozen evaluation accounting', () => {
  it('preserves missing denominators, separates slices, and measures set errors/refusal/abstention', () => {
    const report = score(fixture());
    const before = report.slices.find(
      (s) => s.provenance === 'synthetic' && s.split === 'test' && s.stage === 'before_review',
    )!;
    expect(before.coverage).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(before.traceability.rate).toBe(0.5);
    expect(before.diagnosisExact).toEqual({ numerator: 0, denominator: 2, rate: 0 });
    expect(before.diagnosisMacroF1).toBe(0.5);
    expect(before.errorLabelConfusion.arithmetic).toEqual({ tp: 0, fp: 0, fn: 2, tn: 1 });
    expect(before.abstention.rate).toBeCloseTo(1 / 3);
    expect(before.unattributableRefusal.rate).toBe(1);
    expect(before.forgedDetection.rate).toBe(1);
    expect(before.originalFalseBlock.rate).toBe(1);
    expect(before.finalWrongIdentity.rate).toBe(0.5);
    expect(before.confusion['origin:exam_original']?.missing).toBe(1);
    expect(before.missingOutputs).toHaveLength(3);
    const after = report.slices.find(
      (s) => s.provenance === 'synthetic' && s.split === 'test' && s.stage === 'after_review',
    )!;
    expect(after.coverage.denominator).toBe(2);
    expect(after.coverage.rate).toBe(0);
    const real = report.slices.find((s) => s.provenance === 'real')!;
    expect(real.coverage.rate).toBeNull();
    expect(real.diagnosisMacroF1).toBeNull();
    expect(report.semanticSupport).toBe('not_evaluated');
    expect(report.cost.reviewSeconds).toBe(12);
  });
  it('uses order-independent strict error sets', () => {
    const f = fixture();
    f.predictions.items[2]!.value = {
      task: 'diagnosis',
      decision: 'attribute',
      errors: ['arithmetic', 'concept'],
    };
    expect(
      score(f).slices.find(
        (s) => s.provenance === 'synthetic' && s.split === 'test' && s.stage === 'before_review',
      )!.diagnosisExact.rate,
    ).toBe(0.5);
  });
  it('rejects duplicate IDs, extra/missing gold, unknown outputs, inconsistent decisions and incomplete enumeration', () => {
    const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => {
        f.dataset.cases.push(f.dataset.cases[0]!);
      },
      (f) => {
        f.gold.items.pop();
      },
      (f) => {
        f.predictions.items[0]!.caseId = 'unknown';
      },
      (f) => {
        f.predictions.items.push(f.predictions.items[0]!);
      },
      (f) => {
        f.dataset.enumeration.teachingStatements.pop();
      },
      (f) => {
        f.predictions.items[2]!.value = {
          task: 'diagnosis',
          decision: 'refuse',
          errors: ['concept'],
        };
      },
      (f) => {
        f.gold.items[0]!.expected = {
          task: 'diagnosis',
          decision: 'attribute',
          errors: ['unknown'],
        };
      },
      (f) => {
        f.predictions.configId = 'other';
      },
    ];
    for (const mutate of mutations) {
      const f = fixture();
      mutate(f);
      expect(() => score(f)).toThrow();
    }
  });
  it('rejects same-source dev/test and development/attack leakage and synthetic gold on real cases', () => {
    for (const split of ['dev', 'attack'] as const) {
      const f = fixture();
      f.dataset.cases[1]!.sourceGroup = f.dataset.cases[0]!.sourceGroup;
      f.dataset.cases[1]!.split = split;
      expect(() => score(f)).toThrow(/leakage/);
    }
    const f = fixture();
    f.dataset.cases[0]!.provenance = 'real';
    expect(() => score(f)).toThrow(/human gold/);
  });
  it('detects component tampering and rejects a recomputed hash over an invented report', () => {
    const f = fixture();
    const frozen = freezeEvaluation(f.dataset, f.config, f.gold, f.predictions);
    expect(verifyFrozenEvaluation(frozen)).toEqual(frozen);
    for (const key of ['dataset', 'config', 'gold', 'predictions', 'report'] as const) {
      const altered = structuredClone(frozen);
      altered.digests[key] = '0'.repeat(64);
      expect(() => verifyFrozenEvaluation(altered)).toThrow(/Digest mismatch/);
    }
    const altered = structuredClone(frozen);
    altered.report.slices[0]!.count = 999;
    altered.digests.report = evaluationDigest(altered.report);
    expect(() => verifyFrozenEvaluation(altered)).toThrow(/recomputation/);
  });
  it('holds model, budget and classroom roles fixed for comparisons', () => {
    const f = fixture();
    const a = freezeEvaluation(f.dataset, { ...f.config, condition: 'A' }, f.gold, f.predictions);
    const b = freezeEvaluation(f.dataset, { ...f.config, condition: 'B' }, f.gold, f.predictions);
    expect(() => assertEvaluationComparable(a, b)).not.toThrow();
    const changed = freezeEvaluation(
      f.dataset,
      { ...f.config, condition: 'B', roleConfigDigest: evaluationDigest({ roles: ['peer'] }) },
      f.gold,
      f.predictions,
    );
    expect(() => assertEvaluationComparable(a, changed)).toThrow(/roleConfigDigest/);
    const changedBuild = freezeEvaluation(
      f.dataset,
      { ...f.config, condition: 'B', buildId: 'different-build' },
      f.gold,
      f.predictions,
    );
    expect(() => assertEvaluationComparable(a, changedBuild)).toThrow(/buildId/);
    for (const key of ['node', 'platform', 'arch'] as const) {
      const changedEnvironment = freezeEvaluation(
        f.dataset,
        {
          ...f.config,
          condition: 'B',
          environment: { ...f.config.environment, [key]: `different-${key}` },
        },
        f.gold,
        f.predictions,
      );
      expect(() => assertEvaluationComparable(a, changedEnvironment)).toThrow(/environment/);
    }
    const c = freezeEvaluation(f.dataset, { ...f.config, condition: 'C' }, f.gold, f.predictions);
    expect(() => assertEvaluationComparable(a, c)).not.toThrow();
  });
  it('imports four JSON documents through the offline CLI and refuses to overwrite reports', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sew-eval-cli-'));
    try {
      const f = fixture();
      const names = ['dataset', 'config', 'gold', 'predictions'] as const;
      const paths = names.map((name) => {
        const path = join(directory, `${name}.json`);
        writeFileSync(path, JSON.stringify(f[name]));
        return path;
      });
      const output = join(directory, 'frozen.json'),
        report = join(directory, 'report.json');
      const cli = (...args: string[]) =>
        spawnSync(
          process.execPath,
          ['--import', 'tsx', resolve('scripts/evaluation/cli.ts'), ...args],
          { encoding: 'utf8' },
        );
      expect(cli('freeze', ...paths, output).status).toBe(0);
      expect(cli('recompute', output, report).status).toBe(0);
      expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual(score(f));
      const previous = readFileSync(report, 'utf8');
      expect(cli('recompute', output, report).status).toBe(1);
      expect(readFileSync(report, 'utf8')).toBe(previous);
    } finally {
      if (!resolve(directory).startsWith(resolve(tmpdir()) + sep + 'sew-eval-cli-'))
        throw new Error('Unexpected CLI fixture cleanup target');
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('runs persisted production SQLite attacks and legal controls without any provider', () => {
    const frozen = runSyntheticEvaluation('vitest-build');
    expect(verifyFrozenEvaluation(frozen).report.semanticSupport).toBe('not_evaluated');
    const slice = frozen.report.slices.find(
      (s) => s.provenance === 'synthetic' && s.split === 'attack' && s.stage === 'before_review',
    )!;
    expect(slice.count).toBe(11);
    expect(slice.failures).toEqual([]);
    expect(slice.forgedDetection).toEqual({ numerator: 4, denominator: 4, rate: 1 });
    expect(slice.originalFalseBlock).toEqual({ numerator: 0, denominator: 1, rate: 0 });
    expect(slice.finalWrongIdentity.numerator).toBe(0);
    expect(frozen.predictions.cost.modelCalls).toBe(0);
    expect(
      frozen.predictions.items.find((i) => i.caseId === 'source-corrupt-fingerprint')?.evidence
        .mechanical,
    ).toMatchObject({ passed: false });
    expect(
      frozen.predictions.items.find((i) => i.caseId === 'source-valid')?.evidence
        .persistedAfterRestart,
    ).toMatchObject({ passed: true });
    for (const id of [
      'source-missing',
      'source-unknown-segment',
      'source-stale',
      'source-unknown-material',
    ]) {
      const evidence = frozen.predictions.items.find((i) => i.caseId === id)!.evidence;
      expect(evidence.reviewError).toBeTruthy();
      expect(evidence.authorityAfter).toBe(evidence.authorityBefore);
    }
    expect(
      frozen.report.slices.find(
        (s) => s.provenance === 'synthetic' && s.split === 'attack' && s.stage === 'after_review',
      )?.status,
    ).toBe('not_run');
  });
});
