/**
 * Revision grouping: turns raw editor change events into revision entries.
 * A new group starts after `idleMs` of quiet, on paste, on a jump of more
 * than one line between consecutive changes, or on patch application.
 * Pure and DOM-free; both editor tabs feed it the same event shape.
 */

export type Actor = 'user' | 'agent';

export type RevisionEventKind = 'edit' | 'paste' | 'patch';

export interface RevisionEventInput {
  time: number;
  actor: Actor;
  kind: RevisionEventKind;
  /** 1-based line of the first change in the new text. */
  line: number;
  inserted: number;
  deleted: number;
  snippet: string;
}

export interface RevisionEntry {
  id: string;
  number: number;
  actor: Actor;
  startTime: number;
  endTime: number;
  inserted: number;
  deleted: number;
  snippet: string;
  kinds: RevisionEventKind[];
}

export class RevisionGrouper {
  private closed: RevisionEntry[] = [];
  private current: RevisionEntry | null = null;
  private lastEventTime = 0;
  private lastLine: number | null = null;
  private counter = 0;

  constructor(private idleMs = 1000) {}

  /** Id of the revision the current text would be saved as (base for patches). */
  get currentRevisionId(): string {
    return `r${this.counter}`;
  }

  record(ev: RevisionEventInput): RevisionEntry {
    const startNew =
      !this.current ||
      ev.kind !== 'edit' ||
      this.current.kinds.some((k) => k !== 'edit') ||
      ev.time - this.lastEventTime > this.idleMs ||
      (this.lastLine !== null && Math.abs(ev.line - this.lastLine) > 1);

    if (startNew) {
      if (this.current) this.closed.push(this.current);
      this.counter++;
      this.current = {
        id: `r${this.counter}`,
        number: this.counter,
        actor: ev.actor,
        startTime: ev.time,
        endTime: ev.time,
        inserted: ev.inserted,
        deleted: ev.deleted,
        snippet: ev.snippet,
        kinds: [ev.kind],
      };
    } else if (this.current) {
      this.current.endTime = ev.time;
      this.current.inserted += ev.inserted;
      this.current.deleted += ev.deleted;
      this.current.kinds.push(ev.kind);
    }
    this.lastEventTime = ev.time;
    this.lastLine = ev.line;
    const entry = this.current;
    if (!entry) throw new Error('unreachable: grouper has no current entry');
    return entry;
  }

  /** Closed groups plus the still-open one, newest first. */
  entries(): RevisionEntry[] {
    const all = this.current ? [...this.closed, this.current] : [...this.closed];
    return all.reverse();
  }

  reset(): void {
    this.closed = [];
    this.current = null;
    this.lastEventTime = 0;
    this.lastLine = null;
    this.counter = 0;
  }
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
