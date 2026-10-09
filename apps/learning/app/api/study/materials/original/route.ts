import { NextResponse } from 'next/server';
import { z } from 'zod';
import { MATERIAL_ORIGINAL_MIMES, StudyError } from '@sew/study-contracts';
import { parseQuery, route } from '../../../../../lib/server/http';
import { assertScope } from '../../../../../lib/server/service';

export const dynamic = 'force-dynamic';
const querySchema = z
  .object({
    projectId: z.string().min(1),
    generation: z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(z.number().int().positive()),
    materialId: z.string().min(1).max(200),
    revision: z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(z.number().int().positive()),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const GET = route((request: Request) => {
  const query = parseQuery(request, querySchema);
  const session = assertScope({ projectId: query.projectId, generation: query.generation });
  const original = session.store.readMaterialExtractionOriginal(query.materialId, query.revision);
  if (!original) throw new StudyError('NOT_FOUND');
  if (original.receipt.sourceSha256 !== query.sha256) throw new StudyError('VERSION_CONFLICT');
  return new NextResponse(original.bytes.buffer as ArrayBuffer, {
    headers: {
      'content-type': MATERIAL_ORIGINAL_MIMES[original.receipt.format],
      'content-length': String(original.bytes.length),
      'content-disposition': `attachment; filename="original.${original.receipt.format}"; filename*=UTF-8''${encodeURIComponent(original.receipt.originalName)}`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});
