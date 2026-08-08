import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CheckpointInfo } from '../../shared/domain-types';
import type { RevisionService } from './revision';

/**
 * Checkpoints are durable named snapshots (plan §8). Restoring one is just a
 * restore of the revision it points at — history stays append-only.
 */
export class CheckpointService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly revisions: RevisionService,
  ) {}

  /**
   * Create a checkpoint at the current revision. Name and description are
   * optional (owner request 2026-08-08): when omitted they are generated —
   * the name is `checkpoint rev N` and the description carries the tip
   * revision summary and creation time. Users can rename later, but normally
   * shouldn't have to.
   */
  create(documentId: string, name?: string, description?: string): CheckpointInfo {
    const revisionSeq = this.revisions.getCurrentRevision(documentId);
    if (revisionSeq === 0) {
      throw new Error('cannot checkpoint a document with no revisions');
    }
    const snapshot = this.revisions.getTextAt(documentId, revisionSeq);
    const createdAt = new Date().toISOString();
    const finalName = name?.trim() || `checkpoint rev ${revisionSeq}`;
    const finalDescription =
      description?.trim() ||
      this.autoDescription(documentId, revisionSeq, createdAt);
    const info: CheckpointInfo = {
      id: randomUUID(),
      documentId,
      revisionSeq,
      name: finalName,
      description: finalDescription,
      createdAt,
    };
    this.db
      .prepare(
        `INSERT INTO checkpoints
           (id, document_id, revision_seq, name, description, created_at, snapshot_text)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(info.id, documentId, revisionSeq, info.name, info.description, createdAt, snapshot);
    return info;
  }

  /** Rename a checkpoint / edit its description (either field optional). */
  rename(
    checkpointId: string,
    input: { name?: string; description?: string },
  ): CheckpointInfo {
    const existing = this.get(checkpointId);
    if (!existing) {
      throw new Error(`unknown checkpoint: ${checkpointId}`);
    }
    const finalName = input.name !== undefined ? input.name.trim() : existing.name;
    if (!finalName) {
      throw new Error('checkpoint name cannot be empty');
    }
    const finalDescription =
      input.description !== undefined ? input.description.trim() : existing.description;
    this.db
      .prepare('UPDATE checkpoints SET name = ?, description = ? WHERE id = ?')
      .run(finalName, finalDescription, checkpointId);
    return { ...existing, name: finalName, description: finalDescription };
  }

  get(checkpointId: string): CheckpointInfo | null {
    const row = this.db
      .prepare(
        'SELECT id, document_id, revision_seq, name, description, created_at FROM checkpoints WHERE id = ?',
      )
      .get(checkpointId) as
      | {
          id: string;
          document_id: string;
          revision_seq: number;
          name: string;
          description: string;
          created_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      documentId: row.document_id,
      revisionSeq: row.revision_seq,
      name: row.name,
      description: row.description,
      createdAt: row.created_at,
    };
  }

  /** Generated description: tip revision summary + timestamp. */
  private autoDescription(documentId: string, revisionSeq: number, createdAt: string): string {
    const tip = this.revisions.listRevisions(documentId, 1)[0];
    const summary = tip?.summary.trim() || `revision ${revisionSeq}`;
    const stamp = createdAt.slice(0, 16).replace('T', ' ');
    return `${summary} · ${stamp}`;
  }

  list(documentId: string): CheckpointInfo[] {
    const rows = this.db
      .prepare(
        `SELECT id, document_id, revision_seq, name, description, created_at
         FROM checkpoints WHERE document_id = ? ORDER BY created_at, rowid`,
      )
      .all(documentId) as Array<{
      id: string;
      document_id: string;
      revision_seq: number;
      name: string;
      description: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      revisionSeq: row.revision_seq,
      name: row.name,
      description: row.description,
      createdAt: row.created_at,
    }));
  }

  /** Restore as a new revision (append-only). Returns the new seq. */
  restore(checkpointId: string): number {
    const row = this.db
      .prepare('SELECT document_id, revision_seq FROM checkpoints WHERE id = ?')
      .get(checkpointId) as
      | { document_id: string; revision_seq: number }
      | undefined;
    if (!row) {
      throw new Error(`unknown checkpoint: ${checkpointId}`);
    }
    return this.revisions.restore(row.document_id, row.revision_seq);
  }
}
