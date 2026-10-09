import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Stats } from 'node:fs';
import {
  backupProjectManifestSchema,
  learnerUidSchema,
  projectBackupManifestSchema,
  PROJECT_BACKUP_VERSION,
  classroomSharedCourseSchema,
  LEGACY_LOCAL_LEARNER_KEY,
  type ProjectBackupFile,
  type ProjectBackupManifest,
  type ProjectBackupResult,
} from '@sew/study-contracts';
import { MIGRATIONS, SCHEMA_VERSION } from './schema';
import { StudyStore } from './store';
import {
  ensureProjectLayout,
  PROJECT_FORMAT_VERSION,
  projectPaths,
  type ProjectManifest,
} from './project-layout';
import type { SqlDatabase } from './driver';
import { arbitrarySchema, decodeJson } from './json-codec';

const MAX_BYTES = 32 * 1024 ** 3;
const MAX_FILE_BYTES = 16 * 1024 ** 3;
const MAX_FILES = 10000;
const MAX_JSON_BYTES = 8 * 1024 ** 2;
const CHUNK_BYTES = 1024 ** 2;
// Serialized contracts of @openmaic/dsl 0.11.2, not the npm package version.
const DSL_VERSIONS = { openmaic: '0.3.0', runtime: '0.1.0', formalInteraction: 1 as const };
const supportedDocumentDsl = (value: unknown): boolean =>
  value === '' || (typeof value === 'string' && /^0\.[0-3]\.0$/.test(value));

export class ProjectBackupError extends Error {
  constructor(readonly reason: string) {
    super(`项目备份/恢复失败：${reason}`);
    this.name = 'ProjectBackupError';
  }
}
function fail(reason: string): never {
  throw new ProjectBackupError(reason);
}
const inside = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
};
/** A caller supplied path may be absent; that is a diagnosable refusal, not an internal fault. */
const statNoFollow = (path: string): Stats => {
  try {
    return lstatSync(path);
  } catch {
    return fail('path_unavailable');
  }
};
/** lstat every ancestor, including Windows junctions; realpath prevents alias nesting. */
const checkedPath = (input: string): string => {
  const path = resolve(input);
  let cursor = path;
  while (true) {
    if (statNoFollow(cursor).isSymbolicLink()) fail('symbolic_link');
    if (dirname(cursor) === cursor) break;
    cursor = dirname(cursor);
  }
  return realpathSync(path);
};
const newDestination = (input: string, source: string, protectedRoots: string[]): string => {
  const requested = resolve(input);
  if (existsSync(requested)) fail('destination_exists');
  const parent = checkedPath(dirname(requested));
  if (!statNoFollow(parent).isDirectory()) fail('destination_parent_not_directory');
  const destination = join(parent, basename(requested));
  if (inside(source, destination) || inside(destination, source)) fail('recursive_destination');
  // Publishing inside a live project would change that project's own directory contents.
  for (const root of protectedRoots)
    if (inside(checkedPath(root), destination)) fail('destination_in_open_project');
  return destination;
};
const portablePath = (path: string): boolean =>
  path.length <= 1024 &&
  !isAbsolute(path) &&
  path
    .split('/')
    .every(
      (part) =>
        part.length > 0 &&
        part !== '.' &&
        part !== '..' &&
        !/[<>:"|?*\\\x00-\x1f]/.test(part) &&
        !/[. ]$/.test(part) &&
        !/^(?:\.task-cache|\.env(?:\..*)?|profile(?:\.json)?|learner-profile\.json|credentials(?:\.json)?|secrets?(?:\.json)?|id_rsa|id_ed25519)$/i.test(
          part,
        ) &&
        !/\.(?:pem|key|pfx|p12)$/i.test(part) &&
        !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
    );
const kindOf = (path: string): ProjectBackupFile['kind'] | null => {
  if (!portablePath(path)) return null;
  if (path === 'project.json') return 'manifest';
  if (path === '.study/study.db') return 'database';
  if (path.startsWith('.study/sources/')) return 'source';
  if (path.startsWith('.study/assets/')) return 'asset';
  if (path.startsWith('exports/')) return 'derived_export';
  return null;
};
const allowedDirectory = (path: string): boolean =>
  path === '.study' ||
  path === '.study/sources' ||
  path === '.study/assets' ||
  path === 'exports' ||
  kindOf(`${path}/placeholder`) !== null;
const digestFile = (file: string): { byteLength: number; sha256: string } => {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('invalid_file');
  if (stat.size > MAX_FILE_BYTES) fail('file_limit');
  const fd = openSync(file, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let byteLength = 0;
  try {
    while (true) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) break;
      byteLength += bytes;
      if (byteLength > MAX_FILE_BYTES) fail('file_limit');
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  if (byteLength !== stat.size) fail('file_changed');
  return { byteLength, sha256: hash.digest('hex') };
};
const readJson = (file: string): unknown => {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES)
    fail('invalid_manifest');
  const decoded = decodeJson(
    readFileSync(file, 'utf8'),
    arbitrarySchema,
    undefined,
    'project_backup.manifest',
  );
  if (!decoded.ok) fail('invalid_manifest');
  return decoded.value;
};
const readProject = (root: string): ProjectManifest => {
  const parsed = backupProjectManifestSchema.safeParse(readJson(join(root, 'project.json')));
  if (!parsed.success) fail('invalid_project_manifest');
  if (parsed.data.formatVersion !== PROJECT_FORMAT_VERSION) fail('unsupported_project_version');
  return parsed.data;
};
/** Unknown source files are rejected, never silently exported. Live SQLite sidecars are skipped. */
const walkProject = (root: string, live: boolean): string[] => {
  const files: string[] = [];
  let nodes = 0;
  let totalBytes = 0;
  const visit = (directory: string, prefix: string, depth: number): void => {
    if (depth > 32) fail('path_depth_limit');
    for (const name of readdirSync(directory)) {
      if (++nodes > MAX_FILES * 2) fail('file_count_limit');
      const path = prefix ? `${prefix}/${name}` : name;
      const absolute = join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) fail('symbolic_link');
      if (!portablePath(path)) fail('invalid_path');
      if (live && (path === '.study/study.db-wal' || path === '.study/study.db-shm')) {
        if (!stat.isFile()) fail('invalid_file');
        continue;
      }
      if (stat.isDirectory()) {
        if (!allowedDirectory(path)) fail('unexpected_directory');
        visit(absolute, path, depth + 1);
      } else {
        if (!stat.isFile() || kindOf(path) === null) fail('unexpected_file');
        if (stat.size > MAX_FILE_BYTES) fail('file_limit');
        totalBytes += stat.size;
        if (totalBytes > MAX_BYTES) fail('total_size_limit');
        files.push(path);
        if (files.length > MAX_FILES) fail('file_count_limit');
      }
    }
  };
  visit(root, '', 0);
  return files.sort();
};

/** Native readonly handle avoids creating WAL/SHM or migrating the original container. */
const openReadonly = (file: string): SqlDatabase => {
  const builtin = process.getBuiltinModule('node:sqlite') as unknown as {
    DatabaseSync: new (file: string, options: { readOnly: boolean }) => SqlDatabase;
  };
  try {
    return new builtin.DatabaseSync(file, { readOnly: true });
  } catch {
    // A caller supplied container may hold a non-database or absent file; refuse diagnosably, not as a fault.
    return fail('database_unreadable');
  }
};
type Row = Record<string, unknown>;
const rows = (db: SqlDatabase, sql: string): Row[] => db.prepare(sql).all() as Row[];
const tableExists = (db: SqlDatabase, table: string): boolean =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
const boundedRows = (db: SqlDatabase, table: string, sql: string): Row[] => {
  const count = Number(
    (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as Row)['count'],
  );
  if (count > MAX_FILES) fail('database_row_limit');
  return rows(db, sql);
};
/** Hash BLOBs in SQLite chunks; even a large media item is never materialized in JS. */
const blobDigest = (
  db: SqlDatabase,
  table: string,
  column: string,
  rowid: number,
  expected: string,
  length?: number,
): void => {
  const size = Number(
    (db.prepare(`SELECT length(${column}) AS size FROM ${table} WHERE rowid=?`).get(rowid) as Row)[
      'size'
    ],
  );
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_FILE_BYTES ||
    (length !== undefined && size !== length)
  )
    fail('blob_length_mismatch');
  const hash = createHash('sha256');
  const statement = db.prepare(
    `SELECT substr(${column}, ?, ?) AS bytes FROM ${table} WHERE rowid=?`,
  );
  for (let offset = 1; offset <= size; offset += CHUNK_BYTES) {
    const chunk = (statement.get(offset, CHUNK_BYTES, rowid) as Row)['bytes'];
    if (!(chunk instanceof Uint8Array)) fail('invalid_blob');
    hash.update(chunk);
  }
  if (hash.digest('hex') !== expected) fail('blob_digest_mismatch');
};
const inspectDatabase = (
  file: string,
  project: ProjectManifest,
  expectedUid: string,
): {
  schemaVersion: number;
  externalReferences: ProjectBackupManifest['externalReferences'];
} => {
  const db = openReadonly(file);
  try {
    if (rows(db, 'PRAGMA integrity_check(1)').some((row) => Object.values(row)[0] !== 'ok'))
      fail('database_integrity');
    if (db.prepare('PRAGMA foreign_key_check').get()) fail('database_foreign_keys');
    if (!tableExists(db, 'schema_migrations')) fail('unsupported_schema_version');
    const migrations = rows(
      db,
      `SELECT version, name FROM schema_migrations ORDER BY version LIMIT ${SCHEMA_VERSION + 1}`,
    );
    if (migrations.length < 19 || migrations.length > SCHEMA_VERSION)
      fail('unsupported_schema_version');
    for (const [index, migration] of migrations.entries()) {
      if (migration['version'] !== index + 1 || migration['name'] !== MIGRATIONS[index]?.name)
        fail('unsupported_schema_version');
    }
    const projects = rows(db, 'SELECT project_id, format_version FROM projects LIMIT 2');
    if (
      projects.length !== 1 ||
      projects[0]?.['project_id'] !== project.projectId ||
      projects[0]?.['format_version'] !== project.formatVersion
    )
      fail('project_identity_mismatch');
    const bindings = rows(
      db,
      'SELECT project_id, learner_uid, learner_key FROM learner_identity_bindings LIMIT 2',
    );
    if (
      bindings.length !== 1 ||
      bindings[0]?.['project_id'] !== project.projectId ||
      bindings[0]?.['learner_uid'] !== expectedUid
    )
      fail('uid_mismatch');
    if (bindings[0]?.['learner_key'] !== LEGACY_LOCAL_LEARNER_KEY) fail('invalid_learner_binding');
    if (
      rows(db, 'SELECT DISTINCT dsl_version FROM classroom_documents LIMIT 10').some(
        (row) => !supportedDocumentDsl(row['dsl_version']),
      )
    )
      fail('unsupported_dsl_version');
    if (
      rows(db, 'SELECT DISTINCT runtime_dsl_version FROM classroom_runtime_sessions LIMIT 2').some(
        (row) => row['runtime_dsl_version'] !== DSL_VERSIONS.runtime,
      )
    )
      fail('unsupported_runtime_dsl_version');
    const externalReferences: ProjectBackupManifest['externalReferences'] = [];
    if (tableExists(db, 'source_raw_archives')) {
      if (
        db
          .prepare(
            'SELECT 1 FROM source_versions AS source LEFT JOIN source_raw_archives AS archive USING(material_id, revision) WHERE archive.material_id IS NULL LIMIT 1',
          )
          .get()
      )
        fail('missing_raw_archive_record');
      for (const row of boundedRows(
        db,
        'source_raw_archives',
        'SELECT rowid, material_id, revision, storage_mode, raw_sha256, byte_length FROM source_raw_archives',
      )) {
        if (row['storage_mode'] === 'archived')
          blobDigest(
            db,
            'source_raw_archives',
            'raw_bytes',
            Number(row['rowid']),
            String(row['raw_sha256']),
            Number(row['byte_length']),
          );
        externalReferences.push({
          materialId: String(row['material_id']),
          revision: Number(row['revision']),
          classification:
            row['storage_mode'] === 'archived' ? 'archived_in_database' : 'metadata_only',
        });
      }
    }
    for (const row of boundedRows(
      db,
      'classroom_assets',
      'SELECT rowid, sha256 FROM classroom_assets',
    )) {
      blobDigest(db, 'classroom_assets', 'bytes', Number(row['rowid']), String(row['sha256']));
    }
    if (tableExists(db, 'mp4_export_segments')) {
      for (const row of boundedRows(
        db,
        'mp4_export_segments',
        'SELECT rowid,sha256 FROM mp4_export_segments',
      ))
        blobDigest(db, 'mp4_export_segments', 'bytes', Number(row['rowid']), String(row['sha256']));
    }
    if (tableExists(db, 'material_extraction_originals')) {
      for (const row of boundedRows(
        db,
        'material_extraction_originals',
        'SELECT rowid,source_sha256,source_byte_length FROM material_extraction_originals',
      ))
        blobDigest(
          db,
          'material_extraction_originals',
          'source_bytes',
          Number(row['rowid']),
          String(row['source_sha256']),
          Number(row['source_byte_length']),
        );
    }
    if (tableExists(db, 'classroom_rooms')) {
      const roomDigests = new Map<string, { sha256: string; byteLength: number }>();
      for (const room of boundedRows(
        db,
        'classroom_rooms',
        'SELECT rowid, project_id, room_id, length(CAST(snapshot_json AS BLOB)) AS json_size FROM classroom_rooms',
      )) {
        if (Number(room['json_size']) > MAX_JSON_BYTES) fail('room_snapshot_limit');
        const raw = (
          db
            .prepare('SELECT snapshot_json FROM classroom_rooms WHERE rowid=?')
            .get(room['rowid']) as Row
        )['snapshot_json'];
        if (typeof raw !== 'string') fail('invalid_room_snapshot');
        const decoded = decodeJson(
          raw,
          classroomSharedCourseSchema.nullable(),
          null,
          'project_backup.room_snapshot',
        );
        if (!decoded.ok || decoded.value === null) fail('invalid_room_snapshot');
        const snapshot = decoded.value;
        if (!supportedDocumentDsl(snapshot.course.dslVersion)) fail('unsupported_dsl_version');
        for (const asset of snapshot.assets) {
          const key = JSON.stringify([room['project_id'], room['room_id'], asset.assetId]);
          if (roomDigests.has(key)) fail('invalid_room_snapshot');
          roomDigests.set(key, asset);
          if (roomDigests.size > MAX_FILES) fail('database_row_limit');
        }
      }
      for (const row of boundedRows(
        db,
        'classroom_room_assets',
        'SELECT rowid, project_id, room_id, asset_id FROM classroom_room_assets',
      )) {
        const key = JSON.stringify([row['project_id'], row['room_id'], row['asset_id']]);
        const expected = roomDigests.get(key);
        if (!expected) fail('room_asset_manifest_mismatch');
        blobDigest(
          db,
          'classroom_room_assets',
          'bytes',
          Number(row['rowid']),
          expected.sha256,
          expected.byteLength,
        );
        roomDigests.delete(key);
      }
      if (roomDigests.size) fail('room_asset_manifest_mismatch');
    }
    return { schemaVersion: migrations.length, externalReferences };
  } catch (error) {
    // SQLite can defer corruption detection until prepare/read, after opening succeeds.
    // Keep unrelated SQL/programming errors visible rather than treating every fault as bad input.
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ERR_SQLITE_ERROR' &&
      'errcode' in error &&
      typeof error.errcode === 'number' &&
      [11, 26].includes(error.errcode & 0xff) // SQLITE_CORRUPT / SQLITE_NOTADB, including extended codes.
    )
      fail('database_unreadable');
    throw error;
  } finally {
    db.close();
  }
};
const inventory = (root: string): ProjectBackupFile[] => {
  let total = 0;
  const paths = new Set<string>();
  return walkProject(root, false).map((path) => {
    if (paths.has(path.toLowerCase())) fail('duplicate_path');
    paths.add(path.toLowerCase());
    const digest = digestFile(join(root, path));
    total += digest.byteLength;
    if (total > MAX_BYTES) fail('total_size_limit');
    return { path, kind: kindOf(path)!, ...digest };
  });
};
const copyFiles = (source: string, target: string, files: string[]): void => {
  for (const path of files) {
    checkedPath(join(source, path));
    const targetFile = join(target, path);
    mkdirSync(dirname(targetFile), { recursive: true });
    copyFileSync(join(source, path), targetFile);
  }
};
/** Publish the fully verified stage with one rename, so a fault never leaves a half-written destination. */
const publish = (staged: string, destination: string): void => {
  try {
    renameSync(staged, destination);
  } catch {
    // A destination that appeared after the reservation check stays a refusal, and so does an OS lock.
    if (existsSync(destination)) fail('destination_exists');
    fail('publish_failed');
  }
};
const result = (manifest: ProjectBackupManifest, destinationRoot: string): ProjectBackupResult => ({
  projectId: manifest.project.projectId,
  uid: manifest.uid,
  destinationRoot,
  fileCount: manifest.files.length,
  byteLength: manifest.files.reduce((sum, file) => sum + file.byteLength, 0),
});
export interface CreateProjectBackupOptions {
  store: StudyStore;
  projectRoot: string;
  destinationRoot: string;
  expectedUid: string;
}
export interface RestoreProjectBackupOptions {
  backupRoot: string;
  destinationRoot: string;
  expectedUid: string;
  /** Live project roots the restored copy must not be published inside. */
  protectedRoots?: string[];
}

export const createProjectBackup = async (
  options: CreateProjectBackupOptions,
): Promise<ProjectBackupResult> => {
  if (!learnerUidSchema.safeParse(options.expectedUid).success) fail('invalid_uid');
  const source = checkedPath(options.projectRoot);
  const destination = newDestination(options.destinationRoot, source, []);
  const project = readProject(source);
  const sourceFiles = walkProject(source, true);
  if (!sourceFiles.includes('.study/study.db')) fail('missing_database');
  if (checkedPath(options.store.databaseFile) !== checkedPath(projectPaths(source).databaseFile))
    fail('store_path_mismatch');
  // Do not trust a caller passing a store for another project or another learner.
  if (!options.store.getProject(project.projectId)) fail('project_identity_mismatch');
  if (options.store.getLocalLearnerBinding(project.projectId)?.uid !== options.expectedUid)
    fail('uid_mismatch');
  const stage = mkdtempSync(join(dirname(destination), '.sew-backup-'));
  try {
    const payload = join(stage, 'project');
    mkdirSync(join(payload, '.study'), { recursive: true });
    options.store.backupTo(projectPaths(payload).databaseFile);
    copyFiles(
      source,
      payload,
      sourceFiles.filter((path) => path !== '.study/study.db'),
    );
    if (JSON.stringify(readProject(payload)) !== JSON.stringify(project))
      fail('project_manifest_changed');
    const db = inspectDatabase(projectPaths(payload).databaseFile, project, options.expectedUid);
    const manifest: ProjectBackupManifest = projectBackupManifestSchema.parse({
      containerVersion: PROJECT_BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      project,
      uid: options.expectedUid,
      ...db,
      dslVersions: DSL_VERSIONS,
      files: inventory(payload),
    });
    const encodedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
    if (Buffer.byteLength(encodedManifest) > MAX_JSON_BYTES) fail('manifest_size_limit');
    writeFileSync(join(stage, 'backup.json'), encodedManifest, { flag: 'wx' });
    publish(stage, destination);
    return result(manifest, destination);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
};

export const restoreProjectBackup = async (
  options: RestoreProjectBackupOptions,
): Promise<ProjectBackupResult> => {
  if (!learnerUidSchema.safeParse(options.expectedUid).success) fail('invalid_uid');
  const source = checkedPath(options.backupRoot);
  const destination = newDestination(options.destinationRoot, source, options.protectedRoots ?? []);
  if (readdirSync(source).sort().join('|') !== 'backup.json|project')
    fail('unexpected_container_file');
  checkedPath(join(source, 'backup.json'));
  const payload = checkedPath(join(source, 'project'));
  const parsed = projectBackupManifestSchema.safeParse(readJson(join(source, 'backup.json')));
  if (!parsed.success) fail('unsupported_or_invalid_backup_manifest');
  const manifest = parsed.data;
  if (manifest.uid !== options.expectedUid) fail('uid_mismatch');
  if (manifest.schemaVersion < 19 || manifest.schemaVersion > SCHEMA_VERSION)
    fail('unsupported_schema_version');
  if (manifest.dslVersions.openmaic !== DSL_VERSIONS.openmaic) fail('unsupported_dsl_version');
  if (manifest.dslVersions.runtime !== DSL_VERSIONS.runtime)
    fail('unsupported_runtime_dsl_version');
  const paths = new Set<string>();
  for (const file of manifest.files) {
    const normalized = file.path.toLowerCase();
    if (kindOf(file.path) !== file.kind || paths.has(normalized)) fail('invalid_file_manifest');
    paths.add(normalized);
  }
  // Without these two entries the read path would hit raw fs/SQLite faults instead of a reason.
  if (!paths.has('project.json')) fail('invalid_project_manifest');
  if (!paths.has('.study/study.db')) fail('missing_database');
  const actual = inventory(payload);
  const declared = new Map(manifest.files.map((file) => [file.path, file]));
  if (
    actual.length !== manifest.files.length ||
    actual.some((file) => {
      const expected = declared.get(file.path);
      return (
        !expected ||
        expected.byteLength !== file.byteLength ||
        expected.sha256 !== file.sha256 ||
        expected.kind !== file.kind
      );
    })
  )
    fail('file_digest_or_inventory_mismatch');
  const project = readProject(payload);
  if (JSON.stringify(project) !== JSON.stringify(manifest.project))
    fail('project_identity_mismatch');
  const stage = mkdtempSync(join(dirname(destination), '.sew-restore-'));
  try {
    // Validate the immutable snapshot copy, never write or migrate the original backup.
    copyFiles(
      payload,
      stage,
      actual.map((file) => file.path),
    );
    const copied = inventory(stage);
    if (
      copied.some(
        (file) =>
          file.sha256 !== declared.get(file.path)?.sha256 ||
          file.byteLength !== declared.get(file.path)?.byteLength,
      )
    )
      fail('file_changed');
    const inspected = inspectDatabase(
      projectPaths(stage).databaseFile,
      project,
      options.expectedUid,
    );
    if (
      inspected.schemaVersion !== manifest.schemaVersion ||
      JSON.stringify(inspected.externalReferences) !== JSON.stringify(manifest.externalReferences)
    )
      fail('database_manifest_mismatch');
    const migrated = StudyStore.open({ file: projectPaths(stage).databaseFile });
    migrated.close();
    inspectDatabase(projectPaths(stage).databaseFile, project, options.expectedUid);
    ensureProjectLayout(stage);
    publish(stage, destination);
    return result(manifest, destination);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
};
