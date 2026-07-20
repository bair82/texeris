import type { DatabaseSync } from 'node:sqlite';

/**
 * Compact summary of what changed in a document between two revisions —
 * the agent-facing diff between the last state it saw and the current
 * state (plan §11 between-turns context). Shared by the
 * read_revision_changes tool and the runtime's turn injection.
 */

export interface ChangeSummary {
  fromRevision: number;
  toRevision: number;
  changeCount: number;
  text: string;
}

const PREVIEW = 120;

export function summarizeChangesSince(
  db: DatabaseSync,
  documentId: string,
  sinceRevision: number,
  options: { maxChanges?: number; sinceChangeCount?: number } = {},
): ChangeSummary | null {
  const maxChanges = options.maxChanges ?? 60;
  const current = (
    db
      .prepare('SELECT current_revision FROM documents WHERE id = ?')
      .get(documentId) as { current_revision: number } | undefined
  )?.current_revision;
  if (current === undefined) {
    return null;
  }
  const rows: Array<{
    seq: number;
    idx: number;
    deleted_text: string;
    inserted_text: string;
    actor: string;
    summary: string;
  }> = [];
  if (options.sinceChangeCount !== undefined) {
    // Revision coalescing: user typing amends the tip revision, so changes
    // the caller never saw can live INSIDE the revision it last saw —
    // appended after the change count recorded at that time.
    rows.push(
      ...(db
        .prepare(
          `SELECT c.seq, c.idx, c.deleted_text, c.inserted_text, r.actor, r.summary
           FROM revision_changes c
           JOIN revisions r ON r.document_id = c.document_id AND r.seq = c.seq
           WHERE c.document_id = ? AND c.seq = ? AND c.idx >= ?
           ORDER BY c.idx`,
        )
        .all(documentId, sinceRevision, options.sinceChangeCount) as unknown as Array<
        (typeof rows)[number]
      >),
    );
  }
  if (sinceRevision < current) {
    rows.push(
      ...(db
        .prepare(
          `SELECT c.seq, c.idx, c.deleted_text, c.inserted_text, r.actor, r.summary
           FROM revision_changes c
           JOIN revisions r ON r.document_id = c.document_id AND r.seq = c.seq
           WHERE c.document_id = ? AND c.seq > ? AND c.seq <= ?
           ORDER BY c.seq, c.idx`,
        )
        .all(documentId, sinceRevision, current) as unknown as Array<(typeof rows)[number]>),
    );
  }
  if (rows.length === 0) {
    return null;
  }
  const preview = (s: string) =>
    s.length > PREVIEW ? `${s.slice(0, PREVIEW)}…(${s.length} chars)` : s;
  const lines = rows.slice(0, maxChanges).map(
    (row) =>
      `r${row.seq} [${row.actor}] -${JSON.stringify(preview(row.deleted_text))} +${JSON.stringify(preview(row.inserted_text))}`,
  );
  if (rows.length > maxChanges) {
    lines.push(`… and ${rows.length - maxChanges} more changes`);
  }
  return {
    fromRevision: sinceRevision,
    toRevision: current,
    changeCount: rows.length,
    text: lines.join('\n'),
  };
}
