/**
 * Turns a stream of editor updates into grouped, sequential splices:
 * one minimal splice per update, grouped by the §8 rules (idle, paste,
 * caret jump), flushed on group close or after `idleMs` of quiet.
 * DOM-free and shared by both editor sessions.
 */

import type { TextSplice } from '../../../shared/domain-types';
import { RevisionGrouper } from '../../../shared/grouping';
import { minimalSplice } from '../../../shared/text-splice';

/** Default idle period after which pending changes are flushed (§8). */
export const IDLE_FLUSH_MS = 5000;

export class ChangeAccumulator {
  private pending: TextSplice[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private grouper: RevisionGrouper;

  constructor(
    private readonly onFlush: (splices: TextSplice[]) => void,
    private readonly onDirty?: () => void,
    private readonly idleMs: number = IDLE_FLUSH_MS,
  ) {
    this.grouper = new RevisionGrouper(idleMs);
  }

  record(prevText: string, newText: string, kind: 'typing' | 'paste'): void {
    if (prevText === newText) {
      return;
    }
    const splice = minimalSplice(prevText, newText);
    if (
      this.grouper.shouldStartNewGroup({
        kind: kind === 'paste' ? 'paste' : 'typing',
        at: Date.now(),
        from: splice.from,
      }) &&
      this.pending.length > 0
    ) {
      this.flush();
    }
    const wasEmpty = this.pending.length === 0;
    this.pending.push(splice);
    if (wasEmpty) {
      this.onDirty?.();
    }
    this.armIdle();
  }

  flush(): void {
    if (this.pending.length === 0) {
      return;
    }
    const splices = this.pending;
    this.pending = [];
    this.grouper.reset();
    this.onFlush(splices);
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  dispose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
  }

  private armIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => this.flush(), this.idleMs);
  }
}
