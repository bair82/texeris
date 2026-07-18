/**
 * Tiptap schema for the spike: StarterKit + tables + three custom nodes for
 * the parts of the Markdown profile StarterKit doesn't know about.
 * Kept separate from the editor so tests can build the schema without a DOM.
 */

import { Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { citationLabel, serializeCitation, type CitationItem } from '../lib/citations';

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
    return [
      'span',
      {
        class: 'cite-pill',
        'data-raw': serializeCitation(items),
        title: serializeCitation(items),
      },
      citationLabel(items),
    ];
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
    TableHeader,
    TableCell,
    Citation,
    FootnoteRef,
    FootnoteDef,
  ];
}
