import { z } from 'zod';
import { StudyError } from '@sew/study-contracts';
import type { SqlDatabase } from '../driver';

const token = z
  .string()
  .min(1)
  .max(250)
  .regex(/^[\w:.-]+$/);
const executionKey = z
  .string()
  .min(1)
  .max(1000)
  .regex(/^[\w:.-]+$/);
const receiptSchema = z
  .object({
    projectId: token,
    key: executionKey,
    ownerId: token,
    fence: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type ExecutionLease = z.infer<typeof receiptSchema>;
const claimSchema = z
  .object({
    projectId: token,
    key: executionKey,
    ownerId: token,
    now: z.number().int().nonnegative(),
    ttlMs: z.number().int().min(1000).max(120_000),
  })
  .strict();
interface LeaseRow {
  project_id: string;
  execution_key: string;
  owner_id: string;
  fence: number;
  expires_at: number;
  released: number;
}
const conflict = () =>
  new StudyError('VERSION_CONFLICT', { reason: 'execution_lease_lost_or_held' });

/** Fencing is durable across independent SQLite connections; reclaiming never dispatches work. */
export class ExecutionLeasesRepository {
  constructor(private readonly db: SqlDatabase) {}
  private row(projectId: string, key: string) {
    return this.db
      .prepare('SELECT * FROM execution_leases WHERE project_id=? AND execution_key=?')
      .get(projectId, key) as LeaseRow | undefined;
  }
  private receipt(row: LeaseRow): ExecutionLease {
    return receiptSchema.parse({
      projectId: row.project_id,
      key: row.execution_key,
      ownerId: row.owner_id,
      fence: row.fence,
      expiresAt: row.expires_at,
    });
  }
  held(projectId: string, key: string, now = Date.now()): ExecutionLease | null {
    const row = this.row(token.parse(projectId), executionKey.parse(key));
    if (!row || row.released || row.expires_at <= now) return null;
    return this.receipt(row);
  }
  claim(value: z.input<typeof claimSchema>): ExecutionLease {
    const input = claimSchema.parse(value);
    return this.db.transaction(() => {
      const previous = this.row(input.projectId, input.key);
      if (previous && !previous.released && previous.expires_at > input.now) {
        if (previous.owner_id !== input.ownerId) throw conflict();
        return this.receipt(previous);
      }
      const fence = (previous?.fence ?? 0) + 1;
      const expiresAt = input.now + input.ttlMs;
      if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(fence)) throw conflict();
      this.db
        .prepare(
          `INSERT INTO execution_leases(project_id,execution_key,owner_id,fence,expires_at,released) VALUES(?,?,?,?,?,0)
        ON CONFLICT(project_id,execution_key) DO UPDATE SET owner_id=excluded.owner_id,fence=excluded.fence,expires_at=excluded.expires_at,released=0`,
        )
        .run(input.projectId, input.key, input.ownerId, fence, expiresAt);
      return this.receipt(this.row(input.projectId, input.key)!);
    });
  }
  assert(value: ExecutionLease, now = Date.now()): ExecutionLease {
    const receipt = receiptSchema.parse(value);
    if (!Number.isSafeInteger(now) || now < 0) throw conflict();
    const row = this.row(receipt.projectId, receipt.key);
    if (
      !row ||
      row.released ||
      row.owner_id !== receipt.ownerId ||
      row.fence !== receipt.fence ||
      row.expires_at <= now
    )
      throw conflict();
    return this.receipt(row);
  }
  renew(value: ExecutionLease, now = Date.now(), ttlMs = 30_000): ExecutionLease {
    return this.db.transaction(() => {
      const current = this.assert(value, now);
      const checked = claimSchema.parse({
        projectId: current.projectId,
        key: current.key,
        ownerId: current.ownerId,
        now,
        ttlMs,
      });
      const expiresAt = checked.now + checked.ttlMs;
      if (!Number.isSafeInteger(expiresAt)) throw conflict();
      this.db
        .prepare(
          'UPDATE execution_leases SET expires_at=? WHERE project_id=? AND execution_key=? AND owner_id=? AND fence=? AND released=0',
        )
        .run(expiresAt, current.projectId, current.key, current.ownerId, current.fence);
      return this.receipt(this.row(current.projectId, current.key)!);
    });
  }
  release(value: ExecutionLease): void {
    const receipt = receiptSchema.parse(value);
    this.db
      .prepare(
        'UPDATE execution_leases SET released=1 WHERE project_id=? AND execution_key=? AND owner_id=? AND fence=? AND released=0',
      )
      .run(receipt.projectId, receipt.key, receipt.ownerId, receipt.fence);
  }
  /** Only synchronous database mutations may run here; lease loss rolls the whole transaction back. */
  withLease<T>(value: ExecutionLease, callback: () => T, now?: number): T {
    return this.db.transaction(() => {
      this.assert(value, now ?? Date.now());
      if (callback.constructor.name === 'AsyncFunction')
        throw new StudyError('INVALID_ARGUMENT', { reason: 'lease_transaction_cannot_await' });
      const result = callback();
      if (result instanceof Promise || (result && typeof result === 'object' && 'then' in result))
        throw new StudyError('INVALID_ARGUMENT', { reason: 'lease_transaction_cannot_await' });
      this.assert(value, now ?? Date.now());
      return result;
    });
  }
}
