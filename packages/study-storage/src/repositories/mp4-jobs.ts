import { createHash } from 'node:crypto';
import { StudyError, mp4TaskSchema, type Mp4TaskDto } from '@sew/study-contracts';
import { mp4RenderPlanDigest } from '@sew/study-domain';
import type { SqlDatabase } from '../driver';
import { decodeJson, encodeJson } from '../json-codec';

interface JobRow {
  project_id: string;
  request_id: string;
  job_id: string;
  revision: number;
  task_json: unknown;
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Durable task receipts and actual capture checkpoints; restart never silently re-executes. */
export class Mp4JobsRepository {
  constructor(private readonly db: SqlDatabase) {}
  private parse(row: JobRow): Mp4TaskDto {
    const decoded = decodeJson(row.task_json, mp4TaskSchema.nullable(), null, 'mp4_export_jobs');
    const task = decoded.value;
    if (
      !decoded.ok ||
      !task ||
      task.projectId !== row.project_id ||
      task.job.requestId !== row.request_id ||
      task.job.jobId !== row.job_id ||
      task.revision !== row.revision ||
      mp4RenderPlanDigest(task.plan) !== task.plan.digest
    )
      throw new StudyError('INTERNAL', { reason: 'invalid_mp4_job' });
    return task;
  }
  byRequest(projectId: string, requestId: string, intent?: string): Mp4TaskDto | null {
    const row = this.db
      .prepare('SELECT * FROM mp4_export_jobs WHERE project_id=? AND request_id=?')
      .get(projectId, requestId) as JobRow | undefined;
    const task = row ? this.parse(row) : null;
    if (task && intent !== undefined && task.intent !== intent)
      throw new StudyError('VERSION_CONFLICT', { reason: 'mp4_request_reused' });
    return task;
  }
  get(projectId: string, jobId: string): Mp4TaskDto | null {
    const row = this.db
      .prepare('SELECT * FROM mp4_export_jobs WHERE project_id=? AND job_id=?')
      .get(projectId, jobId) as JobRow | undefined;
    return row ? this.parse(row) : null;
  }
  list(projectId: string): Mp4TaskDto[] {
    return (
      this.db
        .prepare('SELECT * FROM mp4_export_jobs WHERE project_id=? ORDER BY rowid DESC LIMIT 100')
        .all(projectId) as JobRow[]
    ).map((row) => this.parse(row));
  }
  start(value: Mp4TaskDto): Mp4TaskDto {
    const task = mp4TaskSchema.parse(value);
    return this.db.transaction(() => {
      const existing = this.byRequest(task.projectId, task.job.requestId, task.intent);
      if (existing) return existing;
      if (
        task.revision !== 0 ||
        task.job.state !== 'queued' ||
        mp4RenderPlanDigest(task.plan) !== task.plan.digest
      )
        throw new StudyError('INVALID_ARGUMENT');
      if (
        this.list(task.projectId).some((item) =>
          ['queued', 'preparing', 'capturing', 'encoding'].includes(item.job.state),
        )
      )
        throw new StudyError('VERSION_CONFLICT', { reason: 'mp4_job_already_running' });
      this.db
        .prepare(
          'INSERT INTO mp4_export_jobs(project_id,request_id,job_id,revision,task_json) VALUES(?,?,?,?,?)',
        )
        .run(task.projectId, task.job.requestId, task.job.jobId, 0, encodeJson(task));
      return task;
    });
  }
  update(
    value: Mp4TaskDto,
    expectedRevision: number,
    segment?: { index: number; bytes: Uint8Array },
  ): Mp4TaskDto {
    const task = mp4TaskSchema.parse(value);
    return this.db.transaction(() => {
      const old = this.get(task.projectId, task.job.jobId);
      if (!old || old.revision !== expectedRevision || task.revision !== expectedRevision + 1)
        throw new StudyError('VERSION_CONFLICT', { reason: 'mp4_job_revision_changed' });
      if (
        old.intent !== task.intent ||
        old.job.requestId !== task.job.requestId ||
        old.plan.digest !== task.plan.digest ||
        old.bundleDigest !== task.bundleDigest ||
        old.stageId !== task.stageId ||
        old.dslVersion !== task.dslVersion
      )
        throw new StudyError('VERSION_CONFLICT', { reason: 'mp4_job_identity_changed' });
      if (segment) {
        const receipt = task.job.completedSegments[segment.index];
        if (
          segment.index !== old.job.nextSegmentIndex ||
          !receipt ||
          segment.bytes.length < 1 ||
          segment.bytes.length > 32 * 1024 ** 2 ||
          receipt.byteLength !== segment.bytes.length ||
          receipt.sha256 !== sha256(segment.bytes)
        )
          throw new StudyError('INVALID_ARGUMENT', { reason: 'mp4_checkpoint_mismatch' });
        const total = this.db
          .prepare(
            'SELECT COALESCE(SUM(length(bytes)),0) AS total FROM mp4_export_segments WHERE project_id=?',
          )
          .get(task.projectId) as { total: number };
        if (Number(total.total) + segment.bytes.length > 256 * 1024 ** 2)
          throw new StudyError('BUDGET_EXCEEDED', { reason: 'mp4_checkpoint_quota' });
        this.db
          .prepare(
            'INSERT INTO mp4_export_segments(project_id,job_id,segment_index,sha256,bytes) VALUES(?,?,?,?,?)',
          )
          .run(
            task.projectId,
            task.job.jobId,
            segment.index,
            receipt.sha256,
            new Uint8Array(segment.bytes),
          );
      }
      this.db
        .prepare(
          'UPDATE mp4_export_jobs SET revision=?,task_json=? WHERE project_id=? AND job_id=? AND revision=?',
        )
        .run(task.revision, encodeJson(task), task.projectId, task.job.jobId, expectedRevision);
      return this.get(task.projectId, task.job.jobId)!;
    });
  }
  segments(task: Mp4TaskDto): Map<number, Uint8Array> {
    const stored = this.get(task.projectId, task.job.jobId);
    if (!stored || stored.plan.digest !== task.plan.digest)
      throw new StudyError('VERSION_CONFLICT');
    const result = new Map<number, Uint8Array>();
    for (const receipt of stored.job.completedSegments) {
      const row = this.db
        .prepare(
          'SELECT bytes,sha256 FROM mp4_export_segments WHERE project_id=? AND job_id=? AND segment_index=?',
        )
        .get(task.projectId, task.job.jobId, receipt.index) as
        { bytes: Uint8Array; sha256: string } | undefined;
      if (
        !row ||
        row.bytes.length !== receipt.byteLength ||
        row.sha256 !== receipt.sha256 ||
        sha256(row.bytes) !== receipt.sha256
      )
        throw new StudyError('VERSION_CONFLICT', { reason: 'mp4_checkpoint_corrupt' });
      result.set(receipt.index, new Uint8Array(row.bytes));
    }
    return result;
  }
}
