import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_EVALUATION_IMPORT_BYTES, StudyError } from '@sew/study-contracts';
import type { FrozenEvaluation } from '@sew/study-contracts';
import { runSyntheticEvaluation } from '../scripts/evaluation/synthetic';

const guards = vi.hoisted(() => ({ assertScope: vi.fn() }));
vi.mock('../apps/learning/lib/server/service', () => ({ assertScope: guards.assertScope }));
import { POST } from '../apps/learning/app/api/study/evaluation/route';

let frozen: FrozenEvaluation;
const scope = { projectId: 'selected-project', generation: 3 };
const request = (body: unknown) =>
  new Request('http://localhost/api/study/evaluation', {
    method: 'POST',
    body: JSON.stringify(body),
  });
beforeAll(() => {
  frozen = runSyntheticEvaluation('api-test');
  guards.assertScope.mockImplementation((received: typeof scope) => {
    if (received.projectId !== scope.projectId || received.generation !== scope.generation)
      throw new StudyError('PROJECT_GENERATION_STALE');
    return { projectId: scope.projectId, generation: scope.generation }; // Deliberately has no store/provider/filesystem capability.
  });
});

describe('read-only scoped evaluation import', () => {
  it('returns only the recomputed report without importing source records into the project', async () => {
    guards.assertScope.mockClear();
    const response = await POST(request({ scope, frozen }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true, data: frozen.report });
    expect(guards.assertScope).toHaveBeenCalledTimes(2);
  });
  it('rejects stale project/generation and path-based requests', async () => {
    for (const stale of [
      { projectId: 'other-project', generation: 3 },
      { ...scope, generation: 2 },
    ]) {
      expect((await POST(request({ scope: stale, frozen }))).status).toBe(409);
    }
    expect((await POST(request({ scope, path: 'D:/private/project/report.json' }))).status).toBe(
      400,
    );
  });
  it('rejects a tampered bundle instead of trusting its embedded scores', async () => {
    const changed = structuredClone(frozen);
    changed.report.slices[0]!.count = 123;
    const response = await POST(request({ scope, frozen: changed }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.details.reason).toBe(
      'evaluation_digest_or_contract_invalid',
    );
  });
  it('bounds actual streamed bytes even without a Content-Length header', async () => {
    const oversized = new Request('http://localhost/api/study/evaluation', {
      method: 'POST',
      body: ' '.repeat(MAX_EVALUATION_IMPORT_BYTES + 1),
    });
    expect(oversized.headers.has('content-length')).toBe(false);
    const response = await POST(oversized);
    expect(response.status).toBe(400);
    expect((await response.json()).error.details.reason).toBe('evaluation_import_too_large');
    expect(
      (
        await POST(
          new Request('http://localhost/api/study/evaluation', {
            method: 'POST',
            body: '{}',
            headers: { 'content-length': String(MAX_EVALUATION_IMPORT_BYTES + 1) },
          }),
        )
      ).status,
    ).toBe(400);
  });
  it('rejects invalid UTF-8 bytes with the same decode fault contract', async () => {
    const response = await POST(
      new Request('http://localhost/api/study/evaluation', {
        method: 'POST',
        body: new Uint8Array([0x7b, 0xc4, 0xe5, 0x7d]),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.details.reason).toBe('invalid_evaluation_json');
  });
  it('rejects malformed JSON and incompatible contracts', async () => {
    const malformed = await POST(
      new Request('http://localhost/api/study/evaluation', { method: 'POST', body: '{' }),
    );
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.details.error).toContain('http_json_body');
    expect((await POST(request({ scope, frozen: {} }))).status).toBe(400);
  });
  it('keeps the bare invalid-argument contract for a request without a body', async () => {
    const response = await POST(
      new Request('http://localhost/api/study/evaluation', { method: 'POST', body: null }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.details).toBeUndefined();
  });
});
