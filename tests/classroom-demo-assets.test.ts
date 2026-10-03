import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeSqliteDriver, projectPaths } from '@sew/study-storage';
import { DELETE } from '../apps/learning/app/api/maic/assets/[assetId]/route';
import { PUT } from '../apps/learning/app/api/maic/assets/[assetId]/content/route';
import { GET } from '../apps/learning/app/api/maic/demo-assets/[stageId]/route';
import { ensureFixedLesson, reviewedLesson } from '../apps/learning/lib/server/classroom-service';
import {
  closeProject,
  openProjectFromDisk,
} from '../apps/learning/lib/server/service';
import {
  DEMO_ASSET_SCENE_ID,
  DEMO_FONT_REF,
  DEMO_FONT_SLOT,
  DEMO_IMAGE_REF,
  DEMO_IMAGE_SLOT,
} from '../apps/learning/lib/classroom/demo-asset-refs';

const projectScopeHeaders = (projectId: string, generation: number): HeadersInit => ({
  'x-sew-project-id': projectId,
  'x-sew-generation': String(generation),
});

const assetManifest = (projectRoot: string) => ({
  image: new Uint8Array(readFileSync(join(projectRoot, 'apps/learning/lib/classroom/assets/monotonicity-demo.png'))),
  font: new Uint8Array(readFileSync(join(projectRoot, 'apps/learning/lib/classroom/assets/KaTeX_Main-Regular.woff2'))),
});

describe('reviewed classroom demo assets', () => {
  let rootA: string;
  let rootB: string;
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = process.cwd();
    rootA = mkdtempSync(join(tmpdir(), 'sew-demo-assets-a-'));
    rootB = mkdtempSync(join(tmpdir(), 'sew-demo-assets-b-'));
  });

  afterEach(() => {
    closeProject();
    const holder = (globalThis as { __sewSession?: { environmentBootstrapSuppressed?: boolean } }).__sewSession;
    if (holder) holder.environmentBootstrapSuppressed = false;
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  it('GET is read-only and cannot silently provision the lesson or assets', async () => {
    const session = openProjectFromDisk(rootA);
    const response = await GET(new Request('http://service.local/api/maic/demo-assets/stage-demo-monotonicity-1', {
      headers: projectScopeHeaders(session.projectId, session.generation),
    }), { params: Promise.resolve({ stageId: reviewedLesson.stageId }) });

    expect(response.status).toBe(404);
    expect(session.store.listMaterials()).toHaveLength(0);
    expect(session.store.listKnowledge()).toHaveLength(0);
    expect(session.store.listClassroomAssets(session.projectId)).toHaveLength(0);
    expect(session.store.listClassroomDocuments(session.projectId)).toHaveLength(0);
  });

  it('explicit import binds exact image and font bytes idempotently and survives reopening', async () => {
    const session = openProjectFromDisk(rootA);
    ensureFixedLesson(session);
    const bytes = assetManifest(projectRoot);
    const imageBinding = session.store.getClassroomAssetBinding(session.projectId, reviewedLesson.stageId, DEMO_ASSET_SCENE_ID, DEMO_IMAGE_SLOT);
    const fontBinding = session.store.getClassroomAssetBinding(session.projectId, reviewedLesson.stageId, DEMO_ASSET_SCENE_ID, DEMO_FONT_SLOT);
    expect(imageBinding?.assetId).toBeTruthy();
    expect(fontBinding?.assetId).toBeTruthy();
    expect(session.store.getClassroomAsset(session.projectId, imageBinding!.assetId)?.bytes).toEqual(bytes.image);
    expect(session.store.getClassroomAsset(session.projectId, fontBinding!.assetId)?.bytes).toEqual(bytes.font);
    const symbolicImage = (reviewedLesson.document.scenes[0]!.content as { canvas: { elements: Array<{ id: string; src?: string }> } })
      .canvas.elements.find((element) => element.id === 'slide-1-demo-image')?.src;
    expect(symbolicImage).toBe(DEMO_IMAGE_REF);

    ensureFixedLesson(session);
    expect(session.store.listClassroomAssets(session.projectId)).toHaveLength(2);
    expect(session.store.getClassroomAssetBinding(session.projectId, reviewedLesson.stageId, DEMO_ASSET_SCENE_ID, DEMO_IMAGE_SLOT)?.assetId)
      .toBe(imageBinding?.assetId);

    const oldScope = { projectId: session.projectId, generation: session.generation };
    closeProject();
    const reopened = openProjectFromDisk(rootA);
    expect(reopened.projectId).toBe(oldScope.projectId);
    expect(reopened.store.listClassroomAssets(reopened.projectId)).toHaveLength(2);
    const response = await GET(new Request('http://service.local/api/maic/demo-assets/stage-demo-monotonicity-1', {
      headers: projectScopeHeaders(reopened.projectId, reopened.generation),
    }), { params: Promise.resolve({ stageId: reviewedLesson.stageId }) });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { data: { assets: Array<{ symbolicRef: string; assetId: string }> } };
    expect(payload.data.assets.map((asset) => asset.symbolicRef).sort()).toEqual([DEMO_FONT_REF, DEMO_IMAGE_REF].sort());
    expect(payload.data.assets.find((asset) => asset.symbolicRef === DEMO_IMAGE_REF)?.assetId).toBe(imageBinding?.assetId);
  });

  it('rejects a bound asset that was deleted or whose bytes changed', async () => {
    let session = openProjectFromDisk(rootA);
    ensureFixedLesson(session);
    const imageBinding = session.store.getClassroomAssetBinding(session.projectId, reviewedLesson.stageId, DEMO_ASSET_SCENE_ID, DEMO_IMAGE_SLOT)!;
    expect(() => session.store.deleteClassroomAsset(session.projectId, imageBinding.assetId)).toThrow('课堂资源仍被课件引用');
    closeProject();
    const rawMissing = createNodeSqliteDriver().open(projectPaths(rootA).databaseFile);
    rawMissing.exec('PRAGMA foreign_keys = OFF');
    rawMissing.prepare('DELETE FROM classroom_assets WHERE asset_id = ?').run(imageBinding.assetId);
    rawMissing.close();
    session = openProjectFromDisk(rootA);
    const missing = await GET(new Request('http://service.local/api/maic/demo-assets/stage-demo-monotonicity-1', {
      headers: projectScopeHeaders(session.projectId, session.generation),
    }), { params: Promise.resolve({ stageId: reviewedLesson.stageId }) });
    expect(missing.status).toBe(403);

    closeProject();
    session = openProjectFromDisk(rootB);
    ensureFixedLesson(session);
    const binding = session.store.getClassroomAssetBinding(session.projectId, reviewedLesson.stageId, DEMO_ASSET_SCENE_ID, DEMO_IMAGE_SLOT)!;
    const existing = session.store.getClassroomAsset(session.projectId, binding.assetId)!;
    const altered = new Uint8Array(existing.bytes);
    const lastByte = altered.at(-1);
    if (lastByte === undefined) throw new Error('The reviewed image fixture must not be empty');
    altered[altered.length - 1] = lastByte ^ 0x01;
    expect(() => session.store.putClassroomAsset(session.projectId, binding.assetId, existing.mediaType, existing.metadata, altered, 'demo')).toThrow('课堂资源仍被课件引用');
    closeProject();
    const rawTamper = createNodeSqliteDriver().open(projectPaths(rootB).databaseFile);
    rawTamper.prepare('UPDATE classroom_assets SET bytes = ? WHERE asset_id = ?').run(altered, binding.assetId);
    rawTamper.close();
    session = openProjectFromDisk(rootB);
    const tampered = await GET(new Request('http://service.local/api/maic/demo-assets/stage-demo-monotonicity-1', {
      headers: projectScopeHeaders(session.projectId, session.generation),
    }), { params: Promise.resolve({ stageId: reviewedLesson.stageId }) });
    expect(tampered.status).toBe(500); // Raw database corruption fails the internal byte digest.
  });

  it('refuses deletion and replacement of referenced bytes across reopening', async () => {
    let session = openProjectFromDisk(rootA);
    ensureFixedLesson(session);
    const binding = session.store.getClassroomAssetBinding(session.projectId, reviewedLesson.stageId, DEMO_ASSET_SCENE_ID, DEMO_IMAGE_SLOT)!;
    const original = session.store.getClassroomAsset(session.projectId, binding.assetId)!;
    closeProject();
    session = openProjectFromDisk(rootA);
    const headers = projectScopeHeaders(session.projectId, session.generation);
    const context = { params: Promise.resolve({ assetId: binding.assetId }) };
    const deletion = await DELETE(new Request(`http://service.local/api/maic/assets/${binding.assetId}`, { method: 'DELETE', headers }), context);
    expect(deletion.status).toBe(409);
    expect(deletion.headers.get('x-error-code')).toBe('ASSET_IN_USE');
    const replacement = new FormData();
    replacement.append('bytes', new File([new Uint8Array([1, 2])], 'changed.png', { type: 'image/png' }));
    const response = await PUT(new Request(`http://service.local/api/maic/assets/${binding.assetId}/content`, { method: 'PUT', headers, body: replacement }), context);
    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(session.store.getClassroomAsset(session.projectId, binding.assetId)?.bytes).toEqual(original.bytes);
    expect(session.store.getClassroomAssetInfo(session.projectId, binding.assetId)?.revision).toBe(original.revision);
    ensureFixedLesson(session);
    expect(session.store.getClassroomAssetInfo(session.projectId, binding.assetId)?.revision).toBe(original.revision);
  });

  it('rechecks reviewed source admission before returning asset IDs', async () => {
    const session = openProjectFromDisk(rootA);
    ensureFixedLesson(session);
    session.store.importMaterial({
      projectId: session.projectId,
      displayName: '演示材料：函数单调性（必修一片段）.md',
      materialType: 'md',
      readableLocation: 'test:source-invalidation',
      rawText: '替换后的材料内容会使旧审核依据失效。',
      recordScope: 'demo',
    });
    expect(session.store.listKnowledge('demo')[0]?.sourceStatus).toBe('invalidated');
    const response = await GET(new Request('http://service.local/api/maic/demo-assets/stage-demo-monotonicity-1', {
      headers: projectScopeHeaders(session.projectId, session.generation),
    }), { params: Promise.resolve({ stageId: reviewedLesson.stageId }) });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('KNOWLEDGE_NOT_VERIFIED');
  });

  it('rejects a request made with an old generation if the project changes while params resolve', async () => {
    const sessionA = openProjectFromDisk(rootA);
    ensureFixedLesson(sessionA);
    let resolveParams!: (params: { stageId: string }) => void;
    const params = new Promise<{ stageId: string }>((resolve) => { resolveParams = resolve; });
    const pending = GET(new Request('http://service.local/api/maic/demo-assets/stage-demo-monotonicity-1', {
      headers: projectScopeHeaders(sessionA.projectId, sessionA.generation),
    }), { params });
    openProjectFromDisk(rootB);
    resolveParams({ stageId: reviewedLesson.stageId });
    const response = await pending;
    expect(response.status).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('PROJECT_GENERATION_STALE');
  });
});
