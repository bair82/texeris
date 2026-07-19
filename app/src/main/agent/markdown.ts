import type { HeadingInfo } from '../../shared/doc-types';

/**
 * Heading extraction and section slicing over canonical Markdown.
 * Hand-rolled ATX scanner: the only edge case that matters is fenced code
 * blocks, whose `#` lines must not count as headings. Everything else
 * (setext headings, fenced Divs, etc.) is outside the supported profile.
 */

const FENCE_RE = /^\s*(```+|~~~+)/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export function extractHeadings(text: string): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  let inFence = false;
  let fenceMarker = '';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0] === '`' ? '```' : '~~~';
      } else if (line.trimStart().startsWith(fenceMarker)) {
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      headings.push({ level: heading[1].length, text: heading[2], line: i });
    }
  }
  return headings;
}

/**
 * Return the text of the section under `heading` — from the heading line up
 * to (not including) the next heading of the same or higher level. Matching
 * is exact and case-sensitive; the first match wins.
 */
export function sliceSection(text: string, heading: string): string | null {
  const lines = text.split('\n');
  const headings = extractHeadings(text);
  const start = headings.findIndex((h) => h.text === heading);
  if (start === -1) {
    return null;
  }
  const { level, line: startLine } = headings[start];
  let endLine = lines.length;
  for (let i = start + 1; i < headings.length; i++) {
    if (headings[i].level <= level) {
      endLine = headings[i].line;
      break;
    }
  }
  return lines.slice(startLine, endLine).join('\n').trimEnd();
}
