import { parseFragment } from 'parse5';
import { findCitations } from './citations';
import type { PMMarkJSON, PMNodeJSON } from './markdown-in';

interface HtmlNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
}

function attr(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.find((item) => item.name === name)?.value;
}

function textAlign(node: HtmlNode): 'left' | 'center' | 'right' | 'justify' | null {
  const value = attr(node, 'style')?.match(/(?:^|;)\s*text-align\s*:\s*(left|center|right|justify)\b/i)?.[1]?.toLowerCase();
  return value === 'left' || value === 'center' || value === 'right' || value === 'justify' ? value : null;
}

function imageSize(node: HtmlNode, dimension: 'width' | 'height'): string | null {
  const value = attr(node, 'style')?.match(new RegExp(`(?:^|;)\\s*${dimension}\\s*:\\s*([0-9.]+(?:px|in|cm|mm|%))`, 'i'))?.[1];
  return value ?? null;
}

function descendantText(node: HtmlNode): string {
  if (node.nodeName === '#text') return node.value ?? '';
  return (node.childNodes ?? []).map(descendantText).join('');
}

function findElement(node: HtmlNode, tag: string): HtmlNode | null {
  if (node.tagName === tag) return node;
  for (const child of node.childNodes ?? []) {
    const found = findElement(child, tag);
    if (found) return found;
  }
  return null;
}

function imageNode(node: HtmlNode, caption?: string): PMNodeJSON {
  return {
    type: 'image',
    attrs: {
      src: attr(node, 'src') ?? '',
      alt: attr(node, 'alt') ?? '',
      title: attr(node, 'title') ?? null,
      width: imageSize(node, 'width'),
      height: imageSize(node, 'height'),
      caption: caption?.trim() || null,
    },
  };
}

function pushText(out: PMNodeJSON[], text: string, marks: PMMarkJSON[]): void {
  let pos = 0;
  for (const span of findCitations(text)) {
    if (span.from > pos) out.push(textNode(text.slice(pos, span.from), marks));
    out.push({ type: 'citation', attrs: { items: span.items, raw: span.raw } });
    pos = span.to;
  }
  if (pos < text.length) out.push(textNode(text.slice(pos), marks));
}

function textNode(text: string, marks: PMMarkJSON[]): PMNodeJSON {
  return marks.length ? { type: 'text', text, marks: marks.map((mark) => ({ ...mark })) } : { type: 'text', text };
}

function htmlInlines(nodes: HtmlNode[], marks: PMMarkJSON[] = []): PMNodeJSON[] {
  const out: PMNodeJSON[] = [];
  for (const node of nodes) {
    if (node.nodeName === '#text') {
      pushText(out, node.value ?? '', marks);
      continue;
    }
    const tag = node.tagName?.toLowerCase();
    if (tag === 'br') {
      out.push({ type: 'hardBreak' });
      continue;
    }
    if (tag === 'img') {
      out.push(imageNode(node));
      continue;
    }
    let next = marks;
    if (tag === 'strong' || tag === 'b') next = [...marks, { type: 'bold' }];
    else if (tag === 'em' || tag === 'i') next = [...marks, { type: 'italic' }];
    else if (tag === 'u') next = [...marks, { type: 'underline' }];
    else if (tag === 's' || tag === 'del') next = [...marks, { type: 'strike' }];
    else if (tag === 'code') next = [{ type: 'code' }];
    else if (tag === 'a') {
      next = [...marks, { type: 'link', attrs: { href: attr(node, 'href') ?? '', ...(attr(node, 'title') ? { title: attr(node, 'title') } : {}) } }];
    }
    out.push(...htmlInlines(node.childNodes ?? [], next));
  }
  return out;
}

function paragraph(nodes: HtmlNode[]): PMNodeJSON {
  return { type: 'paragraph', content: htmlInlines(nodes) };
}

function cellBlocks(cell: HtmlNode): PMNodeJSON[] {
  const children = cell.childNodes ?? [];
  const explicit = children.filter((node) => node.tagName === 'p' || node.tagName === 'div');
  if (explicit.length > 0) {
    const blocks: PMNodeJSON[] = [];
    let loose: HtmlNode[] = [];
    const flushLoose = () => {
      if (loose.some((node) => node.nodeName !== '#text' || (node.value ?? '').trim())) blocks.push(paragraph(loose));
      loose = [];
    };
    for (const child of children) {
      if (child.tagName === 'p' || child.tagName === 'div') {
        flushLoose();
        blocks.push(paragraph(child.childNodes ?? []));
      } else {
        loose.push(child);
      }
    }
    flushLoose();
    return blocks.length ? blocks : [{ type: 'paragraph' }];
  }
  return [paragraph(children)];
}

function findTable(node: HtmlNode): HtmlNode | null {
  if (node.tagName === 'table') return node;
  for (const child of node.childNodes ?? []) {
    const found = findTable(child);
    if (found) return found;
  }
  return null;
}

function tableRows(table: HtmlNode): HtmlNode[] {
  const rows: HtmlNode[] = [];
  for (const child of table.childNodes ?? []) {
    if (child.tagName === 'tr') rows.push(child);
    else if (child.tagName === 'thead' || child.tagName === 'tbody' || child.tagName === 'tfoot') {
      rows.push(...(child.childNodes ?? []).filter((node) => node.tagName === 'tr'));
    }
  }
  return rows;
}

/** Parse the controlled raw-HTML table subset emitted by Pandoc's GFM writer. */
export function parseHtmlTable(html: string): PMNodeJSON | null {
  const fragment = parseFragment(html) as unknown as HtmlNode;
  const table = findTable(fragment);
  if (!table) return null;
  return {
    type: 'table',
    content: tableRows(table).map((row) => ({
      type: 'tableRow',
      content: (row.childNodes ?? [])
        .filter((cell) => cell.tagName === 'td' || cell.tagName === 'th')
        .map((cell) => ({
          type: cell.tagName === 'th' ? 'tableHeader' : 'tableCell',
          attrs: {
            colspan: Math.max(1, Number.parseInt(attr(cell, 'colspan') ?? '1', 10) || 1),
            rowspan: Math.max(1, Number.parseInt(attr(cell, 'rowspan') ?? '1', 10) || 1),
            colwidth: null,
            textAlign: textAlign(cell),
          },
          content: cellBlocks(cell),
        })),
    })),
  };
}

/** Parse Pandoc's standalone img/figure HTML into a safe editor image node. */
export function parseHtmlImage(html: string): PMNodeJSON | null {
  const fragment = parseFragment(html) as unknown as HtmlNode;
  const image = findElement(fragment, 'img');
  if (!image) return null;
  const figure = findElement(fragment, 'figure');
  const captionNode = figure ? findElement(figure, 'figcaption') : null;
  return { type: 'paragraph', content: [imageNode(image, captionNode ? descendantText(captionNode) : undefined)] };
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll('"', '&quot;');
}

export function serializeImage(node: PMNodeJSON): string {
  const src = escapeAttr(String(node.attrs?.src ?? ''));
  const alt = escapeAttr(String(node.attrs?.alt ?? ''));
  const title = node.attrs?.title ? ` title="${escapeAttr(String(node.attrs.title))}"` : '';
  const dimensions = [
    node.attrs?.width ? `width:${escapeAttr(String(node.attrs.width))}` : '',
    node.attrs?.height ? `height:${escapeAttr(String(node.attrs.height))}` : '',
  ].filter(Boolean).join(';');
  const style = dimensions ? ` style="${dimensions}"` : '';
  const image = `<img src="${src}" alt="${alt}"${title}${style}>`;
  return node.attrs?.caption
    ? `<figure>\n${image}\n<figcaption>${escapeHtml(String(node.attrs.caption))}</figcaption>\n</figure>`
    : image;
}

function htmlInlinesOut(nodes: PMNodeJSON[] | undefined): string {
  return (nodes ?? []).map((node) => {
    if (node.type === 'hardBreak') return '<br>';
    if (node.type === 'citation') return escapeHtml(String(node.attrs?.raw ?? ''));
    if (node.type === 'footnoteRef') return escapeHtml(`[^${String(node.attrs?.label ?? '')}]`);
    let text = escapeHtml(node.text ?? '');
    const marks = node.marks ?? [];
    if (marks.some((mark) => mark.type === 'code')) return `<code>${text}</code>`;
    if (marks.some((mark) => mark.type === 'bold')) text = `<strong>${text}</strong>`;
    if (marks.some((mark) => mark.type === 'italic')) text = `<em>${text}</em>`;
    if (marks.some((mark) => mark.type === 'underline')) text = `<u>${text}</u>`;
    if (marks.some((mark) => mark.type === 'strike')) text = `<s>${text}</s>`;
    const link = marks.find((mark) => mark.type === 'link');
    if (link) {
      const title = link.attrs?.title ? ` title="${escapeAttr(String(link.attrs.title))}"` : '';
      text = `<a href="${escapeAttr(String(link.attrs?.href ?? ''))}"${title}>${text}</a>`;
    }
    return text;
  }).join('');
}

function cellHtml(cell: PMNodeJSON): string {
  return (cell.content ?? []).map((block) => `<p>${htmlInlinesOut(block.content)}</p>`).join('');
}

export function isComplexTable(table: PMNodeJSON): boolean {
  return (table.content ?? []).some((row) => (row.content ?? []).some((cell) =>
    Number(cell.attrs?.colspan ?? 1) > 1 ||
    Number(cell.attrs?.rowspan ?? 1) > 1 ||
    Boolean(cell.attrs?.textAlign) ||
    (cell.content?.length ?? 0) !== 1 ||
    cell.content?.[0]?.type !== 'paragraph'));
}

/** Serialize complex tables as Pandoc-readable HTML, retaining spans and paragraphs. */
export function serializeHtmlTable(table: PMNodeJSON): string[] {
  const rows = table.content ?? [];
  const hasHead = (rows[0]?.content ?? []).some((cell) => cell.type === 'tableHeader');
  const renderRows = (items: PMNodeJSON[]) => items.flatMap((row) => [
    '<tr>',
    ...(row.content ?? []).map((cell) => {
      const tag = cell.type === 'tableHeader' ? 'th' : 'td';
      const colspan = Number(cell.attrs?.colspan ?? 1);
      const rowspan = Number(cell.attrs?.rowspan ?? 1);
      const align = cell.attrs?.textAlign ? ` style="text-align: ${escapeAttr(String(cell.attrs.textAlign))};"` : '';
      const attrs = `${colspan > 1 ? ` colspan="${colspan}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''}${align}`;
      return `<${tag}${attrs}>${cellHtml(cell)}</${tag}>`;
    }),
    '</tr>',
  ]);
  const lines = ['<table>'];
  if (hasHead) lines.push('<thead>', ...renderRows(rows.slice(0, 1)), '</thead>');
  const body = hasHead ? rows.slice(1) : rows;
  if (body.length) lines.push('<tbody>', ...renderRows(body), '</tbody>');
  lines.push('</table>');
  return lines;
}
