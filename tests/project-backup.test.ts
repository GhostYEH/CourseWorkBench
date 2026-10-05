import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ProjectBackupManifest } from '@sew/study-contracts';
import {
  createNodeSqliteDriver,
  createProjectBackup,
  ensureProjectLayout,
  projectPaths,
  restoreProjectBackup,
  SCHEMA_VERSION,
  StudyStore,
  writeManifest,
} from '@sew/study-storage';
import { MIGRATIONS } from '../packages/study-storage/src/schema';

const UID = 'uid_12345678-1234-4123-8123-123456789abc';
const OTHER_UID = 'uid_12345678-1234-4123-8123-123456789abd';
const PROJECT = {
  formatVersion: 1,
  projectId: 'proj_backup',
  displayName: '备份项目',
  createdAt: '2026-10-05T00:00:00.000Z',
};

describe('project directory backup and restore', () => {
  let temp: string;
  let source: string;
  let backup: string;
  let destination: string;
  let store: StudyStore;
  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), 'sew-backup-test-'));
    source = join(temp, 'source');
    backup = join(temp, 'backup');
    destination = join(temp, 'restored');
    ensureProjectLayout(source);
    writeManifest(source, PROJECT);
    store = StudyStore.open({ file: projectPaths(source).databaseFile });
    store.createProject({ projectId: PROJECT.projectId, displayName: PROJECT.displayName });
    store.bindLocalLearner(PROJECT.projectId, UID);
  });
  afterEach(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    rmSync(temp, { recursive: true, force: true });
  });
  const create = () =>
    createProjectBackup({ store, projectRoot: source, destinationRoot: backup, expectedUid: UID });
  const restore = () =>
    restoreProjectBackup({ backupRoot: backup, destinationRoot: destination, expectedUid: UID });
  const editManifest = (edit: (manifest: ProjectBackupManifest) => void) => {
    const manifest = JSON.parse(
      readFileSync(join(backup, 'backup.json'), 'utf8'),
    ) as ProjectBackupManifest;
    edit(manifest);
    writeFileSync(join(backup, 'backup.json'), JSON.stringify(manifest));
  };
  const editDatabase = (sql: string) => {
    const file = projectPaths(join(backup, 'project')).databaseFile;
    const db = createNodeSqliteDriver().open(file);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
    editManifest((manifest) => {
      const entry = manifest.files.find((item) => item.path === '.study/study.db')!;
      const bytes = readFileSync(file);
      entry.byteLength = bytes.length;
      entry.sha256 = createHash('sha256').update(bytes).digest('hex');
    });
  };

  it('captures live WAL, historical raw bytes, assets and exports without accessing disappeared external originals', async () => {
    const external = join(temp, 'outside.md');
    writeFileSync(external, 'original');
    const first = store.importMaterial({
      projectId: PROJECT.projectId,
      displayName: 'history.md',
      materialType: 'md',
      rawText: 'First raw\r\n',
      rawBytes: Buffer.from('First raw\r\n'),
      readableLocation: external,
    }).material;
    store.importMaterial({
      projectId: PROJECT.projectId,
      displayName: 'history.md',
      materialType: 'md',
      rawText: 'Second raw',
      rawBytes: Buffer.from('Second raw'),
      readableLocation: external,
    });
    store.importMaterial({
      projectId: PROJECT.projectId,
      displayName: 'pasted.md',
      materialType: 'md',
      rawText: 'No original',
      readableLocation: join(temp, 'never-existed'),
    });
    const media = Buffer.alloc(2 * 1024 ** 2 + 123, 7);
    store.putClassroomAsset(PROJECT.projectId, 'asset_test', 'image/png', {}, media);
    writeFileSync(join(source, 'exports', 'result.md'), 'derived');
    rmSync(external);
    expect(existsSync(`${projectPaths(source).databaseFile}-wal`)).toBe(true);
    const created = await create();
    expect(created.projectId).toBe(PROJECT.projectId);
    const manifest = JSON.parse(
      readFileSync(join(backup, 'backup.json'), 'utf8'),
    ) as ProjectBackupManifest;
    expect(manifest.externalReferences.map((item) => item.classification)).toEqual([
      'archived_in_database',
      'archived_in_database',
      'metadata_only',
    ]);
    expect(manifest.files.some((item) => item.path.endsWith('-wal'))).toBe(false);
    const originalBackup = readFileSync(projectPaths(join(backup, 'project')).databaseFile);
    await restore();
    expect(readFileSync(projectPaths(join(backup, 'project')).databaseFile)).toEqual(
      originalBackup,
    );
    const restored = StudyStore.open({ file: projectPaths(destination).databaseFile });
    try {
      expect(restored.listMaterialVersions(first.materialId)).toHaveLength(2);
      expect(restored.readMaterialRaw(first.materialId, 1)?.bytes).toEqual(
        new Uint8Array(Buffer.from('First raw\r\n')),
      );
      expect(restored.getLocalLearnerBinding(PROJECT.projectId)?.uid).toBe(UID);
    } finally {
      restored.close();
    }
    expect(readFileSync(join(destination, 'exports', 'result.md'), 'utf8')).toBe('derived');
  });

  it.each([
    'missing',
    'tampered',
    'extra',
    'traversal',
    'duplicate',
    'future_container',
    'future_schema',
    'future_dsl',
    'manifest_identity',
  ])('rejects %s before publishing or changing source', async (mode) => {
    await create();
    const dbBefore = readFileSync(projectPaths(source).databaseFile);
    const payload = join(backup, 'project');
    if (mode === 'missing') rmSync(join(payload, 'project.json'));
    if (mode === 'tampered') writeFileSync(join(payload, 'project.json'), 'tampered');
    if (mode === 'extra') {
      mkdirSync(join(payload, 'exports'));
      writeFileSync(join(payload, 'exports', 'extra.txt'), 'extra');
    }
    if (mode === 'traversal')
      editManifest((manifest) => {
        manifest.files[0]!.path = '../profile.json';
      });
    if (mode === 'duplicate')
      editManifest((manifest) => {
        manifest.files.push(manifest.files[0]!);
      });
    if (mode === 'future_container')
      editManifest((manifest) => {
        manifest.containerVersion = 2 as 1;
      });
    if (mode === 'future_schema')
      editManifest((manifest) => {
        manifest.schemaVersion = SCHEMA_VERSION + 1;
      });
    if (mode === 'future_dsl')
      editManifest((manifest) => {
        manifest.dslVersions.openmaic = '999.0.0';
      });
    if (mode === 'manifest_identity')
      editManifest((manifest) => {
        manifest.project.projectId = 'other';
      });
    await expect(restore()).rejects.toThrow();
    expect(existsSync(destination)).toBe(false);
    expect(readFileSync(projectPaths(source).databaseFile)).toEqual(dbBefore);
    expect(readdirSync(temp).some((name) => name.startsWith('.sew-restore-'))).toBe(false);
  });

  it('refuses other profile UIDs and never overwrites a destination', async () => {
    await create();
    await expect(create()).rejects.toMatchObject({ reason: 'destination_exists' });
    await expect(
      restoreProjectBackup({
        backupRoot: backup,
        destinationRoot: destination,
        expectedUid: OTHER_UID,
      }),
    ).rejects.toMatchObject({ reason: 'uid_mismatch' });
    await restore();
    await expect(restore()).rejects.toMatchObject({ reason: 'destination_exists' });
    expect(store.getLocalLearnerBinding(PROJECT.projectId)?.uid).toBe(UID);
  });

  it('refuses recursive output, unallowed files and directory junctions', async () => {
    await expect(
      createProjectBackup({
        store,
        projectRoot: source,
        destinationRoot: join(source, 'nested'),
        expectedUid: UID,
      }),
    ).rejects.toMatchObject({ reason: 'recursive_destination' });
    writeFileSync(join(source, 'profile.json'), 'secret');
    await expect(create()).rejects.toMatchObject({ reason: 'invalid_path' });
    rmSync(join(source, 'profile.json'));
    symlinkSync(temp, join(source, '.study', 'assets', 'junction'), 'junction');
    await expect(create()).rejects.toMatchObject({ reason: 'symbolic_link' });
  });

  it('refuses to publish a restore inside a live project and reports absent paths diagnosably', async () => {
    await create();
    const openProject = join(temp, 'live-project');
    mkdirSync(openProject);
    const nested = join(openProject, 'restored-inside');
    await expect(
      restoreProjectBackup({
        backupRoot: backup,
        destinationRoot: nested,
        expectedUid: UID,
        protectedRoots: [openProject],
      }),
    ).rejects.toMatchObject({ reason: 'destination_in_open_project' });
    expect(existsSync(nested)).toBe(false);
    await expect(
      restoreProjectBackup({
        backupRoot: backup,
        destinationRoot: join(temp, 'absent-parent', 'restored'),
        expectedUid: UID,
        protectedRoots: [openProject],
      }),
    ).rejects.toMatchObject({ reason: 'path_unavailable' });
  });

  it('refuses a hand built container that omits its own database or manifest', async () => {
    await create();
    const payload = join(backup, 'project');
    const filler = {
      path: 'exports/note.md',
      byteLength: 3,
      sha256: '0'.repeat(64),
      kind: 'derived_export' as const,
    };
    rmSync(projectPaths(payload).databaseFile);
    editManifest((manifest) => {
      manifest.files = manifest.files.filter((file) => file.path !== '.study/study.db');
      manifest.files.push(filler);
    });
    await expect(restore()).rejects.toMatchObject({ reason: 'missing_database' });
    rmSync(backup, { recursive: true, force: true });
    await create();
    rmSync(join(payload, 'project.json'));
    editManifest((manifest) => {
      manifest.files = manifest.files.filter((file) => file.path !== 'project.json');
      manifest.files.push(filler);
    });
    await expect(restore()).rejects.toMatchObject({ reason: 'invalid_project_manifest' });
  });

  it('verifies BLOB digests even when the container file digest was recomputed', async () => {
    store.putClassroomAsset(PROJECT.projectId, 'asset_test', 'image/png', {}, Buffer.from('asset'));
    await create();
    editDatabase("UPDATE classroom_assets SET bytes=x'0001'");
    await expect(restore()).rejects.toMatchObject({ reason: 'blob_digest_mismatch' });
    expect(existsSync(destination)).toBe(false);
  });

  it('rejects database UID and future migrations', async () => {
    await create();
    editDatabase(`UPDATE learner_identity_bindings SET learner_uid='${OTHER_UID}'`);
    await expect(restore()).rejects.toMatchObject({ reason: 'uid_mismatch' });
    editDatabase(
      `UPDATE learner_identity_bindings SET learner_uid='${UID}'; INSERT INTO schema_migrations VALUES (${SCHEMA_VERSION + 1},'future','2026-10-05')`,
    );
    await expect(restore()).rejects.toMatchObject({ reason: 'unsupported_schema_version' });
    expect(existsSync(destination)).toBe(false);
  });

  it('rejects mismatched DB project identity and foreign key violations', async () => {
    await create();
    editDatabase(
      "PRAGMA foreign_keys=OFF; INSERT INTO classroom_rooms VALUES ('missing_project','room_bad','{}','{\"assets\":[]}',NULL)",
    );
    await expect(restore()).rejects.toMatchObject({ reason: 'database_foreign_keys' });
    editDatabase(
      "DELETE FROM classroom_rooms; DELETE FROM learner_identity_bindings; UPDATE projects SET project_id='wrong_project'",
    );
    await expect(restore()).rejects.toMatchObject({ reason: 'project_identity_mismatch' });
    expect(existsSync(destination)).toBe(false);
  });

  it('hashes room assets against their frozen snapshot and detects missing or altered bytes', async () => {
    const bytes = Buffer.from('frozen-room-asset');
    const snapshot = JSON.stringify({
      snapshotVersion: 1,
      course: {
        lessonId: 'lesson_test',
        lessonVersion: 1,
        title: 'Course',
        stageId: 'stage_test',
        dslVersion: '0.3.0',
        documentDigest: '0'.repeat(64),
        bundleDigest: '0'.repeat(64),
      },
      scenes: [
        {
          sceneId: 'scene_test',
          type: 'slide',
          title: 'Slide',
          order: 0,
          elements: [
            {
              elementId: 'el_test',
              type: 'text',
              left: 0,
              top: 0,
              width: 100,
              height: 100,
              rotate: 0,
              text: 'Course content',
            },
          ],
        },
      ],
      evidence: {
        planVersion: 1,
        knowledgeVersions: [{ knowledgeId: 'kp_test', revision: 0 }],
        statements: [],
        segments: [
          {
            materialId: 'mat_test',
            revision: 1,
            segmentId: 'S001',
            fingerprint: '0'.repeat(64),
            text: 'Evidence',
          },
        ],
      },
      sceneSources: [{ sceneId: 'scene_test', knowledgeIds: ['kp_test'], questionId: null }],
      assets: [
        {
          assetId: 'asset_room',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          byteLength: bytes.length,
          mediaType: 'image/png',
          revision: 1,
          bindings: [{ sceneId: 'scene_test', slot: 'image' }],
        },
      ],
    });
    const db = createNodeSqliteDriver().open(projectPaths(source).databaseFile);
    db.prepare('INSERT INTO classroom_rooms VALUES (?,?,?,?,NULL)').run(
      PROJECT.projectId,
      'room_test',
      '{}',
      snapshot,
    );
    db.prepare('INSERT INTO classroom_room_assets VALUES (?,?,?,?)').run(
      PROJECT.projectId,
      'room_test',
      'asset_room',
      bytes,
    );
    db.close();
    await create();
    await restore();
    const secondDestination = join(temp, 'restore-tampered');
    editDatabase(
      "UPDATE classroom_rooms SET snapshot_json=replace(snapshot_json,'0.3.0','99.0.0')",
    );
    await expect(
      restoreProjectBackup({
        backupRoot: backup,
        destinationRoot: secondDestination,
        expectedUid: UID,
      }),
    ).rejects.toMatchObject({ reason: 'unsupported_dsl_version' });
    editDatabase(
      "UPDATE classroom_rooms SET snapshot_json=replace(snapshot_json,'99.0.0','0.3.0')",
    );
    editDatabase('DELETE FROM classroom_room_assets');
    await expect(
      restoreProjectBackup({
        backupRoot: backup,
        destinationRoot: secondDestination,
        expectedUid: UID,
      }),
    ).rejects.toMatchObject({ reason: 'room_asset_manifest_mismatch' });
    expect(existsSync(secondDestination)).toBe(false);
  });

  it('rejects junctions inside a backup payload and modified original archives', async () => {
    store.importMaterial({
      projectId: PROJECT.projectId,
      displayName: 'raw.md',
      materialType: 'md',
      rawText: 'Raw original',
      rawBytes: Buffer.from('Raw original'),
    });
    await create();
    const linked = join(backup, 'project', '.study', 'assets');
    symlinkSync(temp, linked, 'junction');
    await expect(restore()).rejects.toMatchObject({ reason: 'symbolic_link' });
    rmSync(linked);
    editDatabase("UPDATE source_raw_archives SET raw_bytes=x'0001', byte_length=2");
    await expect(restore()).rejects.toMatchObject({ reason: 'blob_digest_mismatch' });
    expect(existsSync(destination)).toBe(false);
  });

  it('migration failure removes staging only and preserves original backup and current project', async () => {
    await create();
    // An interrupted/inconsistent legacy migration can leave columns without its receipt.
    editDatabase(`DELETE FROM schema_migrations WHERE version=${SCHEMA_VERSION}`);
    editManifest((manifest) => {
      manifest.schemaVersion = SCHEMA_VERSION - 1;
    });
    const packageBefore = readFileSync(projectPaths(join(backup, 'project')).databaseFile);
    const currentBefore = readFileSync(projectPaths(source).databaseFile);
    await expect(restore()).rejects.toThrow('duplicate column');
    expect(existsSync(destination)).toBe(false);
    expect(readFileSync(projectPaths(join(backup, 'project')).databaseFile)).toEqual(packageBefore);
    expect(readFileSync(projectPaths(source).databaseFile)).toEqual(currentBefore);
    expect(readdirSync(temp).some((name) => name.startsWith('.sew-restore-'))).toBe(false);
  });

  it.each(['non_database', 'corrupt_page'])(
    'rejects %s SQLite diagnosably without changing the backup or current project',
    async (mode) => {
      await create();
      const file = projectPaths(join(backup, 'project')).databaseFile;
      const currentBefore = readFileSync(projectPaths(source).databaseFile);
      const damaged = mode === 'non_database' ? Buffer.alloc(100, 0x41) : readFileSync(file);
      // First-page b-tree type: preserve the SQLite header but make the schema page unreadable.
      if (mode === 'corrupt_page') damaged[100] = 0xff;
      writeFileSync(file, damaged);
      editManifest((manifest) => {
        const entry = manifest.files.find((item) => item.path === '.study/study.db')!;
        entry.byteLength = damaged.length;
        entry.sha256 = createHash('sha256').update(damaged).digest('hex');
      });
      const manifestBefore = readFileSync(join(backup, 'backup.json'));
      await expect(restore()).rejects.toMatchObject({
        name: 'ProjectBackupError',
        reason: 'database_unreadable',
      });
      expect(existsSync(destination)).toBe(false);
      expect(readFileSync(file)).toEqual(damaged);
      expect(readFileSync(join(backup, 'backup.json'))).toEqual(manifestBefore);
      expect(readFileSync(projectPaths(source).databaseFile)).toEqual(currentBefore);
      expect(existsSync(`${file}-wal`)).toBe(false);
      expect(existsSync(`${file}-shm`)).toBe(false);
      expect(readdirSync(temp).some((name) => name.startsWith('.sew-restore-'))).toBe(false);
    },
  );

  it('rejects future StudyStore schema without migrating it', () => {
    const db = createNodeSqliteDriver().open(projectPaths(source).databaseFile);
    db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(
      SCHEMA_VERSION + 1,
      'future',
      PROJECT.createdAt,
    );
    db.close();
    expect(() => StudyStore.open({ file: projectPaths(source).databaseFile })).toThrow();
  });

  it('migrates supported historical schema only on a staging copy', async () => {
    store.close();
    rmSync(projectPaths(source).databaseFile);
    const db = createNodeSqliteDriver().open(projectPaths(source).databaseFile);
    db.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    for (const migration of MIGRATIONS.filter((item) => item.version <= 19)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(
        migration.version,
        migration.name,
        PROJECT.createdAt,
      );
    }
    db.prepare(
      'INSERT INTO projects (project_id, display_name, created_at, updated_at) VALUES (?,?,?,?)',
    ).run(PROJECT.projectId, PROJECT.displayName, PROJECT.createdAt, PROJECT.createdAt);
    db.prepare('INSERT INTO learner_identity_bindings VALUES (?,?,?,?,?)').run(
      PROJECT.projectId,
      'sew:classroom:owner:v1',
      UID,
      'created_local',
      PROJECT.createdAt,
    );
    db.close();
    // A real legacy DB is packaged without StudyStore.open upgrading the source first.
    const legacy = createNodeSqliteDriver().open(projectPaths(source).databaseFile);
    const proxy = {
      databaseFile: projectPaths(source).databaseFile,
      getProject: () => PROJECT,
      getLocalLearnerBinding: () => ({ uid: UID }),
      backupTo: (file: string) => legacy.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`),
    } as unknown as StudyStore;
    try {
      await createProjectBackup({
        store: proxy,
        projectRoot: source,
        destinationRoot: backup,
        expectedUid: UID,
      });
    } finally {
      legacy.close();
    }
    await restore();
    const restored = createNodeSqliteDriver().open(projectPaths(destination).databaseFile);
    expect(
      (
        restored.prepare('SELECT max(version) AS version FROM schema_migrations').get() as {
          version: number;
        }
      ).version,
    ).toBe(SCHEMA_VERSION);
    restored.close();
    const original = createNodeSqliteDriver().open(projectPaths(source).databaseFile);
    expect(
      (
        original.prepare('SELECT max(version) AS version FROM schema_migrations').get() as {
          version: number;
        }
      ).version,
    ).toBe(19);
    original.close();
  });
});
