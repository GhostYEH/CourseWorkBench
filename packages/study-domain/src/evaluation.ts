import { createHash } from 'node:crypto';
import {
  evaluationDatasetSchema,
  evaluationConfigSchema,
  evaluationGoldSchema,
  evaluationPredictionsSchema,
  evaluationReportSchema,
  frozenEvaluationSchema,
} from '@sew/study-contracts';
import type {
  EvaluationDataset,
  EvaluationConfig,
  EvaluationGold,
  EvaluationPredictions,
  EvaluationReport,
  EvaluationValue,
  FrozenEvaluation,
} from '@sew/study-contracts';
import { canonicalJson } from './classroom';

export const evaluationDigest = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const equal = (a: unknown, b: unknown): boolean => evaluationDigest(a) === evaluationDigest(b);
const rate = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  rate: denominator ? numerator / denominator : null,
});
function unique(values: string[], name: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${name}`);
}
function validate(
  d: EvaluationDataset,
  c: EvaluationConfig,
  g: EvaluationGold,
  p: EvaluationPredictions,
): void {
  if (g.datasetId !== d.datasetId || p.datasetId !== d.datasetId || p.configId !== c.configId)
    throw new Error('Evaluation ID mismatch');
  unique(
    d.cases.map((v) => v.id),
    'case IDs',
  );
  unique(
    d.sources.map((v) => v.sourceId),
    'source IDs',
  );
  unique(
    g.items.map((v) => v.caseId),
    'gold IDs',
  );
  unique(
    p.items.map((v) => `${v.stage}:${v.caseId}`),
    'prediction IDs',
  );
  const cases = new Map(d.cases.map((v) => [v.id, v]));
  const groupSplits = new Map<string, string>();
  for (const item of d.cases) {
    const split = groupSplits.get(item.sourceGroup);
    if (split && split !== item.split) throw new Error(`Source-group leakage: ${item.sourceGroup}`);
    groupSplits.set(item.sourceGroup, item.split);
  }
  for (const task of ['coverage', 'traceability'] as const) {
    const expected =
      task === 'coverage' ? d.enumeration.atomicRequirements : d.enumeration.teachingStatements;
    if (
      !equal(
        [...expected].sort(),
        d.cases
          .filter((v) => v.task === task)
          .map((v) => v.id)
          .sort(),
      )
    )
      throw new Error(`Incomplete ${task} enumeration`);
  }
  if (g.items.length !== d.cases.length) throw new Error('Gold must cover every frozen case');
  if (d.cases.some((v) => v.provenance === 'real') && g.establishedBy !== 'independent_human')
    throw new Error('Real cases require independent human gold');
  if (d.cases.some((v) => v.provenance === 'real') && !d.sources.length)
    throw new Error('Real cases require licensed source manifests');
  if (g.items.some((v) => v.expected.task === 'diagnosis' && v.expected.decision === 'abstain'))
    throw new Error(
      'Gold diagnosis must establish attribution or insufficient evidence, not model abstention',
    );
  for (const item of [
    ...g.items.map((v) => ({ caseId: v.caseId, value: v.expected })),
    ...p.items,
  ]) {
    const sample = cases.get(item.caseId);
    if (!sample || sample.task !== item.value.task)
      throw new Error(`Unknown ID or task mismatch: ${item.caseId}`);
    if (item.value.task === 'diagnosis') {
      if (item.value.errors.some((v) => !c.errorLabels.includes(v)))
        throw new Error('Unknown error label');
      if (
        (item.value.decision !== 'attribute' && item.value.errors.length) ||
        (item.value.decision === 'attribute' && !item.value.errors.length)
      )
        throw new Error('Diagnosis decision/labels inconsistent');
    }
  }
  for (const disagreement of g.disagreements)
    if (!cases.has(disagreement.caseId)) throw new Error('Unknown disagreement ID');
}
const normalizedValue = (v: EvaluationValue): EvaluationValue =>
  v.task === 'diagnosis' ? { ...v, errors: [...v.errors].sort() } : v;

/** Missing outputs stay in frozen denominators. Traceability measures mechanical location only. */
export function recomputeEvaluation(
  dataset: unknown,
  config: unknown,
  gold: unknown,
  predictions: unknown,
): EvaluationReport {
  const d = evaluationDatasetSchema.parse(dataset),
    c = evaluationConfigSchema.parse(config);
  const g = evaluationGoldSchema.parse(gold),
    p = evaluationPredictionsSchema.parse(predictions);
  validate(d, c, g, p);
  const goldMap = new Map(g.items.map((v) => [v.caseId, v.expected]));
  const outputs = new Map(p.items.map((v) => [`${v.stage}:${v.caseId}`, v.value]));
  const slices: EvaluationReport['slices'] = [];
  for (const provenance of ['real', 'synthetic'] as const)
    for (const split of ['dev', 'test', 'attack'] as const)
      for (const stage of ['before_review', 'after_review'] as const) {
        const samples = d.cases.filter((v) => v.provenance === provenance && v.split === split);
        const pairs = samples.map((v) => ({
          id: v.id,
          expected: goldMap.get(v.id)!,
          actual: outputs.get(`${stage}:${v.id}`) ?? null,
        }));
        const taskPairs = (task: EvaluationValue['task']) =>
          pairs.filter((v) => v.expected.task === task);
        const coverage = taskPairs('coverage'),
          trace = taskPairs('traceability'),
          diagnosis = taskPairs('diagnosis'),
          origins = taskPairs('origin');
        const attributable = diagnosis.filter(
          (v) => v.expected.task === 'diagnosis' && v.expected.decision === 'attribute',
        );
        const unattributable = diagnosis.filter(
          (v) => v.expected.task === 'diagnosis' && v.expected.decision === 'refuse',
        );
        const forged = origins.filter(
          (v) => v.expected.task === 'origin' && v.expected.detectedForgery,
        );
        const original = origins.filter(
          (v) => v.expected.task === 'origin' && v.expected.origin === 'exam_original',
        );
        const confusion: Record<string, Record<string, number>> = Object.create(null);
        const countCell = (expected: string, actual: string) => {
          confusion[expected] ??= Object.create(null);
          confusion[expected]![actual] = (confusion[expected]![actual] ?? 0) + 1;
        };
        for (const pair of origins)
          if (pair.expected.task === 'origin')
            countCell(
              `origin:${pair.expected.origin}`,
              pair.actual?.task === 'origin' ? `origin:${pair.actual.origin}` : 'missing',
            );
        for (const pair of diagnosis)
          if (pair.expected.task === 'diagnosis')
            countCell(
              `decision:${pair.expected.decision}`,
              pair.actual?.task === 'diagnosis' ? `decision:${pair.actual.decision}` : 'missing',
            );
        const errorLabelConfusion: EvaluationReport['slices'][number]['errorLabelConfusion'] =
          Object.create(null);
        const f1s = c.errorLabels.map((label) => {
          let tp = 0,
            fp = 0,
            fn = 0,
            tn = 0;
          for (const pair of diagnosis) {
            const expected =
              pair.expected.task === 'diagnosis' && pair.expected.errors.includes(label);
            const actual = pair.actual?.task === 'diagnosis' && pair.actual.errors.includes(label);
            if (expected && actual) tp++;
            else if (actual) fp++;
            else if (expected) fn++;
            else tn++;
          }
          errorLabelConfusion[label] = { tp, fp, fn, tn };
          // Freeze the label universe; unsupported labels contribute zero (no selective exclusion).
          return 2 * tp + fp + fn ? (2 * tp) / (2 * tp + fp + fn) : 0;
        });
        const missing = pairs.filter((v) => !v.actual).map((v) => v.id);
        slices.push({
          provenance,
          split,
          stage,
          status: !samples.length
            ? 'empty'
            : missing.length === samples.length
              ? 'not_run'
              : missing.length
                ? 'partial'
                : 'complete',
          count: samples.length,
          coverage: rate(
            coverage.filter((v) => v.actual?.task === 'coverage' && v.actual.covered).length,
            coverage.length,
          ),
          traceability: rate(
            trace.filter((v) => v.actual?.task === 'traceability' && v.actual.located).length,
            trace.length,
          ),
          diagnosisExact: rate(
            attributable.filter(
              (v) => v.actual && equal(normalizedValue(v.expected), normalizedValue(v.actual)),
            ).length,
            attributable.length,
          ),
          diagnosisMacroF1:
            diagnosis.length && f1s.length ? f1s.reduce((a, b) => a + b, 0) / f1s.length : null,
          abstention: rate(
            diagnosis.filter(
              (v) => v.actual?.task === 'diagnosis' && v.actual.decision === 'abstain',
            ).length,
            diagnosis.length,
          ),
          unattributableRefusal: rate(
            unattributable.filter(
              (v) => v.actual?.task === 'diagnosis' && v.actual.decision === 'refuse',
            ).length,
            unattributable.length,
          ),
          forgedDetection: rate(
            forged.filter((v) => v.actual?.task === 'origin' && v.actual.detectedForgery).length,
            forged.length,
          ),
          originalFalseBlock: rate(
            original.filter(
              (v) =>
                !v.actual || (v.actual.task === 'origin' && v.actual.origin !== 'exam_original'),
            ).length,
            original.length,
          ),
          finalWrongIdentity: rate(
            origins.filter(
              (v) =>
                !v.actual ||
                (v.actual.task === 'origin' &&
                  v.expected.task === 'origin' &&
                  v.actual.origin !== v.expected.origin),
            ).length,
            origins.length,
          ),
          missingOutputs: missing,
          failures: pairs
            .filter(
              (v) => !v.actual || !equal(normalizedValue(v.expected), normalizedValue(v.actual)),
            )
            .map((v) => ({ caseId: v.id, expected: v.expected, actual: v.actual })),
          confusion,
          errorLabelConfusion,
        });
      }
  return evaluationReportSchema.parse({
    version: 1,
    datasetId: d.datasetId,
    configId: c.configId,
    semanticSupport: 'not_evaluated',
    slices,
    cost: p.cost,
  });
}

export function freezeEvaluation(
  dataset: unknown,
  config: unknown,
  gold: unknown,
  predictions: unknown,
): FrozenEvaluation {
  const payload = {
    dataset: evaluationDatasetSchema.parse(dataset),
    config: evaluationConfigSchema.parse(config),
    gold: evaluationGoldSchema.parse(gold),
    predictions: evaluationPredictionsSchema.parse(predictions),
  };
  const report = recomputeEvaluation(
    payload.dataset,
    payload.config,
    payload.gold,
    payload.predictions,
  );
  return frozenEvaluationSchema.parse({
    version: 1,
    ...payload,
    report,
    digests: Object.fromEntries(
      Object.entries({ ...payload, report }).map(([k, v]) => [k, evaluationDigest(v)]),
    ),
  });
}
export function verifyFrozenEvaluation(input: unknown): FrozenEvaluation {
  const frozen = frozenEvaluationSchema.parse(input);
  for (const key of ['dataset', 'config', 'gold', 'predictions', 'report'] as const)
    if (evaluationDigest(frozen[key]) !== frozen.digests[key])
      throw new Error(`Digest mismatch: ${key}`);
  const recomputed = recomputeEvaluation(
    frozen.dataset,
    frozen.config,
    frozen.gold,
    frozen.predictions,
  );
  if (!equal(recomputed, frozen.report)) throw new Error('Report does not match recomputation');
  return frozen;
}

/** A/B/C comparisons must hold material, generation conditions and classroom roles fixed. */
export function assertEvaluationComparable(left: unknown, right: unknown): void {
  const a = verifyFrozenEvaluation(left),
    b = verifyFrozenEvaluation(right);
  if (a.digests.dataset !== b.digests.dataset || a.digests.gold !== b.digests.gold)
    throw new Error('Comparison dataset/gold mismatch');
  for (const key of [
    'buildId',
    'environment',
    'model',
    'provider',
    'promptVersion',
    'skillVersion',
    'budgetVersion',
    'scoringVersion',
    'seed',
    'roleConfigDigest',
    'budget',
    'errorLabels',
  ] as const) {
    if (!equal(a.config[key], b.config[key]))
      throw new Error(`Comparison condition mismatch: ${key}`);
  }
}
