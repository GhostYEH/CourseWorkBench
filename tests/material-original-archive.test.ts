import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';
import { GET } from '../apps/learning/app/api/study/materials/original/route';
import { createNodeSqliteDriver } from '@sew/study-storage';

describe('binary originals are atomically bound to extracted material revisions', () => {
  let root: string;
  let session: Session;
  const bytes = new TextEncoder().encode('%PDF-1.7\ncontrolled storage fixture');
  const rawText = '〔PDF p.1〕\n\n来源保留的正文';
  const command = () => ({
    projectId: session.projectId,
    displayName: '教材.pdf',
    materialType: 'md' as const,
    rawText,
    rawBytes: new TextEncoder().encode(rawText),
    originalName: '教材.pdf.extraction.md',
    sourceExtraction: {
      format: 'pdf' as const,
      originalName: '教材.pdf',
      bytes,
      extractionVersion: 'fixture-v1',
      locations: [{ ordinal: 0, label: 'PDF p.1' }],
    },
  });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-original-'));
    session = openProjectFromDisk(root);
  });
  afterEach(() => {
    closeProject();
    rmSync(root, { recursive: true, force: true });
  });
  it('preserves byte identity, location receipts and immutable versions across reopening', () => {
    const first = session.store.importMaterial(command()).material;
    const second = session.store.importMaterial({
      ...command(),
      rawText: rawText + '新版本',
      rawBytes: new TextEncoder().encode(rawText + '新版本'),
    }).material;
    expect(second.revision).toBe(2);
    closeProject();
    session = openProjectFromDisk(root);
    const original = session.store.readMaterialExtractionOriginal(first.materialId, 1)!;
    expect(original.bytes).toEqual(bytes);
    expect(original.receipt.extractedTextSha256).toBe(
      createHash('sha256').update(rawText).digest('hex'),
    );
    expect(original.receipt.locations).toEqual([{ ordinal: 0, label: 'PDF p.1' }]);
    expect(session.store.readMaterialRaw(first.materialId, 1).bytes).toEqual(
      new TextEncoder().encode(rawText),
    );
    expect(session.store.readMaterialExtractionOriginal(first.materialId, 1, 'demo')).toBeNull();
  });
  it('rolls back the entire material import when the binary receipt is invalid', () => {
    expect(() =>
      session.store.importMaterial({
        ...command(),
        sourceExtraction: { ...command().sourceExtraction, bytes: new Uint8Array([1]) },
      }),
    ).toThrow();
    expect(session.store.listMaterials()).toHaveLength(0);
    expect(() => session.store.importMaterial({ ...command(), rawBytes: null })).toThrow();
    expect(session.store.listMaterials()).toHaveLength(0);
  });
  it('serves only the exact checked original and refuses generation or hash drift', async () => {
    const material = session.store.importMaterial(command()).material;
    const receipt = session.store.readMaterialExtractionOriginal(material.materialId, 1)!.receipt;
    const query = new URLSearchParams({
      projectId: session.projectId,
      generation: String(session.generation),
      materialId: material.materialId,
      revision: '1',
      sha256: receipt.sourceSha256,
    });
    const response = await GET(
      new Request(`http://localhost/api/study/materials/original?${query}`),
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    query.set('sha256', 'a'.repeat(64));
    expect(
      (await GET(new Request(`http://localhost/api/study/materials/original?${query}`))).status,
    ).toBe(409);
    query.set('generation', String(session.generation + 1));
    expect(
      (await GET(new Request(`http://localhost/api/study/materials/original?${query}`))).status,
    ).toBe(409);
  });
  it('refuses corrupted binary data even when the stored receipt still looks valid', () => {
    const material = session.store.importMaterial(command()).material;
    const db = createNodeSqliteDriver().open(session.store.databaseFile);
    db.prepare('UPDATE material_extraction_originals SET source_bytes=? WHERE material_id=?').run(
      new Uint8Array([1]),
      material.materialId,
    );
    db.close();
    expect(() => session.store.readMaterialExtractionOriginal(material.materialId, 1)).toThrowError(
      expect.objectContaining({ code: 'MATERIAL_RAW_UNVERIFIED' }),
    );
  });
});
