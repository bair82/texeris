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

  create(documentId: string, name: string, description = ''): CheckpointInfo {
    const revisionSeq = this.revisions.getCurrentRevision(documentId);
    if (revisionSeq === 0) {
      throw new Error('cannot checkpoint a document with no revisions');
    }
    const snapshot = this.revisions.getTextAt(documentId, revisionSeq);
    const info: CheckpointInfo = {
      id: randomUUID(),
      documentId,
      revisionSeq,
      name,
      description,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO checkpoints
           (id, document_id, revision_seq, name, description, created_at, snapshot_text)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(info.id, documentId, revisionSeq, name, description, info.createdAt, snapshot);
    return info;
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
