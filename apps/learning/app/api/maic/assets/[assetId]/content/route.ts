import { NextResponse } from 'next/server';
import { mapHttpError } from '../../../../../../lib/server/http';
import { ClassroomAssetQuotaExceededError, ClassroomAssetReferencedError } from '@sew/study-storage';
import {
  AssetHttpError,
  MAX_ASSET_BYTES,
  MAX_PROJECT_ASSET_BYTES,
  boundedBody,
  parseAssetMultipart,
  rejectEncodedBody,
  revalidateAssetScope,
  scopedAssetSession,
} from '../../../../../../lib/server/classroom-assets';

export const dynamic = 'force-dynamic';
interface Context { params: Promise<{ assetId: string }> }
const missing = (): NextResponse => NextResponse.json({ error: { code: 'ASSET_NOT_FOUND', message: '课堂资源不存在' } }, { status: 404, headers: { 'x-error-code': 'ASSET_NOT_FOUND', 'cache-control': 'no-store' } });
const typedError = async (error: unknown): Promise<NextResponse> => {
  if (error instanceof ClassroomAssetReferencedError) return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: 409, headers: { 'x-error-code': error.code, 'cache-control': 'no-store' } });
  if (error instanceof ClassroomAssetQuotaExceededError) return NextResponse.json({ error: { code: 'ASSET_QUOTA_EXCEEDED', message: '项目课堂资源总量超过上限' } }, { status: 507, headers: { 'x-error-code': 'ASSET_QUOTA_EXCEEDED', 'cache-control': 'no-store' } });
  if (error instanceof AssetHttpError) return NextResponse.json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }, { status: error.status, headers: { 'x-error-code': error.code, 'cache-control': 'no-store' } });
  const mapped = mapHttpError(error);
  return NextResponse.json({ error: mapped.error }, { status: mapped.status,
    headers: { 'x-error-code': mapped.error.code, 'cache-control': 'no-store' } });
};

const renderableMediaTypes = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'font/woff', 'font/woff2', 'font/ttf', 'font/otf', 'application/font-woff',
]);
const servedMediaType = (original: string): { type: string; disposition?: string } =>
  renderableMediaTypes.has(original.toLowerCase())
    ? { type: original.toLowerCase() }
    : { type: 'application/octet-stream', disposition: 'attachment' };

export const HEAD = async (request: Request, context: Context): Promise<NextResponse> => {
  try {
    const { scope } = scopedAssetSession(request);
    const { assetId } = await context.params;
    const session = revalidateAssetScope(scope);
    const info = session.store.getClassroomAssetInfo(scope.projectId, assetId);
    if (!info) return missing();
    const media = servedMediaType(info.mediaType);
    return new NextResponse(null, { status: 200, headers: {
      'content-type': media.type,
      'content-length': String(info.byteLength),
      'x-asset-revision': String(info.revision),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...(media.disposition ? { 'content-disposition': media.disposition } : {}),
    } });
  } catch (error) { return typedError(error); }
};

export const GET = async (request: Request, context: Context): Promise<NextResponse> => {
  try {
    const { scope } = scopedAssetSession(request);
    const { assetId } = await context.params;
    const session = revalidateAssetScope(scope);
    const asset = session.store.getClassroomAsset(scope.projectId, assetId);
    if (!asset) return missing();
    const media = servedMediaType(asset.mediaType);
    return new NextResponse(asset.bytes.slice().buffer, { status: 200, headers: {
      'content-type': media.type,
      'content-length': String(asset.bytes.byteLength),
      'x-asset-revision': String(asset.revision),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...(media.disposition ? { 'content-disposition': media.disposition } : {}),
    } });
  } catch (error) { return typedError(error); }
};

export const PUT = async (request: Request, context: Context): Promise<NextResponse> => {
  try {
    const { scope } = scopedAssetSession(request);
    const { assetId } = await context.params;
    revalidateAssetScope(scope);
    rejectEncodedBody(request);
    const raw = await boundedBody(request);
    revalidateAssetScope(scope);
    const upload = await parseAssetMultipart(request, raw, false);
    revalidateAssetScope(scope);
    const session = revalidateAssetScope(scope);
    const existing = session.store.getClassroomAsset(scope.projectId, assetId);
    if (!existing) return missing();
    const nextTotal = session.store.classroomAssetBytes(scope.projectId) - existing.bytes.byteLength + upload.bytes.byteLength;
    if (nextTotal > MAX_PROJECT_ASSET_BYTES) throw new AssetHttpError(507, 'ASSET_QUOTA_EXCEEDED', '项目课堂资源总量超过上限', { limit: MAX_PROJECT_ASSET_BYTES });
    if (upload.bytes.byteLength > MAX_ASSET_BYTES) throw new AssetHttpError(413, 'PAYLOAD_TOO_LARGE', '课堂资源文件超过上限', { limit: MAX_ASSET_BYTES });
    const current = revalidateAssetScope(scope);
    const mediaType = !upload.hasMetadata && upload.mediaType === 'application/octet-stream' ? existing.mediaType : upload.mediaType;
    current.store.putClassroomAsset(scope.projectId, assetId, mediaType, upload.hasMetadata ? upload.metadata : existing.metadata, upload.bytes, existing.recordScope);
    const revision = current.store.getClassroomAssetInfo(scope.projectId, assetId)?.revision ?? 1;
    return new NextResponse(null, { status: 204, headers: { 'x-asset-revision': String(revision), 'cache-control': 'no-store' } });
  } catch (error) { return typedError(error); }
};
