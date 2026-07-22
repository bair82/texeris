/**
 * Tiptap schema (ported from the spike): StarterKit + tables + three custom
 * nodes for the parts of the Markdown profile StarterKit doesn't know about.
 * Kept separate from the editor so tests can build the schema without a DOM.
 *
 * D0 feedback: citations render text-like and tinted (raw marker visible),
 * not as opaque pills.
 */

import { Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { serializeCitation, type CitationItem } from '../lib/citations';

const alignmentAttribute = {
  textAlign: {
    default: null,
    parseHTML: (element: { style: { textAlign: string } }) => element.style.textAlign || null,
    renderHTML: (attributes: Record<string, unknown>) => attributes.textAlign
      ? { style: `text-align: ${String(attributes.textAlign)}` }
      : {},
  },
};

const AlignedTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...alignmentAttribute };
  },
});

const AlignedTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...alignmentAttribute };
  },
});

function displayImageSource(source: string): string {
  if (/^(?:data:|https?:|texeris-asset:)/i.test(source)) return source;
  if (source.startsWith('/') || source.includes('..')) return '';
  return `texeris-asset://project/${source.split('/').map(encodeURIComponent).join('/')}`;
}

/** Portable project-relative image rendered through the constrained asset protocol. */
export const Image = Node.create({
  name: 'image',
  group: 'inline',
  inline: true,
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: '' },
      alt: { default: '' },
      title: { default: null },
      width: { default: null },
      height: { default: null },
      caption: { default: null },
    };
  },
  renderHTML({ node }) {
    const imageAttrs: Record<string, string> = {
      src: displayImageSource(String(node.attrs.src)),
      alt: String(node.attrs.alt ?? ''),
    };
    if (node.attrs.title) imageAttrs.title = String(node.attrs.title);
    const styles = [node.attrs.width ? `width:${String(node.attrs.width)}` : '', node.attrs.height ? `height:${String(node.attrs.height)}` : ''].filter(Boolean);
    if (styles.length) imageAttrs.style = styles.join(';');
    return [
      'span',
      { class: 'imported-image' },
      ['img', imageAttrs],
      ...(node.attrs.caption ? [['span', { class: 'imported-image-caption' }, String(node.attrs.caption)]] : []),
    ];
  },
});

/** Pandoc citation marker as an inline atom. `items` drives serialization. */
export const Citation = Node.create({
  name: 'citation',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return {
      items: { default: [] as CitationItem[] },
      raw: { default: '' },
    };
  },
  renderHTML({ node }) {
    const items = node.attrs.items as CitationItem[];
    const raw = serializeCitation(items);
    return ['span', { class: 'cite', 'data-raw': raw, title: raw }, raw];
  },
});

/** Footnote reference `[^label]` as a superscript inline atom. */
export const FootnoteRef = Node.create({
  name: 'footnoteRef',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return { label: { default: '' } };
  },
  renderHTML({ node }) {
    const label = String(node.attrs.label);
    return ['sup', { class: 'fn-ref', 'data-label': label }, `[${label}]`];
  },
});

/** Footnote definition block; renders with its `[^label]:` marker via CSS. */
export const FootnoteDef = Node.create({
  name: 'footnoteDef',
  group: 'block',
  content: 'paragraph+',
  addAttributes() {
    return { label: { default: '' } };
  },
  renderHTML({ node }) {
    return [
      'div',
      { class: 'fn-def', 'data-marker': `[^${String(node.attrs.label)}]:` },
      0,
    ];
  },
});

export function buildExtensions() {
  return [
    StarterKit.configure({
      link: { openOnClick: false },
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      // v3 StarterKit appends trailing empty paragraphs at the doc end,
      // which would pollute the canonical Markdown on every round trip.
      trailingNode: false,
    }),
    Table.configure({ resizable: false }),
    TableRow,
    AlignedTableHeader,
    AlignedTableCell,
    Citation,
    FootnoteRef,
    FootnoteDef,
    Image,
  ];
}
