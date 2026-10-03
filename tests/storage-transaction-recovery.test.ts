import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeSqliteDriver, type SqlDatabase } from '@sew/study-storage';

describe('SQLite transaction recovery', () => {
  let directory: string;
  let file: string;
  let writer: SqlDatabase;
  let reader: SqlDatabase;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sew-transaction-'));
    file = join(directory, 'db.sqlite');
    writer = createNodeSqliteDriver().open(file);
    reader = createNodeSqliteDriver().open(file);
    writer.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY)');
    writer.exec('PRAGMA busy_timeout = 0');
  });

  afterEach(() => {
    writer.close();
    reader.close();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it('commits durably after a lock failure followed by a callback failure', () => {
    reader.exec('BEGIN IMMEDIATE');
    const callback = vi.fn();
    try {
      expect(() => writer.transaction(callback)).toThrow();
      expect(callback).not.toHaveBeenCalled();
    } finally {
      reader.exec('ROLLBACK');
    }

    const failure = new Error('failed command');
    expect(() => writer.transaction(() => {
      writer.prepare('INSERT INTO entries VALUES (?)').run(1);
      throw failure;
    })).toThrow(failure);

    writer.transaction(() => writer.prepare('INSERT INTO entries VALUES (?)').run(2));
    expect(reader.prepare('SELECT id FROM entries').all()).toEqual([{ id: 2 }]);
    writer.close();
    writer = createNodeSqliteDriver().open(file);
    expect(writer.prepare('SELECT id FROM entries').all()).toEqual([{ id: 2 }]);
  });

  it('rolls back a nested failure while preserving the outer transaction', () => {
    writer.transaction(() => {
      writer.prepare('INSERT INTO entries VALUES (?)').run(1);
      expect(() => writer.transaction(() => {
        writer.prepare('INSERT INTO entries VALUES (?)').run(2);
        throw new Error('nested failure');
      })).toThrow('nested failure');
      writer.transaction(() => writer.prepare('INSERT INTO entries VALUES (?)').run(3));
      expect(reader.prepare('SELECT id FROM entries').all()).toEqual([]);
    });
    expect(reader.prepare('SELECT id FROM entries ORDER BY id').all()).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it('keeps the original error when rollback itself fails', () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('original failure');
    expect(() => writer.transaction(() => {
      writer.exec('ROLLBACK');
      throw failure;
    })).toThrow(failure);
    expect(diagnostic).toHaveBeenCalled();
    writer.transaction(() => writer.prepare('INSERT INTO entries VALUES (?)').run(4));
    expect(reader.prepare('SELECT id FROM entries').all()).toEqual([{ id: 4 }]);
  });
});
