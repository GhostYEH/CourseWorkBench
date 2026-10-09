import {
  StudyError,
  proSessionRecordSchema,
  proCustomSkillRecordSchema,
  type ProSessionRecordDto,
  type ProCustomSkillRecordDto,
} from '@sew/study-contracts';
import type { SqlDatabase } from '../driver';
import { decodeJson, encodeJson } from '../json-codec';

interface RecordRow {
  project_id: string;
  learner_uid: string;
  record_id: string;
  request_id: string;
  intent_digest: string;
  revision: number;
  state_json: unknown;
  deleted: number;
}
type OwnerRecord = ProSessionRecordDto | ProCustomSkillRecordDto;
type RecordSchema<T> = import('zod').z.ZodType<T, import('zod').z.ZodTypeDef, unknown>;

/** Owner-bound private records use CAS; session messages/events are append-only. */
class PrivateProRecords<T extends OwnerRecord> {
  constructor(
    private readonly db: SqlDatabase,
    private readonly table: 'pro_sessions' | 'pro_custom_skills',
    private readonly schema: RecordSchema<T>,
    private readonly idOf: (record: T) => string,
    private readonly initialRevision: number,
  ) {}
  private parse(row: RecordRow): T {
    if (
      typeof row.state_json !== 'string' ||
      Buffer.byteLength(row.state_json, 'utf8') > 4 * 1024 ** 2
    )
      throw new StudyError('INTERNAL', { reason: 'pro_record_size' });
    const parsed = decodeJson(row.state_json, this.schema.nullable(), null, this.table);
    const value = parsed.value;
    if (
      !parsed.ok ||
      !value ||
      value.projectId !== row.project_id ||
      value.learnerUid !== row.learner_uid ||
      this.idOf(value) !== row.record_id ||
      value.requestId !== row.request_id ||
      value.intentDigest !== row.intent_digest ||
      value.revision !== row.revision
    )
      throw new StudyError('INTERNAL', { reason: 'pro_record_identity' });
    return value;
  }
  get(projectId: string, learnerUid: string, recordId: string): T | null {
    const row = this.db
      .prepare(
        `SELECT * FROM ${this.table} WHERE project_id=? AND learner_uid=? AND record_id=? AND deleted=0`,
      )
      .get(projectId, learnerUid, recordId) as RecordRow | undefined;
    return row ? this.parse(row) : null;
  }
  list(projectId: string, learnerUid: string): T[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM ${this.table} WHERE project_id=? AND learner_uid=? AND deleted=0 ORDER BY rowid DESC LIMIT 256`,
        )
        .all(projectId, learnerUid) as RecordRow[]
    ).map((row) => this.parse(row));
  }
  byRequest(
    projectId: string,
    learnerUid: string,
    requestId: string,
    intentDigest: string,
  ): T | null {
    const row = this.db
      .prepare(`SELECT * FROM ${this.table} WHERE project_id=? AND learner_uid=? AND request_id=?`)
      .get(projectId, learnerUid, requestId) as RecordRow | undefined;
    if (!row) return null;
    if (row.deleted || row.intent_digest !== intentDigest)
      throw new StudyError('VERSION_CONFLICT', { reason: 'pro_request_reused' });
    return this.parse(row);
  }
  hasRequest(projectId: string, learnerUid: string, requestId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM ${this.table} WHERE project_id=? AND learner_uid=? AND request_id=?`,
        )
        .get(projectId, learnerUid, requestId),
    );
  }
  create(input: T): T {
    const value = this.schema.parse(input);
    return this.db.transaction(() => {
      const existing = this.byRequest(
        value.projectId,
        value.learnerUid,
        value.requestId,
        value.intentDigest,
      );
      if (existing) return existing;
      if (value.revision !== this.initialRevision)
        throw new StudyError('INVALID_ARGUMENT', { reason: 'pro_initial_revision' });
      const count = this.db
        .prepare(
          `SELECT COUNT(*) AS total FROM ${this.table} WHERE project_id=? AND learner_uid=? AND deleted=0`,
        )
        .get(value.projectId, value.learnerUid) as { total: number };
      if (count.total >= 256)
        throw new StudyError('BUDGET_EXCEEDED', { reason: 'pro_owner_record_quota' });
      this.db
        .prepare(
          `INSERT INTO ${this.table}(project_id,learner_uid,record_id,request_id,intent_digest,revision,state_json) VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          value.projectId,
          value.learnerUid,
          this.idOf(value),
          value.requestId,
          value.intentDigest,
          value.revision,
          encodeJson(value),
        );
      return value;
    });
  }
  update(input: T, expectedRevision: number): T {
    const value = this.schema.parse(input);
    return this.db.transaction(() => {
      const previous = this.get(value.projectId, value.learnerUid, this.idOf(value));
      if (
        !previous ||
        previous.revision !== expectedRevision ||
        value.revision !== expectedRevision + 1 ||
        value.requestId !== previous.requestId ||
        value.intentDigest !== previous.intentDigest ||
        value.createdAt !== previous.createdAt
      )
        throw new StudyError('VERSION_CONFLICT', { reason: 'pro_record_revision' });
      if (
        'messages' in value &&
        'messages' in previous &&
        (encodeJson(value.messages.slice(0, previous.messages.length)) !==
          encodeJson(previous.messages) ||
          encodeJson(value.events.slice(0, previous.events.length)) !== encodeJson(previous.events))
      )
        throw new StudyError('VERSION_CONFLICT', { reason: 'pro_history_is_append_only' });
      const changed = this.db
        .prepare(
          `UPDATE ${this.table} SET revision=?,state_json=? WHERE project_id=? AND learner_uid=? AND record_id=? AND revision=? AND deleted=0`,
        )
        .run(
          value.revision,
          encodeJson(value),
          value.projectId,
          value.learnerUid,
          this.idOf(value),
          expectedRevision,
        );
      if (changed.changes !== 1) throw new StudyError('VERSION_CONFLICT');
      return value;
    });
  }
  delete(projectId: string, learnerUid: string, recordId: string, expectedRevision: number): void {
    const changed = this.db
      .prepare(
        `UPDATE ${this.table} SET deleted=1 WHERE project_id=? AND learner_uid=? AND record_id=? AND revision=? AND deleted=0`,
      )
      .run(projectId, learnerUid, recordId, expectedRevision);
    if (changed.changes !== 1) throw new StudyError('VERSION_CONFLICT');
  }
}
export class ProSessionsRepository extends PrivateProRecords<ProSessionRecordDto> {
  constructor(db: SqlDatabase) {
    super(db, 'pro_sessions', proSessionRecordSchema, (value) => value.sessionId, 0);
  }
}
export class ProSkillsRepository extends PrivateProRecords<ProCustomSkillRecordDto> {
  constructor(db: SqlDatabase) {
    super(db, 'pro_custom_skills', proCustomSkillRecordSchema, (value) => value.skillId, 1);
  }
}
