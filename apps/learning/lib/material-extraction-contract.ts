import { z } from 'zod';
import { projectScopeSchema } from '@sew/study-contracts';

export const materialExtractionRequestSchema = z
  .object({
    scope: projectScopeSchema,
    sourcePath: z.string().min(1).max(4096),
  })
  .strict();

export const materialExtractedBlockSchema = z
  .object({
    location: z.string().min(1).max(240),
    text: z.string().min(1).max(100_000),
  })
  .strict();

export const materialExtractionPreviewSchema = z
  .object({
    extractionId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    source: z
      .object({
        name: z.string().min(1).max(255),
        format: z.enum(['pdf', 'docx', 'pptx', 'xlsx']),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        byteLength: z
          .number()
          .int()
          .positive()
          .max(4 * 1024 * 1024),
      })
      .strict(),
    blocks: z.array(materialExtractedBlockSchema).min(1).max(2000),
    extractedText: z.string().min(1).max(1_000_000),
    warnings: z.array(z.string().min(1).max(400)).max(20),
  })
  .strict();
export type MaterialExtractionPreview = z.infer<typeof materialExtractionPreviewSchema>;

export const materialExtractionConfirmSchema = z
  .object({
    scope: projectScopeSchema,
    extractionId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    displayName: z.string().trim().min(1).max(200),
    readableLocation: z.string().trim().max(200).optional(),
  })
  .strict();
