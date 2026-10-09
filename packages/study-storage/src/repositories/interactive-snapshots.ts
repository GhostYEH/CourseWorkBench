/**
 * 互动保活快照仓储（OMA-045）。
 *
 * 非权威现场：按 (项目, stage, 场景, 本人) 一对一保存组件临时状态。只保存白名单标量，
 * 不保存任意大对象；读取时校验形状，损坏按 INTERNAL 拒绝而不是静默重置。
 */

import {
  StudyError,
  interactiveSnapshotDataSchema,
  type InteractiveSnapshotData,
} from '@sew/study-contracts';
import type { SqlDatabase } from '../driver';
import { encodeJson } from '../json-codec';
import { readRequiredJsonColumn, str, type Row } from './types';

export interface InteractiveSnapshotRecord {
  stageId: string;
  sceneId: string;
  widgetVersion: string;
  data: InteractiveSnapshotData;
  updatedAt: string;
}

export class InteractiveSnapshotRepository {
  constructor(private readonly db: SqlDatabase) {}

  read(
    projectId: string,
    stageId: string,
    sceneId: string,
    learnerUid: string,
  ): InteractiveSnapshotRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM interactive_snapshots WHERE project_id=? AND stage_id=? AND scene_id=? AND learner_uid=?',
      )
      .get(projectId, stageId, sceneId, learnerUid) as Row | undefined;
    if (!row) return null;
    const data = readRequiredJsonColumn(
      row['data_json'],
      interactiveSnapshotDataSchema,
      'interactive_snapshots.data_json',
      { reason: 'invalid_interactive_snapshot' },
    );
    const record: InteractiveSnapshotRecord = {
      stageId: str(row['stage_id']),
      sceneId: str(row['scene_id']),
      widgetVersion: str(row['widget_version']),
      data,
      updatedAt: str(row['updated_at']),
    };
    if (record.stageId !== stageId || record.sceneId !== sceneId)
      throw new StudyError('INTERNAL', { reason: 'invalid_interactive_snapshot' });
    return record;
  }

  write(input: {
    projectId: string;
    stageId: string;
    sceneId: string;
    learnerUid: string;
    widgetVersion: string;
    data: InteractiveSnapshotData;
    updatedAt: string;
  }): InteractiveSnapshotRecord {
    this.db
      .prepare(
        `INSERT INTO interactive_snapshots (project_id, stage_id, scene_id, learner_uid, widget_version, data_json, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(project_id, stage_id, scene_id, learner_uid) DO UPDATE SET
           widget_version = excluded.widget_version, data_json = excluded.data_json, updated_at = excluded.updated_at`,
      )
      .run(
        input.projectId,
        input.stageId,
        input.sceneId,
        input.learnerUid,
        input.widgetVersion,
        encodeJson(input.data),
        input.updatedAt,
      );
    return this.read(input.projectId, input.stageId, input.sceneId, input.learnerUid)!;
  }

  clear(projectId: string, stageId: string, sceneId: string, learnerUid: string): void {
    this.db
      .prepare(
        'DELETE FROM interactive_snapshots WHERE project_id=? AND stage_id=? AND scene_id=? AND learner_uid=?',
      )
      .run(projectId, stageId, sceneId, learnerUid);
  }
}
