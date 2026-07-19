import { Type, type Static } from '@sinclair/typebox';
import type { TextSplice } from './domain-types';

/**
 * Structured patches against a base revision of the canonical text
 * (plan §9, spike-proven semantics). The agent proposes; the application
 * validates and applies. Pure functions — shared by main (validation,
 * application) and the renderer (review UI).
 */

export interface TextChange {
  from: number;
  to: number;
  expectedText: string;
  insert: string;
  prefixContext?: string;
  suffixContext?: string;
}

export interface PatchGroupInput {
  explanation: string;
  changes: TextChange[];
}

export interface ProposePatchInput {
  documentId?: string;
  baseRevision: number;
  title: string;
  summary: string;
  groups: PatchGroupInput[];
}

export type ConflictReason =
  | 'base-revision-mismatch'
  | 'expected-text-mismatch'
  | 'context-mismatch'
  | 'overlapping-changes'
  | 'empty-patch';

export interface PatchConflictItem {
  groupIdx: number;
  changeIdx: number;
  reason: ConflictReason;
  expectedText?: string;
  actualText?: string;
  message: string;
}

export type PatchStatus = 'proposed' | 'accepted' | 'partial' | 'rejected' | 'conflict';
export type PatchGroupStatus = 'pending' | 'accepted' | 'rejected';

export interface PatchGroupRecord {
  id: string;
  idx: number;
  explanation: string;
  status: PatchGroupStatus;
  changes: TextChange[];
}

export interface PatchRecord {
  id: string;
  documentId: string;
  baseRevision: number;
  title: string;
  summary: string;
  status: PatchStatus;
  createdAt: string;
  resolvedAt: string | null;
  groups: PatchGroupRecord[];
}

// ---------------------------------------------------------------------------
// Pure validation / application
// ---------------------------------------------------------------------------

/** Check one change against the text; null when it matches. */
function checkChange(
  text: string,
  groupIdx: number,
  changeIdx: number,
  change: TextChange,
): PatchConflictItem | null {
  const actual = text.slice(change.from, change.to);
  if (actual !== change.expectedText) {
    return {
      groupIdx,
      changeIdx,
      reason: 'expected-text-mismatch',
      expectedText: change.expectedText,
      actualText: actual,
      message: `expected text not found at ${change.from}..${change.to}`,
    };
  }
  if (
    change.prefixContext !== undefined &&
    text.slice(Math.max(0, change.from - change.prefixContext.length), change.from) !==
      change.prefixContext
  ) {
    return {
      groupIdx,
      changeIdx,
      reason: 'context-mismatch',
      message: `prefix context mismatch before offset ${change.from}`,
    };
  }
  if (
    change.suffixContext !== undefined &&
    text.slice(change.to, change.to + change.suffixContext.length) !== change.suffixContext
  ) {
    return {
      groupIdx,
      changeIdx,
      reason: 'context-mismatch',
      message: `suffix context mismatch after offset ${change.to}`,
    };
  }
  return null;
}

/**
 * Validate groups against the CURRENT text (base revision is a concurrency
 * hint checked by the caller): every expectedText/context must match, and
 * changes must not overlap.
 */
export function validateGroups(
  text: string,
  groups: readonly PatchGroupInput[],
): PatchConflictItem[] {
  const conflicts: PatchConflictItem[] = [];
  interface Flat {
    groupIdx: number;
    changeIdx: number;
    change: TextChange;
  }
  const flat: Flat[] = [];
  groups.forEach((group, groupIdx) => {
    group.changes.forEach((change, changeIdx) => {
      const err = checkChange(text, groupIdx, changeIdx, change);
      if (err) {
        conflicts.push(err);
      } else {
        flat.push({ groupIdx, changeIdx, change });
      }
    });
  });
  const byFrom = [...flat].sort((a, b) => a.change.from - b.change.from);
  for (let i = 1; i < byFrom.length; i++) {
    if (byFrom[i].change.from < byFrom[i - 1].change.to) {
      conflicts.push({
        groupIdx: byFrom[i].groupIdx,
        changeIdx: byFrom[i].changeIdx,
        reason: 'overlapping-changes',
        message: `change at ${byFrom[i].change.from} overlaps an earlier change`,
      });
    }
  }
  if (flat.length === 0 && conflicts.length === 0) {
    conflicts.push({
      groupIdx: -1,
      changeIdx: -1,
      reason: 'empty-patch',
      message: 'patch contains no changes',
    });
  }
  return conflicts;
}

export interface AppliedRange {
  from: number;
  to: number;
}

export type ApplyGroupsResult =
  | { ok: true; text: string; splices: TextSplice[]; appliedRanges: AppliedRange[] }
  | { ok: false; conflicts: PatchConflictItem[] };

/**
 * Validate-then-apply. Atomic: any conflict leaves the text untouched.
 * The returned splices are in the revision engine's sequential convention
 * (ascending, offsets adjusted for earlier insertions), so a patch commit
 * records each change individually in revision_changes.
 */
export function applyGroups(
  text: string,
  groups: readonly PatchGroupInput[],
): ApplyGroupsResult {
  const conflicts = validateGroups(text, groups);
  if (conflicts.length > 0) {
    return { ok: false, conflicts };
  }
  interface Flat {
    change: TextChange;
  }
  const flat: Flat[] = groups.flatMap((group) =>
    group.changes.map((change) => ({ change })),
  );
  const ascending = [...flat].sort((a, b) => a.change.from - b.change.from);
  const splices: TextSplice[] = [];
  const appliedRanges: AppliedRange[] = [];
  let delta = 0;
  let out = text;
  for (const { change } of ascending) {
    const from = change.from + delta;
    const to = from + change.expectedText.length;
    splices.push({ from, to, deletedText: change.expectedText, insertedText: change.insert });
    out = out.slice(0, from) + change.insert + out.slice(to);
    appliedRanges.push({ from, to: from + change.insert.length });
    delta += change.insert.length - change.expectedText.length;
  }
  return { ok: true, text: out, splices, appliedRanges };
}

// ---------------------------------------------------------------------------
// IPC schemas
// ---------------------------------------------------------------------------

export const PatchAcceptRequestSchema = Type.Object({
  patchId: Type.String(),
  groupIds: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
});
export type PatchAcceptRequest = Static<typeof PatchAcceptRequestSchema>;

export const PatchRejectRequestSchema = Type.Object({
  patchId: Type.String(),
  groupIds: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
});
export type PatchRejectRequest = Static<typeof PatchRejectRequestSchema>;

export const PatchGetRequestSchema = Type.Object({ patchId: Type.String() });

export const DocRestoreRequestSchema = Type.Object({
  revision: Type.Integer({ minimum: 1 }),
});
export type DocRestoreRequest = Static<typeof DocRestoreRequestSchema>;

/** main → renderer push event when the agent proposes a patch. */
export interface PatchProposedEvent {
  type: 'patch-proposed';
  patchId: string;
  title: string;
}

export const PatchChannels = {
  list: 'texeris:patch-list',
  get: 'texeris:patch-get',
  accept: 'texeris:patch-accept',
  reject: 'texeris:patch-reject',
  event: 'texeris:patch-event',
} as const;
