/** Side-panel rendering: revisions, round-trip badge/diff, messages. */

import type { PatchConflictItem } from '../lib/patch';
import { formatTime, type RevisionEntry } from '../lib/revisions';

export function renderRevisions(
  el: HTMLElement,
  entries: RevisionEntry[],
  currentRevisionId: string,
): void {
  el.replaceChildren();
  for (const e of entries) {
    const li = document.createElement('li');
    li.className = `revision-entry actor-${e.actor}`;
    const head = document.createElement('div');
    head.className = 'revision-head';
    head.textContent = `#${e.number} · ${e.actor} · ${formatTime(e.startTime)}`;
    const counts = document.createElement('span');
    counts.className = 'revision-counts';
    counts.textContent = `+${e.inserted} −${e.deleted}`;
    head.appendChild(counts);
    const snippet = document.createElement('div');
    snippet.className = 'revision-snippet';
    snippet.textContent = e.snippet || '(no text change)';
    li.appendChild(head);
    li.appendChild(snippet);
    el.appendChild(li);
  }
  const base = document.createElement('li');
  base.className = 'revision-base';
  base.textContent = `current base: ${currentRevisionId}`;
  el.appendChild(base);
}

export function showRoundTrip(
  badge: HTMLElement,
  diffEl: HTMLElement,
  result: { ok: boolean; differingLines?: number; diff?: string },
): void {
  badge.classList.remove('ok', 'bad', 'unknown');
  if (result.ok) {
    badge.classList.add('ok');
    badge.textContent = 'round-trip OK';
    diffEl.style.display = 'none';
    diffEl.textContent = '';
  } else {
    badge.classList.add('bad');
    badge.textContent = `normalized (${result.differingLines ?? '?'} lines differ)`;
    diffEl.style.display = '';
    diffEl.textContent = result.diff ?? '';
  }
}

export function showMessage(el: HTMLElement, text: string, tone: 'info' | 'ok' | 'error'): void {
  el.className = `message-line ${tone}`;
  el.textContent = text;
}

export function formatConflicts(conflicts: PatchConflictItem[]): string {
  return conflicts
    .map((c) => {
      let s = `conflict: ${c.message}`;
      if (c.reason === 'expected-text-mismatch') {
        s += `\n  expected: ${JSON.stringify(truncate(c.expectedText ?? ''))}`;
        s += `\n  found:    ${JSON.stringify(truncate(c.actualText ?? ''))}`;
      }
      return s;
    })
    .join('\n');
}

function truncate(s: string, n = 50): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
