/**
 * 考纲原子项（repository）。
 *
 * 条目由人工登记并绑定到已登记材料的某个段落：条目本身只是「可考核范围」的证据登记，
 * 不承载知识点是否被支持的判断。覆盖计数交给 `@sew/study-domain`，这里只保证
 * 编号在记录范围内唯一（重复登记会被拒绝）且来源段落可定位。
 */

import { StudyError, newId, type RecordScope } from '@sew/study-contracts';
import { fingerprintOf } from '@sew/study-domain';
import type { SyllabusItemRecord, SyllabusRequirementRecord } from '@sew/study-domain';
import type { SqlDatabase } from '../driver';
import { encodeJson, syllabusRequirementsSchema } from '../json-codec';
import {
  defaultJsonPolicy,
  num,
  readAuthoritativeJsonColumn,
  recordScope,
  str,
  type Row,
} from './types';

export interface CreateSyllabusItemInput {
  code: string;
  label: string;
  requirements: SyllabusRequirementRecord[];
  source: { materialId: string; revision: number; segmentId: string };
  recordScope: RecordScope;
}

export interface SyllabusItemRow {
  itemId: string;
  code: string;
  label: string;
  recordScope: RecordScope;
  requirements: SyllabusRequirementRecord[];
  source: {
    materialId: string;
    revision: number;
    segmentId: string;
    use: 'scope_basis';
    fingerprint: string;
    excerpt: string;
    /** 材料已有更新版本：条目仍指向旧版本，需要人工重新核对。 */
    sourceStale: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

const SELECT_ITEM = `
  SELECT item.*,
         (SELECT MAX(latest.revision) FROM source_versions AS latest
           WHERE latest.material_id = item.source_material_id) AS source_current_revision
    FROM syllabus_items AS item`;

const mapItem = (row: Row): SyllabusItemRow => ({
  itemId: str(row['item_id']),
  code: str(row['code']),
  label: str(row['label']),
  recordScope: recordScope(row['record_scope']),
  requirements: readAuthoritativeJsonColumn(
    row['requirements_json'],
    syllabusRequirementsSchema,
    `syllabus_items.requirements_json[${str(row['item_id'])}]`,
    defaultJsonPolicy,
  ),
  source: {
    materialId: str(row['source_material_id']),
    revision: num(row['source_revision']),
    segmentId: str(row['source_segment_id']),
    use: 'scope_basis',
    fingerprint: str(row['source_fingerprint']),
    excerpt: str(row['source_excerpt']),
    sourceStale: num(row['source_current_revision']) !== num(row['source_revision']),
  },
  createdAt: str(row['created_at']),
  updatedAt: str(row['updated_at']),
});

export class SyllabusRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * 登记条目。来源段落必须已登记、属于同一记录范围且指纹可重算；
   * 同一范围内重复的考纲编号按 `SYLLABUS_CODE_DUPLICATE` 拒绝，而不是静默合并。
   */
  createItem(input: CreateSyllabusItemInput): SyllabusItemRow {
    const code = input.code.trim();
    if (code.length === 0) throw new StudyError('INVALID_ARGUMENT', { reason: 'empty_code' });
    if (input.requirements.length === 0) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'empty_requirements' });
    }
    if (new Set(input.requirements.map((requirement) => requirement.key)).size !== input.requirements.length) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'duplicate_requirement_key' });
    }
    const duplicate = this.db
      .prepare('SELECT 1 AS ok FROM syllabus_items WHERE record_scope = ? AND code = ? COLLATE NOCASE')
      .get(input.recordScope, code) as Row | undefined;
    if (duplicate) throw new StudyError('SYLLABUS_CODE_DUPLICATE', { code, recordScope: input.recordScope });

    const segment = this.db
      .prepare(
        `SELECT segment.text AS text, segment.fingerprint AS fingerprint
           FROM source_segments AS segment
           JOIN source_versions AS source ON source.material_id = segment.material_id
            AND source.revision = segment.revision
          WHERE segment.material_id = ? AND segment.revision = ? AND segment.segment_id = ?
            AND source.record_scope = ?`,
      )
      .get(input.source.materialId, input.source.revision, input.source.segmentId, input.recordScope) as
      | Row
      | undefined;
    if (!segment) {
      throw new StudyError('SYLLABUS_SOURCE_NOT_LOCATABLE', {
        reason: 'segment_not_found',
        materialId: input.source.materialId,
        revision: input.source.revision,
        segmentId: input.source.segmentId,
      });
    }
    const text = str(segment['text']);
    const fingerprint = str(segment['fingerprint']);
    if (fingerprintOf(text) !== fingerprint) {
      throw new StudyError('SYLLABUS_SOURCE_NOT_LOCATABLE', {
        reason: 'fingerprint_mismatch',
        segmentId: input.source.segmentId,
      });
    }

    const itemId = newId<'syllabus'>('syl');
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO syllabus_items (item_id, code, label, requirements_json, source_material_id, source_revision, source_segment_id, source_fingerprint, source_excerpt, record_scope, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        itemId,
        code,
        input.label,
        encodeJson(input.requirements),
        input.source.materialId,
        input.source.revision,
        input.source.segmentId,
        fingerprint,
        text,
        input.recordScope,
        now,
        now,
      );

    const created = this.getItem(itemId, input.recordScope);
    if (!created) throw new StudyError('INTERNAL', { itemId });
    return created;
  }

  getItem(itemId: string, scope: RecordScope): SyllabusItemRow | null {
    const row = this.db
      .prepare(`${SELECT_ITEM} WHERE item.item_id = ? AND item.record_scope = ?`)
      .get(itemId, scope) as Row | undefined;
    return row ? mapItem(row) : null;
  }

  listItems(scope: RecordScope): SyllabusItemRow[] {
    const rows = this.db
      .prepare(`${SELECT_ITEM} WHERE item.record_scope = ? ORDER BY item.code COLLATE NOCASE ASC`)
      .all(scope) as Row[];
    return rows.map(mapItem);
  }

  /** 领域校验只需要条目的要素与范围；不读来源，避免为一个映射判断扫描段落文本。 */
  countItems(scope: RecordScope): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS total FROM syllabus_items WHERE record_scope = ?')
      .get(scope) as Row | undefined;
    return num(row?.['total'] ?? 0);
  }

  /** 覆盖统计用的最简形状。 */
  recordsForCoverage(scope: RecordScope): SyllabusItemRecord[] {
    return this.listItems(scope).map((item) => ({
      itemId: item.itemId,
      code: item.code,
      label: item.label,
      recordScope: item.recordScope,
      requirements: item.requirements,
    }));
  }
}
