/**
 * Revision grouping (plan §8, rules inherited from the spike): a new group
 * starts after 1000 ms idle, on paste, on a >1-line jump between consecutive
 * changes, and on patch application. Mode switches never create revisions
 * (they produce no text changes, so callers simply never signal them).
 *
 * This grouper is a pure decision function fed by editor-side signals; the
 * editor adapter (WP2) owns the actual signals, main owns commits.
 */
export interface ChangeSignal {
  kind: 'typing' | 'paste' | 'patch';
  /** Timestamp in ms (any monotonic clock). */
  at: number;
  /** 0-based line of the first change in this batch. */
  changedLine: number;
}

export const DEFAULT_IDLE_MS = 1000;

export class RevisionGrouper {
  private lastAt: number | null = null;
  private lastLine: number | null = null;

  constructor(private readonly idleMs: number = DEFAULT_IDLE_MS) {}

  /** Returns true when this signal should open a new revision group. */
  shouldStartNewGroup(signal: ChangeSignal): boolean {
    const isNew =
      signal.kind !== 'typing' ||
      this.lastAt === null ||
      signal.at - this.lastAt > this.idleMs ||
      (this.lastLine !== null && Math.abs(signal.changedLine - this.lastLine) > 1);
    this.lastAt = signal.at;
    this.lastLine = signal.changedLine;
    return isNew;
  }

  /** Call when a group is committed so the next signal always starts fresh. */
  reset(): void {
    this.lastAt = null;
    this.lastLine = null;
  }
}
