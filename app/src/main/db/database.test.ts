import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

  it('migrates a 0003 database to 0004, keeping legacy corpus rows intact', () => {
    // Build a database exactly at schema version 3 with a legacy corpus row.
    const db = new DatabaseSync(dbPath);
    for (let i = 0; i < 3; i++) {
      migrations[i](db);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    }
    db.prepare("INSERT INTO conversations (id, title, created_at) VALUES ('c1', 't', 'now')").run();
    db.prepare(
      "INSERT INTO corpus_grants (id, conversation_id, created_at, source_kind) VALUES ('g1', 'c1', 'now', 'files')",
    ).run();
    db.prepare(
      `INSERT INTO corpus_sources
       (id, grant_id, original_path, canonical_path, source_hash, source_size,
        source_mtime, format, markdown_path, markdown_hash, converter)
       VALUES ('s1', 'g1', '/tmp/a.md', '/tmp/a.md', 'h', 1, 'now', 'md', '/tmp/m.md', 'mh', 'direct-utf8-v1')`,
    ).run();
    db.close();

    const migrated = openDatabase(dbPath);
    const version = migrated.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).toBe(migrations.length);
    const columns = (
      migrated.prepare('PRAGMA table_info(corpus_sources)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toContain('snapshot_path');
    // Legacy rows migrate to snapshot_path NULL.
    const row = migrated
      .prepare('SELECT snapshot_path FROM corpus_sources WHERE id = ?')
      .get('s1') as { snapshot_path: string | null };
    expect(row.snapshot_path).toBeNull();
    const indexes = (
      migrated
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain('idx_corpus_sources_grant');
    expect(indexes).toContain('idx_corpus_grants_conversation');
    migrated.close();
  });
});
