/**
 * Footnote renumbering + reordering (M1.5 EU6 follow-up): footnote labels
 * follow document order, and definition blocks are physically ordered to
 * match. After any footnote-affecting transaction this plugin renumbers all
 * refs 1..N in document order, retargets their definitions, and re-sorts
 * the def blocks ascending (anchored where the first def was).
 *
 * Rules that keep it safe:
 * - Inserts use transient UNIQUE labels (max+1) in ONE transaction with
 *   their def, so def→ref matching is unambiguous mid-renumber.
 * - Orphaned definitions (their ref is gone) keep their content — never
 *   silent data loss; they are only relabeled when their label collides
 *   with a live ref. Deleting the last ref leaves all defs untouched, so
 *   cut → paste moves restore cleanly.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

export interface FootnoteEdit {
  pos: number;
  label: string;
}

interface DefEntry {
  pos: number;
  label: string;
  node: PMNode;
}

function collect(doc: PMNode): {
  refs: Array<{ pos: number; label: string }>;
  defs: DefEntry[];
} {
  const refs: Array<{ pos: number; label: string }> = [];
  const defs: DefEntry[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'footnoteRef') {
      refs.push({ pos, label: String(node.attrs.label) });
    } else if (node.type.name === 'footnoteDef') {
      defs.push({ pos, label: String(node.attrs.label), node });
    }
    return true;
  });
  return { refs, defs };
}

export interface FootnotePlan {
  refEdits: FootnoteEdit[];
  /** Defs re-created with new labels, sorted ascending — null when the
   * current order already matches the numbering. */
  reorder: { anchor: number; nodes: PMNode[] } | null;
}

/**
 * Compute the updates that make footnotes follow document order. Pure and
 * DOM-free; refEdits/reorder are both empty when everything is consistent.
 */
export function planFootnoteRenumber(doc: PMNode): FootnotePlan {
  const { refs, defs } = collect(doc);
  if (refs.length === 0) {
    // no live refs: leave everything untouched so cut → paste restores
    return { refEdits: [], reorder: null };
  }

  // refs become 1..N in document order
  const refEdits: FootnoteEdit[] = [];
  refs.forEach((ref, i) => {
    const next = String(i + 1);
    if (ref.label !== next) {
      refEdits.push({ pos: ref.pos, label: next });
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
  const defNext = defs.map((def) => {
    let next = refNewByOld.get(def.label);
    if (next === undefined) {
      // orphaned def: keep its label unless a live ref now holds it
      next = used.has(def.label) ? String(orphanNext++) : def.label;
      used.add(next);
    }
    return next;
  });

  // reorder when the def blocks aren't in ascending label order
  let reorder: FootnotePlan['reorder'] = null;
  const inOrder = defNext.every((_, i) => i === 0 || Number(defNext[i - 1]) <= Number(defNext[i]));
  if (!inOrder && defs.length > 0) {
    const sorted = defs
      .map((def, i) => ({ def, next: defNext[i] }))
      .sort((a, b) => Number(a.next) - Number(b.next));
    reorder = {
      anchor: defs[0].pos,
      nodes: sorted.map(({ def, next }) =>
        def.node.type.create(
          { ...def.node.attrs, label: next },
          def.node.content,
          def.node.marks,
        ),
      ),
    };
  }
  return { refEdits, reorder };
}

const renumberKey = new PluginKey('footnoteRenumber');

/** The renumber+reorder transaction for a state, or null when consistent. */
export function footnoteRenumberTransaction(state: EditorState): Transaction | null {
  const plan = planFootnoteRenumber(state.doc);
  if (plan.refEdits.length === 0 && !plan.reorder) {
    return null;
  }
  const tr = state.tr;
  for (const edit of plan.refEdits) {
    tr.setNodeAttribute(edit.pos, 'label', edit.label);
  }
  if (plan.reorder) {
    // delete defs last→first (keeps positions valid), insert sorted at the
    // anchor (start of the original first def)
    const { defs } = collect(state.doc);
    for (let i = defs.length - 1; i >= 0; i--) {
      tr.delete(defs[i].pos, defs[i].pos + defs[i].node.nodeSize);
    }
    let at = plan.reorder.anchor;
    for (const node of plan.reorder.nodes) {
      tr.insert(at, node);
      at += node.nodeSize;
    }
  }
  tr.setMeta(renumberKey, true);
  return tr;
}

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
          return footnoteRenumberTransaction(newState);
        },
      }),
    ];
  },
});
