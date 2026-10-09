import { z } from 'zod';

const loopback = (hostname: string): boolean => {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
};

const endpointObject = z
  .object({
    baseUrl: z.string().trim().min(1).max(2000),
    bearerToken: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
  })
  .strict();

const endpointRules = (value: z.infer<typeof endpointObject>, context: z.RefinementCtx): void => {
  let url: URL;
  try {
    url = new URL(value.baseUrl);
  } catch {
    context.addIssue({ code: 'custom', path: ['baseUrl'], message: '引擎地址无效' });
    return;
  }
  const local = loopback(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['http:', 'https:'].includes(url.protocol)
  )
    context.addIssue({
      code: 'custom',
      path: ['baseUrl'],
      message: '地址不能携带凭据、查询或片段',
    });
  if (local && url.protocol !== 'http:' && url.protocol !== 'https:')
    context.addIssue({ code: 'custom', path: ['baseUrl'], message: 'loopback 地址协议无效' });
  if (!local && (url.protocol !== 'https:' || !value.bearerToken))
    context.addIssue({
      code: 'custom',
      path: ['baseUrl'],
      message: '非本机地址需要 HTTPS 与 bearer 凭据',
    });
};
/** User-editable local endpoint configuration. Workflow JSON and filesystem paths are intentionally absent. */
export const localMediaConfigurationInputSchema = z
  .object({
    comfyUi: endpointObject
      .extend({
        checkpoint: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .regex(/^[A-Za-z0-9_. -]+$/),
      })
      .strict()
      .superRefine(endpointRules)
      .optional(),
    whisper: endpointObject
      .extend({
        model: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[\w.\-:/]+$/),
      })
      .strict()
      .superRefine(endpointRules)
      .optional(),
    /** Official FunASR runtime WebSocket has no bearer header; keep it loopback-only. */
    funAsr: z
      .object({
        baseUrl: z.string().trim().min(1).max(2000),
      })
      .strict()
      .superRefine((value, context) => {
        try {
          const url = new URL(value.baseUrl);
          if (
            !loopback(url.hostname) ||
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          )
            context.addIssue({
              code: 'custom',
              message: 'FunASR runtime 仅允许无凭据 loopback HTTP(S) 地址',
            });
        } catch {
          context.addIssue({ code: 'custom', message: 'FunASR 地址无效' });
        }
      })
      .optional(),
  })
  .strict();
export type LocalMediaConfigurationInput = z.infer<typeof localMediaConfigurationInputSchema>;

const configuredEngine = z
  .object({
    configured: z.boolean(),
    endpointOrigin: z.string().url().optional(),
  })
  .strict();

export const localMediaConfigurationStatusSchema = z
  .object({
    configured: z.boolean(),
    storage: z.literal('memory_only'),
    comfyUi: configuredEngine
      .extend({
        workflowId: z.literal('basic-txt2img').optional(),
        checkpoint: z.string().optional(),
      })
      .strict(),
    whisper: configuredEngine.extend({ model: z.string().optional() }).strict(),
    funAsr: configuredEngine.strict(),
  })
  .strict();
export type LocalMediaConfigurationStatus = z.infer<typeof localMediaConfigurationStatusSchema>;
