/**
 * Footnote helpers for the supported Markdown profile:
 * inline refs `[^label]` and definitions `[^label]: text` with optional
 * 4-space-indented continuation paragraphs.
 */

export interface FootnoteRefSpan {
  from: number;
  to: number;
  label: string;
  /** True when the match opens a definition (`[^label]:`) rather than a ref. */
  isDefinition: boolean;
}

const FOOTNOTE_RE = /\[\^([A-Za-z0-9_-]+)\]/g;

/**
 * Find footnote refs and definition markers in a single line of text.
 * A match at the start of the (trimmed) line followed by `:` is a definition.
 */
export function findFootnotesInLine(lineText: string): FootnoteRefSpan[] {
  const out: FootnoteRefSpan[] = [];
  FOOTNOTE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FOOTNOTE_RE.exec(lineText))) {
    const before = lineText.slice(0, m.index);
    const after = lineText.slice(m.index + m[0].length);
    const isDefinition = before.trim() === '' && after.startsWith(':');
    out.push({ from: m.index, to: m.index + m[0].length, label: m[1], isDefinition });
  }
  return out;
}

/** Parse a footnote definition line: `[^label]: rest`. */
export function parseFootnoteDefLine(
  lineText: string,
): { label: string; rest: string } | null {
  const m = /^\[\^([A-Za-z0-9_-]+)\]:\s?(.*)$/.exec(lineText.trimStart());
  return m ? { label: m[1], rest: m[2] } : null;
}

/** Is this line a 4-space-indented continuation of a footnote definition? */
export function isFootnoteContinuation(lineText: string): boolean {
  return /^ {4}\S/.test(lineText);
}
