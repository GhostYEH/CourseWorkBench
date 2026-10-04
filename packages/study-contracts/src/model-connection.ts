import { z } from 'zod';
import { projectScopeSchema } from './api';

/** User-entered secret is write-only; status and test results never include it. */
export const modelConnectionInputSchema = z.object({
  provider: z.literal('openai-compatible'),
  baseUrl: z.string().url().max(2000).refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  }, '模型地址须为不含凭据、查询或片段的 HTTPS 地址'),
  model: z.string().trim().min(1).max(200).regex(/^[\w.\-:/]+$/),
  apiKey: z.string().trim().min(1).max(4096).regex(/^[\x21-\x7e]+$/),
}).strict();
export type ModelConnectionInput = z.infer<typeof modelConnectionInputSchema>;

export const modelTestResultSchema = z.object({
  ok: z.boolean(), message: z.string().max(500),
  requestedModel: z.string().max(200).optional(),
  returnedModel: z.string().max(200).optional(),
  elapsedMs: z.number().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
}).strict();
export type ModelTestResult = z.infer<typeof modelTestResultSchema>;

export const modelConnectionStatusSchema = z.object({
  configured: z.boolean(), persisted: z.boolean(),
  provider: z.literal('openai-compatible').optional(),
  baseUrl: z.string().optional(), model: z.string().optional(),
  lastTest: modelTestResultSchema.nullable(),
}).strict();
export type ModelConnectionStatus = z.infer<typeof modelConnectionStatusSchema>;

/**
 * 生成用消息。正文由服务端从证据包组装，不接受渲染层提交的提示词或密钥；
 * 内容长度设上限，避免一次调用把整个项目材料塞进请求。
 */
export const modelChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1).max(40_000),
}).strict();
export type ModelChatMessage = z.infer<typeof modelChatMessageSchema>;

/** 生成请求只给出用途与已冻结的证据包编号；陈述文本由服务端从证据包读取。 */
export const modelGenerationInputSchema = z.object({
  scope: projectScopeSchema,
  requestId: z.string().trim().min(1).max(200).optional(),
  purpose: z.enum(['lesson_draft', 'teaching_prompt']),
  bundleId: z.string().min(1),
  /** teaching_prompt 必须给出课程；lesson_draft 尚未有课程身份。 */
  lessonId: z.string().min(1).nullable(),
  instruction: z.string().trim().min(2).max(600),
}).strict();
export type ModelGenerationInput = z.infer<typeof modelGenerationInputSchema>;

/** 生成结果里的 usage 是本次调用前后的 run 累计值，供界面显示剩余额度。 */
export const modelGenerationUsageSchema = z.object({
  callsUsed: z.number().int().nonnegative(),
  tokensUsed: z.number().int().nonnegative(),
  maxCalls: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
}).strict();
export type ModelGenerationUsageDto = z.infer<typeof modelGenerationUsageSchema>;

export const modelGenerationResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().max(500),
  /** 草案正文。仅作为「模型草案」展示，不进入任何权威记录。 */
  text: z.string().max(20_000).optional(),
  totalTokens: z.number().int().nonnegative(),
  requestedModel: z.string().max(200).optional(),
  elapsedMs: z.number().nonnegative(),
  requestId: z.string().optional(),
  callState: z.enum(['started', 'failed', 'completed']).optional(),
  returnedModel: z.string().max(200).optional(),
  providerTokens: z.number().int().nonnegative().nullable().optional(),
  estimatedCost: z.number().nonnegative().nullable().optional(),
  usage: modelGenerationUsageSchema,
  /** 剩余额度按同一份台账计算并显示，避免界面按「大概还能用几次」猜测。 */
  remainingCalls: z.number().int().nonnegative(),
  remainingTokens: z.number().int().nonnegative(),
  /** 课堂调用产生的正文进入待核区时给出卡片编号；草案用途为 null。 */
  pendingExplanationId: z.string().nullable(),
}).strict();
export type ModelGenerationResultDto = z.infer<typeof modelGenerationResultSchema>;
