import { z } from 'zod';
import { projectScopeSchema } from './api';

/** Provider ids pinned to the OpenMAIC v1.1.1 baseline plus a custom-compatible slot. */
export const MODEL_PROVIDER_IDS = [
  'openai-compatible',
  'openai',
  'azure',
  'anthropic',
  'bedrock',
  'google',
  'atlascloud',
  'deepseek',
  'qwen',
  'kimi',
  'minimax',
  'glm',
  'siliconflow',
  'doubao',
  'openrouter',
  'grok',
  'tencent-hunyuan',
  'xiaomi',
  'tokendance',
  'lemonade',
  'ollama',
] as const;

const providerIdSchema = z.union([
  z.enum(MODEL_PROVIDER_IDS),
  z.string().regex(/^custom-[a-z0-9][a-z0-9-]{0,78}$/),
]);
const endpointSchema = z
  .string()
  .url()
  .max(2000)
  .refine((value) => {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  }, '远端服务必须使用 HTTPS；HTTP 仅允许 loopback 地址');
const credentialSchema = z
  .string()
  .trim()
  .max(4096)
  .regex(/^[\x21-\x7e]*$/);
const modelSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\w.\-:/]+$/);
const stageModelRoutesSchema = z
  .object({
    'lesson-draft': modelSchema.optional(),
    courseware: modelSchema.optional(),
    teaching: modelSchema.optional(),
    feedback: modelSchema.optional(),
    grading: modelSchema.optional(),
    pbl: modelSchema.optional(),
    'pro-chat': modelSchema.optional(),
    media: modelSchema.optional(),
  })
  .strict()
  .optional();

/** User-entered credentials are write-only; do not add secrets to status/results. */
export const modelConnectionInputSchema = z
  .object({
    /** `openai-compatible` preserves the original public configuration shape. */
    provider: providerIdSchema,
    baseUrl: endpointSchema.optional(),
    model: modelSchema,
    apiKey: credentialSchema.optional(),
    apiVersion: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[\w.-]+$/)
      .optional(),
    region: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    accessKeyId: credentialSchema.optional(),
    secretAccessKey: credentialSchema.optional(),
    sessionToken: credentialSchema.optional(),
    routeModels: stageModelRoutesSchema,
    thinking: z
      .object({
        enabled: z.boolean().optional(),
        effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
        budgetTokens: z.number().int().min(0).max(100_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const provider = value.provider;
    const requiresKey = !['bedrock', 'ollama', 'lemonade'].includes(provider);
    if (['openai-compatible'].includes(provider) || provider.startsWith('custom-')) {
      if (!value.baseUrl)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['baseUrl'],
          message: '兼容协议需要填写服务地址',
        });
    }
    if (provider === 'azure' && !value.baseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseUrl'],
        message: 'Azure 需要 resource/openai endpoint',
      });
    }
    if (requiresKey && !value.apiKey?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apiKey'],
        message: '该服务需要 API 密钥',
      });
    }
    if (provider === 'bedrock') {
      const hasAccessKey = Boolean(value.accessKeyId?.trim());
      const hasSecretKey = Boolean(value.secretAccessKey?.trim());
      if (hasAccessKey !== hasSecretKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['secretAccessKey'],
          message: 'AWS Access Key ID 与 Secret Access Key 必须成对填写',
        });
      }
      if (value.apiKey?.trim() && (hasAccessKey || hasSecretKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['apiKey'],
          message: 'Bedrock API key 与 AWS access/secret key 只能选择一种凭据方式',
        });
      }
      if (value.sessionToken?.trim() && !hasAccessKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sessionToken'],
          message: 'AWS Session Token 需要 access/secret key 凭据',
        });
      }
      if (!value.region?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['region'],
          message: 'Bedrock 需要 AWS region',
        });
      }
    }
  });
export type ModelConnectionInput = z.infer<typeof modelConnectionInputSchema>;

export const modelTestResultSchema = z
  .object({
    ok: z.boolean(),
    message: z.string().max(500),
    requestedModel: z.string().max(200).optional(),
    returnedModel: z.string().max(200).optional(),
    elapsedMs: z.number().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ModelTestResult = z.infer<typeof modelTestResultSchema>;

export const modelConnectionStatusSchema = z
  .object({
    configured: z.boolean(),
    persisted: z.boolean(),
    provider: providerIdSchema.optional(),
    baseUrl: z.string().optional(),
    model: z.string().optional(),
    apiVersion: z.string().max(64).optional(),
    region: z.string().max(64).optional(),
    routeModels: stageModelRoutesSchema.unwrap().optional(),
    thinking: z
      .object({
        enabled: z.boolean().optional(),
        effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
        budgetTokens: z.number().int().min(0).max(100_000).optional(),
      })
      .strict()
      .optional(),
    lastTest: modelTestResultSchema.nullable(),
  })
  .strict();
export type ModelConnectionStatus = z.infer<typeof modelConnectionStatusSchema>;

/** Model discovery is user-triggered and returns only safe model ids, never credentials or provider payloads. */
export const modelDiscoveryResultSchema = z
  .object({
    ok: z.boolean(),
    message: z.string().max(500),
    models: z.array(z.string().min(1).max(200)).max(500),
    elapsedMs: z.number().nonnegative(),
  })
  .strict();
export type ModelDiscoveryResultDto = z.infer<typeof modelDiscoveryResultSchema>;

/** Generation uses fixed evidence prompt text assembled server-side. */
export const modelChatMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().min(1).max(40_000),
  })
  .strict();
export type ModelChatMessage = z.infer<typeof modelChatMessageSchema>;

export const modelGenerationInputSchema = z
  .object({
    scope: projectScopeSchema,
    requestId: z.string().trim().min(1).max(200).optional(),
    purpose: z.enum(['lesson_draft', 'teaching_prompt']),
    bundleId: z.string().min(1),
    lessonId: z.string().min(1).nullable(),
    instruction: z.string().trim().min(2).max(600),
  })
  .strict();
export type ModelGenerationInput = z.infer<typeof modelGenerationInputSchema>;

export const modelGenerationUsageSchema = z
  .object({
    callsUsed: z.number().int().nonnegative(),
    tokensUsed: z.number().int().nonnegative(),
    maxCalls: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
  })
  .strict();
export type ModelGenerationUsageDto = z.infer<typeof modelGenerationUsageSchema>;

export const modelGenerationResultSchema = z
  .object({
    ok: z.boolean(),
    message: z.string().max(500),
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
    remainingCalls: z.number().int().nonnegative(),
    remainingTokens: z.number().int().nonnegative(),
    pendingExplanationId: z.string().nullable(),
  })
  .strict();
export type ModelGenerationResultDto = z.infer<typeof modelGenerationResultSchema>;
