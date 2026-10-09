import { NextResponse } from 'next/server';
import { z } from 'zod';
import { LESSON_EXPORT_FORMATS } from '@sew/study-contracts';
import { parseQuery, route } from '../../../../../../lib/server/http';
import { assertScope } from '../../../../../../lib/server/service';
import { readLessonExport } from '../../../../../../lib/server/lesson-export-files';

export const dynamic = 'force-dynamic';
const querySchema = z
  .object({
    projectId: z.string().min(1),
    generation: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive()),
    lessonId: z.string().min(1).max(200),
    version: z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(z.number().int().positive()),
    format: z.enum(LESSON_EXPORT_FORMATS),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const GET = route((request: Request) => {
  const query = parseQuery(request, querySchema);
  const session = assertScope({ projectId: query.projectId, generation: query.generation });
  const product = readLessonExport(
    session,
    query.lessonId,
    query.version,
    query.format,
    query.sha256,
  );
  return new NextResponse(new Uint8Array(product.bytes).buffer, {
    headers: {
      'content-type': product.mime,
      'content-length': String(product.bytes.byteLength),
      'content-disposition': `attachment; filename="${product.fileName}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});
