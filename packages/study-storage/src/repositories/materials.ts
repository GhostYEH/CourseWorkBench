/**
 * 材料版本与真题来源核实（repository）。
 *
 * `source_versions` 是不可变材料版本；`material_exam_verifications` 是服务端权威事实，
 * 记录某材料版本是否已由人工审核核实为考试真题来源。题目身份据此派生，请求方不能自报。
 *
 * 材料重新导入需要把受影响的已核实知识点转为失效；该跨域动作由调用方通过
 * `invalidateKnowledge` 回调注入，并在同一事务内完成，保证原子性。
 */

import { StudyError, newId } from '@sew/study-contracts';
import type { RecordScope } from '@sew/study-contracts';
import { normalizeMaterial, type MaterialChangeImpact } from '@sew/study-domain';
import type { SqlDatabase } from '../driver';
import { evidenceListSchema } from '../json-codec';
import {
  defaultJsonPolicy,
  mapMaterial,
  num,
  readJsonColumn,
  str,
  type ImportMaterialInput,
  type MaterialRow,
  type Row,
  type SegmentRow,
} from './types';

export interface MaterialImportHooks {
  /** 在导入事务内重算并失效受影响知识点；返回影响列表。 */
  invalidateKnowledge: (currentRevisions: Record<string, number>, scope: RecordScope) => MaterialChangeImpact[];
}

export interface MaterialImportOutcome {
  material: MaterialRow;
  segments: SegmentRow[];
  invalidated: MaterialChangeImpact[];
}

export interface VerifyMaterialAsExamInput {
  materialId: string;
  revision: number;
  note?: string | undefined;
}

export class MaterialsRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** 导入材料：登记新版本、切分段落、重算指纹，并由回调在同一事务内失效受影响知识点。 */
  importMaterial(input: ImportMaterialInput, hooks: MaterialImportHooks): MaterialImportOutcome {
    const normalized = normalizeMaterial(input.rawText);
    if (normalized.segments.length === 0) {
      throw new StudyError('MATERIAL_TYPE_UNSUPPORTED', { reason: 'empty_material' }, '材料内容为空，无法切分段落');
    }

    // 同名材料沿用既有 materialId，重新导入产生新 revision，旧版本保留。
    const matched = this.db
      .prepare('SELECT material_id, MAX(revision) AS rev FROM source_versions WHERE display_name = ? AND record_scope = ? GROUP BY material_id')
      .get(input.displayName, input.recordScope ?? 'formal') as Row | undefined;
    const materialId = matched ? str(matched['material_id']) : newId<'material'>('mat');
    const revision = matched ? Number(matched['rev']) + 1 : 1;

    const now = new Date().toISOString();
    const invalidated = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO source_versions (material_id, revision, display_name, material_type, readable_location, imported_at, normalization_version, fingerprint, normalized_text, segment_count, record_scope)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          materialId,
          revision,
          input.displayName,
          input.materialType,
          input.readableLocation ?? null,
          now,
          normalized.normalizationVersion,
          normalized.fingerprint,
          normalized.normalizedText,
          normalized.segments.length,
          input.recordScope ?? 'formal',
        );

      const insertSegment = this.db.prepare(
        `INSERT INTO source_segments (material_id, revision, segment_id, ordinal, text, fingerprint)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const segment of normalized.segments) {
        insertSegment.run(materialId, revision, segment.segmentId, segment.ordinal, segment.text, segment.fingerprint);
      }

      const scope = input.recordScope ?? 'formal';
      return hooks.invalidateKnowledge(this.currentRevisions(scope), scope);
    });

    const material = this.getMaterial(materialId, revision, input.recordScope ?? 'formal');
    if (!material) throw new StudyError('INTERNAL', { materialId });
    return { material, segments: this.getSegments(materialId, revision), invalidated };
  }

  listMaterials(scope: RecordScope = 'formal'): MaterialRow[] {
    const rows = this.db
      .prepare(
        `SELECT v.* FROM source_versions v
         WHERE v.record_scope = ?
           AND v.revision = (SELECT MAX(revision) FROM source_versions s WHERE s.material_id = v.material_id)
         ORDER BY v.imported_at DESC`,
      )
      .all(scope) as Row[];
    const references = this.referenceCounts();
    return rows.map((row) =>
      mapMaterial({
        ...row,
        referenced: references.get(`${str(row['material_id'])}|${num(row['revision'])}`) ?? 0,
      }),
    );
  }

  getMaterial(materialId: string, revision?: number, scope: RecordScope = 'formal'): MaterialRow | null {
    const row = (
      revision === undefined
        ? this.db
            .prepare(
              `SELECT * FROM source_versions WHERE material_id = ? AND record_scope = ? ORDER BY revision DESC LIMIT 1`,
            )
            .get(materialId, scope)
        : this.db
            .prepare('SELECT * FROM source_versions WHERE material_id = ? AND revision = ? AND record_scope = ?')
            .get(materialId, revision, scope)
    ) as Row | undefined;
    if (!row) return null;
    const referenced = this.referenceCounts().get(`${materialId}|${num(row['revision'])}`) ?? 0;
    return mapMaterial({ ...row, referenced });
  }

  /**
   * 统计每个 `(materialId, revision)` 被多少条知识点证据精确引用。
   * 不跨 revision 用子串匹配：id 前缀重叠会多计，且旧版本引用不应算作当前版本。
   * 同一知识点对同一材料版本只计一次。
   */
  private referenceCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    const rows = this.db.prepare('SELECT evidence_json FROM knowledge_points').all() as Row[];
    for (const row of rows) {
      const evidence = readJsonColumn(
        row['evidence_json'],
        evidenceListSchema,
        [],
        'knowledge_points.evidence_json',
        defaultJsonPolicy,
      );
      const seen = new Set<string>();
      for (const item of evidence) {
        const key = `${item.materialId}|${item.revision}`;
        if (seen.has(key)) continue;
        seen.add(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  }

  getSegments(materialId: string, revision: number): SegmentRow[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM source_segments WHERE material_id = ? AND revision = ? ORDER BY ordinal ASC',
        )
        .all(materialId, revision) as Row[]
    ).map((row) => ({
      materialId: str(row['material_id']),
      revision: num(row['revision']),
      segmentId: str(row['segment_id']),
      ordinal: num(row['ordinal']),
      text: str(row['text']),
      fingerprint: str(row['fingerprint']),
    }));
  }

  currentRevisions(scope: RecordScope = 'formal'): Record<string, number> {
    const rows = this.db
      .prepare('SELECT material_id, MAX(revision) AS rev FROM source_versions WHERE record_scope = ? GROUP BY material_id')
      .all(scope) as Row[];
    const result: Record<string, number> = {};
    for (const row of rows) result[str(row['material_id'])] = num(row['rev']);
    return result;
  }

  lookupSegment(materialId: string, revision: number, segmentId: string, scope: RecordScope = 'formal') {
    const row = this.db
      .prepare(
        `SELECT segments.* FROM source_segments AS segments
         JOIN source_versions AS source ON source.material_id = segments.material_id AND source.revision = segments.revision
         WHERE segments.material_id = ? AND segments.revision = ? AND segments.segment_id = ? AND source.record_scope = ?`,
      )
      .get(materialId, revision, segmentId, scope) as Row | undefined;
    if (!row) return undefined;
    return {
      materialId: str(row['material_id']),
      revision: num(row['revision']),
      segmentId: str(row['segment_id']),
      text: str(row['text']),
      fingerprint: str(row['fingerprint']),
    };
  }

  /**
   * 核实某材料版本可作为考试真题来源。要求该版本已存在于 `source_versions`，
   * 否则拒绝；重复核实幂等更新，不产生重复行。
   */
  verifyMaterialAsExam(input: VerifyMaterialAsExamInput): {
    materialId: string;
    revision: number;
    verifiedAt: string;
  } {
    const exists = this.db
      .prepare("SELECT 1 AS ok FROM source_versions WHERE material_id = ? AND revision = ? AND record_scope = 'formal'")
      .get(input.materialId, input.revision) as Row | undefined;
    if (!exists) {
      throw new StudyError('NOT_FOUND', { materialId: input.materialId, revision: input.revision });
    }
    const verifiedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO material_exam_verifications (material_id, revision, verified_by, verified_at, note)
         VALUES (?, ?, 'human_review', ?, ?)
         ON CONFLICT(material_id, revision) DO UPDATE SET
           verified_by = excluded.verified_by,
           verified_at = excluded.verified_at,
           note = excluded.note`,
      )
      .run(input.materialId, input.revision, verifiedAt, input.note ?? '');
    return { materialId: input.materialId, revision: input.revision, verifiedAt };
  }

  isMaterialVerifiedAsExam(materialId: string, revision: number): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS ok FROM material_exam_verifications AS verification
        JOIN source_versions AS source USING (material_id, revision)
        WHERE material_id = ? AND revision = ? AND source.record_scope = 'formal'`)
      .get(materialId, revision) as Row | undefined;
    return row !== undefined;
  }
}
