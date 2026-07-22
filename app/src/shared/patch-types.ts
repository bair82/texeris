import { Type, type Static } from '@sinclair/typebox';
import type { TextSplice } from './domain-types';

/**
 * Structured patches against a base revision of the canonical text
 * (plan §9, spike-proven semantics). The agent proposes; the application
 * validates and applies. Pure functions — shared by main (validation,
 * application) and the renderer (review UI).
 */

export interface TextChange {
  /**
   * Optional offsets. Prefer omitting them: the application locates
   * `expectedText` itself (uniquely, or disambiguated by context). When
   * given, they must be exact — expectedText must match at [from, to).
   */
  from?: number;
  to?: number;
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
  | 'empty-patch'
  | 'anchor-not-found'
  | 'anchor-ambiguous'
  | 'anchor-missing';

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
  /** Stored changes always carry resolved offsets. */
  changes: ResolvedTextChange[];
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
  styleReview: PatchStyleReview | null;
  groups: PatchGroupRecord[];
}

export interface PatchStyleIssue {
  groupIndex: number;
  changeIndex: number;
  category: string;
  span: string;
  severity: 'medium' | 'high';
  confidence: 'medium' | 'high';
  reason: string;
  direction: string;
}

export interface PatchStyleReview {
  verdict: 'pass' | 'revise' | 'unavailable';
  mode: 'audit' | 'revise-once';
  issues: PatchStyleIssue[];
  model?: string;
  promptVersion: number;
  warning?: string;
}

// ---------------------------------------------------------------------------
// Anchor resolution (offset-free changes)
// ---------------------------------------------------------------------------

/** A change whose offsets are known (post-resolution, post-storage). */
export type ResolvedTextChange = TextChange & { from: number; to: number };
export type ResolvedPatchGroup = Omit<PatchGroupInput, 'changes'> & {
  changes: ResolvedTextChange[];
};

function occurrencesOf(text: string, needle: string): number[] {
  const out: number[] = [];
  let i = text.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = text.indexOf(needle, i + 1);
  }
  return out;
}

/**
 * Locate every change in the text: changes with explicit offsets pass
 * through; offset-free changes are resolved by searching `expectedText`
 * (uniquely, or disambiguated by prefix/suffix context). LLMs are bad at
 * counting characters — anchors move that work to deterministic code.
 */
export function resolveAnchors(
  text: string,
  groups: readonly PatchGroupInput[],
):
  | { ok: true; groups: ResolvedPatchGroup[] }
  | { ok: false; conflicts: PatchConflictItem[] } {
  const conflicts: PatchConflictItem[] = [];
  const resolved: ResolvedPatchGroup[] = groups.map((group, groupIdx) => ({
    explanation: group.explanation,
    changes: group.changes.map((change, changeIdx) => {
      const conflict = (reason: ConflictReason, message: string): PatchConflictItem => ({
        groupIdx,
        changeIdx,
        reason,
        message,
      });
      if (change.from !== undefined && change.to !== undefined) {
        return change as ResolvedTextChange;
      }
      if (change.expectedText === '') {
        // pure insertion: needs a unique context anchor
        if (change.prefixContext) {
          const hits = occurrencesOf(text, change.prefixContext);
          if (hits.length === 1) {
            const at = hits[0] + change.prefixContext.length;
            return { ...change, from: at, to: at };
          }
        }
        if (change.suffixContext) {
          const hits = occurrencesOf(text, change.suffixContext);
          if (hits.length === 1) {
            const at = hits[0];
            return { ...change, from: at, to: at };
          }
        }
        conflicts.push(
          conflict(
            'anchor-missing',
            'pure insertion needs from/to or a unique prefixContext/suffixContext anchor',
          ),
        );
        return { ...change, from: 0, to: 0 };
      }
      let hits = occurrencesOf(text, change.expectedText);
      if (change.prefixContext) {
        hits = hits.filter(
          (h) =>
            text.slice(Math.max(0, h - change.prefixContext!.length), h) ===
            change.prefixContext,
        );
      }
      if (change.suffixContext) {
        hits = hits.filter(
          (h) =>
            text.slice(h + change.expectedText.length, h + change.expectedText.length + change.suffixContext!.length) ===
            change.suffixContext,
        );
      }
      if (hits.length === 0) {
        conflicts.push(
          conflict(
            'anchor-not-found',
            `expectedText ${JSON.stringify(change.expectedText.slice(0, 80))} not found` +
              (change.prefixContext || change.suffixContext ? ' (with the given context)' : ''),
          ),
        );
        return { ...change, from: 0, to: 0 };
      }
      if (hits.length > 1) {
        conflicts.push(
          conflict(
            'anchor-ambiguous',
            `expectedText ${JSON.stringify(change.expectedText.slice(0, 80))} matches ${hits.length} places — add prefixContext/suffixContext to disambiguate`,
          ),
        );
        return { ...change, from: 0, to: 0 };
      }
      const from = hits[0];
      return { ...change, from, to: from + change.expectedText.length };
    }),
  }));
  if (conflicts.length > 0) {
    return { ok: false, conflicts };
  }
  return { ok: true, groups: resolved };
}

// ---------------------------------------------------------------------------
// Pure validation / application
// ---------------------------------------------------------------------------

/** Check one change against the text; null when it matches. */
function checkChange(
  text: string,
  groupIdx: number,
  changeIdx: number,
  change: ResolvedTextChange,
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
  groups: readonly ResolvedPatchGroup[],
): PatchConflictItem[] {
  const conflicts: PatchConflictItem[] = [];
  interface Flat {
    groupIdx: number;
    changeIdx: number;
    change: ResolvedTextChange;
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
  groups: readonly ResolvedPatchGroup[],
): ApplyGroupsResult {
  const conflicts = validateGroups(text, groups);
  if (conflicts.length > 0) {
    return { ok: false, conflicts };
  }
  interface Flat {
    change: ResolvedTextChange;
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
  documentId: Type.Optional(Type.String()),
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
