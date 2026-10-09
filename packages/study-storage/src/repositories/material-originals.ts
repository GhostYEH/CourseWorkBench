import { createHash } from 'node:crypto';
import { StudyError, materialOriginalReceiptSchema, type RecordScope } from '@sew/study-contracts';
import type { SqlDatabase } from '../driver';
import { decodeJson, encodeJson } from '../json-codec';
import type { ImportMaterialInput } from './types';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export class MaterialOriginalsRepository {
  constructor(private readonly db: SqlDatabase) {}
  /** Called inside the import transaction, binding the binary original to the extracted revision. */
  insert(materialId: string, revision: number, input: ImportMaterialInput, at: string) {
    const extraction = input.sourceExtraction;
    if (!extraction) return;
    const bytes = new Uint8Array(extraction.bytes);
    const signature = Buffer.from(bytes.subarray(0, 5));
    if (
      extraction.format === 'pdf'
        ? signature.toString('ascii') !== '%PDF-'
        : signature.subarray(0, 4).toString('hex') !== '504b0304'
    )
      throw new StudyError('MATERIAL_RAW_UNVERIFIED', { reason: 'original_container_signature' });
    const receipt = materialOriginalReceiptSchema.parse({
      schemaVersion: 1,
      materialId,
      revision,
      format: extraction.format,
      originalName: extraction.originalName,
      sourceSha256: sha(bytes),
      sourceByteLength: bytes.length,
      extractedTextSha256: sha(input.rawText),
      extractionVersion: extraction.extractionVersion,
      locations: extraction.locations,
      archivedAt: at,
    });
    const total = this.db
      .prepare(
        'SELECT COALESCE(SUM(source_byte_length),0) AS total FROM material_extraction_originals',
      )
      .get() as { total: number };
    if (Number(total.total) + bytes.length > 256 * 1024 ** 2)
      throw new StudyError('BUDGET_EXCEEDED', { reason: 'material_original_quota' });
    this.db
      .prepare(
        'INSERT INTO material_extraction_originals(material_id,revision,receipt_json,source_sha256,source_byte_length,source_bytes) VALUES(?,?,?,?,?,?)',
      )
      .run(materialId, revision, encodeJson(receipt), receipt.sourceSha256, bytes.length, bytes);
  }
  read(materialId: string, revision: number, scope: RecordScope = 'formal') {
    const row = this.db
      .prepare(
        `SELECT original.*, archive.raw_sha256 AS extracted_sha FROM material_extraction_originals AS original
      JOIN source_versions AS source USING(material_id,revision)
      JOIN source_raw_archives AS archive USING(material_id,revision)
      WHERE original.material_id=? AND original.revision=? AND source.record_scope=?`,
      )
      .get(materialId, revision, scope) as
      | {
          receipt_json: unknown;
          source_sha256: string;
          source_byte_length: number;
          source_bytes: unknown;
          extracted_sha: string;
        }
      | undefined;
    if (!row) return null;
    const parsed = decodeJson(
      row.receipt_json,
      materialOriginalReceiptSchema.nullable(),
      null,
      'material_extraction_originals',
    );
    const receipt = parsed.value;
    if (
      !parsed.ok ||
      !receipt ||
      receipt.materialId !== materialId ||
      receipt.revision !== revision ||
      receipt.sourceSha256 !== row.source_sha256 ||
      receipt.sourceByteLength !== row.source_byte_length ||
      receipt.extractedTextSha256 !== row.extracted_sha ||
      !(row.source_bytes instanceof Uint8Array) ||
      row.source_bytes.length !== receipt.sourceByteLength ||
      sha(row.source_bytes) !== receipt.sourceSha256
    )
      throw new StudyError('MATERIAL_RAW_UNVERIFIED', { reason: 'extraction_original_changed' });
    return { receipt, bytes: new Uint8Array(row.source_bytes) };
  }
}
