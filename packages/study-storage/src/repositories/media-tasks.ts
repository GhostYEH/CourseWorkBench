import {
  StudyError,
  mediaTaskSchema,
  type MediaTaskDto,
  type MediaUsageQuantitiesDto,
} from '@sew/study-contracts';
import { assertMediaBudget, mediaLedgerForRun } from '@sew/study-domain';
import type { SqlDatabase } from '../driver';
import { decodeJson, encodeJson } from '../json-codec';
import type { ClassroomAssetsRepository } from './classroom-assets';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

interface Row {
  project_id: string;
  request_id: string;
  task_id: string;
  run_id: string;
  task_json: unknown;
}
export interface MediaAssetBytes {
  bytes: Uint8Array;
  mime: string;
  durationSeconds: number | null;
}

/** Task/asset/usage writes share one SQLite transaction. No restart silently re-dispatches a request. */
export class MediaTasksRepository {
  constructor(
    private readonly db: SqlDatabase,
    private readonly assets: ClassroomAssetsRepository,
    private readonly databaseFile: string,
  ) {}

  private productFile(assetId: string): string {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(assetId))
      throw new StudyError('INVALID_ARGUMENT', { reason: 'media_asset_id_invalid' });
    const root = realpathSync(dirname(dirname(this.databaseFile)));
    const directory = join(dirname(this.databaseFile), 'assets');
    mkdirSync(directory, { recursive: true });
    const actualDirectory = realpathSync(directory);
    const part = relative(root, actualDirectory);
    if (
      part === '..' ||
      part.startsWith(`..${sep}`) ||
      resolve(root, part) !== actualDirectory ||
      lstatSync(directory).isSymbolicLink()
    )
      throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'media_directory_outside_project' });
    return join(actualDirectory, assetId);
  }

  private productBytes(ref: MediaTaskDto['products'][number]): Uint8Array {
    const file = this.productFile(ref.assetId);
    if (
      !existsSync(file) ||
      lstatSync(file).isSymbolicLink() ||
      !lstatSync(file).isFile() ||
      lstatSync(file).size !== ref.byteLength ||
      ref.relativePath !== `.study/assets/${ref.assetId}`
    )
      throw new StudyError('VERSION_CONFLICT', { reason: 'media_file_changed' });
    const bytes = readFileSync(file);
    if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256)
      throw new StudyError('VERSION_CONFLICT', { reason: 'media_file_changed' });
    return bytes;
  }

  readProduct(projectId: string, assetId: string): { bytes: Uint8Array; mime: string } {
    const ref = this.list(projectId)
      .flatMap((task) => task.products)
      .find((product) => product.assetId === assetId);
    if (!ref) throw new StudyError('NOT_FOUND');
    const asset = this.assets.get(projectId, assetId);
    if (
      !asset ||
      asset.recordScope !== 'formal' ||
      asset.sha256 !== ref.sha256 ||
      asset.mediaType !== ref.mime ||
      asset.bytes.byteLength !== ref.byteLength
    )
      throw new StudyError('VERSION_CONFLICT', { reason: 'media_asset_changed' });
    return { bytes: this.productBytes(ref), mime: ref.mime };
  }

  private parse(row: Row): MediaTaskDto {
    const decoded = decodeJson(
      row.task_json,
      mediaTaskSchema.nullable(),
      null,
      'media_generation_tasks',
    );
    const task = decoded.value;
    if (
      !decoded.ok ||
      !task ||
      task.command.scope.projectId !== row.project_id ||
      task.command.requestId !== row.request_id ||
      task.taskId !== row.task_id ||
      task.command.scope.runId !== row.run_id
    )
      throw new StudyError('INTERNAL', { reason: 'invalid_media_task' });
    return task;
  }

  get(projectId: string, requestId: string, intent?: string): MediaTaskDto | null {
    const row = this.db
      .prepare('SELECT * FROM media_generation_tasks WHERE project_id=? AND request_id=?')
      .get(projectId, requestId) as Row | undefined;
    if (!row) return null;
    const task = this.parse(row);
    if (intent !== undefined && task.intent !== intent)
      throw new StudyError('VERSION_CONFLICT', { reason: 'media_request_reused' });
    return task;
  }

  byId(projectId: string, taskId: string): MediaTaskDto | null {
    const row = this.db
      .prepare('SELECT * FROM media_generation_tasks WHERE project_id=? AND task_id=?')
      .get(projectId, taskId) as Row | undefined;
    return row ? this.parse(row) : null;
  }

  list(projectId: string): MediaTaskDto[] {
    return (
      this.db
        .prepare('SELECT * FROM media_generation_tasks WHERE project_id=? ORDER BY rowid DESC')
        .all(projectId) as Row[]
    ).map((row) => this.parse(row));
  }

  start(
    value: MediaTaskDto,
    limits: MediaUsageQuantitiesDto,
    reserveShared: () => void,
  ): MediaTaskDto {
    const task = mediaTaskSchema.parse(value);
    return this.db.transaction(() => {
      const old = this.get(task.command.scope.projectId, task.command.requestId, task.intent);
      if (old) return old;
      if (task.observation.state !== 'started' || task.review.status !== 'pending_review')
        throw new StudyError('INVALID_ARGUMENT', { reason: 'media_initial_state' });
      const ledger = mediaLedgerForRun(
        task.observation.runId,
        this.list(task.observation.projectId)
          .filter((item) => item.observation.runId === task.observation.runId)
          .map((item) => item.observation),
      );
      const used = Object.fromEntries(
        Object.keys(limits).map((key) => {
          const dimension = key as keyof MediaUsageQuantitiesDto;
          return [
            key,
            ledger.total.actual[dimension] +
              ledger.total.estimated[dimension] +
              ledger.total.unknown[dimension] +
              ledger.total.unsettled[dimension],
          ];
        }),
      ) as MediaUsageQuantitiesDto;
      const reservation = task.observation.reserved;
      assertMediaBudget({
        limits,
        used,
        reserved: {
          tokens: reservation.tokens.totalTokens ?? 0,
          images: reservation.images ?? 0,
          seconds:
            (reservation.videoSeconds ?? 0) +
            (reservation.audioSeconds ?? 0) +
            (reservation.asrSeconds ?? 0),
          characters: reservation.characters ?? 0,
        },
      });
      reserveShared();
      this.db
        .prepare(
          'INSERT INTO media_generation_tasks(project_id,request_id,task_id,run_id,task_json) VALUES(?,?,?,?,?)',
        )
        .run(
          task.observation.projectId,
          task.observation.requestId,
          task.taskId,
          task.observation.runId,
          encodeJson(task),
        );
      return task;
    });
  }

  settle(
    value: MediaTaskDto,
    products: readonly MediaAssetBytes[],
    settleShared: () => void,
  ): MediaTaskDto {
    const task = mediaTaskSchema.parse(value);
    const created: string[] = [];
    try {
      return this.db.transaction(() => {
        const previous = this.get(
          task.observation.projectId,
          task.observation.requestId,
          task.intent,
        );
        if (!previous || previous.taskId !== task.taskId) throw new StudyError('NOT_FOUND');
        if (previous.observation.state !== 'started') return previous;
        if (
          encodeJson(previous.command) !== encodeJson(task.command) ||
          previous.lessonVersion !== task.lessonVersion ||
          previous.bundleDigest !== task.bundleDigest ||
          previous.knowledgeDigest !== task.knowledgeDigest
        )
          throw new StudyError('VERSION_CONFLICT', { reason: 'media_settlement_binding_changed' });
        if (
          task.observation.state === 'started' ||
          task.products.length !== products.length ||
          task.review.status !== 'pending_review'
        )
          throw new StudyError('INVALID_ARGUMENT', { reason: 'media_settlement_invalid' });
        task.products.forEach((ref, index) => {
          const product = products[index]!;
          if (ref.relativePath !== `.study/assets/${ref.assetId}`)
            throw new StudyError('INVALID_ARGUMENT', { reason: 'media_product_path_invalid' });
          if (
            product.bytes.byteLength < 1 ||
            product.bytes.byteLength > 16 * 1024 * 1024 ||
            product.mime !== ref.mime ||
            product.bytes.byteLength !== ref.byteLength ||
            ref.taskId !== task.taskId
          )
            throw new StudyError('INVALID_ARGUMENT', { reason: 'media_product_invalid' });
          const saved = this.assets.put(
            task.observation.projectId,
            ref.assetId,
            ref.mime,
            { generatedMediaTaskId: task.taskId, symbolicRef: ref.assetId },
            product.bytes,
            'formal',
          );
          if (saved.sha256 !== ref.sha256)
            throw new StudyError('INVALID_ARGUMENT', { reason: 'media_product_digest_mismatch' });
          const file = this.productFile(ref.assetId);
          if (!existsSync(file)) {
            writeFileSync(file, product.bytes, { flag: 'wx' });
            created.push(file);
          }
          this.productBytes(ref);
          this.db
            .prepare(
              'INSERT INTO media_candidate_assets(project_id,asset_id,task_id,sha256) VALUES(?,?,?,?)',
            )
            .run(task.observation.projectId, ref.assetId, task.taskId, saved.sha256);
        });
        settleShared();
        this.write(task);
        return task;
      });
    } catch (error) {
      for (const file of created) {
        // Only files newly created at a checked project asset path belong to this rollback.
        try {
          unlinkSync(file);
        } catch {
          /* Preserve the original transaction failure. */
        }
      }
      throw error;
    }
  }

  review(
    projectId: string,
    taskId: string,
    intent: string,
    decision: 'approved' | 'rejected',
    note: string,
  ): MediaTaskDto {
    return this.db.transaction(() => {
      const task = this.byId(projectId, taskId);
      if (!task) throw new StudyError('NOT_FOUND');
      if (task.intent !== intent || task.observation.state !== 'completed')
        throw new StudyError('VERSION_CONFLICT', { reason: 'media_review_binding_changed' });
      if (task.review.status !== 'pending_review') {
        if (task.review.status === decision && task.review.note === note) return task;
        throw new StudyError('VERSION_CONFLICT', { reason: 'media_already_reviewed' });
      }
      for (const ref of task.products) {
        this.productBytes(ref);
        const asset = this.assets.get(projectId, ref.assetId);
        if (
          !asset ||
          asset.sha256 !== ref.sha256 ||
          asset.mediaType !== ref.mime ||
          asset.bytes.byteLength !== ref.byteLength
        )
          throw new StudyError('VERSION_CONFLICT', { reason: 'media_asset_changed' });
      }
      const reviewed = mediaTaskSchema.parse({
        ...task,
        review: { status: decision, note, reviewedAt: new Date().toISOString() },
      });
      this.db
        .prepare('UPDATE media_candidate_assets SET approved=? WHERE project_id=? AND task_id=?')
        .run(decision === 'approved' ? 1 : 0, projectId, taskId);
      this.write(reviewed);
      return reviewed;
    });
  }

  private write(task: MediaTaskDto): void {
    this.db
      .prepare('UPDATE media_generation_tasks SET task_json=? WHERE project_id=? AND request_id=?')
      .run(
        encodeJson(mediaTaskSchema.parse(task)),
        task.observation.projectId,
        task.observation.requestId,
      );
  }
}
