/**
 * Pandoc-style citation markers: [@key], [-@key, p. 14], [@a; @b, ch. 4].
 * Pure parsing helpers shared by the CodeMirror decorations, the Tiptap
 * markdown import/export, and the patch tooling.
 */

export interface CitationItem {
  suppressAuthor: boolean;
  key: string;
  /** Verbatim text after the key, up to `;` or `]` (e.g. ", p. 14"). */
  suffix: string;
}

export interface CitationSpan {
  from: number;
  to: number;
  raw: string;
  items: CitationItem[];
}

const KEY_START = /[A-Za-z0-9_]/;
const KEY_CHAR = /[A-Za-z0-9_:.#$%&+?<>~/=-]/;

/** Try to parse a citation marker starting at `open`, where text[open] === '['. */
export function parseCitationAt(text: string, open: number): CitationSpan | null {
  if (text[open] !== '[') return null;
  let i = open + 1;
  const items: CitationItem[] = [];
  for (;;) {
    let suppressAuthor = false;
    if (text[i] === '-') {
      suppressAuthor = true;
      i++;
    }
    if (text[i] !== '@') return null;
    i++;
    if (i >= text.length || !KEY_START.test(text[i])) return null;
    let key = '';
    while (i < text.length && KEY_CHAR.test(text[i])) key += text[i++];
    let suffix = '';
    while (
      i < text.length &&
      text[i] !== ';' &&
      text[i] !== ']' &&
      text[i] !== '[' &&
      text[i] !== '@'
    ) {
      suffix += text[i++];
    }
    items.push({ suppressAuthor, key, suffix });
    if (text[i] === ']') {
      return { from: open, to: i + 1, raw: text.slice(open, i + 1), items };
    }
    if (text[i] === ';') {
      i++;
      if (text[i] === ' ') i++; // canonical item separator is "; "
      continue;
    }
    return null;
  }
}

/** Find all citation markers in `text`. */
export function findCitations(text: string): CitationSpan[] {
  const spans: CitationSpan[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '[') continue;
    const span = parseCitationAt(text, i);
    if (span) {
      spans.push(span);
      i = span.to - 1;
    }
  }
  return spans;
}

/** Deterministic serialization: the exact marker syntax for the items. */
export function serializeCitation(items: CitationItem[]): string {
  const inner = items
    .map((it) => `${it.suppressAuthor ? '-' : ''}@${it.key}${it.suffix}`)
    .join('; ');
  return `[${inner}]`;
}

/** Human label for a key: "smith2024" -> "Smith 2024". Falls back to "@key". */
export function keyToLabel(key: string): string {
  const m = /^([A-Za-z][A-Za-z'-]*?)(\d{4}[a-z]?)?$/.exec(key);
  if (!m || !m[2]) return `@${key}`;
  const name = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return `${name} ${m[2]}`;
}

/** Human label for a whole citation: "Smith 2024; Jones 2023". */
export function citationLabel(items: CitationItem[]): string {
  return items
    .map((it) => {
      const base = keyToLabel(it.key);
      const suffix = it.suffix.replace(/^,\s*/, ', ');
      return it.suppressAuthor ? base.replace(/^.*? /, '') + suffix : base + suffix;
    })
    .join('; ');
}
