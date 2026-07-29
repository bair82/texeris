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
  // 0003: skills, delegated runs, scoped profile corpora, and patch style
  // reviews. These are application-level records: Pi sessions remain an
  // implementation detail and never become the source of truth.
  (db) => {
    db.exec(`
      ALTER TABLE conversations ADD COLUMN skill_id TEXT;
      ALTER TABLE conversations ADD COLUMN skill_version INTEGER;
      ALTER TABLE conversations ADD COLUMN corpus_grant_id TEXT;

      ALTER TABLE agent_runs ADD COLUMN parent_run_id TEXT;
      ALTER TABLE agent_runs ADD COLUMN role_id TEXT;
      ALTER TABLE agent_runs ADD COLUMN skill_id TEXT;
      ALTER TABLE agent_runs ADD COLUMN skill_version INTEGER;
      ALTER TABLE agent_runs ADD COLUMN result_json TEXT;

      ALTER TABLE patches ADD COLUMN style_review_json TEXT;

      CREATE TABLE corpus_grants(
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        created_at TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      );

      CREATE TABLE corpus_sources(
        id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL REFERENCES corpus_grants(id),
        original_path TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        source_size INTEGER NOT NULL,
        source_mtime TEXT NOT NULL,
        format TEXT NOT NULL,
        markdown_path TEXT NOT NULL,
        markdown_hash TEXT NOT NULL,
        converter TEXT NOT NULL,
        detected_date TEXT,
        date_confidence TEXT,
        conversion_warnings_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE delegated_results(
        id TEXT PRIMARY KEY,
        parent_run_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role_id TEXT NOT NULL,
        status TEXT NOT NULL,
        task TEXT NOT NULL,
        summary TEXT,
        result_json TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        usage_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        ended_at TEXT
      );
    `);
  },
  // 0004: corpus ownership — grants snapshot source bytes into per-project
  // storage at grant time (snapshot_path; NULL = legacy row that still reads
  // the original file), plus indexes for grant/conversation lookups.
  (db) => {
    db.exec(`
      ALTER TABLE corpus_sources ADD COLUMN snapshot_path TEXT;
      CREATE INDEX IF NOT EXISTS idx_corpus_sources_grant ON corpus_sources(grant_id);
      CREATE INDEX IF NOT EXISTS idx_corpus_grants_conversation ON corpus_grants(conversation_id);
    `);
  },
  // 0005: edit-message rewind. User messages retain the exact run context
  // they saw; conversation forks record their origin without sharing runs,
  // patches, delegations, or corpus grants.
  (db) => {
    db.exec(`
      ALTER TABLE messages ADD COLUMN turn_context_json TEXT;
      ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT;
      ALTER TABLE conversations ADD COLUMN forked_from_message_seq INTEGER;

      UPDATE messages
      SET turn_context_json = (
        SELECT json_object(
          'runId', r.id,
          'mode', r.model_mode,
          'manifest', json(r.context_manifest_json)
        )
        FROM agent_runs r
        WHERE r.conversation_id = messages.conversation_id
          AND r.parent_run_id IS NULL
          AND r.context_manifest_json IS NOT NULL
          AND r.started_at <= messages.created_at
          AND (r.ended_at IS NULL OR r.ended_at >= messages.created_at)
        ORDER BY r.started_at DESC, r.rowid DESC
        LIMIT 1
      )
      WHERE messages.role = 'user';
    `);
  },
  // 0006: rebuildable search index for the canonical project CSL JSON file.
  (db) => {
    db.exec(`
      CREATE TABLE reference_index(
        citation_key TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        authors TEXT NOT NULL,
        issued_year TEXT NOT NULL,
        doi TEXT,
        record_json TEXT NOT NULL
      );
      CREATE INDEX idx_reference_title ON reference_index(title);
      CREATE INDEX idx_reference_authors ON reference_index(authors);
    `);
  },
];
