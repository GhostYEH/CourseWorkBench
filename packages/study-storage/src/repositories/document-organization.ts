/**
 * Project-scoped folders and document membership.
 *
 * Folder changes are organization metadata only. They never rewrite a document,
 * source binding, review digest, or classroom state.
 */

import type { SqlDatabase } from '../driver';
import type { Row } from './types';

export interface DocumentFolderRow {
  id: string;
  name: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export class DocumentOrganizationError extends Error {
  constructor(
    message: string,
    readonly kind: 'empty' | 'tooLong' | 'duplicate' | 'limit',
  ) {
    super(message);
    this.name = 'DocumentOrganizationError';
  }
}

const FOLDER_COUNT_LIMIT = 50;
const FOLDER_NAME_MAX_WIDTH = 40;
const FULL_WIDTH_CHARS =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u3000-\u303F\u3040-\u30FF]/;

const displayWidth = (name: string): number => {
  let width = 0;
  for (const character of name) width += FULL_WIDTH_CHARS.test(character) ? 2 : 1;
  return width;
};

const normalizedName = (name: string): string => name.toLowerCase();
const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const string = (value: unknown): string => (typeof value === 'string' ? value : '');

export class DocumentOrganizationRepository {
  constructor(private readonly db: SqlDatabase) {}

  listFolders(projectId: string): DocumentFolderRow[] {
    return (this.db
      .prepare(
        `SELECT id, name, folder_order, created_at, updated_at
           FROM classroom_folders
          WHERE project_id = ?
          ORDER BY folder_order ASC, id ASC`,
      )
      .all(projectId) as Row[]).map((row) => ({
      id: string(row['id']),
      name: string(row['name']),
      order: number(row['folder_order']),
      createdAt: number(row['created_at']),
      updatedAt: number(row['updated_at']),
    }));
  }

  createFolder(
    projectId: string,
    id: string,
    name: string,
    limit = FOLDER_COUNT_LIMIT,
  ): { folder: DocumentFolderRow; reused: boolean } {
    const trimmed = this.validateName(name);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError('folder limit must be a positive safe integer');
    }
    return this.db.transaction(() => {
      const duplicate = this.db
        .prepare(
          `SELECT id FROM classroom_folders
            WHERE project_id = ? AND normalized_name = ?`,
        )
        .get(projectId, normalizedName(trimmed)) as Row | undefined;
      if (duplicate) {
        const existing = this.getFolder(projectId, string(duplicate['id']));
        if (!existing) throw new Error('Folder disappeared during create');
        return { folder: existing, reused: true };
      }

      const count = this.db
        .prepare('SELECT COUNT(*) AS count FROM classroom_folders WHERE project_id = ?')
        .get(projectId) as Row | undefined;
      if (number(count?.['count']) >= limit) {
        throw new DocumentOrganizationError('Folder count limit reached', 'limit');
      }
      const order = this.db
        .prepare(
          `SELECT COALESCE(MAX(folder_order), -1) AS max_order
             FROM classroom_folders WHERE project_id = ?`,
        )
        .get(projectId) as Row | undefined;
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO classroom_folders
             (project_id, id, name, normalized_name, folder_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(projectId, id, trimmed, normalizedName(trimmed), number(order?.['max_order']) + 1, now, now);
      const folder = this.getFolder(projectId, id);
      if (!folder) throw new Error('Created folder could not be read back');
      return { folder, reused: false };
    });
  }

  renameFolder(projectId: string, id: string, name: string): DocumentFolderRow | null {
    const trimmed = this.validateName(name);
    return this.db.transaction(() => {
      const existing = this.getFolder(projectId, id);
      if (!existing) return null;
      const duplicate = this.db
        .prepare(
          `SELECT id FROM classroom_folders
            WHERE project_id = ? AND normalized_name = ? AND id <> ?`,
        )
        .get(projectId, normalizedName(trimmed), id) as Row | undefined;
      if (duplicate) throw new DocumentOrganizationError('A folder with this name already exists', 'duplicate');
      this.db
        .prepare(
          `UPDATE classroom_folders
              SET name = ?, normalized_name = ?, updated_at = ?
            WHERE project_id = ? AND id = ?`,
        )
        .run(trimmed, normalizedName(trimmed), Date.now(), projectId, id);
      return this.getFolder(projectId, id);
    });
  }

  /** Delete a folder and unfile its documents. This operation never deletes documents. */
  deleteFolder(projectId: string, id: string): boolean {
    return this.db.transaction(() => {
      const result = this.db
        .prepare('DELETE FROM classroom_folders WHERE project_id = ? AND id = ?')
        .run(projectId, id);
      return result.changes > 0;
    });
  }

  /**
   * Set folder membership. Assignments require a document and folder in this
   * project; clearing membership is idempotent even after a document is gone.
   */
  setStageFolder(projectId: string, stageId: string, folderId: string | null): boolean {
    if (folderId === null) {
      this.db
        .prepare('DELETE FROM classroom_document_folders WHERE project_id = ? AND stage_id = ?')
        .run(projectId, stageId);
      return true;
    }
    return this.db.transaction(() => {
      const folder = this.getFolder(projectId, folderId);
      if (!folder) return false;
      const document = this.db
        .prepare('SELECT 1 AS present FROM classroom_documents WHERE project_id = ? AND stage_id = ?')
        .get(projectId, stageId) as Row | undefined;
      if (!document) return false;
      this.db
        .prepare(
          `INSERT INTO classroom_document_folders (project_id, stage_id, folder_id)
           VALUES (?, ?, ?)
           ON CONFLICT(project_id, stage_id) DO UPDATE SET folder_id = excluded.folder_id`,
        )
        .run(projectId, stageId, folderId);
      return true;
    });
  }

  listDocumentFolderIds(projectId: string): Map<string, string> {
    const rows = this.db
      .prepare(
        `SELECT membership.stage_id, membership.folder_id
           FROM classroom_document_folders AS membership
           JOIN classroom_folders AS folder
             ON folder.project_id = membership.project_id AND folder.id = membership.folder_id
          WHERE membership.project_id = ?`,
      )
      .all(projectId) as Row[];
    return new Map(rows.map((row) => [string(row['stage_id']), string(row['folder_id'])]));
  }

  private getFolder(projectId: string, id: string): DocumentFolderRow | null {
    const row = this.db
      .prepare(
        `SELECT id, name, folder_order, created_at, updated_at
           FROM classroom_folders WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, id) as Row | undefined;
    if (!row) return null;
    return {
      id: string(row['id']),
      name: string(row['name']),
      order: number(row['folder_order']),
      createdAt: number(row['created_at']),
      updatedAt: number(row['updated_at']),
    };
  }

  private validateName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) throw new DocumentOrganizationError('Folder name must not be empty', 'empty');
    if (displayWidth(trimmed) > FOLDER_NAME_MAX_WIDTH) {
      throw new DocumentOrganizationError('Folder name is too long', 'tooLong');
    }
    return trimmed;
  }
}
