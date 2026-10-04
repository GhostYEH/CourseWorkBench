import { z } from 'zod';

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
