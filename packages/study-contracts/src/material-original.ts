import { z } from 'zod';

export const materialOriginalReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    materialId: z.string().min(1),
    revision: z.number().int().positive(),
    format: z.enum(['pdf', 'docx', 'pptx', 'xlsx']),
    originalName: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => !/[\\/\x00-\x1f]/.test(value)),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceByteLength: z
      .number()
      .int()
      .min(1)
      .max(4 * 1024 ** 2),
    extractedTextSha256: z.string().regex(/^[a-f0-9]{64}$/),
    extractionVersion: z.string().min(1).max(100),
    locations: z
      .array(
        z
          .object({ ordinal: z.number().int().nonnegative(), label: z.string().min(1).max(500) })
          .strict(),
      )
      .min(1)
      .max(10_000),
    archivedAt: z.string().datetime(),
  })
  .strict();
export type MaterialOriginalReceipt = z.infer<typeof materialOriginalReceiptSchema>;
export const MATERIAL_ORIGINAL_MIMES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;
