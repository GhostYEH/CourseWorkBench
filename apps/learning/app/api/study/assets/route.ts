import { StudyError, assetReclaimSchema } from '@sew/study-contracts';
import { ClassroomAssetReferencedError } from '@sew/study-storage';
import { parseBody, route, ok } from '../../../../lib/server/http';
import { assertScope, requireSession } from '../../../../lib/server/service';
import { MAX_PROJECT_ASSET_BYTES } from '../../../../lib/server/classroom-assets';

export const dynamic = 'force-dynamic';

/**
 * 课堂资源回收（STORE-02 的资源删除合同）。
 *
 * GET 只报告未被课件绑定的资源；POST 显式回收。页面读取不删除任何东西，
 * 被课件引用的资源永不进入候选，回收途中出现绑定则整批取消。
 */
export const GET = route(() => {
  const session = requireSession();
  const unbound = session.store.listReclaimableAssets(session.projectId);
  const response = ok({
    unbound,
    unboundBytes: unbound.reduce((total, asset) => total + asset.byteLength, 0),
    usedBytes: session.store.classroomAssetBytes(session.projectId),
    limitBytes: MAX_PROJECT_ASSET_BYTES,
  });
  // 候选会随绑定变化；缓存旧报告会让人以为还能回收已用资源。
  response.headers.set('cache-control', 'no-store');
  return response;
});

/**
 * 回收给定标识的未绑定资源。
 *
 * 服务端不复用界面看到的候选：每个标识都重新确认绑定状态，因此即使报告过期，
 * 也不会删除随后被课件引用的资源。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, assetReclaimSchema);
  const session = assertScope(body.scope);

  let result: { reclaimed: string[]; freedBytes: number };
  try {
    result = session.store.reclaimAssets(session.projectId, body.assetIds);
  } catch (error) {
    if (error instanceof ClassroomAssetReferencedError) {
      throw new StudyError(
        'ASSET_IN_USE',
        { reason: 'binding_appeared' },
        '有资源在此期间被课件引用，本次回收整体取消',
      );
    }
    throw error;
  }

  return ok({
    reclaimed: result.reclaimed,
    freedBytes: result.freedBytes,
    remainingUnbound: session.store.listReclaimableAssets(session.projectId).length,
  });
});
