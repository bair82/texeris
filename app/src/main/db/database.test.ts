import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database';
import { migrations } from './migrations';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-db-'));
  dbPath = path.join(dir, 'history.sqlite');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase / migration 0001', () => {
  it('creates the full v1 schema and sets user_version', () => {
    const db = openDatabase(dbPath);
    const version = db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(migrations.length);

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const expected of [
      'meta',
      'documents',
      'revisions',
      'revision_changes',
      'checkpoints',
      'conversations',
      'messages',
      'agent_runs',
      'patches',
      'patch_groups',
      'patch_changes',
      'settings',
    ]) {
      expect(tables).toContain(expected);
    }
    db.close();
  });

  it('is idempotent on reopen and keeps data', () => {
    const db = openDatabase(dbPath);
    db.prepare("INSERT INTO settings (key, value) VALUES ('k', 'v')").run();
    db.close();

    const reopened = openDatabase(dbPath);
    const row = reopened
      .prepare("SELECT value FROM settings WHERE key = 'k'")
      .get() as { value: string };
    expect(row.value).toBe('v');
    const version = reopened.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(migrations.length);
    reopened.close();
  });
});
