import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeProject, openProjectFromDisk } from '../apps/learning/lib/server/service';
import { modelConnection } from '../apps/learning/lib/server/model-connection';
import { GET, POST } from '../apps/learning/app/api/study/models/local/route';

describe('local media configuration HTTP boundary', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sew-local-media-config-'));
    openProjectFromDisk(directory);
  });
  afterEach(() => {
    modelConnection.configureLocalMedia({});
    closeProject();
    rmSync(directory, { recursive: true, force: true });
  });

  it('keeps bearer credentials memory-only, redacts readback and rejects arbitrary workflow JSON', async () => {
    const secret = 'fixture-local-engine-secret';
    const response = await POST(
      new Request('http://localhost/api/study/models/local', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          whisper: {
            baseUrl: 'https://whisper.example/v1',
            model: 'whisper-large-v3',
            bearerToken: secret,
          },
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(secret);
    expect(body).toContain('memory_only');

    const readback = await GET();
    expect(readback.status).toBe(200);
    expect(await readback.text()).not.toContain(secret);

    const invalid = await POST(
      new Request('http://localhost/api/study/models/local', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          whisper: {
            baseUrl: 'https://whisper.example/v1',
            model: 'whisper-large-v3',
            bearerToken: secret,
          },
          workflow: { '1': { class_type: 'PythonShell' } },
        }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(modelConnection.localMediaStatus()).toMatchObject({ whisper: { configured: true } });
  });
});
