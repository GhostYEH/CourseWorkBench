import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeSqliteDriver } from '@sew/study-storage';
import { applyMigrations } from '../packages/study-storage/src/schema';
import { ExecutionLeasesRepository } from '../packages/study-storage/src/repositories/execution-leases';

describe('durable execution lease fencing', () => {
  it('excludes a second writer and fences stale receipts after expiry, renewal and reopening', () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-lease-'));
    const path = join(root, 'lease.db');
    const firstDb = createNodeSqliteDriver().open(path);
    applyMigrations(firstDb);
    const secondDb = createNodeSqliteDriver().open(path);
    try {
      const first = new ExecutionLeasesRepository(firstDb);
      const second = new ExecutionLeasesRepository(secondDb);
      const claim = {
        projectId: 'project_1',
        key: 'pro:owner:session:task',
        ownerId: 'executor_1',
        now: 1000,
        ttlMs: 1000,
      };
      const lease = first.claim(claim);
      expect(first.claim({ ...claim, now: 1500 }).fence).toBe(lease.fence);
      expect(() => second.claim({ ...claim, ownerId: 'executor_2', now: 1500 })).toThrow();
      const renewed = first.renew(lease, 1900, 1000);
      expect(renewed.expiresAt).toBe(2900);
      const takeover = second.claim({ ...claim, ownerId: 'executor_2', now: 2900 });
      expect(takeover.fence).toBe(lease.fence + 1);
      expect(() => first.assert(renewed, 2901)).toThrow();
      first.release(lease);
      expect(second.assert(takeover, 2901)).toEqual(takeover);
      expect(() =>
        first.withLease(lease, () => firstDb.exec('CREATE TABLE unauthorized (id TEXT)'), 2901),
      ).toThrow();
      expect(
        firstDb.prepare("SELECT name FROM sqlite_master WHERE name='unauthorized'").get(),
      ).toBeUndefined();
      second.release(takeover);
      expect(() => second.assert(takeover, 2901)).toThrow();
    } finally {
      firstDb.close();
      secondDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('rejects asynchronous transaction callbacks and rolls back their synchronous writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-lease-'));
    const db = createNodeSqliteDriver().open(join(root, 'lease.db'));
    applyMigrations(db);
    try {
      const repo = new ExecutionLeasesRepository(db);
      const lease = repo.claim({
        projectId: 'project_1',
        key: 'task',
        ownerId: 'worker',
        now: 1,
        ttlMs: 1000,
      });
      expect(() =>
        repo.withLease(
          lease,
          () => {
            db.exec('CREATE TABLE must_rollback (id TEXT)');
            return Promise.resolve();
          },
          2,
        ),
      ).toThrow();
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='must_rollback'").get(),
      ).toBeUndefined();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
