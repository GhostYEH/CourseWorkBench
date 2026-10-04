/**
 * 课堂文档、场景来源侧表与课堂状态（repository）。
 *
 * 课堂文档沿用 OpenMAIC DSL 的 `{ stage, scenes }` 形状，按 `(project_id, stage_id)`
 * 分区：另一个项目读不到、也写不进当前项目的同名 stage。
 *
 * `document_json` 与来源绑定都是权威列：损坏时拒绝使用，不能回退成「没有场景」。
 */

import type { SqlDatabase } from '../driver';
import type { RecordScope } from '@sew/study-contracts';
import { arbitrarySchema, encodeJson, knowledgeIdsSchema } from '../json-codec';
import {
  defaultJsonPolicy,
  nullableStr,
  num,
  readAuthoritativeJsonColumn,
  recordScope,
  str,
  type Row,
} from './types';

export interface ClassroomDocumentRow {
  recordScope: RecordScope;
  projectId: string;
  stageId: string;
  lessonId: string;
  dslVersion: string;
  document: unknown;
  digest: string;
  sceneCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ClassroomSceneSourceRow {
  recordScope: RecordScope;
  sceneId: string;
  knowledgeIds: string[];
  questionId: string | null;
  reviewedBy: string;
  reviewNote: string;
}

export interface ClassroomStateRow {
  stageId: string;
  currentSceneId: string;
  revision: number;
  updatedAt: string;
}

export interface SaveClassroomDocumentInput {
  recordScope?: RecordScope;
  projectId: string;
  stageId: string;
  lessonId: string;
  dslVersion: string;
  document: unknown;
  digest: string;
  sceneCount: number;
  scenes: Array<{ sceneId: string; knowledgeIds: string[]; questionId: string | null }>;
  reviewedBy: string;
  reviewNote: string;
}

const sceneIdsOf = (document: unknown): string[] => {
  const scenes = (document as { scenes?: unknown })?.scenes;
  if (!Array.isArray(scenes)) return [];
  return scenes
    .map((scene) => (scene && typeof scene === 'object' ? str((scene as Row)['id']) : ''))
    .filter((id) => id.length > 0);
};

export class ClassroomRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** 写入审核课件：文档与其来源绑定在同一事务落库，重复写入幂等。 */
  saveDocument(input: SaveClassroomDocumentInput): ClassroomDocumentRow {
    const now = new Date().toISOString();
    const documentJson = encodeJson(input.document);
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO classroom_documents
             (stage_id, project_id, lesson_id, dsl_version, document_json, digest, scene_count, created_at, updated_at, record_scope)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, stage_id) DO UPDATE SET
             lesson_id = excluded.lesson_id,
             dsl_version = excluded.dsl_version,
             document_json = excluded.document_json,
             digest = excluded.digest,
             scene_count = excluded.scene_count,
             record_scope = excluded.record_scope,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.stageId,
          input.projectId,
          input.lessonId,
          input.dslVersion,
          documentJson,
          input.digest,
          input.sceneCount,
          now,
          now,
          input.recordScope ?? 'formal',
        );

      this.db
        .prepare('DELETE FROM classroom_scene_sources WHERE project_id = ? AND stage_id = ?')
        .run(input.projectId, input.stageId);

      const insert = this.db.prepare(
        `INSERT INTO classroom_scene_sources
           (project_id, stage_id, scene_id, knowledge_ids_json, question_id, reviewed_by, review_note, created_at, updated_at, record_scope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const scene of input.scenes) {
        insert.run(
          input.projectId,
          input.stageId,
          scene.sceneId,
          encodeJson(scene.knowledgeIds),
          scene.questionId,
          input.reviewedBy,
          input.reviewNote,
          now,
          now,
          input.recordScope ?? 'formal',
        );
      }
      const saved = this.getDocument(input.projectId, input.stageId);
      if (!saved) {
        throw new Error(`classroom_documents 写入后无法读回：${input.stageId}`);
      }
      return saved;
    });
  }

  getDocument(projectId: string, stageId: string): ClassroomDocumentRow | null {
    const row = this.db
      .prepare('SELECT * FROM classroom_documents WHERE project_id = ? AND stage_id = ?')
      .get(projectId, stageId) as Row | undefined;
    if (!row) return null;
    return this.mapDocument(row);
  }


  listDocuments(projectId: string): Array<{
    recordScope: RecordScope;
    stageId: string;
    lessonId: string;
    name: string;
    description: string;
    sceneCount: number;
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = this.db
      .prepare(
        'SELECT * FROM classroom_documents WHERE project_id = ? ORDER BY updated_at DESC, stage_id ASC',
      )
      .all(projectId) as Row[];
    return rows.map((row) => {
      const stage = (this.mapDocument(row).document as { stage?: Row })?.stage ?? {};
      return {
        recordScope: recordScope(row['record_scope']),
        stageId: str(row['stage_id']),
        lessonId: str(row['lesson_id']),
        name: str(stage['name']),
        description: str(stage['description']),
        sceneCount: num(row['scene_count']),
        createdAt: str(row['created_at']),
        updatedAt: str(row['updated_at']),
      };
    });
  }

  listSceneSources(projectId: string, stageId: string): Map<string, ClassroomSceneSourceRow> {
    const rows = this.db
      .prepare('SELECT * FROM classroom_scene_sources WHERE project_id = ? AND stage_id = ?')
      .all(projectId, stageId) as Row[];
    const out = new Map<string, ClassroomSceneSourceRow>();
    for (const row of rows) {
      const sceneId = str(row['scene_id']);
      out.set(sceneId, {
        recordScope: recordScope(row['record_scope']),
        sceneId,
        knowledgeIds: readAuthoritativeJsonColumn<string[]>(
          row['knowledge_ids_json'],
          knowledgeIdsSchema,
          `classroom_scene_sources.knowledge_ids_json[${stageId}/${sceneId}]`,
          defaultJsonPolicy,
        ),
        questionId: nullableStr(row['question_id']),
        reviewedBy: str(row['reviewed_by']),
        reviewNote: str(row['review_note']),
      });
    }
    return out;
  }

  /** 文档、来源绑定与课堂状态必须一起消失，不能留下没有来源的文档。 */
  deleteDocument(projectId: string, stageId: string): void {
    this.db.transaction(() => {
      // Remove only this document's binding references. Asset bytes remain owned by the project and
      // may still be referenced by another reviewed document.
      this.db
        .prepare('DELETE FROM classroom_asset_bindings WHERE project_id = ? AND stage_id = ?')
        .run(projectId, stageId);
      this.db
        .prepare('DELETE FROM classroom_scene_sources WHERE project_id = ? AND stage_id = ?')
        .run(projectId, stageId);
      this.db
        .prepare('DELETE FROM classroom_state WHERE project_id = ? AND stage_id = ?')
        .run(projectId, stageId);
      this.db
        .prepare('DELETE FROM classroom_documents WHERE project_id = ? AND stage_id = ?')
        .run(projectId, stageId);
    });
  }

  /**
   * 场景级写入：在已存文档内替换或追加一个场景，并同步文档指纹。
   * 归属与审核校验（stageId 必须等于 URL 的文档 id、内容必须与登记课件一致）
   * 由调用方在服务边界完成。
   */
  putScene(projectId: string, stageId: string, scene: unknown, digest: string): boolean {
    const current = this.getDocument(projectId, stageId);
    if (!current) return false;
    const id =
      scene && typeof scene === 'object' && typeof (scene as Row)['id'] === 'string'
        ? (scene as Row)['id'] as string
        : '';
    if (id.length === 0) return false;
    const scenesValue = (current.document as { scenes?: unknown }).scenes;
    const scenes = Array.isArray(scenesValue) ? [...scenesValue] : [];
    const next = scenes.map((item) =>
      item && typeof item === 'object' && (item as Row)['id'] === id ? scene : item,
    );
    if (!next.some((item) => item && typeof item === 'object' && (item as Row)['id'] === id)) {
      next.push(scene);
    }
    const document = { ...(current.document as Row), scenes: next };
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE classroom_documents SET document_json = ?, scene_count = ?, digest = ?, updated_at = ?
         WHERE project_id = ? AND stage_id = ?`,
      )
      .run(encodeJson(document), next.length, digest, now, projectId, stageId);
    return true;
  }


  readState(projectId: string, stageId: string): ClassroomStateRow | null {
    const row = this.db
      .prepare('SELECT * FROM classroom_state WHERE project_id = ? AND stage_id = ?')
      .get(projectId, stageId) as Row | undefined;
    if (!row) return null;
    return {
      stageId: str(row['stage_id']),
      currentSceneId: str(row['current_scene_id']),
      revision: num(row['revision']),
      updatedAt: str(row['updated_at']),
    };
  }

  /**
   * 课堂状态写入是幂等覆盖：同一场景重复写入只推进一个代次。
   * 场景不属于该文档时返回 null，由调用方在服务边界拒绝，不静默保留旧位置。
   */
  writeState(projectId: string, stageId: string, currentSceneId: string): ClassroomStateRow | null {
    const sceneIds = sceneIdsOf(this.getDocument(projectId, stageId)?.document);
    if (sceneIds.length === 0 || !sceneIds.includes(currentSceneId)) return null;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO classroom_state (project_id, stage_id, current_scene_id, revision, updated_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(project_id, stage_id) DO UPDATE SET
           current_scene_id = excluded.current_scene_id,
           revision = classroom_state.revision + 1,
           updated_at = excluded.updated_at`,
      )
      .run(projectId, stageId, currentSceneId, now);
    const saved = this.readState(projectId, stageId);
    if (!saved) throw new Error(`classroom_state 写入后无法读回：${stageId}`);
    return saved;
  }

  private mapDocument(row: Row): ClassroomDocumentRow {
    const stageId = str(row['stage_id']);
    const context = `classroom_documents.document_json[${stageId}]`;
    return {
      recordScope: recordScope(row['record_scope']),
      projectId: str(row['project_id']),
      stageId,
      lessonId: str(row['lesson_id']),
      dslVersion: str(row['dsl_version']),
      document: readAuthoritativeJsonColumn(row['document_json'], arbitrarySchema, context, defaultJsonPolicy),
      digest: str(row['digest']),
      sceneCount: num(row['scene_count']),
      createdAt: str(row['created_at']),
      updatedAt: str(row['updated_at']),
    };
  }
}
