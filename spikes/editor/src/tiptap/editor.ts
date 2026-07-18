/**
 * Tiptap/ProseMirror editor: structured doc, Markdown parsed in on load and
 * serialized out on demand. Raw mode is a separate CodeMirror 6 Markdown
 * editor bound to the serialized text; switching back re-parses.
 *
 * Revision capture here differs from the CM tab on purpose: PM steps do not
 * map to Markdown ranges, so every update re-serializes and line-diffs
 * against the previous snapshot (see README).
 */

import { Editor, Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { EditorView as CMEditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { buildExtensions } from './nodes';
import { markdownIn, type PMNodeJSON } from '../lib/markdown-in';
import { markdownOut } from '../lib/markdown-out';
import {
  diffCharCounts,
  firstChangedLine,
  firstChangeSnippet,
  lineDiff,
} from '../lib/diff';
import { applyPatch, type ApplyResult, type DocumentPatch } from '../lib/patch';
import type { RevisionEventInput } from '../lib/revisions';
import type { EditorHandle, EditorMode } from '../ui/handle';
import { baseMarkdownExtensions, programAnnotation, revisionListener } from '../cm/editor';

// ---------------------------------------------------------------------------
// Temporary highlight of patch-applied ranges (~3s)
// ---------------------------------------------------------------------------

const patchHighlightKey = new PluginKey<DecorationSet>('patchHighlight');

const PatchHighlight = Extension.create({
  name: 'patchHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: patchHighlightKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const meta = tr.getMeta(patchHighlightKey) as
              | { ranges: { from: number; to: number }[] }
              | 'clear'
              | undefined;
            if (meta === 'clear') return DecorationSet.empty;
            if (meta && meta.ranges) {
              return DecorationSet.create(
                tr.doc,
                meta.ranges
                  .filter((r) => r.to > r.from && r.to <= tr.doc.content.size)
                  .map((r) => Decoration.inline(r.from, r.to, { class: 'patch-highlight' })),
              );
            }
            return set.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return patchHighlightKey.getState(state);
          },
        },
      }),
    ];
  },
});

/** Approximate: find the first text node containing `search`, return PM range. */
function findTextRange(doc: PMNode, search: string): { from: number; to: number } | null {
  let result: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (result) return false;
    if (node.isText && node.text) {
      const idx = node.text.indexOf(search);
      if (idx >= 0) {
        result = { from: pos + idx, to: pos + idx + search.length };
        return false;
      }
    }
    return true; // keep descending into non-text nodes
  });
  return result;
}

// ---------------------------------------------------------------------------
// Editor handle
// ---------------------------------------------------------------------------

export function createTiptapEditor(opts: {
  doc: string;
  onRevisionEvent: (ev: RevisionEventInput) => void;
}): EditorHandle {
  let mode: EditorMode = 'rendered';
  let pastePending = false;
  let suppressUpdate = false;
  let highlightTimer: ReturnType<typeof setTimeout> | null = null;

  const renderedHost = document.createElement('div');
  renderedHost.className = 'tiptap-rendered';
  const rawHost = document.createElement('div');
  rawHost.className = 'tiptap-raw cm-host';
  rawHost.style.display = 'none';

  let snapshot = opts.doc;

  const editor = new Editor({
    element: renderedHost,
    extensions: [...buildExtensions(), PatchHighlight],
    content: markdownIn(opts.doc),
    onUpdate: ({ editor: e }) => {
      const text = markdownOut(e.getJSON() as PMNodeJSON);
      const prev = snapshot;
      snapshot = text;
      if (suppressUpdate || text === prev) {
        suppressUpdate = false;
        return;
      }
      const ops = lineDiff(prev, text);
      const { added, removed } = diffCharCounts(ops);
      const kind = pastePending ? 'paste' : 'edit';
      pastePending = false;
      opts.onRevisionEvent({
        time: Date.now(),
        actor: 'user',
        kind,
        line: firstChangedLine(ops),
        inserted: added,
        deleted: removed,
        snippet: firstChangeSnippet(ops),
      });
    },
    onCreate: ({ editor: e }) => {
      snapshot = markdownOut(e.getJSON() as PMNodeJSON);
      e.view.dom.addEventListener('paste', () => {
        pastePending = true;
      });
    },
  });

  // Raw-mode CodeMirror editor, created lazily on first switch.
  let rawView: CMEditorView | null = null;
  function ensureRawView(): CMEditorView {
    if (!rawView) {
      rawView = new CMEditorView({
        state: EditorState.create({
          doc: snapshot,
          extensions: [
            ...baseMarkdownExtensions(),
            revisionListener(opts.onRevisionEvent),
          ],
        }),
        parent: rawHost,
      });
      rawHost.classList.add('raw-mode');
    }
    return rawView;
  }

  /** Replace the PM doc from Markdown without producing a revision. */
  function resetDoc(text: string): void {
    suppressUpdate = true;
    editor.commands.setContent(markdownIn(text), { emitUpdate: false });
    snapshot = markdownOut(editor.getJSON() as PMNodeJSON);
  }

  function scheduleHighlightClear() {
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => {
      const tr = editor.state.tr.setMeta(patchHighlightKey, 'clear');
      editor.view.dispatch(tr);
    }, 3000);
  }

  const handle: EditorHandle = {
    kind: 'tiptap',

    mount(el: HTMLElement) {
      el.classList.add('tiptap-host');
      el.appendChild(renderedHost);
      el.appendChild(rawHost);
    },

    destroy() {
      if (highlightTimer) clearTimeout(highlightTimer);
      rawView?.destroy();
      editor.destroy();
    },

    getCanonicalText() {
      if (mode === 'raw' && rawView) return rawView.state.doc.toString();
      return markdownOut(editor.getJSON() as PMNodeJSON);
    },

    setCanonicalText(text: string) {
      resetDoc(text);
      if (rawView) {
        // Keep any existing raw view consistent; it will be re-synced on the
        // next mode switch anyway, but stale content is confusing.
        rawView.dispatch({
          changes: { from: 0, to: rawView.state.doc.length, insert: snapshot },
          annotations: [programAnnotation.of(true)],
        });
      }
    },

    setMode(m: EditorMode) {
      if (m === mode) return;
      if (m === 'raw') {
        snapshot = markdownOut(editor.getJSON() as PMNodeJSON);
        const view = ensureRawView();
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: snapshot },
          annotations: [programAnnotation.of(true)],
        });
        renderedHost.style.display = 'none';
        rawHost.style.display = '';
      } else {
        const rawText = ensureRawView().state.doc.toString();
        resetDoc(rawText);
        rawHost.style.display = 'none';
        renderedHost.style.display = '';
      }
      mode = m;
    },

    getMode() {
      return mode;
    },

    applyDocumentPatch(patch: DocumentPatch, groupIds?: string[]): ApplyResult {
      if (mode === 'raw' && rawView) {
        // Same path as the CM tab: patch the raw text directly.
        const current = rawView.state.doc.toString();
        const result = applyPatch(current, patch, groupIds);
        if (!result.ok) return result;
        const groups = patch.groups.filter((g) => !groupIds || groupIds.includes(g.id));
        const changes = groups
          .flatMap((g) => g.changes)
          .sort((a, b) => b.from - a.from)
          .map((c) => ({ from: c.from, to: c.to, insert: c.insert }));
        rawView.dispatch({ changes });
        return result;
      }
      const current = markdownOut(editor.getJSON() as PMNodeJSON);
      const result = applyPatch(current, patch, groupIds);
      if (!result.ok) return result;
      // Serialize -> apply -> reparse. Revision entry is emitted manually
      // from the text diff (PM steps don't map to Markdown ranges).
      const ops = lineDiff(current, result.text);
      const { added, removed } = diffCharCounts(ops);
      resetDoc(result.text);
      opts.onRevisionEvent({
        time: Date.now(),
        actor: 'agent',
        kind: 'patch',
        line: firstChangedLine(ops),
        inserted: added,
        deleted: removed,
        snippet: firstChangeSnippet(ops),
      });
      // Approximate highlight + selection: locate inserted snippets in the
      // re-parsed doc. Pure deletions get no highlight (nothing to mark).
      const pmRanges: { from: number; to: number }[] = [];
      for (const r of result.appliedRanges) {
        const snippetText = result.text.slice(r.from, r.to);
        if (!snippetText.trim()) continue;
        const found = findTextRange(editor.state.doc, snippetText.slice(0, 48));
        if (found) pmRanges.push(found);
      }
      if (pmRanges.length > 0) {
        const tr = editor.state.tr.setMeta(patchHighlightKey, { ranges: pmRanges });
        editor.view.dispatch(tr);
        editor.commands.setTextSelection(pmRanges[0].from);
        scheduleHighlightClear();
      }
      return result;
    },

    replaceLiteral(find: string, insert: string): boolean {
      if (mode === 'raw' && rawView) {
        const idx = rawView.state.doc.toString().indexOf(find);
        if (idx < 0) return false;
        rawView.dispatch({
          changes: { from: idx, to: idx + find.length, insert },
          selection: { anchor: idx + insert.length },
        });
        return true;
      }
      const found = findTextRange(editor.state.doc, find);
      if (!found) return false;
      editor.chain().focus().insertContentAt(found, insert).run();
      return true;
    },

    onRevisionEvent() {
      // Wired at construction; kept for interface symmetry.
    },

    focus() {
      editor.commands.focus();
    },
  };
  return handle;
}
