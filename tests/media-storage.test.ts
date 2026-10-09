import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zeroMediaUsage, type MediaTaskDto } from '@sew/study-contracts';
import { settleMediaTask } from '@sew/study-domain';
import { createNodeSqliteDriver } from '../packages/study-storage/src/driver';
import { createProjectBackup, restoreProjectBackup } from '@sew/study-storage';
import { closeProject, openProjectFromDisk } from '../apps/learning/lib/server/service';

const roots: string[] = [];
afterEach(() => {
  closeProject();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const limits = { tokens: 20000, images: 2, seconds: 600, characters: 40000 };
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sew-media-storage-'));
  roots.push(root);
  const session = openProjectFromDisk(root);
  const task: MediaTaskDto = {
    schemaVersion: 1,
    taskId: 'media-test',
    intent: 'a'.repeat(64),
    lessonVersion: 1,
    bundleDigest: 'b'.repeat(64),
    knowledgeDigest: 'c'.repeat(64),
    command: {
      scope: { projectId: session.projectId, generation: session.generation, runId: 'run-test' },
      requestId: 'request-test',
      provider: 'openai-compatible',
      model: 'image-test',
      lessonId: 'lesson-test',
      kind: 'image',
      prompt: '来源示意',
      workflowId: 'images-generations',
      workflowLocation: 'remote',
      width: 1024,
      height: 1024,
      steps: 20,
      guidance: 7,
      count: 1,
    },
    observation: {
      projectId: session.projectId,
      requestId: 'request-test',
      runId: 'run-test',
      taskId: 'media-test',
      kind: 'image',
      state: 'started',
      failureKind: null,
      dispatched: true,
      usageMeasurement: 'unknown',
      accounted: null,
      reserved: {
        ...zeroMediaUsage(),
        images: 1,
        tokens: { promptTokens: 500, completionTokens: null, totalTokens: 500 },
      },
      elapsedMs: null,
      cost: null,
      costMeasurement: 'unknown',
      createdAt: '2026-10-08T00:00:00.000Z',
      updatedAt: '2026-10-08T00:00:00.000Z',
    },
    products: [],
    review: { status: 'pending_review', note: '', reviewedAt: null },
  };
  return { session, task };
}
function complete(task: MediaTaskDto, bytes = new Uint8Array([1, 2, 3])) {
  const product: MediaTaskDto['products'][number] = {
    taskId: task.taskId,
    assetId: 'asset-media-test',
    kind: task.command.kind,
    sha256: hash(bytes),
    byteLength: bytes.byteLength,
    mime: 'image/png',
    relativePath: `.study/assets/asset-media-test`,
    durationSeconds: null,
    reviewStatus: 'pending_review',
    authority: false,
    recordedAt: '2026-10-08T00:00:01.000Z',
  };
  const observation = settleMediaTask({
    observation: task.observation,
    next: 'completed',
    products: [product],
    providerUsage: { ...zeroMediaUsage(), images: 1 },
    estimatedUsage: null,
    priceKnown: false,
    cost: null,
    costIsEstimate: false,
    elapsedMs: 1000,
    nowIso: product.recordedAt,
  });
  return {
    task: { ...task, observation, products: [product] },
    products: [{ bytes, mime: 'image/png', durationSeconds: null }],
  };
}

describe('persistent media candidates', () => {
  it('backs up and restores both the authoritative task and its actual product bytes', () => {
    const { session, task } = fixture();
    session.store.media.start(task, limits, () => undefined);
    const done = complete(task);
    session.store.media.settle(done.task, done.products, () => undefined);
    session.store.media.review(session.projectId, task.taskId, task.intent, 'approved', '核对字节');
    const transferRoot = mkdtempSync(join(tmpdir(), 'sew-media-backup-'));
    roots.push(transferRoot);
    const backupRoot = join(transferRoot, 'backup');
    const destinationRoot = join(transferRoot, 'restored');
    createProjectBackup({
      store: session.store,
      projectRoot: session.displayPath,
      destinationRoot: backupRoot,
      expectedUid: session.learnerUid,
    });
    restoreProjectBackup({ backupRoot, destinationRoot, expectedUid: session.learnerUid });
    closeProject();
    const restored = openProjectFromDisk(destinationRoot);
    expect(restored.store.media.byId(restored.projectId, task.taskId)?.review.status).toBe(
      'approved',
    );
    expect([
      ...restored.store.media.readProduct(restored.projectId, 'asset-media-test')!.bytes,
    ]).toEqual([...done.products[0]!.bytes]);
  });
  it('reserves once, settles atomically, blocks unreviewed binding and reads approval after reopen', () => {
    const { session, task } = fixture();
    const reserve = vi.fn();
    session.store.media.start(task, limits, reserve);
    session.store.media.start(task, limits, reserve);
    expect(reserve).toHaveBeenCalledTimes(1);
    const done = complete(task);
    const settle = vi.fn();
    session.store.media.settle(done.task, done.products, settle);
    session.store.media.settle(done.task, done.products, settle);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(() =>
      session.store.putClassroomAssetBinding(
        session.projectId,
        'stage',
        'scene',
        'image',
        'asset-media-test',
      ),
    ).toThrow();
    session.store.media.review(session.projectId, task.taskId, task.intent, 'approved', '已核对');
    session.store.putClassroomAssetBinding(
      session.projectId,
      'stage',
      'scene',
      'image',
      'asset-media-test',
    );
    const savedRoot = session.displayPath;
    closeProject();
    const reopened = openProjectFromDisk(savedRoot);
    expect(
      reopened.store.media.get(reopened.projectId, task.command.requestId)?.review.status,
    ).toBe('approved');
    expect(reopened.store.getClassroomAsset(reopened.projectId, 'asset-media-test')?.sha256).toBe(
      done.task.products[0]?.sha256,
    );
  });

  it('rolls back the task if shared reservation fails and rolls back assets if shared settlement fails', () => {
    const { session, task } = fixture();
    expect(() =>
      session.store.media.start(task, limits, () => {
        throw new Error('shared-budget');
      }),
    ).toThrow('shared-budget');
    expect(session.store.media.list(session.projectId)).toEqual([]);
    session.store.media.start(task, limits, () => undefined);
    const done = complete(task);
    expect(() =>
      session.store.media.settle(done.task, done.products, () => {
        throw new Error('shared-settlement');
      }),
    ).toThrow('shared-settlement');
    expect(session.store.getClassroomAsset(session.projectId, 'asset-media-test')).toBeNull();
    expect(existsSync(join(session.displayPath, '.study', 'assets', 'asset-media-test'))).toBe(
      false,
    );
    expect(
      session.store.media.get(session.projectId, task.command.requestId)?.observation.state,
    ).toBe('started');
  });

  it('preserves unknown reservation and rejects over-budget new tasks without issuing shared calls', () => {
    const { session, task } = fixture();
    session.store.media.start(task, { ...limits, images: 1 }, () => undefined);
    const failed = settleMediaTask({
      observation: task.observation,
      next: 'failed',
      products: [],
      failureKind: 'unknown_outcome',
      providerUsage: null,
      estimatedUsage: null,
      priceKnown: false,
      cost: null,
      costIsEstimate: false,
      elapsedMs: 1000,
      nowIso: '2026-10-08T00:00:01.000Z',
    });
    session.store.media.settle({ ...task, observation: failed }, [], () => undefined);
    const next = {
      ...task,
      taskId: 'next-task',
      intent: 'd'.repeat(64),
      command: { ...task.command, requestId: 'next-request' },
      observation: { ...task.observation, taskId: 'next-task', requestId: 'next-request' },
    };
    const reserve = vi.fn();
    expect(() => session.store.media.start(next, { ...limits, images: 1 }, reserve)).toThrow();
    expect(reserve).not.toHaveBeenCalled();
    expect(
      session.store.media.get(session.projectId, task.command.requestId)?.observation.accounted,
    ).toBeNull();
  });

  it('rejects nonce changes, mutation between reservation and settlement, and asset changes before review', () => {
    const { session, task } = fixture();
    session.store.media.start(task, limits, () => undefined);
    expect(() =>
      session.store.media.start({ ...task, intent: 'e'.repeat(64) }, limits, () => undefined),
    ).toThrow();
    const done = complete(task);
    expect(() =>
      session.store.media.settle(
        { ...done.task, lessonVersion: 2 },
        done.products,
        () => undefined,
      ),
    ).toThrow();
    session.store.media.settle(done.task, done.products, () => undefined);
    expect(() =>
      session.store.putClassroomAsset(
        session.projectId,
        'asset-media-test',
        'image/png',
        {},
        new Uint8Array([4, 5, 6]),
      ),
    ).toThrow();
    expect(session.store.listReclaimableAssets(session.projectId, 'formal')).toEqual([]);
    expect(() =>
      session.store.reclaimAssets(session.projectId, ['asset-media-test'], 'formal'),
    ).toThrow();
    writeFileSync(
      join(session.displayPath, '.study', 'assets', 'asset-media-test'),
      new Uint8Array([4, 5, 6]),
    );
    expect(() => session.store.media.readProduct(session.projectId, 'asset-media-test')).toThrow();
    expect(() =>
      session.store.media.review(session.projectId, task.taskId, task.intent, 'approved', ''),
    ).toThrow();
    expect(() =>
      session.store.putClassroomAssetBinding(
        session.projectId,
        'stage',
        'scene',
        'image',
        'asset-media-test',
      ),
    ).toThrow();
  });

  it('rejects corrupt authoritative task identity instead of re-dispatching a damaged receipt', () => {
    const { session, task } = fixture();
    session.store.media.start(task, limits, () => undefined);
    const db = createNodeSqliteDriver().open(session.store.databaseFile);
    try {
      db.prepare('UPDATE media_generation_tasks SET task_json=? WHERE project_id=?').run(
        JSON.stringify({ ...task, taskId: 'forged' }),
        session.projectId,
      );
    } finally {
      db.close();
    }
    expect(() => session.store.media.get(session.projectId, task.command.requestId)).toThrow();
  });
});
