/**
 * Tiny line-based diff (LCS over lines). Good enough for spike-sized docs;
 * falls back to a coarse "everything changed" for very large inputs.
 */

export type DiffOpType = 'same' | 'add' | 'del';

export interface DiffOp {
  type: DiffOpType;
  line: string;
}

const MAX_CELLS = 4_000_000;

export function lineDiff(a: string, b: string): DiffOp[] {
  const al = a.split('\n');
  const bl = b.split('\n');
  if (al.length * bl.length > MAX_CELLS) {
    return [
      ...al.map((line) => ({ type: 'del' as const, line })),
      ...bl.map((line) => ({ type: 'add' as const, line })),
    ];
  }
  // LCS table.
  const n = al.length;
  const m = bl.length;
  const dp: Uint32Array = new Uint32Array((n + 1) * (m + 1));
  const W = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] =
        al[i] === bl[j]
          ? dp[(i + 1) * W + j + 1] + 1
          : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) {
      ops.push({ type: 'same', line: al[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) {
      ops.push({ type: 'del', line: al[i++] });
    } else {
      ops.push({ type: 'add', line: bl[j++] });
    }
  }
  while (i < n) ops.push({ type: 'del', line: al[i++] });
  while (j < m) ops.push({ type: 'add', line: bl[j++] });
  return ops;
}

export function diffLineCounts(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added++;
    else if (op.type === 'del') removed++;
  }
  return { added, removed };
}

export function diffCharCounts(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added += op.line.length;
    else if (op.type === 'del') removed += op.line.length;
  }
  return { added, removed };
}

/** 1-based line number (in the new text) of the first change; 0 if none. */
export function firstChangedLine(ops: DiffOp[]): number {
  let line = 0;
  for (const op of ops) {
    if (op.type !== 'del') line++;
    if (op.type !== 'same') return Math.max(1, line);
  }
  return 0;
}

/** First non-same line content, truncated — used as a revision snippet. */
export function firstChangeSnippet(ops: DiffOp[], maxLen = 60): string {
  for (const op of ops) {
    if (op.type !== 'same') {
      const t = op.line.trim();
      return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t;
    }
  }
  return '';
}

/** Compact unified-style rendering: -/+ lines, runs of context collapsed. */
export function formatCompactDiff(ops: DiffOp[], maxLines = 60): string {
  const out: string[] = [];
  let skipped = 0;
  for (const op of ops) {
    if (op.type === 'same') {
      skipped++;
      continue;
    }
    if (skipped > 0) {
      out.push(`  … (${skipped} unchanged line${skipped === 1 ? '' : 's'})`);
      skipped = 0;
    }
    out.push(`${op.type === 'add' ? '+' : '-'} ${op.line}`);
    if (out.length >= maxLines) {
      out.push('  … (diff truncated)');
      break;
    }
  }
  if (out.length === 0) return '(identical)';
  return out.join('\n');
}
