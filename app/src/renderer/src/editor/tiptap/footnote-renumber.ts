/**
 * Footnote renumbering (M1.5 EU6 follow-up): footnote labels follow
 * document order. After any transaction that changes footnote refs/defs,
 * this plugin renumbers all refs 1..N in document order and retargets the
 * matching definitions.
 *
 * Rules that keep it safe:
 * - Inserts use transient UNIQUE labels (max+1), so def→ref matching is
 *   unambiguous even mid-renumber.
 * - Orphaned definitions (their ref is gone) keep their content — never
 *   silent data loss; they are only relabeled when their label collides
 *   with a live ref. Deleting the last ref leaves all defs untouched, so
 *   cut → paste moves restore cleanly.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

export interface FootnoteEdit {
  pos: number;
  label: string;
}

/**
 * Compute the label updates that make footnotes follow document order.
 * Pure and DOM-free; returns an empty list when everything is consistent.
 */
export function planFootnoteRenumber(doc: PMNode): FootnoteEdit[] {
  const refs: Array<{ pos: number; label: string }> = [];
  const defs: Array<{ pos: number; label: string }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'footnoteRef') {
      refs.push({ pos, label: String(node.attrs.label) });
    } else if (node.type.name === 'footnoteDef') {
      defs.push({ pos, label: String(node.attrs.label) });
    }
    return true;
  });

  // refs become 1..N in document order
  const edits: FootnoteEdit[] = [];
  refs.forEach((ref, i) => {
    const next = String(i + 1);
    if (ref.label !== next) {
      edits.push({ pos: ref.pos, label: next });
    }
  });

  // defs follow their refs (old label → that ref's new label; first ref
  // wins when a label was duplicated)
  const refNewByOld = new Map<string, string>();
  refs.forEach((ref, i) => {
    if (!refNewByOld.has(ref.label)) {
      refNewByOld.set(ref.label, String(i + 1));
    }
  });
  const used = new Set(refs.map((_, i) => String(i + 1)));
  let orphanNext = refs.length + 1;
  for (const def of defs) {
    let next = refNewByOld.get(def.label);
    if (next === undefined) {
      // orphaned def: keep its label unless a live ref now holds it
      next = used.has(def.label) ? String(orphanNext++) : def.label;
      used.add(next);
    }
    if (def.label !== next) {
      edits.push({ pos: def.pos, label: next });
    }
  }
  return edits;
}

const renumberKey = new PluginKey('footnoteRenumber');

export const footnoteRenumberExtension = Extension.create({
  name: 'footnoteRenumber',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: renumberKey,
        appendTransaction: (transactions, _oldState, newState) => {
          if (transactions.some((tr) => tr.getMeta(renumberKey))) {
            return null; // our own renumber transaction
          }
          if (!transactions.some((tr) => tr.docChanged)) {
            return null;
          }
          const edits = planFootnoteRenumber(newState.doc);
          if (edits.length === 0) {
            return null;
          }
          const tr = newState.tr;
          for (const edit of edits) {
            tr.setNodeAttribute(edit.pos, 'label', edit.label);
          }
          tr.setMeta(renumberKey, true);
          return tr;
        },
      }),
    ];
  },
});
