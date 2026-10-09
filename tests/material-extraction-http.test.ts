import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipFixture } from './helpers/office-zip-fixture';
import {
  authorizePaths,
  closeProject,
  openProjectFromDisk,
} from '../apps/learning/lib/server/service';
import { POST as extract } from '../apps/learning/app/api/study/materials/extract/route';
import { POST as importExtracted } from '../apps/learning/app/api/study/materials/import-extracted/route';

const request = (path: string, body: unknown): Request =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('material extraction HTTP consumer', () => {
  let directory: string;
  let session: ReturnType<typeof openProjectFromDisk>;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sew-material-extraction-http-'));
    session = openProjectFromDisk(directory);
  });
  afterEach(() => {
    closeProject();
    rmSync(directory, { recursive: true, force: true });
  });

  it('uses a source-bound preview token and refuses renderer-substituted extracted text', async () => {
    const path = join(directory, 'notes.docx');
    const source = zipFixture({
      '[Content_Types].xml':
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      'word/document.xml':
        '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>HTTP 路由提取正文</w:t></w:r></w:p></w:body></w:document>',
    });
    writeFileSync(path, source);
    authorizePaths([path]);
    const scope = { projectId: session.projectId, generation: session.generation };
    const previewResponse = await extract(
      request('/api/study/materials/extract', { scope, sourcePath: path }),
    );
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.headers.get('cache-control')).toBe('no-store');
    const previewEnvelope = (await previewResponse.json()) as {
      data: { extractionId: string; extractedText: string };
    };
    expect(previewEnvelope.data.extractedText).toContain('HTTP 路由提取正文');
    const malicious = await importExtracted(
      request('/api/study/materials/import-extracted', {
        scope,
        extractionId: previewEnvelope.data.extractionId,
        displayName: 'notes.docx',
        extractedText: 'renderer-substituted',
      }),
    );
    expect(malicious.status).toBe(400);
    const confirmed = await importExtracted(
      request('/api/study/materials/import-extracted', {
        scope,
        extractionId: previewEnvelope.data.extractionId,
        displayName: 'notes.docx',
      }),
    );
    expect(confirmed.status).toBe(200);
    expect(await confirmed.text()).toContain('HTTP 路由提取正文');
    expect(session.store.listMaterials()).toHaveLength(1);
  });

  it('refuses a source path that was neither picked nor inside the active project', async () => {
    const outsideDirectory = mkdtempSync(join(tmpdir(), 'sew-material-extraction-outside-'));
    try {
      const path = join(outsideDirectory, 'unselected.docx');
      writeFileSync(
        path,
        zipFixture({
          '[Content_Types].xml':
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
          'word/document.xml':
            '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>outside</w:t></w:r></w:p></w:body></w:document>',
        }),
      );
      const response = await extract(
        request('/api/study/materials/extract', {
          scope: { projectId: session.projectId, generation: session.generation },
          sourcePath: path,
        }),
      );
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(outsideDirectory);
    } finally {
      rmSync(outsideDirectory, { recursive: true, force: true });
    }
  });
});
