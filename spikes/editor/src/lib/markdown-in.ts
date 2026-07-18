/**
 * Markdown -> ProseMirror doc JSON, via remark (mdast).
 * Supports the spike's Markdown profile only; anything else degrades to
 * literal text (or is dropped, for consumed definitions).
 * Pandoc citations are split out of text nodes into `citation` atom nodes.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { findCitations } from './citations';

export interface PMMarkJSON {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface PMNodeJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNodeJSON[];
  marks?: PMMarkJSON[];
  text?: string;
}

/** Minimal structural view of mdast (incl. GFM) nodes — enough for the profile. */
interface MdNode {
  type: string;
  children?: MdNode[];
  value?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  url?: string;
  title?: string | null;
  alt?: string | null;
  identifier?: string;
  label?: string | null;
  lang?: string | null;
}

const processor = unified().use(remarkParse).use(remarkGfm);

type Mark = PMMarkJSON;

function pushText(out: PMNodeJSON[], text: string, marks: Mark[]): void {
  if (text === '') return;
  const node: PMNodeJSON = { type: 'text', text };
  if (marks.length > 0) node.marks = marks.map((m) => ({ ...m }));
  out.push(node);
}

function inlines(nodes: MdNode[], marks: Mark[]): PMNodeJSON[] {
  const out: PMNodeJSON[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text': {
        const value = node.value ?? '';
        let pos = 0;
        for (const span of findCitations(value)) {
          pushText(out, value.slice(pos, span.from), marks);
          out.push({ type: 'citation', attrs: { items: span.items, raw: span.raw } });
          pos = span.to;
        }
        pushText(out, value.slice(pos), marks);
        break;
      }
      case 'emphasis':
        out.push(...inlines(node.children ?? [], [...marks, { type: 'italic' }]));
        break;
      case 'strong':
        out.push(...inlines(node.children ?? [], [...marks, { type: 'bold' }]));
        break;
      case 'delete':
        out.push(...inlines(node.children ?? [], [...marks, { type: 'strike' }]));
        break;
      case 'link': {
        const attrs: Record<string, unknown> = { href: node.url ?? '' };
        if (node.title) attrs.title = node.title;
        out.push(...inlines(node.children ?? [], [...marks, { type: 'link', attrs }]));
        break;
      }
      case 'inlineCode':
        // Code excludes other marks in PM; keep only the code mark.
        pushText(out, node.value ?? '', [{ type: 'code' }]);
        break;
      case 'footnoteReference':
        out.push({
          type: 'footnoteRef',
          attrs: { label: node.label ?? node.identifier ?? '' },
        });
        break;
      case 'break':
        out.push({ type: 'hardBreak' });
        break;
      case 'image':
        // Outside the profile: degrade to the alt text (or URL) literally.
        pushText(out, node.alt ?? node.url ?? '', marks);
        break;
      case 'html':
        pushText(out, node.value ?? '', marks);
        break;
      default:
        // Unknown inline: degrade to any literal value.
        if (node.value) pushText(out, node.value, marks);
        break;
    }
  }
  return out;
}

function blocks(nodes: MdNode[]): PMNodeJSON[] {
  const out: PMNodeJSON[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'paragraph': {
        out.push({ type: 'paragraph', content: inlines(node.children ?? [], []) });
        break;
      }
      case 'heading': {
        out.push({
          type: 'heading',
          attrs: { level: node.depth ?? 1 },
          content: inlines(node.children ?? [], []),
        });
        break;
      }
      case 'blockquote': {
        out.push({ type: 'blockquote', content: blocks(node.children ?? []) });
        break;
      }
      case 'list': {
        const ordered = node.ordered === true;
        const list: PMNodeJSON = {
          type: ordered ? 'orderedList' : 'bulletList',
          content: (node.children ?? []).map((item) => ({
            type: 'listItem',
            content: blocks(item.children ?? []),
          })),
        };
        if (ordered) list.attrs = { start: node.start ?? 1 };
        out.push(list);
        break;
      }
      case 'table': {
        const rows = node.children ?? [];
        out.push({
          type: 'table',
          content: rows.map((row, ri) => ({
            type: 'tableRow',
            content: (row.children ?? []).map((cell) => ({
              type: ri === 0 ? 'tableHeader' : 'tableCell',
              content: [{ type: 'paragraph', content: inlines(cell.children ?? [], []) }],
            })),
          })),
        });
        break;
      }
      case 'footnoteDefinition': {
        out.push({
          type: 'footnoteDef',
          attrs: { label: node.label ?? node.identifier ?? '' },
          content: blocks(node.children ?? []),
        });
        break;
      }
      case 'code': {
        const cb: PMNodeJSON = { type: 'codeBlock' };
        if (node.lang) cb.attrs = { language: node.lang };
        if (node.value) cb.content = [{ type: 'text', text: node.value }];
        out.push(cb);
        break;
      }
      case 'thematicBreak': {
        out.push({ type: 'horizontalRule' });
        break;
      }
      case 'html': {
        out.push({ type: 'paragraph', content: [{ type: 'text', text: node.value ?? '' }] });
        break;
      }
      default:
        // Consumed definitions (link/footnote handled above) and unknown
        // blocks are dropped — outside the supported profile.
        break;
    }
  }
  return out;
}

/** Parse canonical Markdown into a ProseMirror doc JSON object. */
export function markdownIn(md: string): PMNodeJSON {
  const tree = processor.runSync(processor.parse(md)) as unknown as MdNode;
  const content = blocks(tree.children ?? []);
  if (content.length === 0) content.push({ type: 'paragraph' });
  return { type: 'doc', content };
}
