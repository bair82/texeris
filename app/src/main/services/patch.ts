import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  PatchConflictItem,
  PatchGroupStatus,
  PatchRecord,
  PatchStatus,
  ProposePatchInput,
  ResolvedTextChange,
} from '../../shared/patch-types';
import { applyGroups, resolveAnchors, validateGroups } from '../../shared/patch-types';
import type { RevisionService } from './revision';

/**
 * The patch pipeline (plan §9): the agent proposes structured patches; the
 * application validates, stores, reviews, and applies them. Validation is
 * always against the CURRENT text — the base revision is a concurrency hint
 * (rebase policy v1: expectedText still matching ⇒ auto-rebase with notice;
 * otherwise a structured conflict goes back to the agent to regenerate).
 */
/**
 * Shift changes from base coordinates by the cumulative length delta of
 * already-applied changes located before them (partial acceptance across
 * multiple transactions).
 */
function shiftChanges(
  changes: ResolvedTextChange[],
  applied: ResolvedTextChange[],
): ResolvedTextChange[] {
  if (applied.length === 0) {
    return changes;
  }
  const sorted = [...applied].sort((a, b) => a.from - b.from);
  return changes.map((change) => {
    let delta = 0;
    for (const a of sorted) {
      if (a.from <= change.from) {
        delta += a.insert.length - a.expectedText.length;
      }
    }
    return { ...change, from: change.from + delta, to: change.to + delta };
  });
}

export class PatchService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly revisions: RevisionService,
    private readonly onProposed?: (patchId: string, title: string) => void,
  ) {}

  propose(
    input: ProposePatchInput & { documentId: string },
    origin: { conversationId?: string; agentRunId?: string } = {},
  ): { patchId: string } | { conflict: PatchConflictItem[] } {
    const current = this.revisions.getCurrentRevision(input.documentId);
    if (input.baseRevision < 1 || input.baseRevision > current) {
      return {
        conflict: [
          {
            groupIdx: -1,
            changeIdx: -1,
            reason: 'base-revision-mismatch',
            message: `base revision ${input.baseRevision} out of range (1..${current}) — re-read the document`,
          },
        ],
      };
    }
    const text = this.revisions.getCurrentText(input.documentId);
    const resolved = resolveAnchors(text, input.groups);
    if (!resolved.ok) {
      return { conflict: resolved.conflicts };
    }
    const resolvedGroups = resolved.groups;
    const conflicts = validateGroups(text, resolvedGroups);
    if (conflicts.length > 0) {
      return { conflict: conflicts };
    }
    const patchId = randomUUID();
    const now = new Date().toISOString();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO patches
             (id, document_id, base_revision, origin_json, title, summary, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?)`,
        )
        .run(
          patchId,
          input.documentId,
          input.baseRevision,
          JSON.stringify(origin),
          input.title,
          input.summary,
          now,
        );
      const insertGroup = this.db.prepare(
        'INSERT INTO patch_groups (id, patch_id, idx, explanation, status) VALUES (?, ?, ?, ?, ?)',
      );
      const insertChange = this.db.prepare(
        `INSERT INTO patch_changes
           (id, group_id, idx, from_off, to_off, expected_text, insert_text,
            prefix_context, suffix_context)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      resolvedGroups.forEach((group, groupIdx) => {
        const groupId = randomUUID();
        insertGroup.run(groupId, patchId, groupIdx, group.explanation, 'pending');
        group.changes.forEach((change, changeIdx) => {
          insertChange.run(
            randomUUID(),
            groupId,
            changeIdx,
            change.from,
            change.to,
            change.expectedText,
            change.insert,
            change.prefixContext ?? null,
            change.suffixContext ?? null,
          );
        });
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.onProposed?.(patchId, input.title);
    return { patchId };
  }

  get(patchId: string): PatchRecord | null {    const row = this.db
      .prepare(
        `SELECT id, document_id, base_revision, title, summary, status, created_at, resolved_at
         FROM patches WHERE id = ?`,
      )
      .get(patchId) as
      | {
          id: string;
          document_id: string;
          base_revision: number;
          title: string;
          summary: string;
          status: string;
          created_at: string;
          resolved_at: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    const groups = (
      this.db
        .prepare('SELECT id, idx, explanation, status FROM patch_groups WHERE patch_id = ? ORDER BY idx')
        .all(patchId) as unknown as Array<{
        id: string;
        idx: number;
        explanation: string;
        status: string;
      }>
    ).map((group) => ({
      id: group.id,
      idx: group.idx,
      explanation: group.explanation,
      status: group.status as PatchGroupStatus,
      changes: (
        this.db
          .prepare(
            `SELECT from_off, to_off, expected_text, insert_text, prefix_context, suffix_context
             FROM patch_changes WHERE group_id = ? ORDER BY idx`,
          )
          .all(group.id) as unknown as Array<{
          from_off: number;
          to_off: number;
          expected_text: string;
          insert_text: string;
          prefix_context: string | null;
          suffix_context: string | null;
        }>
      ).map((change): ResolvedTextChange => {
        const out: ResolvedTextChange = {
          from: change.from_off,
          to: change.to_off,
          expectedText: change.expected_text,
          insert: change.insert_text,
        };
        if (change.prefix_context !== null) {
          out.prefixContext = change.prefix_context;
        }
        if (change.suffix_context !== null) {
          out.suffixContext = change.suffix_context;
        }
        return out;
      }),
    }));
    return {
      id: row.id,
      documentId: row.document_id,
      baseRevision: row.base_revision,
      title: row.title,
      summary: row.summary,
      status: row.status as PatchStatus,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      groups,
    };
  }

  list(documentId?: string): PatchRecord[] {
    const rows = (
      documentId
        ? this.db
            .prepare('SELECT id FROM patches WHERE document_id = ? ORDER BY created_at DESC')
            .all(documentId)
        : this.db.prepare('SELECT id FROM patches ORDER BY created_at DESC').all()
    ) as unknown as Array<{ id: string }>;
    return rows.map((row) => this.get(row.id)!);
  }

  /**
   * Apply the chosen groups as ONE agent revision linked to the patch.
   * Re-validates against the current text first — a stale patch fails
   * safely with a structured conflict and status 'conflict'.
   */
  accept(
    patchId: string,
    groupIds?: string[],
  ): { seq: number; previousSeq: number } | { conflict: PatchConflictItem[] } {
    const patch = this.get(patchId);
    if (!patch) {
      throw new Error(`unknown patch: ${patchId}`);
    }
    const chosen = patch.groups.filter(
      (g) => g.status === 'pending' && (!groupIds || groupIds.includes(g.id)),
    );
    if (chosen.length === 0) {
      throw new Error('no pending groups selected');
    }
    // Earlier accepts moved the text: shift the remaining spans by the
    // cumulative delta of already-applied changes before them (all changes
    // in a patch are stored in base-revision coordinates).
    const appliedBefore = patch.groups
      .filter((g) => g.status === 'accepted')
      .flatMap((g) => g.changes);
    const rebasedGroups = chosen.map((g) => ({
      explanation: g.explanation,
      changes: shiftChanges(g.changes, appliedBefore),
    }));
    const text = this.revisions.getCurrentText(patch.documentId);
    const result = applyGroups(text, rebasedGroups);
    if (!result.ok) {
      this.setPatchStatus(patchId, 'conflict');
      return { conflict: result.conflicts };
    }
    const previousSeq = this.revisions.getCurrentRevision(patch.documentId);
    const origin = this.readOrigin(patchId);
    const seq = this.revisions.commit(patch.documentId, result.splices, {
      actor: 'agent',
      source: { kind: 'patch', patchId, ...origin },
      summary: patch.title,
    });
    const now = new Date().toISOString();
    const markGroup = this.db.prepare(
      "UPDATE patch_groups SET status = 'accepted' WHERE id = ?",
    );
    for (const group of chosen) {
      markGroup.run(group.id);
    }
    this.refreshPatchStatus(patchId, now);
    return { seq, previousSeq };
  }

  reject(patchId: string, groupIds?: string[]): void {
    const patch = this.get(patchId);
    if (!patch) {
      throw new Error(`unknown patch: ${patchId}`);
    }
    const chosen = patch.groups.filter(
      (g) => g.status === 'pending' && (!groupIds || groupIds.includes(g.id)),
    );
    if (chosen.length === 0) {
      throw new Error('no pending groups selected');
    }
    const mark = this.db.prepare("UPDATE patch_groups SET status = 'rejected' WHERE id = ?");
    for (const group of chosen) {
      mark.run(group.id);
    }
    this.refreshPatchStatus(patchId, new Date().toISOString());
  }

  /**
   * Recompute patch status from group statuses: 'accepted' when every group
   * is accepted, 'rejected' when none is accepted and all are resolved,
   * 'partial' when some are accepted, otherwise still 'proposed'.
   */
  private refreshPatchStatus(patchId: string, resolvedAt: string): void {
    const fresh = this.get(patchId);
    if (!fresh) {
      return;
    }
    const pending = fresh.groups.filter((g) => g.status === 'pending').length;
    const accepted = fresh.groups.filter((g) => g.status === 'accepted').length;
    let status: PatchStatus;
    if (accepted === fresh.groups.length) {
      status = 'accepted';
    } else if (pending === 0) {
      status = accepted > 0 ? 'partial' : 'rejected';
    } else if (accepted > 0) {
      status = 'partial';
    } else {
      return; // still fully proposed
    }
    this.setPatchStatus(patchId, status, pending === 0 ? resolvedAt : undefined);
  }

  private setPatchStatus(patchId: string, status: PatchStatus, resolvedAt?: string): void {
    this.db
      .prepare('UPDATE patches SET status = ?, resolved_at = COALESCE(?, resolved_at) WHERE id = ?')
      .run(status, resolvedAt ?? null, patchId);
  }

  private readOrigin(patchId: string): { conversationId?: string; agentRunId?: string } {
    const row = this.db
      .prepare('SELECT origin_json FROM patches WHERE id = ?')
      .get(patchId) as { origin_json: string } | undefined;
    return row ? (JSON.parse(row.origin_json) as { conversationId?: string; agentRunId?: string }) : {};
  }
}
