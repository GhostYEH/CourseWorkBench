import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GET as getPbl, POST as postPbl } from '../apps/learning/app/api/study/pbl/route';
import { POST as postSimulation } from '../apps/learning/app/api/study/pbl/simulation/route';
import { POST as runtimePost } from '../apps/learning/app/api/maic/runtime/[...segments]/route';
import { closeProject, openProjectFromDisk } from '../apps/learning/lib/server/service';

const roots: string[] = [];
const scopeHeaders = (session: ReturnType<typeof openProjectFromDisk>) => ({
  'content-type': 'application/json',
  'x-sew-project-id': session.projectId,
  'x-sew-generation': String(session.generation),
});
afterEach(() => {
  closeProject();
  const holder = (globalThis as { __sewSession?: { environmentBootstrapSuppressed?: boolean } })
    .__sewSession;
  if (holder) holder.environmentBootstrapSuppressed = false;
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('PBL HTTP authority boundary', () => {
  it('uses scoped no-store reads and refuses raw renderer AI output before any record partition is touched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-pbl-http-'));
    roots.push(root);
    const session = openProjectFromDisk(root);
    const read = await getPbl(
      new Request('http://local/api/study/pbl?lessonId=lesson_missing&lessonVersion=1', {
        headers: scopeHeaders(session),
      }),
    );
    expect(read.status).toBe(200);
    expect(read.headers.get('cache-control')).toBe('no-store');
    expect(await read.json()).toMatchObject({ ok: true, data: null });

    const denied = await postPbl(
      new Request('http://local/api/study/pbl', {
        method: 'POST',
        headers: scopeHeaders(session),
        body: JSON.stringify({
          scope: { projectId: session.projectId, generation: session.generation },
          binding: {
            version: 1,
            stageId: 'stage_any',
            definitionId: 'pbl_any',
            documentDigest: 'doc',
            definitionDigest: 'def',
          },
          operation: 'contribute',
          actorUid: session.learnerUid,
          nonce: 'renderer-ai',
          contribution: {
            roleId: 'peer_ai',
            taskId: 'task',
            milestoneId: null,
            content: 'renderer cannot submit this',
            basisArtifactIds: ['pbl_art_fake'],
          },
        }),
      }),
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get('cache-control')).toBe('no-store');
    expect(await denied.json()).toMatchObject({
      ok: false,
      error: { code: 'ROLE_PERMISSION_DENIED' },
    });
    expect(
      session.store.runtime.listSessions(session.projectId, 'stage_any', session.learnerUid),
    ).toEqual([]);
  });

  it('blocks generic RuntimeStore writes to protected PBL partitions and keeps simulation failures uncached', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-pbl-http-runtime-'));
    roots.push(root);
    const session = openProjectFromDisk(root);
    const blocked = await runtimePost(
      new Request('http://local/api/maic/runtime/sessions', {
        method: 'POST',
        headers: scopeHeaders(session),
        body: JSON.stringify({
          id: 'sew-pbl-record-v1-attacker',
          kind: 'pblRecords',
          stageId: 'stage_any',
          learnerKey: 'caller-chosen',
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      }),
      { params: Promise.resolve({ segments: ['sessions'] }) },
    );
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get('cache-control')).toBe('no-store');

    const invalidSimulation = await postSimulation(
      new Request('http://local/api/study/pbl/simulation', {
        method: 'POST',
        headers: scopeHeaders(session),
        body: JSON.stringify({
          scope: { projectId: session.projectId, generation: session.generation },
          binding: {
            version: 1,
            stageId: 'stage_any',
            definitionId: 'pbl_any',
            documentDigest: 'doc',
            definitionDigest: 'def',
          },
          maxSteps: 1,
          steps: [{ operation: 'submit', actorUid: session.learnerUid, nonce: 'missing-fields' }],
        }),
      }),
    );
    expect(invalidSimulation.status).toBe(400);
    expect(invalidSimulation.headers.get('cache-control')).toBe('no-store');
  });
});
