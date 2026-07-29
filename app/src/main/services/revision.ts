import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  Actor,
  RevisionInfo,
  RevisionSource,
  TextSplice,
} from '../../shared/domain-types';
import {
  applySplices,
  minimalSplice,
  summarizeSplices,
} from '../../shared/text-splice';
import { atomicWriteText, hashText } from './document';
import { reconcileImageAssetsBestEffort } from './assets';

/** Full-text snapshot is stored on every SNAPSHOT_EVERY-th revision (§7.2). */
export const SNAPSHOT_EVERY = 25;

/**
 * Revision coalescing (owner decision 2026-07-20, M1.5): a user-typing
 * commit amends the tip revision instead of appending a new one when the
 * tip is a recent user-typing revision on the same document — one revision
 * per sitting rather than one per typing burst. The window bounds how long
 * one revision keeps absorbing edits.
 */
export const TIP_AMEND_WINDOW_MS = 15 * 60 * 1000;

export interface CommitMeta {
  actor: Actor;
  source: RevisionSource;
  summary?: string;
}

export type ExternalImportResult =
  | { kind: 'unchanged' }
  | { kind: 'imported'; seq: number }
  | { kind: 'conflict'; currentRevision: number };

interface DocumentRow {
  id: string;
  path: string;
  title: string;
  current_revision: number;
  content_hash: string;
}

/**
 * The revision engine (plan §8). The Markdown file is the canonical text;
 * the DB holds change records and periodic snapshots. All commits validate
 * against the current file content, write the file atomically, then record
 * the revision in one DB transaction.
 */
export class RevisionService {
  /** Depth of commits currently in flight (relevant once IPC is async). */
  private commitDepth = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly projectRoot: string,
  ) {}

  /** Current canonical text = the document file. */
  getCurrentText(documentId: string): string {
    const doc = this.documentRow(documentId);
    return fs.readFileSync(this.filePath(doc), 'utf8');
  }

  getCurrentRevision(documentId: string): number {
    return this.documentRow(documentId).current_revision;
  }

  /**
   * Commit a group of splices as one revision. Validates against the
   * current text, writes the file atomically, records revision + changes
   * (+ snapshot when due) in a transaction, returns the new seq.
   * User-typing commits coalesce into the tip revision when possible
   * (see TIP_AMEND_WINDOW_MS) — then the tip's seq is returned unchanged.
   */
  commit(documentId: string, splices: readonly TextSplice[], meta: CommitMeta): number {
    if (splices.length === 0) {
      throw new Error('cannot commit an empty change group');
    }
    const doc = this.documentRow(documentId);
    const baseText = fs.readFileSync(this.filePath(doc), 'utf8');
    // Throws on any mismatch; the file is untouched in that case.
    const newText = applySplices(baseText, splices);
    if (newText === baseText) {
      return doc.current_revision; // no-op change group, nothing to record
    }
    if (meta.actor === 'user' && meta.source.kind === 'typing') {
      const amended = this.tryAmendTip(doc, baseText, newText, splices, meta);
      if (amended !== null) {
        reconcileImageAssetsBestEffort(this.projectRoot, this.db);
        return amended;
      }
    }
    const seq = this.commitInternal(doc, baseText, splices, meta, { writeFile: true });
    reconcileImageAssetsBestEffort(this.projectRoot, this.db);
    return seq;
  }

  /**
   * Reconstruct the text at `seq`: nearest snapshot at or before it, then
   * replay stored changes. A deleted_text mismatch during replay means the
   * change records are corrupt — fail loudly.
   */
  getTextAt(documentId: string, seq: number): string {
    const current = this.getCurrentRevision(documentId);
    if (seq < 1 || seq > current) {
      throw new Error(`revision ${seq} out of range (1..${current})`);
    }
    const snapshotRow = this.db
      .prepare(
        `SELECT seq, snapshot_text FROM revisions
         WHERE document_id = ? AND seq <= ? AND snapshot_text IS NOT NULL
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(documentId, seq) as { seq: number; snapshot_text: string } | undefined;
    let text: string;
    let fromSeq: number;
    if (snapshotRow) {
      text = snapshotRow.snapshot_text;
      fromSeq = snapshotRow.seq;
    } else {
      text = '';
      fromSeq = 0;
    }
    if (fromSeq === seq) {
      return text;
    }
    const changes = this.db
      .prepare(
        `SELECT seq, idx, from_off, to_off, deleted_text, inserted_text
         FROM revision_changes
         WHERE document_id = ? AND seq > ? AND seq <= ?
         ORDER BY seq, idx`,
      )
      .all(documentId, fromSeq, seq) as Array<{
      seq: number;
      idx: number;
      from_off: number;
      to_off: number;
      deleted_text: string;
      inserted_text: string;
    }>;
    try {
      text = applySplices(
        text,
        changes.map((c) => ({
          from: c.from_off,
          to: c.to_off,
          deletedText: c.deleted_text,
          insertedText: c.inserted_text,
        })),
      );
    } catch (err) {
      throw new Error(
        `change records for revision ${seq} failed replay (corrupt history)`,
        { cause: err },
      );
    }
    return text;
  }

  /**
   * Restore the content of an earlier revision as a NEW revision (history
   * is append-only, plan §8).
   */
  restore(
    documentId: string,
    seq: number,
    meta: { actor: Actor } = { actor: 'user' },
  ): number {
    const target = this.getTextAt(documentId, seq);
    const current = this.getCurrentText(documentId);
    if (target === current) {
      return this.getCurrentRevision(documentId);
    }
    return this.commit(documentId, [minimalSplice(current, target)], {
      actor: meta.actor,
      source: { kind: 'restore', fromRevision: seq },
      summary: `restore of revision ${seq}`,
    });
  }

  /**
   * Import a file changed outside the app (plan §8). The file on disk is
   * already the new content; the DB is brought in sync with an
   * `external`-actor revision. If a commit is in flight, never overwrite —
   * report a conflict and leave both sides intact.
   */
  importExternalChange(
    documentId: string,
    options: { commitInFlight?: boolean } = {},
  ): ExternalImportResult {
    const inFlight = options.commitInFlight ?? this.commitDepth > 0;
    const doc = this.documentRow(documentId);
    const diskText = fs.readFileSync(this.filePath(doc), 'utf8');
    const diskHash = hashText(diskText);
    if (diskHash === doc.content_hash) {
      return { kind: 'unchanged' };
    }
    if (inFlight) {
      return { kind: 'conflict', currentRevision: doc.current_revision };
    }
    const baseText =
      doc.current_revision === 0
        ? ''
        : this.getTextAt(documentId, doc.current_revision);
    const seq = this.commitInternal(
      doc,
      baseText,
      [minimalSplice(baseText, diskText)],
      {
        actor: 'external',
        source: { kind: 'external' },
        summary: 'external edit import',
      },
      { writeFile: false },
    );
    reconcileImageAssetsBestEffort(this.projectRoot, this.db);
    return { kind: 'imported', seq };
  }

  listRevisions(documentId: string, limit = 100): RevisionInfo[] {
    const rows = this.db
      .prepare(
        `SELECT document_id, seq, parent_seq, actor, source_json, summary,
                content_hash, created_at
         FROM revisions WHERE document_id = ?
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(documentId, limit) as Array<{
      document_id: string;
      seq: number;
      parent_seq: number | null;
      actor: string;
      source_json: string;
      summary: string;
      content_hash: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      documentId: row.document_id,
      seq: row.seq,
      parentSeq: row.parent_seq,
      actor: row.actor as Actor,
      source: JSON.parse(row.source_json) as RevisionSource,
      summary: row.summary,
      contentHash: row.content_hash,
      createdAt: row.created_at,
    }));
  }

  /**
   * Shared commit body. `writeFile: false` is used when the file on disk
   * already carries the new content (external import).
   */
  private commitInternal(
    doc: DocumentRow,
    baseText: string,
    splices: readonly TextSplice[],
    meta: CommitMeta,
    options: { writeFile: boolean },
  ): number {
    const newText = applySplices(baseText, splices);
    const newHash = hashText(newText);
    const newSeq = doc.current_revision + 1;
    const snapshot = newSeq % SNAPSHOT_EVERY === 0 ? newText : null;
    this.commitDepth += 1;
    try {
      if (options.writeFile) {
        atomicWriteText(this.filePath(doc), newText);
      }
      this.db.exec('BEGIN');
      try {
        this.db
          .prepare(
            `INSERT INTO revisions
               (document_id, seq, parent_seq, actor, source_json, created_at,
                summary, content_hash, snapshot_text)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            doc.id,
            newSeq,
            doc.current_revision === 0 ? null : doc.current_revision,
            meta.actor,
            JSON.stringify(meta.source),
            new Date().toISOString(),
            meta.summary ?? summarizeSplices(splices),
            newHash,
            snapshot,
          );
        const insertChange = this.db.prepare(
          `INSERT INTO revision_changes
             (document_id, seq, idx, from_off, to_off, deleted_text, inserted_text)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        splices.forEach((splice, idx) => {
          insertChange.run(
            doc.id,
            newSeq,
            idx,
            splice.from,
            splice.to,
            splice.deletedText,
            splice.insertedText,
          );
        });
        this.db
          .prepare(
            'UPDATE documents SET current_revision = ?, content_hash = ? WHERE id = ?',
          )
          .run(newSeq, newHash, doc.id);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        // The canonical rename happens before the SQLite transaction. If the
        // transaction fails while the process is still alive, put the file
        // back immediately instead of waiting for startup reconciliation.
        if (options.writeFile) {
          atomicWriteText(this.filePath(doc), baseText);
        }
        throw err;
      }
    } finally {
      this.commitDepth -= 1;
    }
    return newSeq;
  }

  /**
   * Revision coalescing: amend the tip revision with another user-typing
   * change group, or return null when the tip must stay immutable — it is
   * not a recent user-typing revision, it is checkpointed, or it is the
   * base of an unresolved patch (the agent's expectedText validation must
   * never see its base move). Amending appends to the tip's change list
   * and refreshes its snapshot when it has one, so replay stays exact.
   */
  private tryAmendTip(
    doc: DocumentRow,
    baseText: string,
    newText: string,
    splices: readonly TextSplice[],
    meta: CommitMeta,
  ): number | null {
    if (doc.current_revision === 0) {
      return null;
    }
    const tip = this.db
      .prepare(
        `SELECT actor, source_json, created_at, snapshot_text FROM revisions
         WHERE document_id = ? AND seq = ?`,
      )
      .get(doc.id, doc.current_revision) as
      | { actor: string; source_json: string; created_at: string; snapshot_text: string | null }
      | undefined;
    if (!tip || tip.actor !== 'user') {
      return null;
    }
    const source = JSON.parse(tip.source_json) as RevisionSource;
    if (source.kind !== 'typing') {
      return null;
    }
    if (Date.now() - Date.parse(tip.created_at) > TIP_AMEND_WINDOW_MS) {
      return null;
    }
    const checkpointed =
      this.db
        .prepare(
          'SELECT 1 AS x FROM checkpoints WHERE document_id = ? AND revision_seq = ? LIMIT 1',
        )
        .get(doc.id, doc.current_revision) !== undefined;
    const patchBase =
      this.db
        .prepare(
          `SELECT 1 AS x FROM patches
           WHERE document_id = ? AND base_revision = ?
             AND status IN ('proposed', 'partial', 'conflict') LIMIT 1`,
        )
        .get(doc.id, doc.current_revision) !== undefined;
    if (checkpointed || patchBase) {
      return null;
    }

    const newHash = hashText(newText);
    const prior = this.db
      .prepare(
        `SELECT from_off, to_off, deleted_text, inserted_text FROM revision_changes
         WHERE document_id = ? AND seq = ? ORDER BY idx`,
      )
      .all(doc.id, doc.current_revision) as Array<{
      from_off: number;
      to_off: number;
      deleted_text: string;
      inserted_text: string;
    }>;
    const allSplices: TextSplice[] = [
      ...prior.map((c) => ({
        from: c.from_off,
        to: c.to_off,
        deletedText: c.deleted_text,
        insertedText: c.inserted_text,
      })),
      ...splices,
    ];

    this.commitDepth += 1;
    try {
      atomicWriteText(this.filePath(doc), newText);
      this.db.exec('BEGIN');
      try {
        const insertChange = this.db.prepare(
          `INSERT INTO revision_changes
             (document_id, seq, idx, from_off, to_off, deleted_text, inserted_text)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        splices.forEach((splice, i) => {
          insertChange.run(
            doc.id,
            doc.current_revision,
            prior.length + i,
            splice.from,
            splice.to,
            splice.deletedText,
            splice.insertedText,
          );
        });
        this.db
          .prepare(
            `UPDATE revisions SET summary = ?, content_hash = ?,
               snapshot_text = CASE WHEN snapshot_text IS NOT NULL THEN ? ELSE snapshot_text END
             WHERE document_id = ? AND seq = ?`,
          )
          .run(
            meta.summary ?? summarizeSplices(allSplices),
            newHash,
            newText,
            doc.id,
            doc.current_revision,
          );
        this.db
          .prepare('UPDATE documents SET content_hash = ? WHERE id = ?')
          .run(newHash, doc.id);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        atomicWriteText(this.filePath(doc), baseText);
        throw err;
      }
    } finally {
      this.commitDepth -= 1;
    }
    return doc.current_revision;
  }

  private documentRow(documentId: string): DocumentRow {
    const row = this.db
      .prepare(
        'SELECT id, path, title, current_revision, content_hash FROM documents WHERE id = ?',
      )
      .get(documentId) as DocumentRow | undefined;
    if (!row) {
      throw new Error(`unknown document: ${documentId}`);
    }
    return row;
  }

  private filePath(doc: DocumentRow): string {
    return path.join(this.projectRoot, doc.path);
  }
}
