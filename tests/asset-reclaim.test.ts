import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeProject, openProjectFromDisk, type Session,
} from '../apps/learning/lib/server/service';
import { GET as readAssets, POST as reclaimAssets } from '../apps/learning/app/api/study/assets/route';

/**
 * 课堂资源回收合同（STORE-02）。
 *
 * 候选只来自未绑定判定；读取不删除；回收途中出现绑定整批取消；
 * 重复提交同一批按幂等处理；正式回收不能越界删除演示分区资源。
 */

const bytesOf = (seed: number): Uint8Array => Uint8Array.from([seed, seed + 1, seed + 2, seed + 3]);

describe('课堂资源回收', () => {
  let session: Session;
  const roots: string[] = [];

  const put = (assetId: string, scope: 'formal' | 'demo' = 'formal') =>
    session.store.putClassroomAsset(session.projectId, assetId, 'image/png', { source: assetId }, bytesOf(assetId.length), scope);

  const get = () => readAssets();
  const post = (assetIds: string[], generation = session.generation) => reclaimAssets(
    new Request('http://service.local/api/study/assets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: { projectId: session.projectId, generation }, assetIds }),
    }),
  );

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'sew-asset-reclaim-'));
    roots.push(root);
    session = openProjectFromDisk(root);
  });

  afterEach(() => {
    closeProject();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('候选只包含未绑定资源，读取报告不删除任何字节', async () => {
    put('asset-bound');
    put('asset-free');
    session.store.putClassroomAssetBinding(session.projectId, 'stage-1', 'scene-1', 'hero', 'asset-bound');

    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { data } = await response.json();
    expect(data.unbound.map((asset: { assetId: string }) => asset.assetId)).toEqual(['asset-free']);
    expect(data.unbound[0]).not.toHaveProperty('metadata');
    expect(data.unboundBytes).toBe(4);
    expect(data.usedBytes).toBe(8);
    expect(data.limitBytes).toBe(128 * 1024 * 1024);
    // 读取只报告，不回收：两条资源的字节仍在库里。
    expect(session.store.listClassroomAssets(session.projectId)).toHaveLength(2);
  });

  it('显式回收释放字节，重复提交同一批不再删除', async () => {
    put('asset-free');
    const first = await post(['asset-free']);
    expect(first.status).toBe(200);
    expect((await first.json()).data).toEqual({ reclaimed: ['asset-free'], freedBytes: 4, remainingUnbound: 0 });
    expect(session.store.getClassroomAsset(session.projectId, 'asset-free')).toBeNull();

    // 同一批再提交一次：候选已不存在，按幂等空结果处理而不是报错。
    const again = await post(['asset-free']);
    expect((await again.json()).data).toEqual({ reclaimed: [], freedBytes: 0, remainingUnbound: 0 });
  });

  it('回收途中出现绑定时整批取消，不出现部分删除', async () => {
    put('asset-a');
    put('asset-b');
    const report = (await (await get()).json()).data;
    expect(report.unbound).toHaveLength(2);

    // 报告之后课件绑定了 asset-a：整批请求必须失败，asset-b 不能被顺带删掉。
    session.store.putClassroomAssetBinding(session.projectId, 'stage-1', 'scene-1', 'hero', 'asset-a');
    const response = await post(['asset-a', 'asset-b']);
    expect(response.status).toBe(409);
    const failure = await response.json();
    expect(failure.error.code).toBe('ASSET_IN_USE');
    expect(failure.error.pending).toBe(false);

    expect(session.store.getClassroomAsset(session.projectId, 'asset-a')).not.toBeNull();
    expect(session.store.getClassroomAsset(session.projectId, 'asset-b')).not.toBeNull();
  });

  it('正式回收不越界删除演示资源，演示资源也不进入正式候选', async () => {
    put('asset-demo', 'demo');
    put('asset-formal');

    const report = (await (await get()).json()).data;
    expect(report.unbound.map((asset: { assetId: string }) => asset.assetId)).toEqual(['asset-formal']);

    const response = await post(['asset-demo']);
    expect((await response.json()).data.reclaimed).toEqual([]);
    expect(session.store.getClassroomAsset(session.projectId, 'asset-demo')).not.toBeNull();
    expect(session.store.getClassroomAsset(session.projectId, 'asset-formal')).not.toBeNull();
  });

  it('旧代次的回收请求被拒绝，资源保持原样', async () => {
    put('asset-free');
    const response = await post(['asset-free'], session.generation + 1);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('PROJECT_GENERATION_STALE');
    expect(session.store.getClassroomAsset(session.projectId, 'asset-free')).not.toBeNull();
  });
});
