/**
 * ProseMirror doc JSON -> canonical Markdown. Deterministic: this output IS
 * the canonical form; `markdownOut(markdownIn(x)) === x` holds exactly when
 * x is already canonical. Works on plain JSON (no PM/schema dependency).
 */

import { serializeCitation, type CitationItem } from './citations';
import type { PMMarkJSON, PMNodeJSON } from './markdown-in';
import { isComplexTable, serializeHtmlTable } from './html-table';

function inlineMarks(text: string, marks: PMMarkJSON[] | undefined): string {
  if (!marks || marks.length === 0) return text;
  const has = (t: string) => marks.some((m) => m.type === t);
  let out = text;
  if (has('code')) return `\`${out}\``;
  const italic = has('italic');
  const bold = has('bold');
  const strike = has('strike');
  const underline = has('underline');
  if (italic && bold) out = `***${out}***`;
  else if (bold) out = `**${out}**`;
  else if (italic) out = `*${out}*`;
  if (strike) out = `~~${out}~~`;
  if (underline) out = `<u>${out}</u>`;
  const link = marks.find((m) => m.type === 'link');
  if (link) {
    const href = String(link.attrs?.href ?? '');
    const title = link.attrs?.title ? ` "${String(link.attrs.title)}"` : '';
    out = `[${out}](${href}${title})`;
  }
  return out;
}

export function serializeInlines(nodes: PMNodeJSON[] | undefined): string {
  let out = '';
  for (const node of nodes ?? []) {
    switch (node.type) {
      case 'text':
        out += inlineMarks(node.text ?? '', node.marks);
        break;
      case 'citation':
        out += serializeCitation((node.attrs?.items ?? []) as CitationItem[]);
        break;
      case 'footnoteRef':
        out += `[^${String(node.attrs?.label ?? '')}]`;
        break;
      case 'hardBreak':
        out += '\n';
        break;
      default:
        throw new Error(`markdownOut: unsupported inline node "${node.type}"`);
    }
  }
  return out;
}

function cellText(cell: PMNodeJSON): string {
  return (cell.content ?? []).map((b) => serializeInlines(b.content)).join(' ');
}

function serializeTable(node: PMNodeJSON): string[] {
  const rows = node.content ?? [];
  if (rows.length === 0) return [];
  const renderRow = (row: PMNodeJSON) =>
    `| ${(row.content ?? []).map(cellText).join(' | ')} |`;
  const cols = rows[0].content?.length ?? 0;
  const sep = `| ${new Array(cols).fill('---').join(' | ')} |`;
  return [renderRow(rows[0]), sep, ...rows.slice(1).map(renderRow)];
}

function serializeList(node: PMNodeJSON): string[] {
  const ordered = node.type === 'orderedList';
  const start = typeof node.attrs?.start === 'number' ? (node.attrs.start as number) : 1;
  const items = node.content ?? [];
  const loose = items.some((item) => (item.content?.length ?? 0) > 1);
  const lines: string[] = [];
  items.forEach((item, i) => {
    if (i > 0 && loose) lines.push('');
    const marker = ordered ? `${start + i}. ` : '- ';
    const itemLines = serializeBlocks(item.content ?? []);
    itemLines.forEach((l, j) => {
      if (j === 0) lines.push(marker + l);
      else if (l === '') lines.push('');
      else lines.push(`    ${l}`);
    });
  });
  return lines;
}

function serializeFootnoteDef(node: PMNodeJSON): string[] {
  const label = String(node.attrs?.label ?? '');
  const paras = node.content ?? [];
  const lines: string[] = [];
  paras.forEach((p, i) => {
    const inline = serializeInlines(p.content);
    if (i === 0) lines.push(`[^${label}]: ${inline}`);
    else {
      lines.push('');
      lines.push(`    ${inline}`);
    }
  });
  return lines;
}

function serializeBlock(node: PMNodeJSON): string[] {
  switch (node.type) {
    case 'paragraph': {
      const inline = serializeInlines(node.content);
      // A literal paragraph beginning with a Markdown list marker must remain
      // a paragraph when this canonical text is parsed again.
      return [inline
        .replace(/^(\s*)([-+*])\s/, '$1\\$2 ')
        .replace(/^(\s*)(\d+)([.)])\s/, '$1$2\\$3 ')];
    }
    case 'heading': {
      const level = typeof node.attrs?.level === 'number' ? (node.attrs.level as number) : 1;
      return [`${'#'.repeat(level)} ${serializeInlines(node.content)}`];
    }
    case 'blockquote': {
      return serializeBlocks(node.content ?? []).map((l) => (l === '' ? '>' : `> ${l}`));
    }
    case 'bulletList':
    case 'orderedList':
      return serializeList(node);
    case 'table':
      return isComplexTable(node) ? serializeHtmlTable(node) : serializeTable(node);
    case 'footnoteDef':
      return serializeFootnoteDef(node);
    case 'codeBlock': {
      const lang = node.attrs?.language ? String(node.attrs.language) : '';
      const text = (node.content ?? []).map((c) => c.text ?? '').join('');
      return [`\`\`\`${lang}`, ...text.split('\n'), '```'];
    }
    case 'horizontalRule':
      return ['---'];
    default:
      throw new Error(`markdownOut: unsupported block node "${node.type}"`);
  }
}

/** Blocks joined by exactly one blank line (footnote defs run together). */
function serializeBlocks(nodes: PMNodeJSON[]): string[] {
  const lines: string[] = [];
  nodes.forEach((node, i) => {
    const prev = i > 0 ? nodes[i - 1] : null;
    const tight = prev?.type === 'footnoteDef' && node.type === 'footnoteDef';
    if (i > 0 && !tight) lines.push('');
    if (prev && /List$/.test(prev.type) && /List$/.test(node.type)) {
      // CommonMark otherwise merges adjacent lists. The comment is invisible
      // in rendered mode and parsed away by markdownIn.
      lines.push('<!-- texeris-list-break -->', '');
    }
    lines.push(...serializeBlock(node));
  });
  return lines;
}

/** Serialize a ProseMirror doc JSON to canonical Markdown (trailing newline). */
export function markdownOut(doc: PMNodeJSON): string {
  const lines = serializeBlocks(doc.content ?? []);
  return lines.join('\n') + '\n';
}
