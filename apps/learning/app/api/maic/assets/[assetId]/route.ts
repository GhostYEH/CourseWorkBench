import { NextResponse } from 'next/server';
import { ClassroomAssetReferencedError } from '@sew/study-storage';
import { fail } from '../../../../../lib/server/http';
import { AssetHttpError, revalidateAssetScope, scopedAssetSession } from '../../../../../lib/server/classroom-assets';

export const dynamic = 'force-dynamic';
interface Context { params: Promise<{ assetId: string }> }

export const DELETE = async (request: Request, context: Context): Promise<NextResponse> => {
  try {
    const { scope } = scopedAssetSession(request);
    const { assetId } = await context.params;
    revalidateAssetScope(scope);
    const session = revalidateAssetScope(scope);
    // DELETE is idempotent; a missing asset is still a successful removal.
    session.store.deleteClassroomAsset(scope.projectId, assetId);
    return new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof ClassroomAssetReferencedError) return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: 409, headers: { 'cache-control': 'no-store', 'x-error-code': error.code } });
    if (error instanceof AssetHttpError) return NextResponse.json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }, { status: error.status, headers: { 'cache-control': 'no-store', 'x-error-code': error.code } });
    const mapped = fail(error);
    const body = await mapped.json() as { error?: unknown };
    const code = body.error && typeof body.error === 'object' && 'code' in body.error && typeof body.error.code === 'string' ? body.error.code : 'INTERNAL';
    return NextResponse.json({ error: body.error }, { status: mapped.status, headers: { 'cache-control': 'no-store', 'x-error-code': code } });
  }
};
