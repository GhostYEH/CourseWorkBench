import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { setSessionToken } from '../apps/learning/lib/client';
import { fetchVerifiedArtifact } from '../apps/learning/lib/verified-artifact';

const bytes = Uint8Array.from([1, 2, 3, 4]);
const expected = {
  sha256: createHash('sha256').update(bytes).digest('hex'),
  byteLength: bytes.byteLength,
  mime: 'image/png',
};
afterEach(() => {
  setSessionToken(null);
  vi.unstubAllGlobals();
});

describe('authenticated binary artifact consumers', () => {
  it('sends the session only in a header and verifies length, mime and digest before returning a blob', async () => {
    setSessionToken('session-secret');
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(bytes, { headers: { 'content-type': 'image/png', 'content-length': '4' } }),
    );
    vi.stubGlobal('fetch', fetch);
    const blob = await fetchVerifiedArtifact(
      '/api/study/media/products/asset?projectId=p&generation=1',
      expected,
    );
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(fetch).toHaveBeenCalledWith(
      '/api/study/media/products/asset?projectId=p&generation=1',
      expect.objectContaining({
        headers: { 'x-sew-session': 'session-secret' },
        cache: 'no-store',
      }),
    );
    expect(fetch.mock.calls[0]![0]).not.toContain('session-secret');
  });

  it.each([
    [Uint8Array.from([1, 2, 3]), 'image/png', /不完整/],
    [Uint8Array.from([1, 2, 3, 4, 5]), 'image/png', /超过/],
    [Uint8Array.from([4, 3, 2, 1]), 'image/png', /SHA-256/],
    [bytes, 'text/html', /类型/],
  ] as const)(
    'rejects corrupted or oversized bytes and MIME substitutions',
    async (body, mime, message) => {
      setSessionToken('secret');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(body, { headers: { 'content-type': mime } })),
      );
      await expect(
        fetchVerifiedArtifact('/api/study/media/products/asset', expected),
      ).rejects.toThrow(message);
    },
  );

  it('preserves source/approval errors and refuses cancellation before dispatch', async () => {
    setSessionToken('secret');
    const fetch = vi.fn(async () =>
      Response.json(
        { ok: false, error: { code: 'VERSION_CONFLICT', message: '来源已变化', pending: false } },
        { status: 409 },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      fetchVerifiedArtifact('/api/study/lessons/export/download', expected),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const signal = AbortSignal.abort();
    await expect(
      fetchVerifiedArtifact('/api/study/lessons/export/download', { ...expected, signal }),
    ).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(
      fetchVerifiedArtifact('https://external.test/api/study/file', expected),
    ).rejects.toThrow('参数');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
