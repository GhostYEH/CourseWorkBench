import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiResponses } from '@sew/study-contracts';
import {
  openProjectFromDisk,
  closeProject,
  type Session,
} from '../apps/learning/lib/server/service';
import { POST } from '../apps/learning/app/api/study/media/recordings/route';
import { encodeRecordingWav } from '../apps/learning/lib/recording-wav';
import { modelConnection } from '../apps/learning/lib/server/model-connection';
import { setSessionToken } from '../apps/learning/lib/client';
import { saveRecording } from '../apps/learning/lib/save-recording';

describe('local recording saves without model dispatch', () => {
  let root: string;
  let session: Session;
  const bytes = encodeRecordingWav([new Float32Array(16000)], 16000);
  const request = (
    body = bytes,
    requestId = 'recording-request-1',
    generation = session.generation,
  ) =>
    new Request(
      `http://localhost/api/study/media/recordings?projectId=${session.projectId}&generation=${generation}`,
      {
        method: 'POST',
        headers: { 'content-type': 'audio/wav', 'x-recording-request-id': requestId },
        body: body as Uint8Array<ArrayBuffer>,
      },
    );
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-recording-'));
    session = openProjectFromDisk(root);
  });
  afterEach(() => {
    setSessionToken(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    closeProject();
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips real WAV bytes, retries idempotently and rejects a reused nonce with new content', async () => {
    const dispatch = vi.spyOn(modelConnection, 'generateMedia');
    const first = await POST(request());
    expect(first.status).toBe(200);
    const asset = apiResponses.recordingAsset.parse((await first.json()).data);
    expect(asset.seconds).toBe(1);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(session.store.getClassroomAsset(session.projectId, asset.assetId)?.bytes).toEqual(bytes);
    expect((await POST(request())).status).toBe(200);
    expect(session.store.listClassroomAssets(session.projectId)).toHaveLength(1);
    const changed = bytes.slice();
    changed[44] = 1;
    expect((await POST(request(changed))).status).toBe(409);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('blocks malformed WAV, stale scopes and encoded bodies before storing', async () => {
    expect((await POST(request(Uint8Array.of(1, 2, 3)))).status).toBe(400);
    expect((await POST(request(bytes, 'id', session.generation + 1))).status).toBe(409);
    const encoded = request();
    encoded.headers.set('content-encoding', 'gzip');
    expect((await POST(encoded)).status).toBe(400);
    const large = request();
    large.headers.set('content-length', String(17 * 1024 * 1024));
    expect((await POST(large)).status).toBe(400);
    expect(session.store.listClassroomAssets(session.projectId)).toHaveLength(0);
  });

  it('rejects a project closed while request bytes are pending', async () => {
    let finish!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => {
          controller.enqueue(bytes);
          controller.close();
        };
      },
    });
    const pending = POST(
      new Request(request().url, {
        method: 'POST',
        headers: request().headers,
        body: stream,
        duplex: 'half',
      } as RequestInit),
    );
    closeProject();
    finish();
    expect((await pending).status).toBe(403);
    session = openProjectFromDisk(root);
    expect(session.store.listClassroomAssets(session.projectId)).toHaveLength(0);
  });

  it('client sends a scoped authenticated WAV and verifies its receipt with unchanged retries', async () => {
    setSessionToken('in-memory-secret');
    const transport = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const actual = new Uint8Array(await (init!.body as Blob).arrayBuffer());
      expect(actual).toEqual(bytes);
      return POST(request(actual, new Headers(init?.headers).get('x-recording-request-id')!));
    });
    vi.stubGlobal('fetch', transport);
    const saved = await saveRecording(
      { projectId: session.projectId, generation: session.generation },
      'retry-id',
      bytes,
      new AbortController().signal,
    );
    const repeat = await saveRecording(
      { projectId: session.projectId, generation: session.generation },
      'retry-id',
      bytes,
      new AbortController().signal,
    );
    expect(repeat.assetId).toBe(saved.assetId);
    expect(transport.mock.calls[0]![0]).not.toContain('in-memory-secret');
    expect(new Headers(transport.mock.calls[0]![1]?.headers).get('x-sew-session')).toBe(
      'in-memory-secret',
    );
    expect(session.store.listClassroomAssets(session.projectId)).toHaveLength(1);
  });
});
