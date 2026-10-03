import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { fail } from '../../../../lib/server/http';
import { ClassroomAssetQuotaExceededError } from '@sew/study-storage';
import {
  AssetHttpError,
  MAX_ASSET_BYTES,
  MAX_PROJECT_ASSET_BYTES,
  boundedBody,
  parseAssetMultipart,
  rejectEncodedBody,
  revalidateAssetScope,
  scopedAssetSession,
} from '../../../../lib/server/classroom-assets';

export const dynamic = 'force-dynamic';

const errorResponse = async (error: unknown): Promise<NextResponse> => {
  if (error instanceof ClassroomAssetQuotaExceededError) return NextResponse.json({ error: { code: 'ASSET_QUOTA_EXCEEDED', message: '项目课堂资源总量超过上限' } }, { status: 507, headers: { 'cache-control': 'no-store', 'x-error-code': 'ASSET_QUOTA_EXCEEDED' } });
  if (error instanceof AssetHttpError) return NextResponse.json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }, { status: error.status, headers: { 'cache-control': 'no-store', 'x-error-code': error.code } });
  const mapped = fail(error);
  const body = await mapped.json() as { error?: unknown };
  return NextResponse.json({ error: body.error }, { status: mapped.status, headers: { 'cache-control': 'no-store', ...(typeof (body.error as { code?: unknown } | undefined)?.code === 'string' ? { 'x-error-code': (body.error as { code: string }).code } : {}) } });
};

export const POST = async (request: Request): Promise<NextResponse> => {
  try {
    const { scope, session } = scopedAssetSession(request);
    rejectEncodedBody(request);
    const raw = await boundedBody(request);
    revalidateAssetScope(scope);
    const upload = await parseAssetMultipart(request, raw, true);
    revalidateAssetScope(scope);
    if (upload.bytes.byteLength > MAX_ASSET_BYTES) throw new AssetHttpError(413, 'PAYLOAD_TOO_LARGE', '课堂资源文件超过上限', { limit: MAX_ASSET_BYTES });
    const nextTotal = session.store.classroomAssetBytes(scope.projectId) + upload.bytes.byteLength;
    if (nextTotal > MAX_PROJECT_ASSET_BYTES) throw new AssetHttpError(507, 'ASSET_QUOTA_EXCEEDED', '项目课堂资源总量超过上限', { limit: MAX_PROJECT_ASSET_BYTES });
    const assetId = randomUUID();
    const current = revalidateAssetScope(scope);
    const asset = current.store.putClassroomAsset(scope.projectId, assetId, upload.mediaType, upload.metadata, upload.bytes);
    return NextResponse.json({ id: asset.assetId }, { status: 201, headers: { 'x-asset-revision': String(current.store.getClassroomAssetInfo(scope.projectId, assetId)?.revision ?? 1), 'cache-control': 'no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
};
