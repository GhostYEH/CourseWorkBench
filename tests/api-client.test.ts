import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiResponses, interactionStateSchema } from '@sew/study-contracts';
import { ApiError, apiFetch, setSessionToken } from '../apps/learning/lib/client';

const schema = interactionStateSchema.pick({ count: true }).strict();
const reply = (body: unknown, status = 200) => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(body, { status }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};
afterEach(() => { setSessionToken(null); vi.unstubAllGlobals(); });

describe('renderer HTTP response boundary', () => {
  it('validates data and preserves authentication, scope headers and request signal', async () => {
    const fetcher = reply({ ok: true, data: { count: 3 } });
    setSessionToken('memory-token');
    const controller = new AbortController();
    const result = await apiFetch('/api/study/test', schema, {
      method: 'POST', headers: { 'x-sew-project-id': 'project' }, signal: controller.signal, body: '{}',
    });
    expect(result).toEqual({ count: 3 });
    const init = fetcher.mock.calls[0]?.[1];
    expect(init.headers.get('x-sew-session')).toBe('memory-token');
    expect(init.headers.get('x-sew-project-id')).toBe('project');
    expect(init.signal).toBe(controller.signal);
    expect(init.method).toBe('POST');
  });

  it.each([
    null, [], {}, { ok: 'true', data: { count: 1 } }, { ok: true },
    { ok: true, data: null }, { ok: true, data: { count: '1' } },
    { ok: true, data: { count: -1 } }, { ok: true, data: { count: 1 }, error: {} },
    { ok: false }, { ok: false, error: { code: 'INTERNAL', message: 'secret' } },
    { ok: false, error: { code: '', message: 'secret', pending: false } },
  ])('rejects malformed response %j with a safe diagnostic', async body => {
    reply(body);
    await expect(apiFetch('/api/study/test', schema)).rejects.toMatchObject({ name: 'ApiError', code: 'API_RESPONSE_INVALID', pending: false });
  });

  it('preserves a validated pending study failure even when HTTP status is 200', async () => {
    reply({ ok: false, error: { code: 'SOURCE_MISSING', message: '补材料', pending: true, details: { missing: ['S001'] } } });
    await expect(apiFetch('/api/study/test', schema)).rejects.toMatchObject({ code: 'SOURCE_MISSING', message: '补材料', pending: true });
  });

  it('never treats a valid success envelope on HTTP 500 as success', async () => {
    reply({ ok: true, data: { count: 1 } }, 500);
    await expect(apiFetch('/api/study/test', schema)).rejects.toMatchObject({ code: 'API_HTTP_ERROR' });
  });

  it('handles the upstream runtime error only on failed runtime endpoints', async () => {
    const body = { error: { code: 'RUNTIME_APPEND_CONFLICT', message: '版本冲突', details: { actualLastSeq: 1 } } };
    reply(body, 409);
    await expect(apiFetch('/api/maic/runtime/submit', apiResponses.quizSubmit)).rejects.toMatchObject({ code: 'RUNTIME_APPEND_CONFLICT', pending: false });
    reply(body, 200);
    await expect(apiFetch('/api/maic/runtime/submit', apiResponses.quizSubmit)).rejects.toMatchObject({ code: 'API_RESPONSE_INVALID' });
    reply(body, 409);
    await expect(apiFetch('/api/study/plan', apiResponses.planWrite)).rejects.toMatchObject({ code: 'API_RESPONSE_INVALID' });
  });

  it('HTML and invalid JSON never leak the response body into the diagnostic', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>private provider content</html>', { status: 502 })));
    try { await apiFetch('/api/study/test', schema); } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).message).not.toContain('private');
      expect((error as ApiError).code).toBe('API_RESPONSE_INVALID');
      return;
    }
    throw new Error('Malformed JSON was accepted');
  });

  it('keeps cancellation recognizable while reading the response', async () => {
    const controller = new AbortController();
    const aborted = new DOMException('cancelled', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => { controller.abort(); throw aborted; } }));
    await expect(apiFetch('/api/study/test', schema, { signal: controller.signal })).rejects.toBe(aborted);
  });

  it('runs schema transforms instead of asserting generic JSON', async () => {
    reply({ ok: true, data: { learnerKey: '2026-10-04' } });
    expect(await apiFetch('/api/study/test', apiResponses.classroomLearner.transform(value => value.learnerKey.length))).toBe(10);
  });
});
