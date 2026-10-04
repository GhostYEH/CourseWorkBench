import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createModelConnectionRuntime } from '../apps/learning/lib/server/model-connection';
import { modelConnectionStatusSchema, modelConnectionInputSchema } from '@sew/study-contracts';
const require = createRequire(import.meta.url);
const { createSettings } = require('../apps/desktop/src/settings.cjs');
const { validateModelConfig } = require('../apps/desktop/src/model-config.cjs');
const config = { provider: 'openai-compatible' as const, baseUrl: 'https://test.example/v1', model: 'muse-spark-1.3', apiKey: 'fake-test-secret' };
const success = () => Response.json({ model: 'muse-spark-1.3-contributor', choices: [{ message: { content: 'OK' } }], usage: { total_tokens: 47 } });
const waitingFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error(config.apiKey)), { once: true }));

describe('write-only model credentials and guarded real-call adapter', () => {
  it('does not call without configuration and rejects credential-bearing or non-HTTPS URLs', async () => {
    let calls = 0;
    const runtime = createModelConnectionRuntime({ fetcher: async () => { calls++; return success(); } });
    expect((await runtime.test()).ok).toBe(false);
    expect(calls).toBe(0);
    for (const baseUrl of ['http://test.example/v1', 'https://key:test@test.example/v1', 'https://test.example/v1?key=secret']) {
      expect(modelConnectionInputSchema.safeParse({ ...config, baseUrl }).success).toBe(false);
      expect(() => validateModelConfig({ ...config, baseUrl })).toThrow();
    }
  });
  it('uses the selected endpoint/model, bounded prompt, no redirects or retries, and no secret readback', async () => {
    let calls = 0;
    const runtime = createModelConnectionRuntime({ fetcher: async (url, init) => {
      calls++;
      expect(url).toBe('https://test.example/v1/chat/completions');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${config.apiKey}`);
      expect(init?.body).toBe(JSON.stringify({ model: config.model, messages: [{ role: 'user', content: 'Reply exactly OK.' }], max_tokens: 1024, stream: false }));
      return success();
    } });
    runtime.configure(config, true);
    expect(await runtime.test()).toMatchObject({ ok: true, requestedModel: config.model, returnedModel: 'muse-spark-1.3-contributor', totalTokens: 47 });
    expect(calls).toBe(1);
    expect(modelConnectionStatusSchema.safeParse(runtime.status()).success).toBe(true);
    expect(JSON.stringify(runtime.status())).not.toContain(config.apiKey);
  });
  it('rejects HTTP errors and malformed/empty/oversized replies without leaking provider text', async () => {
    for (const response of [
      new Response(config.apiKey, { status: 401 }),
      Response.json({ choices: [{ message: { content: null } }] }),
      Response.json({ choices: [{ message: { content: 123 } }] }),
      new Response('x'.repeat(129 * 1024)),
    ]) {
      const runtime = createModelConnectionRuntime({ fetcher: async () => response });
      runtime.configure(config, false);
      const result = await runtime.test();
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(config.apiKey);
    }
  });
  it('enforces the explicit call budget even when configuration is replaced', async () => {
    let calls = 0;
    const runtime = createModelConnectionRuntime({ now: () => 10_000, fetcher: async () => { calls++; return success(); } });
    runtime.configure(config, true);
    for (let i = 0; i < 3; i++) expect((await runtime.test()).ok).toBe(true);
    runtime.configure({ ...config, model: 'other' }, true);
    expect((await runtime.test()).ok).toBe(false);
    expect(calls).toBe(3);
  });
  it('cancels old calls when config changes and refuses parallel calls', async () => {
    const runtime = createModelConnectionRuntime({ fetcher: waitingFetch });
    runtime.configure(config, true);
    const pending = runtime.test();
    expect((await runtime.test()).ok).toBe(false);
    runtime.configure({ ...config, model: 'new-model' }, true);
    expect((await pending).ok).toBe(false);
    expect(runtime.status().lastTest).toBeNull();
    expect(runtime.status().model).toBe('new-model');
  });
  it('bounds duration and treats explicit cancellation as a cancelled diagnostic', async () => {
    const runtime = createModelConnectionRuntime({ fetcher: waitingFetch, deadlineMs: 5 });
    runtime.configure(config, true);
    expect((await runtime.test()).message).toContain('超时');
    const external = new AbortController();
    const pending = runtime.test(external.signal);
    external.abort();
    expect((await pending).message).toContain('取消');
  });
  it('ignores a late success after shutdown even if the transport ignores cancellation', async () => {
    let resolveReply: (response: Response) => void = () => undefined;
    const runtime = createModelConnectionRuntime({ fetcher: async () => new Promise(resolve => { resolveReply = resolve; }) });
    runtime.configure(config, true);
    const pending = runtime.test();
    runtime.cancel(); resolveReply(success());
    expect((await pending).ok).toBe(false);
    expect(runtime.status().lastTest).toBeNull();
    expect((await runtime.test()).message).toContain('退出');
  });
  it('restores encrypted credentials, refuses corrupt disk values, and never writes plaintext on fallback', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sew-model-key-'));
    const app = { getPath: () => directory };
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (text: string) => Buffer.from(text).map(byte => byte ^ 0x5a),
      decryptString: (bytes: Buffer) => Buffer.from(Buffer.from(bytes).map(byte => byte ^ 0x5a)).toString('utf8'),
    };
    try {
      const first = createSettings({ app, safeStorage });
      expect(first.saveModelCredentials(config)).toEqual({ persisted: true });
      expect(readFileSync(first.credentialFile()).toString()).not.toContain(config.apiKey);
      const reopened = createSettings({ app, safeStorage });
      expect(reopened.readModelCredentials()).toEqual({ config, persisted: true });
      writeFileSync(first.credentialFile(), 'broken encrypted record');
      expect(reopened.readModelCredentials()).toBeNull();
      const fallback = createSettings({ app, safeStorage: { ...safeStorage, isEncryptionAvailable: () => false } });
      expect(fallback.saveModelCredentials(config)).toEqual({ persisted: false });
      expect(fallback.readModelCredentials()).toEqual({ config, persisted: false });
      expect(readFileSync(first.credentialFile()).toString()).toBe('broken encrypted record');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
