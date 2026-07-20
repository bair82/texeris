/**
 * Revision grouping (plan §8, rules inherited from the spike): a new group
 * starts after the idle gap, on paste, on a caret jump between consecutive
 * changes, and on patch application. Mode switches never create revisions
 * (they produce no text changes, so callers simply never signal them).
 *
 * The jump rule compares canonical OFFSETS, not line numbers: near the
 * document end each Enter shifts line numbering by up to two on alternating
 * keystrokes, which made a line-based rule break the group every other
 * keystroke (the dirty→saving→saved status flapping, owner report
 * 2026-07-20). Sequential typing/backspacing moves the change start by ±1
 * char per keystroke, so a jump is judged as the change start moving by
 * more than JUMP_CHARS.
 *
 * This grouper is a pure decision function fed by editor-side signals; the
 * editor adapter (WP2) owns the actual signals, main owns commits.
 */
export interface ChangeSignal {
  kind: 'typing' | 'paste' | 'patch';
  /** Timestamp in ms (any monotonic clock). */
  at: number;
  /** Canonical-text offset where this change starts. */
  from: number;
}

export const DEFAULT_IDLE_MS = 1000;

/** Change-start movement beyond this many chars counts as a caret jump. */
export const JUMP_CHARS = 8;

export class RevisionGrouper {
  private lastAt: number | null = null;
  private lastFrom: number | null = null;

  constructor(private readonly idleMs: number = DEFAULT_IDLE_MS) {}

  /** Returns true when this signal should open a new revision group. */
  shouldStartNewGroup(signal: ChangeSignal): boolean {
    const isNew =
      signal.kind !== 'typing' ||
      this.lastAt === null ||
      signal.at - this.lastAt > this.idleMs ||
      (this.lastFrom !== null && Math.abs(signal.from - this.lastFrom) > JUMP_CHARS);
    this.lastAt = signal.at;
    this.lastFrom = signal.from;
    return isNew;
  }

  /** Call when a group is committed so the next signal always starts fresh. */
  reset(): void {
    this.lastAt = null;
    this.lastFrom = null;
  }
}
