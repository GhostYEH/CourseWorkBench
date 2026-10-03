/**
 * SQLite 驱动抽象。
 *
 * 《规划书》把 better-sqlite3 列为候选驱动。首版先用 Node 22 内置的 `node:sqlite`
 * 落地：随包 Node 直接可用、无原生编译与 ABI 风险，接口形状与 better-sqlite3
 * 接近，后续要换驱动只需实现同一个 `SqlDatabase`。
 *
 * 注意：Electron 主进程不打开数据库；数据库由本地服务（随包 Node）独占写入。
 */

export interface SqlRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqlStatement {
  run(...params: unknown[]): SqlRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /** 事务包装：回调抛错时回滚。 */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface SqliteDriver {
  readonly name: string;
  open(file: string): SqlDatabase;
}

interface NodeSqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

export const createNodeSqliteDriver = (): SqliteDriver => ({
  name: 'node:sqlite',
  open(file: string): SqlDatabase {
    // 同步取用内置模块，避免在 ESM 里使用 require，也避免顶层 import 让
    // 没有 node:sqlite 的环境（例如只做类型检查的构建）直接失败。
    const builtin = (
      process as unknown as { getBuiltinModule?: (id: string) => unknown }
    ).getBuiltinModule?.('node:sqlite') as
      | { DatabaseSync: new (path: string) => NodeSqliteDatabase }
      | undefined;
    if (!builtin) {
      throw new Error('当前 Node 运行时没有 node:sqlite，无法打开本地数据库');
    }
    const raw = new builtin.DatabaseSync(file);
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec('PRAGMA busy_timeout = 5000');

    let depth = 0;
    return {
      exec: (sql) => raw.exec(sql),
      prepare: (sql) => {
        const statement = raw.prepare(sql);
        return {
          run: (...params) => {
            const result = statement.run(...params);
            return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
          },
          get: (...params) => statement.get(...params),
          all: (...params) => statement.all(...params),
        };
      },
      transaction<T>(fn: () => T): T {
        const level = depth + 1;
        // BEGIN can fail (e.g. SQLITE_BUSY). Change depth only after it succeeds.
        raw.exec(level === 1 ? 'BEGIN IMMEDIATE' : `SAVEPOINT sp_${level}`);
        depth = level;
        try {
          const result = fn();
          raw.exec(level === 1 ? 'COMMIT' : `RELEASE sp_${level}`);
          return result;
        } catch (error) {
          try {
            if (level === 1) raw.exec('ROLLBACK');
            else {
              raw.exec(`ROLLBACK TO sp_${level}`);
              raw.exec(`RELEASE sp_${level}`);
            }
          } catch (rollbackError) {
            // A cleanup failure must not replace the original business/commit error.
            console.error('[sqlite] transaction rollback failed', rollbackError);
          }
          throw error;
        } finally {
          depth = level - 1;
        }
      },
      close: () => raw.close(),
    };
  },
});
