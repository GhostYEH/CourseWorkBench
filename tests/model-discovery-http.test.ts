import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const discovery = vi.hoisted(() => vi.fn());
vi.mock('../apps/learning/lib/server/model-connection', () => ({
  modelConnection: { discoverModels: discovery },
}));

import { closeProject, openProjectFromDisk } from '../apps/learning/lib/server/service';
import { POST } from '../apps/learning/app/api/study/models/discover/route';

describe('model discovery HTTP consumer', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sew-model-discovery-'));
    openProjectFromDisk(directory);
    discovery.mockReset();
    discovery.mockResolvedValue({
      ok: true,
      message: '已从 anthropic 获取 1 个模型名称',
      models: ['claude-sonnet-4-6'],
      elapsedMs: 8,
    });
  });

  afterEach(() => {
    closeProject();
    rmSync(directory, { recursive: true, force: true });
  });

  it('requires an open project session before accessing the in-memory provider config', async () => {
    closeProject();
    const response = await POST(
      new Request('http://localhost/api/study/models/discover', { method: 'POST' }),
    );
    expect(response.status).toBe(403);
    expect(discovery).not.toHaveBeenCalled();
  });

  it('discovers only on the explicit POST and returns the strict, credential-free result', async () => {
    const response = await POST(
      new Request('http://localhost/api/study/models/discover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The route never accepts renderer-supplied credentials or provider config.
        body: JSON.stringify({ apiKey: 'renderer-secret', provider: 'anthropic' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('renderer-secret');
    expect(discovery).toHaveBeenCalledTimes(1);
    expect(discovery.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });
});
