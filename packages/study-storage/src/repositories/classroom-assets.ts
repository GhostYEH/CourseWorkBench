import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RecordScope } from '@sew/study-contracts';
import type { SqlDatabase } from '../driver';
import { encodeJson } from '../json-codec';
import { defaultJsonPolicy, readAuthoritativeJsonColumn, recordScope, str, type Row } from './types';

export interface ClassroomAssetRow {
  recordScope: RecordScope;
  assetId: string;
  mediaType: string;
  metadata: Record<string, unknown>;
  bytes: Uint8Array;
  sha256: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ClassroomAssetBindingRow {
  recordScope: RecordScope;
  stageId: string;
  sceneId: string;
  slot: string;
  assetId: string;
  createdAt: string;
  updatedAt: string;
}
export interface ClassroomAssetInfo {
  recordScope: RecordScope;
  assetId: string;
  mediaType: string;
  sha256: string;
  revision: number;
  byteLength: number;
}
export class ClassroomAssetQuotaExceededError extends Error {
  readonly code = 'ASSET_QUOTA_EXCEEDED';
  constructor() { super('classroom asset quota exceeded'); this.name = 'ClassroomAssetQuotaExceededError'; }
}
export class ClassroomAssetReferencedError extends Error {
  readonly code = 'ASSET_IN_USE';
  constructor() { super('课堂资源仍被课件引用，请创建新资源并审核新课件'); this.name = 'ClassroomAssetReferencedError'; }
}
const MAX_PROJECT_ASSET_BYTES = 128 * 1024 * 1024;

const metadataSchema = z.record(z.string(), z.unknown());
const assertMetadata = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('asset metadata must be a JSON object');
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const item = pending.pop()!;
    nodes += 1;
    if (nodes > 20_000 || item.depth > 64) throw new TypeError('asset metadata is too deeply nested or contains too many members');
    if (typeof item.value === 'string') {
      if (item.value.includes('\0')) throw new TypeError('asset metadata contains a prohibited character');
      continue;
    }
    if (typeof item.value === 'number') {
      if (!Number.isFinite(item.value) || Object.is(item.value, -0)) throw new TypeError('asset metadata contains an invalid number');
      continue;
    }
    if (item.value === null || typeof item.value === 'boolean') continue;
    if (Array.isArray(item.value)) {
      if (seen.has(item.value)) throw new TypeError('asset metadata contains a cycle');
      seen.add(item.value);
      for (const child of item.value) pending.push({ value: child, depth: item.depth + 1 });
      continue;
    }
    if (typeof item.value === 'object') {
      if (Object.getPrototypeOf(item.value) !== Object.prototype && Object.getPrototypeOf(item.value) !== null) throw new TypeError('asset metadata contains a non-JSON object');
      if (seen.has(item.value)) throw new TypeError('asset metadata contains a cycle');
      seen.add(item.value);
      for (const [key, child] of Object.entries(item.value)) {
        pending.push({ value: key, depth: item.depth + 1 });
        pending.push({ value: child, depth: item.depth + 1 });
      }
      continue;
    }
    throw new TypeError('asset metadata contains a non-JSON value');
  }
  if ('principal' in value || 'contentHash' in value) throw new TypeError('asset metadata contains a prohibited member');
  return value as Record<string, unknown>;
};
const rowBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  throw new Error('classroom_assets.bytes is not binary data');
};
const assertDigest = (bytes: Uint8Array, digest: string, assetId: string): void => {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== digest) throw new Error(`classroom asset integrity check failed: ${assetId}`);
};

export class ClassroomAssetsRepository {
  constructor(private readonly db: SqlDatabase) {}

  put(projectId: string, assetId: string, mediaType: string, metadata: Record<string, unknown>, bytes: Uint8Array, scope: RecordScope = 'formal'): ClassroomAssetRow {
    const safeMetadata = assertMetadata(metadata);
    const now = new Date().toISOString();
    const copied = new Uint8Array(bytes);
    const sha256 = createHash('sha256').update(copied).digest('hex');
    this.db.transaction(() => {
      if (this.isReferenced(projectId, assetId)) {
        const existing = this.get(projectId, assetId);
        if (!existing || existing.sha256 !== sha256 || existing.mediaType !== mediaType ||
            existing.recordScope !== scope || encodeJson(existing.metadata) !== encodeJson(safeMetadata)) {
          throw new ClassroomAssetReferencedError();
        }
        return; // Identical reviewed import is a no-op; preserve its revision.
      }
      const usage = this.db.prepare(`SELECT COALESCE(SUM(length(bytes)), 0) AS total,
        COALESCE((SELECT length(bytes) FROM classroom_assets WHERE project_id = ? AND asset_id = ?), 0) AS existing
        FROM classroom_assets WHERE project_id = ?`).get(projectId, assetId, projectId) as Row | undefined;
      const total = Number(usage?.['total'] ?? 0);
      const existing = Number(usage?.['existing'] ?? 0);
      if (total - existing + copied.byteLength > MAX_PROJECT_ASSET_BYTES) throw new ClassroomAssetQuotaExceededError();
      this.db.prepare(`INSERT INTO classroom_assets
        (project_id, asset_id, media_type, metadata_json, bytes, sha256, revision, created_at, updated_at, record_scope)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(project_id, asset_id) DO UPDATE SET
          media_type=excluded.media_type, metadata_json=excluded.metadata_json, bytes=excluded.bytes,
          sha256=excluded.sha256, revision=classroom_assets.revision + 1, updated_at=excluded.updated_at, record_scope=excluded.record_scope`)
        .run(projectId, assetId, mediaType, encodeJson(safeMetadata), copied, sha256, now, now, scope);
    });
    const saved = this.get(projectId, assetId);
    if (!saved) throw new Error(`classroom asset write could not be read back: ${assetId}`);
    return saved;
  }

  get(projectId: string, assetId: string): ClassroomAssetRow | null {
    const row = this.db.prepare('SELECT * FROM classroom_assets WHERE project_id = ? AND asset_id = ?').get(projectId, assetId) as Row | undefined;
    if (!row) return null;
    const metadata = assertMetadata(readAuthoritativeJsonColumn(row['metadata_json'], metadataSchema, `classroom_assets.metadata_json[${assetId}]`, defaultJsonPolicy));
    const bytes = rowBytes(row['bytes']);
    const sha256 = str(row['sha256']);
    assertDigest(bytes, sha256, assetId);
    return {
      recordScope: recordScope(row['record_scope']),
      assetId: str(row['asset_id']), mediaType: str(row['media_type']), metadata,
      bytes, sha256,
      revision: Number(row['revision']), createdAt: str(row['created_at']), updatedAt: str(row['updated_at']),
    };
  }

  getInfo(projectId: string, assetId: string): ClassroomAssetInfo | null {
    const row = this.db.prepare(`SELECT asset_id, media_type, sha256, revision, record_scope, length(bytes) AS byte_length
      FROM classroom_assets WHERE project_id = ? AND asset_id = ?`).get(projectId, assetId) as Row | undefined;
    if (!row) return null;
    return { recordScope: recordScope(row['record_scope']), assetId: str(row['asset_id']), mediaType: str(row['media_type']), sha256: str(row['sha256']), revision: Number(row['revision']), byteLength: Number(row['byte_length']) };
  }

  totalBytes(projectId: string): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(length(bytes)), 0) AS total FROM classroom_assets WHERE project_id = ?').get(projectId) as Row | undefined;
    return Number(row?.['total'] ?? 0);
  }

  list(projectId: string): Array<Omit<ClassroomAssetRow, 'bytes'>> {
    const rows = this.db.prepare(`SELECT asset_id, media_type, metadata_json, sha256, revision, created_at, updated_at, record_scope
      FROM classroom_assets WHERE project_id = ? ORDER BY created_at, asset_id`).all(projectId) as Row[];
    return rows.map((row) => ({
      recordScope: recordScope(row['record_scope']),
      assetId: str(row['asset_id']), mediaType: str(row['media_type']),
      metadata: assertMetadata(readAuthoritativeJsonColumn(row['metadata_json'], metadataSchema, `classroom_assets.metadata_json[${str(row['asset_id'])}]`, defaultJsonPolicy)),
      sha256: str(row['sha256']), revision: Number(row['revision']), createdAt: str(row['created_at']), updatedAt: str(row['updated_at']),
    }));
  }

  delete(projectId: string, assetId: string): void {
    this.db.transaction(() => {
      if (this.isReferenced(projectId, assetId)) throw new ClassroomAssetReferencedError();
      this.db.prepare('DELETE FROM classroom_assets WHERE project_id = ? AND asset_id = ?').run(projectId, assetId);
    });
  }

  /**
   * 未被任何课件绑定的资源：回收候选清单。
   *
   * 只返回身份与占用，不返回字节或元数据；分区由参数限定，正式与演示互不越界。
   */
  listUnbound(projectId: string, scope: RecordScope): ClassroomAssetInfo[] {
    const rows = this.db.prepare(`
      SELECT assets.asset_id, assets.media_type, assets.sha256, assets.revision, assets.record_scope,
             length(assets.bytes) AS byte_length
        FROM classroom_assets AS assets
       WHERE assets.project_id = ? AND assets.record_scope = ?
         AND NOT EXISTS (SELECT 1 FROM classroom_asset_bindings AS bindings
                          WHERE bindings.project_id = assets.project_id AND bindings.asset_id = assets.asset_id)
       ORDER BY assets.created_at, assets.asset_id`).all(projectId, scope) as Row[];
    return rows.map((row) => ({
      recordScope: recordScope(row['record_scope']),
      assetId: str(row['asset_id']),
      mediaType: str(row['media_type']),
      sha256: str(row['sha256']),
      revision: Number(row['revision']),
      byteLength: Number(row['byte_length']),
    }));
  }

  /**
   * 显式回收未绑定资源。
   *
   * 在同一事务内重新确认每个候选仍无绑定：任一候选已被课件引用就整体放弃，
   * 避免出现「一半已删除、一半被拒」的部分回收。候选不存在按幂等跳过，
   * 因此重复执行同一批回收不会报错也不会多删。
   */
  reclaim(projectId: string, assetIds: readonly string[], scope: RecordScope): { reclaimed: string[]; freedBytes: number } {
    const requested = [...new Set(assetIds)];
    return this.db.transaction(() => {
      const reclaimed: string[] = [];
      let freedBytes = 0;
      for (const assetId of requested) {
        const info = this.getInfoInScope(projectId, assetId, scope);
        if (!info) continue;
        if (this.isReferenced(projectId, assetId)) throw new ClassroomAssetReferencedError();
        this.db.prepare('DELETE FROM classroom_assets WHERE project_id = ? AND asset_id = ?').run(projectId, assetId);
        freedBytes += info.byteLength;
        reclaimed.push(assetId);
      }
      return { reclaimed, freedBytes };
    });
  }

  private getInfoInScope(projectId: string, assetId: string, scope: RecordScope): ClassroomAssetInfo | null {
    const info = this.getInfo(projectId, assetId);
    return info && info.recordScope === scope ? info : null;
  }

  putBinding(projectId: string, stageId: string, sceneId: string, slot: string, assetId: string, scope: RecordScope = 'formal'): ClassroomAssetBindingRow {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const asset = this.getInfo(projectId, assetId);
      if (!asset || asset.recordScope !== scope) throw new ClassroomAssetReferencedError();
      const existing = this.getBinding(projectId, stageId, sceneId, slot);
      if (existing && (existing.assetId !== assetId || existing.recordScope !== scope)) throw new ClassroomAssetReferencedError();
      this.db.prepare(`INSERT INTO classroom_asset_bindings
        (project_id, stage_id, scene_id, slot, asset_id, created_at, updated_at, record_scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, stage_id, scene_id, slot) DO UPDATE SET asset_id=excluded.asset_id, updated_at=excluded.updated_at`)
        .run(projectId, stageId, sceneId, slot, assetId, now, now, scope);
    });
    const saved = this.getBinding(projectId, stageId, sceneId, slot);
    if (!saved) throw new Error(`classroom asset binding write could not be read back: ${stageId}/${sceneId}/${slot}`);
    return saved;
  }

  getBinding(projectId: string, stageId: string, sceneId: string, slot: string): ClassroomAssetBindingRow | null {
    const row = this.db.prepare(`SELECT * FROM classroom_asset_bindings
      WHERE project_id = ? AND stage_id = ? AND scene_id = ? AND slot = ?`).get(projectId, stageId, sceneId, slot) as Row | undefined;
    return row ? this.mapBinding(row) : null;
  }

  listBindings(projectId: string, stageId: string): ClassroomAssetBindingRow[] {
    const rows = this.db.prepare(`SELECT * FROM classroom_asset_bindings WHERE project_id = ? AND stage_id = ?
      ORDER BY scene_id, slot`).all(projectId, stageId) as Row[];
    return rows.map((row) => this.mapBinding(row));
  }

  private mapBinding(row: Row): ClassroomAssetBindingRow {
    return { recordScope: recordScope(row['record_scope']), stageId: str(row['stage_id']), sceneId: str(row['scene_id']), slot: str(row['slot']), assetId: str(row['asset_id']), createdAt: str(row['created_at']), updatedAt: str(row['updated_at']) };
  }

  private isReferenced(projectId: string, assetId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM classroom_asset_bindings WHERE project_id = ? AND asset_id = ? LIMIT 1').get(projectId, assetId));
  }
}
