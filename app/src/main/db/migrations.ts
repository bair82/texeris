import type { DatabaseSync } from 'node:sqlite';

/**
 * Ordered migrations. Index N migrates schema version N → N+1; each runs in
 * a transaction and bumps PRAGMA user_version. Migration 0001 is the full
 * v1 schema from docs/implementation-plan.md §7.2 (including tables only
 * later WPs use — the schema must not preclude them).
 */
export const migrations: ReadonlyArray<(db: DatabaseSync) => void> = [
  (db) => {
    db.exec(`
      CREATE TABLE meta(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE documents(
        id TEXT PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        current_revision INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL
      );

      CREATE TABLE revisions(
        document_id TEXT NOT NULL REFERENCES documents(id),
        seq INTEGER NOT NULL,
        parent_seq INTEGER,
        actor TEXT NOT NULL,
        source_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL,
        snapshot_text TEXT,
        PRIMARY KEY(document_id, seq)
      );

      CREATE TABLE revision_changes(
        document_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        from_off INTEGER NOT NULL,
        to_off INTEGER NOT NULL,
        deleted_text TEXT NOT NULL,
        inserted_text TEXT NOT NULL,
        PRIMARY KEY(document_id, seq, idx),
        FOREIGN KEY(document_id, seq) REFERENCES revisions(document_id, seq)
      );

      CREATE TABLE checkpoints(
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id),
        revision_seq INTEGER NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        snapshot_text TEXT NOT NULL
      );

      CREATE TABLE conversations(
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE messages(
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE agent_runs(
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        model_mode TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        usage_json TEXT,
        context_manifest_json TEXT,
        error_json TEXT
      );

      CREATE TABLE patches(
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id),
        base_revision INTEGER NOT NULL,
        origin_json TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE patch_groups(
        id TEXT PRIMARY KEY,
        patch_id TEXT NOT NULL REFERENCES patches(id),
        idx INTEGER NOT NULL,
        explanation TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE patch_changes(
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES patch_groups(id),
        idx INTEGER NOT NULL,
        from_off INTEGER NOT NULL,
        to_off INTEGER NOT NULL,
        expected_text TEXT NOT NULL,
        insert_text TEXT NOT NULL,
        prefix_context TEXT,
        suffix_context TEXT
      );

      CREATE TABLE settings(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  },
  // 0002: document trash (M1.5 EU3) — trashed docs keep their rows (and
  // revision history) so a later trash view can restore them; NULL = live.
  (db) => {
    db.exec('ALTER TABLE documents ADD COLUMN trashed_at TEXT');
  },
];
