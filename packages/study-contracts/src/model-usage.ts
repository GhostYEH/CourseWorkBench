import { z } from 'zod';
import { modelGenerationResultSchema } from './model-connection';
import { MODEL_CALL_PURPOSE } from './status';

/**
 * 共享模型台账合同（《规划书》6.4 / 6.5，BUDGET-01）。
 *
 * 这一层只描述「一次外部调用是怎么被计量的」，不描述谁在调用。原本只服务
 * 课程草案与课堂讲解的台账，现在把模型评分、错因归因、复习建议以及 AI 同学
 * 发言也纳进来——它们必须共用同一份限额，而不是各记一本账。
 */

/** 调用用途：与 `MODEL_CALL_PURPOSE` 同源，避免两处枚举漂移。 */
export const MODEL_USAGE_PURPOSE = MODEL_CALL_PURPOSE;
export type ModelUsagePurpose = (typeof MODEL_USAGE_PURPOSE)[number];

/**
 * 用量口径。三档必须分开报告，不能把未知按 0 计。
 *
 * - `actual`    provider 回包给了计数；
 * - `estimated` provider 没给计数，但有可复核的估算依据（提示词长度）；
 * - `unknown`   请求已发出但拿不到任何依据，只能保守保留预占。
 */
export const MODEL_USAGE_MEASUREMENT = ['actual', 'estimated', 'unknown'] as const;
export type ModelUsageMeasurement = (typeof MODEL_USAGE_MEASUREMENT)[number];

/** 费用口径。没有价格表时必须是 `unknown`，不能默认 0 元。 */
export const MODEL_COST_MEASUREMENT = ['actual', 'estimated', 'unknown'] as const;
export type ModelCostMeasurement = (typeof MODEL_COST_MEASUREMENT)[number];

export const modelUsageCallSchema = z.object({
  projectId: z.string().min(1).max(200), requestId: z.string().min(1).max(200), runId: z.string().min(1).max(200),
  purpose: z.enum(MODEL_USAGE_PURPOSE), sessionId: z.string().nullable(),
  roundIndex: z.number().int().nonnegative().nullable(),
  /** 发出这次调用的角色；`peer_turn` 一定是某个 AI 同学。 */
  roleProfileId: z.string().max(200).nullable(),
  /** 同一轮内同一角色的发言序号，用于「最多两次同学发言」的判定与审计。 */
  peerTurnIndex: z.number().int().nonnegative().nullable(),
  state: z.enum(['started', 'failed', 'completed']), intent: z.string().regex(/^[a-f0-9]{64}$/),
  reservedTokens: z.number().int().positive(), accountedTokens: z.number().int().nonnegative().nullable(),
  provider: z.string().nullable(), requestedModel: z.string().nullable(), returnedModel: z.string().nullable(),
  providerTokens: z.number().int().nonnegative().nullable(), elapsedMs: z.number().nonnegative().nullable(),
  /**
   * 实际用量口径。历史记录没有这一列时按兼容规则推导，不视为缺陷：
   * `providerTokens !== null` 记为 actual，有 accounted 记为 estimated，否则 unknown。
   */
  tokenMeasurement: z.enum(MODEL_USAGE_MEASUREMENT),
  cost: z.number().nonnegative().nullable(),
  costMeasurement: z.enum(MODEL_COST_MEASUREMENT),
  createdAt: z.string(), updatedAt: z.string(),
  result: modelGenerationResultSchema.nullable(),
}).strict();
export type ModelUsageCallDto = z.infer<typeof modelUsageCallSchema>;

/**
 * 兼容推导：给 v23 以前的记录补出口径，避免为了新增字段而重写历史 JSON。
 * 这不会改变任何既有结算值，只把「当时大概是什么口径」如实标注出来。
 */
export const measurementOf = (call: Pick<ModelUsageCallDto, 'state' | 'accountedTokens' | 'providerTokens'>
  & Partial<Pick<ModelUsageCallDto, 'tokenMeasurement'>>): ModelUsageMeasurement => {
  if (call.tokenMeasurement === 'actual' || call.tokenMeasurement === 'estimated' || call.tokenMeasurement === 'unknown') {
    return call.tokenMeasurement;
  }
  if (call.providerTokens !== null && call.providerTokens !== undefined) return 'actual';
  if (call.accountedTokens !== null && call.accountedTokens !== undefined) return 'estimated';
  return 'unknown';
};

/** 一次调用在界面上的展示口径：实际/估算/未知分开计数，不做四舍五入的假精度。 */
export const modelUsageSummarySchema = z.object({
  calls: z.number().int().nonnegative(),
  actualTokens: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  unknownTokens: z.number().int().nonnegative(),
  reservedTokens: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
  actualCost: z.number().nonnegative().nullable(),
  estimatedCost: z.number().nonnegative().nullable(),
  unknownCostCalls: z.number().int().nonnegative(),
}).strict();
export type ModelUsageSummaryDto = z.infer<typeof modelUsageSummarySchema>;

/** 按用途分组合计；课堂与生成的分开显示，但共用同一份总额度。 */
export const modelUsageBreakdownSchema = z.object({
  purpose: z.enum(MODEL_USAGE_PURPOSE),
  summary: modelUsageSummarySchema,
}).strict();
export type ModelUsageBreakdownDto = z.infer<typeof modelUsageBreakdownSchema>;

export const modelUsageReportSchema = z.object({
  runId: z.string().min(1).max(200),
  limits: z.object({
    maxCalls: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    maxWallClockMs: z.number().int().positive(),
  }).strict(),
  total: modelUsageSummarySchema,
  remainingCalls: z.number().int().nonnegative(),
  remainingTokens: z.number().int().nonnegative(),
  /** 执行墙钟口径：只累计「已发出且已结算」的调用耗时，等待本人输入不算。 */
  activeElapsedMs: z.number().int().nonnegative(),
  maxWallClockMs: z.number().int().positive(),
  wallClockExhausted: z.boolean(),
  byPurpose: z.array(modelUsageBreakdownSchema),
  /** 未结算的 `started` 调用编号：界面必须能指出「这笔钱花在哪、结果未知」。 */
  unsettled: z.array(z.object({ requestId: z.string(), purpose: z.enum(MODEL_USAGE_PURPOSE), reservedTokens: z.number().int().positive(), createdAt: z.string() }).strict()),
}).strict();
export type ModelUsageReportDto = z.infer<typeof modelUsageReportSchema>;
