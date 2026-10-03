import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpAssetStore } from '@openmaic/storage/asset/http';
import { DELETE } from '../apps/learning/app/api/maic/assets/[assetId]/route';
import { GET, HEAD, PUT } from '../apps/learning/app/api/maic/assets/[assetId]/content/route';
import { POST } from '../apps/learning/app/api/maic/assets/route';
import { closeProject, getSession, openProjectFromDisk } from '../apps/learning/lib/server/service';

const BASE = 'http://service.local/api/maic';
const roots: string[] = [];
const tempRoot = (): string => { const path = mkdtempSync(join(tmpdir(), 'sew-assets-')); roots.push(path); return path; };

const dispatch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(typeof input === 'string' ? input : input.toString(), init);
  const path = new URL(request.url).pathname.slice('/api/maic/assets'.length).split('/').filter(Boolean).map(decodeURIComponent);
  if (path.length === 0 && request.method === 'POST') return POST(request);
  if (path.length === 1 && request.method === 'DELETE') return DELETE(request, { params: Promise.resolve({ assetId: path[0]! }) });
  if (path.length === 2 && path[1] === 'content') {
    const context = { params: Promise.resolve({ assetId: path[0]! }) };
    if (request.method === 'GET') return GET(request, context);
    if (request.method === 'HEAD') return HEAD(request, context);
    if (request.method === 'PUT') return PUT(request, context);
  }
  return new Response(null, { status: 404 });
};

const clientFor = (captured?: { projectId: string; generation: number }): HttpAssetStore => new HttpAssetStore({
  baseUrl: BASE,
  headers: (): HeadersInit => {
    const session = captured ?? getSession();
    return session ? { 'x-sew-project-id': session.projectId, 'x-sew-generation': String(session.generation) } : {};
  },
  fetch: dispatch as typeof globalThis.fetch,
});

afterEach(() => {
  closeProject();
  const holder = (globalThis as { __sewSession?: { environmentBootstrapSuppressed?: boolean } }).__sewSession;
  if (holder) holder.environmentBootstrapSuppressed = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('upstream HttpAssetStore adapter and persistent classroom assets', () => {
  it('round-trips image and font bytes, stores internal SHA-256, lists, reopens and deletes', async () => {
    const root = tempRoot();
    let session = openProjectFromDisk(root);
    const client = clientFor();
    const image = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2]);
    const font = Uint8Array.from([119, 79, 70, 50, 0, 3, 4, 5]);
    try {
      const imageId = await client.put(new Blob([image], { type: 'image/png' }), { source: 'lesson image' });
      const fontId = await client.put(new Blob([font], { type: 'font/woff2' }), { source: 'lesson font' });
      expect(await client.resolve(imageId)).toMatch(/^blob:/);
      expect(session.store.getClassroomAsset(session.projectId, imageId)?.bytes).toEqual(image);
      expect(session.store.getClassroomAsset(session.projectId, fontId)?.bytes).toEqual(font);
      expect(session.store.getClassroomAsset(session.projectId, imageId)?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(session.store.listClassroomAssets(session.projectId).map((item) => item.assetId).sort()).toEqual([imageId, fontId].sort());
      session.store.putClassroomAssetBinding(session.projectId, 'stage', 'scene', 'image', imageId);
      expect(session.store.getClassroomAssetBinding(session.projectId, 'stage', 'scene', 'image')?.assetId).toBe(imageId);

      await client.close();
      closeProject();
      session = openProjectFromDisk(root);
      const restored = clientFor();
      try {
        expect(session.store.getClassroomAsset(session.projectId, imageId)?.bytes).toEqual(image);
        expect(await restored.resolve(fontId)).toMatch(/^blob:/);
        await expect(restored.remove(imageId)).rejects.toThrow();
        expect(session.store.getClassroomAsset(session.projectId, imageId)?.bytes).toEqual(image);
        await restored.remove(fontId);
        expect(session.store.getClassroomAsset(session.projectId, fontId)).toBeNull();
      } finally { await restored.close(); }
    } finally { await client.close(); }
  });

  it('supports upstream replacement with and without metadata and allocates a new id for identical content', async () => {
    const root = tempRoot();
    const session = openProjectFromDisk(root);
    const client = clientFor();
    const originalBytes = Uint8Array.of(1, 2, 3);
    const replacementBytes = Uint8Array.of(4, 5, 6);
    try {
      const id = await client.put(new Blob([originalBytes], { type: 'image/png' }), { label: 'preserved', contentType: 'image/jpeg' });
      const duplicate = await client.put(new Blob([originalBytes], { type: 'image/png' }), { label: 'preserved' });
      expect(duplicate).not.toBe(id);
      const before = await dispatch(`${BASE}/assets/${id}/content`, { method: 'HEAD', headers: {
        'x-sew-project-id': session.projectId, 'x-sew-generation': String(session.generation),
      } });
      expect(before.headers.get('x-asset-revision')).toBe('1');
      expect(before.headers.get('content-type')).toBe('image/jpeg');

      await client.replace(id as never, new Blob([replacementBytes], { type: '' }));
      expect(session.store.getClassroomAsset(session.projectId, id)?.metadata).toEqual({ label: 'preserved', contentType: 'image/jpeg' });
      const afterBytesOnly = await dispatch(`${BASE}/assets/${id}/content`, { method: 'HEAD', headers: {
        'x-sew-project-id': session.projectId, 'x-sew-generation': String(session.generation),
      } });
      expect(afterBytesOnly.headers.get('x-asset-revision')).toBe('2');
      expect(afterBytesOnly.headers.get('content-type')).toBe('image/jpeg');

      await client.replace(id as never, new Blob([replacementBytes], { type: 'image/png' }), { label: 'replaced', contentType: '' });
      expect(session.store.getClassroomAsset(session.projectId, id)?.metadata).toEqual({ label: 'replaced', contentType: '' });
      const afterMetadata = await dispatch(`${BASE}/assets/${id}/content`, { method: 'HEAD', headers: {
        'x-sew-project-id': session.projectId, 'x-sew-generation': String(session.generation),
      } });
      expect(afterMetadata.headers.get('x-asset-revision')).toBe('3');
      expect(afterMetadata.headers.get('content-type')).toBe('application/octet-stream');
      expect(afterMetadata.headers.get('content-disposition')).toBe('attachment');
      const downloaded = await dispatch(`${BASE}/assets/${id}/content`, { headers: {
        'x-sew-project-id': session.projectId, 'x-sew-generation': String(session.generation),
      } });
      expect(downloaded.headers.get('x-content-type-options')).toBe('nosniff');
      expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(replacementBytes);

      await expect(client.put(new Blob([Uint8Array.of(1)], { type: 'image/png' }), { contentType: 'image/png\r\nX-Injected: 1' } as never))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
      await expect(client.put(new Blob([Uint8Array.of(1)], { type: 'image/png' }), { contentType: 17 } as never))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });

      const html = await client.put(new Blob(['<svg><script>alert(1)</script></svg>'], { type: 'image/svg+xml' }));
      const htmlResponse = await dispatch(`${BASE}/assets/${html}/content`, { headers: {
        'x-sew-project-id': session.projectId, 'x-sew-generation': String(session.generation),
      } });
      expect(htmlResponse.headers.get('content-type')).toBe('application/octet-stream');
      expect(htmlResponse.headers.get('content-disposition')).toBe('attachment');
    } finally { await client.close(); }
  });

  it('does not read asset BLOBs for HEAD and rejects query, encoding, malformed and oversized metadata', async () => {
    const root = tempRoot();
    const session = openProjectFromDisk(root);
    const scopeHeaders = { 'x-sew-project-id': session.projectId, 'x-sew-generation': String(session.generation) };
    const client = clientFor();
    try {
      const id = await client.put(new Blob([Uint8Array.of(7)], { type: 'image/png' }));
      const originalGetter = session.store.getClassroomAsset.bind(session.store);
      session.store.getClassroomAsset = () => { throw new Error('HEAD must not read BLOB'); };
      try {
        const head = await dispatch(`${BASE}/assets/${id}/content`, { method: 'HEAD', headers: scopeHeaders });
        expect(head.status).toBe(200);
        expect(await head.text()).toBe('');
      } finally { session.store.getClassroomAsset = originalGetter; }

      expect((await dispatch(`${BASE}/assets/${id}/content?`, { headers: scopeHeaders })).status).toBe(400);
      const encoded = await dispatch(`${BASE}/assets`, { method: 'POST', headers: { ...scopeHeaders, 'content-encoding': 'identity' }, body: 'ignored' });
      expect(encoded.status).toBe(400);

      const malformedMeta = new FormData();
      malformedMeta.append('meta', new File([Uint8Array.of(0xff, 0xfe)], 'x', { type: 'application/json' }));
      malformedMeta.append('bytes', new File([Uint8Array.of(1)], 'x', { type: 'image/png' }));
      expect((await dispatch(`${BASE}/assets`, { method: 'POST', headers: scopeHeaders, body: malformedMeta })).status).toBe(400);

      const parameterizedMeta = new FormData();
      parameterizedMeta.append('meta', new File(['{}'], 'metadata.json', { type: 'application/json; charset=utf-8' }));
      parameterizedMeta.append('bytes', new File([Uint8Array.of(1)], 'asset', { type: 'image/png' }));
      expect((await dispatch(`${BASE}/assets`, { method: 'POST', headers: scopeHeaders, body: parameterizedMeta })).status).toBe(201);

      const duplicateMeta = new FormData();
      duplicateMeta.append('meta', new File(['{}'], 'first', { type: 'application/json' }));
      duplicateMeta.append('meta', new File(['{}'], 'second', { type: 'application/json' }));
      duplicateMeta.append('bytes', new File([Uint8Array.of(1)], 'bytes', { type: 'image/png' }));
      expect((await dispatch(`${BASE}/assets`, { method: 'POST', headers: scopeHeaders, body: duplicateMeta })).status).toBe(400);

      const nonFiniteMeta = new FormData();
      nonFiniteMeta.append('meta', new File(['{"value":1e400}'], 'metadata.json', { type: 'application/json' }));
      nonFiniteMeta.append('bytes', new File([Uint8Array.of(1)], 'asset', { type: 'image/png' }));
      expect((await dispatch(`${BASE}/assets`, { method: 'POST', headers: scopeHeaders, body: nonFiniteMeta })).status).toBe(400);

      const deepMeta = new FormData();
      const nested = `${'['.repeat(100)}0${']'.repeat(100)}`;
      deepMeta.append('meta', new File([`{"value":${nested}}`], 'metadata.json', { type: 'application/json' }));
      deepMeta.append('bytes', new File([Uint8Array.of(1)], 'asset', { type: 'image/png' }));
      expect((await dispatch(`${BASE}/assets`, { method: 'POST', headers: scopeHeaders, body: deepMeta })).status).toBe(400);

      const oversizedMeta = new FormData();
      oversizedMeta.append('meta', new File([new Uint8Array(64 * 1024 + 1)], 'x', { type: 'application/json' }));
      oversizedMeta.append('bytes', new File([Uint8Array.of(1)], 'x', { type: 'image/png' }));
      const oversized = await dispatch(`${BASE}/assets`, { method: 'POST', headers: scopeHeaders, body: oversizedMeta });
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    } finally { await client.close(); }
  });

  it('uses upstream missing and stale project error semantics and rejects forged metadata', async () => {
    const rootA = tempRoot();
    const rootB = tempRoot();
    const sessionA = openProjectFromDisk(rootA);
    const staleClient = clientFor({ projectId: sessionA.projectId, generation: sessionA.generation });
    const id = await staleClient.put(new Blob([Uint8Array.of(1, 2, 3)], { type: 'image/png' }));
    try {
      const sessionB = openProjectFromDisk(rootB);
      const stale = await dispatch(`${BASE}/assets/${id}/content`, { headers: { 'x-sew-project-id': sessionA.projectId, 'x-sew-generation': String(sessionA.generation) } });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: { code: 'PROJECT_GENERATION_STALE' } });
      const unknown = await dispatch(`${BASE}/assets/${id}/content`, { headers: { 'x-sew-project-id': sessionB.projectId, 'x-sew-generation': String(sessionB.generation) } });
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toMatchObject({ error: { code: 'ASSET_NOT_FOUND' } });

      const form = new FormData();
      form.append('meta', new File(['{"principal":"forged"}'], 'metadata.json', { type: 'application/json' }));
      form.append('bytes', new File([Uint8Array.of(9)], 'asset', { type: 'image/png' }));
      const forged = await dispatch(`${BASE}/assets`, { method: 'POST', body: form, headers: { 'x-sew-project-id': sessionB.projectId, 'x-sew-generation': String(sessionB.generation) } });
      expect(forged.status).toBe(400);
      expect(await forged.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
      const staleDelete = await dispatch(`${BASE}/assets/${id}`, { method: 'DELETE', headers: {
        'x-sew-project-id': sessionA.projectId, 'x-sew-generation': String(sessionA.generation),
      } });
      expect(staleDelete.status).toBe(409);
      expect(staleDelete.headers.get('x-error-code')).toBe('PROJECT_GENERATION_STALE');
      expect(staleDelete.headers.get('cache-control')).toContain('no-store');
    } finally { await staleClient.close(); }
  });

  it('bounds actual streamed request bytes even when Content-Length lies', async () => {
    const root = tempRoot();
    openProjectFromDisk(root);
    const session = getSession()!;
    const headers = new Headers({ 'content-type': 'multipart/form-data; boundary=x', 'content-length': '1', 'x-sew-project-id': session.projectId, 'x-sew-generation': String(session.generation) });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(33 * 1024 * 1024));
        controller.enqueue(Uint8Array.of(1));
        controller.close();
      },
    });
    const response = await POST(new Request(`${BASE}/assets`, { method: 'POST', headers, body, duplex: 'half' } as RequestInit & { duplex: 'half' }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(session.store.listClassroomAssets(session.projectId)).toEqual([]);
  });

  it('enforces the project logical-byte quota for direct imports and keeps the rejected write absent', async () => {
    const root = tempRoot();
    const session = openProjectFromDisk(root);
    const fullQuota = new Uint8Array(128 * 1024 * 1024);
    session.store.putClassroomAsset(session.projectId, 'full', 'application/octet-stream', {}, fullQuota);
    const form = new FormData();
    form.append('meta', new File(['{}'], 'meta', { type: 'application/json' }));
    form.append('bytes', new File([Uint8Array.of(1)], 'bytes', { type: 'image/png' }));
    const overHttp = await dispatch(`${BASE}/assets`, { method: 'POST', body: form, headers: {
      'x-sew-project-id': session.projectId, 'x-sew-generation': String(session.generation),
    } });
    expect(overHttp.status).toBe(507);
    expect(await overHttp.json()).toMatchObject({ error: { code: 'ASSET_QUOTA_EXCEEDED' } });
    expect(() => session.store.putClassroomAsset(session.projectId, 'overflow', 'application/octet-stream', {}, Uint8Array.of(1)))
      .toThrowError(expect.objectContaining({ code: 'ASSET_QUOTA_EXCEEDED' }));
    expect(session.store.getClassroomAssetInfo(session.projectId, 'overflow')).toBeNull();
  }, 15000);

  it('returns revision identity and rejects writes after a project switch during body streaming', async () => {
    const rootA = tempRoot();
    const rootB = tempRoot();
    const sessionA = openProjectFromDisk(rootA);
    const headers = { 'x-sew-project-id': sessionA.projectId, 'x-sew-generation': String(sessionA.generation) };
    const initial = new FormData();
    initial.append('meta', new File(['{}'], 'metadata.json', { type: 'application/json' }));
    initial.append('bytes', new File([Uint8Array.of(1, 2)], 'asset', { type: 'image/png' }));
    const created = await dispatch(`${BASE}/assets`, { method: 'POST', headers, body: initial });
    const id = ((await created.json()) as { id: string }).id;
    const update = new FormData();
    update.append('bytes', new File([Uint8Array.of(3, 4)], 'asset', { type: 'image/png' }));
    const body = new ReadableStream<Uint8Array>({ pull(controller) { openProjectFromDisk(rootB); controller.enqueue(new TextEncoder().encode('stale')); controller.close(); } }, { highWaterMark: 0 });
    const response = await PUT(new Request(`${BASE}/assets/${id}/content`, { method: 'PUT', headers: { ...headers, 'content-type': `multipart/form-data; boundary=${'ignored'}` }, body, duplex: 'half' } as RequestInit & { duplex: 'half' }), { params: Promise.resolve({ assetId: id }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'PROJECT_GENERATION_STALE' } });
    expect(getSession()?.store.getClassroomAsset(getSession()!.projectId, id)).toBeNull();
  });
});
