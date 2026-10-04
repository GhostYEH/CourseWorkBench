import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { validateBuildInputs } = require('../scripts/freshness.mjs') as {
  validateBuildInputs: (root: string, buildDirectory: string) => unknown;
};

describe.skipIf(!existsSync('apps/learning/.next/BUILD_ID'))('production model configuration control boundary', () => {
  let child: ChildProcessWithoutNullStreams;
  let temporary: string;
  let lines = '';
  let ready: { origin: string; sessionToken: string; controlToken: string };
  let shutdown = false;
  const secret = 'fake-http-key-never-returned';
  const request = (path: string, body?: unknown, control = false) => fetch(`${ready.origin}${path}`, {
    method: body ? 'POST' : 'GET', headers: {
      origin: ready.origin, 'content-type': 'application/json', 'x-sew-session': ready.sessionToken,
      ...(control ? { 'x-sew-control': ready.controlToken } : {}),
    }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000),
  });
  beforeAll(async () => {
    validateBuildInputs(resolve('.'), resolve('apps/learning/.next'));
    temporary = mkdtempSync(join(tmpdir(), 'sew-model-http-'));
    child = spawn(process.execPath, ['server.mjs', '--user-data', temporary], {
      cwd: resolve('apps/learning'), windowsHide: true,
      env: { ...process.env, NODE_ENV: 'production', SEW_PROJECT_ROOT: '' },
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { lines += chunk; });
    // Do not reflect server diagnostics or credentials into assertion output.
    child.stderr.resume();
    ready = await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Model HTTP service did not start')), 15000);
      child.stdout.on('data', () => {
        for (const line of lines.split('\n')) {
          try {
            const value = JSON.parse(line);
            if (value.type === 'ready') { clearTimeout(timer); accept(value); }
          } catch { /* Partial stdout line. */ }
        }
      });
      child.once('error', () => { clearTimeout(timer); reject(new Error('Model HTTP service start failed')); });
    });
  }, 20000);
  afterAll(async () => {
    if (child?.exitCode === null) {
      const exited = once(child, 'exit');
      if (!shutdown) await request('/internal/shutdown', {}, true).catch(() => undefined);
      await Promise.race([exited, new Promise<void>(resolveWait => setTimeout(resolveWait, 4000))]);
      if (child.exitCode === null) child.kill();
    }
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  });
  it('requires control credentials for configuration/test/cancel and exposes status without a secret', async () => {
    const input = { action: 'configure', config: { provider: 'openai-compatible', baseUrl: 'https://test.example/v1', model: 'muse-spark-1.3', apiKey: secret }, persisted: false };
    expect((await request('/internal/models', input)).status).toBe(401);
    expect((await request('/internal/models', { action: 'test' })).status).toBe(401);
    expect((await request('/internal/models/cancel', {})).status).toBe(401);
    const accepted = await request('/internal/models', input, true);
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).not.toContain(secret);
    const status = await request('/api/study/models');
    expect(status.headers.get('cache-control')).toBe('no-store');
    const value = await status.text();
    expect(value).toContain('muse-spark-1.3');
    expect(value).not.toContain(secret);
    expect(value).toContain('"lastTest":null');
  });
  it('admits its own model cancellation during real service shutdown', async () => {
    const exited = once(child, 'exit');
    const response = await request('/internal/shutdown', {}, true);
    shutdown = true;
    expect(response.status).toBe(200);
    await exited;
    expect(child.exitCode).toBe(0);
    expect(lines).toContain('"type":"model-requests-cancelled"');
  });
});
