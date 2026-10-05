import { z } from 'zod';
export const MAX_EVALUATION_IMPORT_BYTES = 2 * 1024 * 1024;

const id = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uniqueStrings = z
  .array(id)
  .max(5000)
  .refine((v) => new Set(v).size === v.length, 'duplicate labels');
export const evaluationTaskSchema = z.enum(['coverage', 'traceability', 'diagnosis', 'origin']);
const origin = z.enum(['exam_original', 'material_original', 'material_rewrite', 'ai_new']);
export const evaluationValueSchema = z.discriminatedUnion('task', [
  z.object({ task: z.literal('coverage'), covered: z.boolean() }).strict(),
  z.object({ task: z.literal('traceability'), located: z.boolean() }).strict(),
  z
    .object({
      task: z.literal('diagnosis'),
      decision: z.enum(['attribute', 'abstain', 'refuse']),
      errors: uniqueStrings,
    })
    .strict(),
  z.object({ task: z.literal('origin'), origin, detectedForgery: z.boolean() }).strict(),
]);
export const evaluationDatasetSchema = z
  .object({
    version: z.literal(1),
    datasetId: id,
    // One coverage row per atomic requirement; one traceability row per teaching statement.
    enumeration: z
      .object({ atomicRequirements: uniqueStrings, teachingStatements: uniqueStrings })
      .strict(),
    sources: z
      .array(z.object({ sourceId: id, digest, license: id, version: id }).strict())
      .max(1000),
    cases: z
      .array(
        z
          .object({
            id,
            sourceGroup: id,
            split: z.enum(['dev', 'test', 'attack']),
            provenance: z.enum(['real', 'synthetic']),
            task: evaluationTaskSchema,
            input: z.record(z.unknown()),
          })
          .strict(),
      )
      .max(5000),
  })
  .strict();
export const evaluationConfigSchema = z
  .object({
    version: z.literal(1),
    configId: id,
    buildId: id,
    model: id,
    provider: id,
    promptVersion: id,
    skillVersion: id,
    budgetVersion: id,
    scoringVersion: z.literal('1'),
    seed: z.number().int(),
    repetition: z.number().int().positive(),
    command: id,
    executedAt: z.string().datetime(),
    environment: z.object({ node: id, platform: id, arch: id }).strict(),
    condition: z.enum(['A', 'B', 'C', 'mechanical']),
    roleConfigDigest: digest,
    budget: z
      .object({
        maxCalls: z.number().int().nonnegative(),
        maxTokens: z.number().int().nonnegative(),
      })
      .strict(),
    errorLabels: uniqueStrings.refine((v) => v.length <= 64, 'at most 64 error labels'),
  })
  .strict();
export const evaluationGoldSchema = z
  .object({
    version: z.literal(1),
    datasetId: id,
    establishedBy: z.enum(['independent_human', 'synthetic_fixture']),
    adjudicator: id,
    disagreements: z.array(z.object({ caseId: id, note: id, resolution: id }).strict()).max(5000),
    items: z.array(z.object({ caseId: id, expected: evaluationValueSchema }).strict()).max(5000),
  })
  .strict();
export const evaluationPredictionsSchema = z
  .object({
    version: z.literal(1),
    datasetId: id,
    configId: id,
    items: z
      .array(
        z
          .object({
            caseId: id,
            stage: z.enum(['before_review', 'after_review']),
            value: evaluationValueSchema,
            evidence: z.record(z.unknown()),
          })
          .strict(),
      )
      .max(10000),
    cost: z
      .object({
        modelCalls: z.number().int().nonnegative(),
        inputTokens: z.number().int().nonnegative().nullable(),
        outputTokens: z.number().int().nonnegative().nullable(),
        monetaryCost: z.number().nonnegative().nullable(),
        currency: id.nullable(),
        reviewSeconds: z.number().nonnegative(),
        reviewItems: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export const evaluationRateSchema = z
  .object({
    numerator: z.number().int().nonnegative(),
    denominator: z.number().int().nonnegative(),
    rate: z.number().min(0).max(1).nullable(),
  })
  .strict();
export const evaluationReportSchema = z
  .object({
    version: z.literal(1),
    datasetId: id,
    configId: id,
    semanticSupport: z.literal('not_evaluated'),
    slices: z.array(
      z
        .object({
          provenance: z.enum(['real', 'synthetic']),
          split: z.enum(['dev', 'test', 'attack']),
          stage: z.enum(['before_review', 'after_review']),
          status: z.enum(['empty', 'not_run', 'partial', 'complete']),
          count: z.number().int().nonnegative(),
          coverage: evaluationRateSchema,
          traceability: evaluationRateSchema,
          diagnosisExact: evaluationRateSchema,
          diagnosisMacroF1: z.number().min(0).max(1).nullable(),
          abstention: evaluationRateSchema,
          unattributableRefusal: evaluationRateSchema,
          forgedDetection: evaluationRateSchema,
          originalFalseBlock: evaluationRateSchema,
          finalWrongIdentity: evaluationRateSchema,
          missingOutputs: uniqueStrings,
          failures: z.array(
            z
              .object({
                caseId: id,
                expected: evaluationValueSchema,
                actual: evaluationValueSchema.nullable(),
              })
              .strict(),
          ),
          confusion: z.record(z.record(z.number().int().nonnegative())),
          errorLabelConfusion: z.record(
            z
              .object({
                tp: z.number().int().nonnegative(),
                fp: z.number().int().nonnegative(),
                fn: z.number().int().nonnegative(),
                tn: z.number().int().nonnegative(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    cost: evaluationPredictionsSchema.shape.cost,
  })
  .strict();
export const frozenEvaluationSchema = z
  .object({
    version: z.literal(1),
    dataset: evaluationDatasetSchema,
    config: evaluationConfigSchema,
    gold: evaluationGoldSchema,
    predictions: evaluationPredictionsSchema,
    report: evaluationReportSchema,
    digests: z
      .object({
        dataset: digest,
        config: digest,
        gold: digest,
        predictions: digest,
        report: digest,
      })
      .strict(),
  })
  .strict();
export type EvaluationDataset = z.infer<typeof evaluationDatasetSchema>;
export type EvaluationConfig = z.infer<typeof evaluationConfigSchema>;
export type EvaluationGold = z.infer<typeof evaluationGoldSchema>;
export type EvaluationPredictions = z.infer<typeof evaluationPredictionsSchema>;
export type EvaluationReport = z.infer<typeof evaluationReportSchema>;
export type EvaluationValue = z.infer<typeof evaluationValueSchema>;
export type FrozenEvaluation = z.infer<typeof frozenEvaluationSchema>;
