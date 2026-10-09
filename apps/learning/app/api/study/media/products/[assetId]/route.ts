import { NextResponse } from 'next/server';
import { projectScopeSchema, StudyError } from '@sew/study-contracts';
import { route } from '../../../../../../lib/server/http';
import { assertScope } from '../../../../../../lib/server/service';
import { readMediaProduct } from '../../../../../../lib/server/media-service';

export const dynamic = 'force-dynamic';
export const GET = route(
  async (request: Request, context: { params: Promise<{ assetId: string }> }) => {
    const url = new URL(request.url);
    const generation = url.searchParams.get('generation');
    if (generation === null || !/^\d+$/.test(generation)) throw new StudyError('INVALID_ARGUMENT');
    const scope = projectScopeSchema.safeParse({
      projectId: url.searchParams.get('projectId'),
      generation: Number(generation),
    });
    if (!scope.success) throw new StudyError('INVALID_ARGUMENT');
    const product = readMediaProduct(assertScope(scope.data), (await context.params).assetId);
    return new NextResponse(new Uint8Array(product.bytes).buffer, {
      headers: {
        'content-type': product.mime,
        'content-length': String(product.bytes.byteLength),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  },
);
