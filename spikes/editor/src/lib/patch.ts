/**
 * Structured patches against a base revision of the canonical Markdown text.
 * The agent proposes; the application validates and applies. Pure functions.
 */

export interface TextChange {
  from: number;
  to: number;
  expectedText: string;
  insert: string;
  prefixContext?: string;
  suffixContext?: string;
}

export interface PatchGroup {
  id: string;
  explanation?: string;
  changes: TextChange[];
}

export interface DocumentPatch {
  id: string;
  documentId: string;
  baseRevisionId: string;
  title: string;
  summary?: string;
  groups: PatchGroup[];
}

export type ConflictReason =
  | 'base-revision-mismatch'
  | 'expected-text-mismatch'
  | 'context-mismatch'
  | 'overlapping-changes'
  | 'unknown-group';

export interface PatchConflictItem {
  groupId: string;
  changeIndex: number;
  reason: ConflictReason;
  expectedText?: string;
  actualText?: string;
  message: string;
}

export type ValidateResult = { ok: true } | { ok: false; errors: PatchConflictItem[] };

export interface AppliedRange {
  from: number;
  to: number;
}

export type ApplyResult =
  | { ok: true; text: string; appliedRanges: AppliedRange[]; appliedGroups: string[] }
  | { ok: false; conflicts: PatchConflictItem[]; text: string };

/** Check one change against the text; null when it matches. */
function checkChange(
  text: string,
  groupId: string,
  changeIndex: number,
  change: TextChange,
): PatchConflictItem | null {
  const actual = text.slice(change.from, change.to);
  if (actual !== change.expectedText) {
    return {
      groupId,
      changeIndex,
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
      groupId,
      changeIndex,
      reason: 'context-mismatch',
      message: `prefix context mismatch before offset ${change.from}`,
    };
  }
  if (
    change.suffixContext !== undefined &&
    text.slice(change.to, change.to + change.suffixContext.length) !== change.suffixContext
  ) {
    return {
      groupId,
      changeIndex,
      reason: 'context-mismatch',
      message: `suffix context mismatch after offset ${change.to}`,
    };
  }
  return null;
}

function collectGroups(patch: DocumentPatch, groupIds?: string[]): PatchGroup[] {
  if (!groupIds) return patch.groups;
  return patch.groups.filter((g) => groupIds.includes(g.id));
}

/**
 * Full validation: base revision (when currentRevisionId is given) plus
 * expectedText/context for every change in the selected groups.
 */
export function validatePatch(
  text: string,
  patch: DocumentPatch,
  currentRevisionId?: string,
  groupIds?: string[],
): ValidateResult {
  const errors: PatchConflictItem[] = [];
  if (currentRevisionId !== undefined && patch.baseRevisionId !== currentRevisionId) {
    errors.push({
      groupId: '*',
      changeIndex: -1,
      reason: 'base-revision-mismatch',
      message: `patch targets base revision ${patch.baseRevisionId}, current is ${currentRevisionId}`,
    });
  }
  const groups = collectGroups(patch, groupIds);
  if (groupIds) {
    for (const id of groupIds) {
      if (!patch.groups.some((g) => g.id === id)) {
        errors.push({
          groupId: id,
          changeIndex: -1,
          reason: 'unknown-group',
          message: `no group with id ${id}`,
        });
      }
    }
  }
  for (const group of groups) {
    group.changes.forEach((change, i) => {
      const err = checkChange(text, group.id, i, change);
      if (err) errors.push(err);
    });
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Validate-then-apply. Atomic: any conflict leaves the text untouched.
 * Ranges in the result are offsets in the *new* text.
 * Note: expectedText/context are the hard safety checks here; the base
 * revision check lives in validatePatch (callers may treat a base mismatch
 * as a soft warning when expectedText still validates — an optimistic
 * auto-rebase).
 */
export function applyPatch(
  text: string,
  patch: DocumentPatch,
  groupIds?: string[],
): ApplyResult {
  const groups = collectGroups(patch, groupIds);
  const conflicts: PatchConflictItem[] = [];
  if (groupIds) {
    for (const id of groupIds) {
      if (!patch.groups.some((g) => g.id === id)) {
        conflicts.push({
          groupId: id,
          changeIndex: -1,
          reason: 'unknown-group',
          message: `no group with id ${id}`,
        });
      }
    }
  }
  interface FlatChange {
    groupId: string;
    changeIndex: number;
    change: TextChange;
  }
  const flat: FlatChange[] = [];
  for (const group of groups) {
    group.changes.forEach((change, i) => {
      const err = checkChange(text, group.id, i, change);
      if (err) conflicts.push(err);
      else flat.push({ groupId: group.id, changeIndex: i, change });
    });
  }
  // Overlap check between validated changes.
  const byFrom = [...flat].sort((a, b) => a.change.from - b.change.from);
  for (let i = 1; i < byFrom.length; i++) {
    if (byFrom[i].change.from < byFrom[i - 1].change.to) {
      conflicts.push({
        groupId: byFrom[i].groupId,
        changeIndex: byFrom[i].changeIndex,
        reason: 'overlapping-changes',
        message: `change at ${byFrom[i].change.from} overlaps an earlier change`,
      });
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts, text };

  // Apply bottom-up so earlier offsets stay valid.
  const descending = [...flat].sort((a, b) => b.change.from - a.change.from);
  let out = text;
  const appliedRanges: AppliedRange[] = [];
  for (const { change } of descending) {
    out = out.slice(0, change.from) + change.insert + out.slice(change.to);
    appliedRanges.push({ from: change.from, to: change.from + change.insert.length });
  }
  appliedRanges.sort((a, b) => a.from - b.from);
  return {
    ok: true,
    text: out,
    appliedRanges,
    appliedGroups: groups.map((g) => g.id),
  };
}
