/**
 * Editor sessions (plan §13, PM variant): rendered (Tiptap) and raw
 * (CodeMirror 6) modes over ONE canonical text — never separate editable
 * copies. Each session emits grouped text splices (validated sequentially
 * by main on commit); mode switches flush pending changes and produce no
 * revision of their own.
 *
 * Revision capture: PM steps don't map to Markdown ranges, so both sessions
 * derive a minimal splice per editor update (serialize+diff for Tiptap,
 * direct doc diff for CM) and group them with the §8 rules.
 */

import { Editor, Extension } from '@tiptap/core';
import { Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import {
  Decoration as CMDecoration,
  DecorationSet as CMDecorationSet,
  EditorView,
  drawSelection,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, redo as cmRedo, undo as cmUndo } from '@codemirror/commands';
import { markdown as markdownLang } from '@codemirror/lang-markdown';
import type { TextSplice } from '../../../shared/domain-types';
import { ChangeAccumulator } from './accumulator';
import type { HighlightRange } from './editorBridge';
import { buildExtensions } from './tiptap/nodes';
import { markdownIn, type PMNodeJSON } from './lib/markdown-in';
import { markdownOut } from './lib/markdown-out';

export type EditorMode = 'rendered' | 'raw';

export interface SearchMatch {
  from: number;
  to: number;
}

export interface EditorSession {
  readonly mode: EditorMode;
  mount(el: HTMLElement): void;
  destroy(): void;
  /** Current canonical text. */
  getText(): string;
  /** Approximate canonical-text selection offsets (null when empty). */
  getSelection(): { from: number; to: number } | null;
  /** Text of the current selection (null when empty). */
  getSelectionText(): string | null;
  /** Canonical-text caret offset (approximate in rendered mode). */
  getCursor(): number;
  /** Move the caret near a canonical-text offset (best-effort; no scroll). */
  setCursor(offset: number): void;
  /** Commit any pending changes now (mode switch, patch application). */
  flush(): void;
  /** Temporarily mark ranges in the editor (patch review indication, D0). */
  setHighlights(ranges: HighlightRange[]): void;
  /** Find matches of `query` (empty array for an empty query). */
  search(query: string, caseSensitive: boolean): SearchMatch[];
  /** Highlight matches; `current` is the active index (-1 clears). */
  setSearchHighlights(matches: SearchMatch[], current: number): void;
  /** Select a match and scroll it into view. */
  revealMatch(match: SearchMatch): void;
  /** Replace one match (flows through the normal update→commit path). */
  replaceMatch(match: SearchMatch, replacement: string): void;
  /** Replace all matches in one transaction (one revision group). */
  replaceAll(matches: SearchMatch[], replacement: string): void;
  /** Select a heading's text and scroll to it (outline navigation, EU2). */
  navigateToHeading(headingText: string): boolean;
  /** Editor-local undo/redo (per-session history; lost on session swap). */
  undo(): boolean;
  redo(): boolean;
  focus(): void;
}

export interface SessionOptions {
  text: string;
  /** Grouped, sequential splices ready to commit. */
  onFlush: (splices: TextSplice[]) => void;
  /** Fired when the session gains uncommitted changes. */
  onDirty?: () => void;
}

// ---------------------------------------------------------------------------
// Review highlights (patch review indication, D0 feedback)
// ---------------------------------------------------------------------------

const HIGHLIGHT_MS = 6000;

const highlightKey = new PluginKey<DecorationSet>('reviewHighlight');

const highlightExtension = Extension.create({
  name: 'reviewHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: highlightKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const meta = tr.getMeta(highlightKey) as
              | { ranges: { from: number; to: number }[] }
              | 'clear'
              | undefined;
            if (meta === 'clear') {
              return DecorationSet.empty;
            }
            if (meta?.ranges) {
              return DecorationSet.create(
                tr.doc,
                meta.ranges
                  .filter((r) => r.to > r.from && r.to <= tr.doc.content.size)
                  .map((r) => Decoration.inline(r.from, r.to, { class: 'review-highlight' })),
              );
            }
            return set.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return highlightKey.getState(state);
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
    if (result) {
      return false;
    }
    if (node.isText && node.text) {
      const idx = node.text.indexOf(search);
      if (idx >= 0) {
        result = { from: pos + idx, to: pos + idx + search.length };
        return false;
      }
    }
    return true;
  });
  return result;
}

// ---------------------------------------------------------------------------
// Search (EU2): match + current-match decorations
// ---------------------------------------------------------------------------

const searchKey = new PluginKey<DecorationSet>('searchHighlight');

const searchHighlightExtension = Extension.create({
  name: 'searchHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: searchKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const meta = tr.getMeta(searchKey) as
              | { matches: SearchMatch[]; current: number }
              | undefined;
            if (meta) {
              return DecorationSet.create(
                tr.doc,
                meta.matches
                  .filter((m) => m.to > m.from && m.to <= tr.doc.content.size)
                  .map((m, i) =>
                    Decoration.inline(m.from, m.to, {
                      class: i === meta.current ? 'search-match-current' : 'search-match',
                    }),
                  ),
              );
            }
            return set.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return searchKey.getState(state);
          },
        },
      }),
    ];
  },
});

// ---------------------------------------------------------------------------
// Rendered mode: Tiptap
// ---------------------------------------------------------------------------

export class RenderedSession implements EditorSession {
  readonly mode = 'rendered' as const;
  private editor: Editor;
  private accumulator: ChangeAccumulator;
  private snapshot: string;
  private pastePending = false;
  private suppress = false;
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SessionOptions) {
    this.accumulator = new ChangeAccumulator(options.onFlush, options.onDirty);
    this.snapshot = options.text;
    this.editor = new Editor({
      extensions: [...buildExtensions(), highlightExtension, searchHighlightExtension],
      content: markdownIn(options.text),
      onUpdate: ({ editor }) => {
        const text = markdownOut(editor.getJSON() as PMNodeJSON);
        const prev = this.snapshot;
        this.snapshot = text;
        if (this.suppress || text === prev) {
          this.suppress = false;
          return;
        }
        this.accumulator.record(prev, text, this.pastePending ? 'paste' : 'typing');
        this.pastePending = false;
      },
      onCreate: ({ editor }) => {
        editor.view.dom.addEventListener('paste', () => {
          this.pastePending = true;
        });
      },
    });
  }

  mount(el: HTMLElement): void {
    el.appendChild(this.editor.view.dom);
    this.editor.view.dom.classList.add('tiptap-rendered');
  }

  destroy(): void {
    this.accumulator.dispose();
    if (this.highlightTimer) {
      clearTimeout(this.highlightTimer);
    }
    this.editor.destroy();
  }

  getText(): string {
    return markdownOut(this.editor.getJSON() as PMNodeJSON);
  }

  /** The underlying Tiptap editor (toolbar commands). */
  getEditor(): Editor {
    return this.editor;
  }

  flush(): void {
    this.accumulator.flush();
  }

  setHighlights(ranges: HighlightRange[]): void {
    const pmRanges: { from: number; to: number }[] = [];
    for (const range of ranges) {
      const snippet = range.snippet.slice(0, 48);
      if (!snippet.trim()) {
        continue;
      }
      const found = findTextRange(this.editor.state.doc, snippet);
      if (found) {
        pmRanges.push(found);
      }
    }
    const tr = this.editor.state.tr.setMeta(highlightKey, { ranges: pmRanges });
    this.editor.view.dispatch(tr);
    if (pmRanges[0]) {
      this.editor.commands.setTextSelection(pmRanges[0].from);
    }
    if (this.highlightTimer) {
      clearTimeout(this.highlightTimer);
    }
    this.highlightTimer = setTimeout(() => {
      const clear = this.editor.state.tr.setMeta(highlightKey, 'clear');
      this.editor.view.dispatch(clear);
    }, HIGHLIGHT_MS);
  }

  getSelection(): { from: number; to: number } | null {
    const { from, to } = this.editor.state.selection;
    if (from === to) {
      return null;
    }
    return { from: this.toCanonicalOffset(from), to: this.toCanonicalOffset(to) };
  }

  getSelectionText(): string | null {
    const selection = this.editor.state.selection;
    if (selection.empty) {
      return null;
    }
    return this.editor.state.doc.textBetween(selection.from, selection.to, ' ', ' ');
  }

  /**
   * Canonical offset of a PM position via prefix serialization (plan §13 PM
   * variant, approximate): serialize the doc prefix up to the position.
   * O(doc) per call, exact enough for context slicing and cursor restore.
   */
  private toCanonicalOffset(pos: number): number {
    const doc = this.editor.state.doc;
    const topType = this.editor.schema.topNodeType;
    const slice = topType.create(null, doc.slice(0, pos).content);
    return markdownOut(slice.toJSON() as PMNodeJSON).length;
  }

  getCursor(): number {
    return this.toCanonicalOffset(this.editor.state.selection.head);
  }

  search(query: string, caseSensitive: boolean): SearchMatch[] {
    if (!query) {
      return [];
    }
    const needle = caseSensitive ? query : query.toLowerCase();
    const matches: SearchMatch[] = [];
    this.editor.state.doc.descendants((node, pos) => {
      if (!node.isText || !node.text) {
        return true;
      }
      const hay = caseSensitive ? node.text : node.text.toLowerCase();
      let idx = hay.indexOf(needle);
      while (idx >= 0) {
        matches.push({ from: pos + idx, to: pos + idx + needle.length });
        idx = hay.indexOf(needle, idx + needle.length);
      }
      return true;
    });
    return matches;
  }

  setSearchHighlights(matches: SearchMatch[], current: number): void {
    const tr = this.editor.state.tr.setMeta(searchKey, { matches, current });
    this.editor.view.dispatch(tr);
  }

  revealMatch(match: SearchMatch): void {
    this.editor.chain().setTextSelection(match).scrollIntoView().run();
  }

  replaceMatch(match: SearchMatch, replacement: string): void {
    const tr = this.editor.state.tr.insertText(replacement, match.from, match.to);
    this.editor.view.dispatch(tr);
  }

  replaceAll(matches: SearchMatch[], replacement: string): void {
    // descending order keeps earlier positions valid within one transaction
    const tr = this.editor.state.tr;
    for (const match of [...matches].sort((a, b) => b.from - a.from)) {
      tr.insertText(replacement, match.from, match.to);
    }
    this.editor.view.dispatch(tr);
  }

  navigateToHeading(headingText: string): boolean {
    // IIFE: TS's flow analysis treats closure-assigned lets as never after
    // a truthiness guard — keep the walk inside a typed function instead.
    const range = ((): { from: number; to: number } | null => {
      let found: { from: number; to: number } | null = null;
      this.editor.state.doc.descendants((node, pos) => {
        if (found) {
          return false;
        }
        if (node.type.name === 'heading' && node.textContent === headingText) {
          found = { from: pos + 1, to: pos + 1 + node.content.size };
          return false;
        }
        return true;
      });
      return found;
    })();
    if (!range) {
      return false;
    }
    // Focus synchronously: Tiptap's focus command defers into a rAF, which
    // never fires in a hidden window (smoke runs), leaving focus behind.
    const { view } = this.editor;
    view.dom.focus();
    const sel = TextSelection.create(view.state.doc, range.from, range.to);
    view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
    return true;
  }

  undo(): boolean {
    return this.editor.commands.undo();
  }

  redo(): boolean {
    return this.editor.commands.redo();
  }

  setCursor(offset: number): void {
    // Invert toCanonicalOffset by binary search: the largest PM position
    // whose canonical prefix fits within `offset`. Approximate but stable.
    const doc = this.editor.state.doc;
    let lo = 0;
    let hi = doc.content.size;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.toCanonicalOffset(mid) <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    const sel = Selection.near(doc.resolve(lo), 1);
    this.editor.view.dispatch(this.editor.state.tr.setSelection(sel));
  }

  focus(): void {
    this.editor.commands.focus();
  }
}

// ---------------------------------------------------------------------------
// Raw mode: CodeMirror 6 over the same canonical text
// ---------------------------------------------------------------------------

const setCmHighlights = StateEffect.define<HighlightRange[]>();
const setCmSearch = StateEffect.define<{ matches: SearchMatch[]; current: number }>();
const cmSearchField = StateField.define<CMDecorationSet>({
  create: () => CMDecoration.none,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setCmSearch)) {
        const { matches, current } = effect.value;
        next = CMDecoration.set(
          matches
            .filter((m) => m.to > m.from && m.to <= tr.state.doc.length)
            .map((m, i) =>
              CMDecoration.mark({
                class: i === current ? 'search-match-current' : 'search-match',
              }).range(m.from, m.to),
            ),
          true,
        );
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});
const rawTheme = EditorView.theme(
  {
    '&': {
      color: '#f5f5f5',
    },
    '.cm-cursor': {
      borderLeftColor: '#f5f5f5',
    },
  },
  { dark: true },
);
const cmHighlightField = StateField.define<CMDecorationSet>({
  create: () => CMDecoration.none,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setCmHighlights)) {
        const marks = effect.value
          .filter((r) => r.to > r.from && r.to <= tr.state.doc.length)
          .map((r) =>
            CMDecoration.mark({ class: 'review-highlight' }).range(r.from, r.to),
          );
        next = CMDecoration.set(marks, true);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export class RawSession implements EditorSession {
  readonly mode = 'raw' as const;
  private view: EditorView;
  private accumulator: ChangeAccumulator;
  private pastePending = false;
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SessionOptions) {
    this.accumulator = new ChangeAccumulator(options.onFlush, options.onDirty);
    let prevText = options.text;
    this.view = new EditorView({
      state: EditorState.create({
        doc: options.text,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdownLang(),
          cmHighlightField,
          cmSearchField,
          rawTheme,
          // CM defaults spellcheck="false" on its contentDOM — allow the
          // Chromium spellchecker (EU4) in raw mode too.
          EditorView.contentAttributes.of({ spellcheck: 'true' }),
          // Custom-drawn cursor + selection: the native caret can be
          // invisible under Electron/Wayland (owner report).
          drawSelection(),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) {
              return;
            }
            const text = update.state.doc.toString();
            this.accumulator.record(
              prevText,
              text,
              this.pastePending ? 'paste' : 'typing',
            );
            this.pastePending = false;
            prevText = text;
          }),
        ],
      }),
    });
    this.view.dom.addEventListener('paste', () => {
      this.pastePending = true;
    });
    this.view.dom.classList.add('cm-raw');
  }

  mount(el: HTMLElement): void {
    el.appendChild(this.view.dom);
  }

  destroy(): void {
    this.accumulator.dispose();
    if (this.highlightTimer) {
      clearTimeout(this.highlightTimer);
    }
    this.view.destroy();
  }

  getText(): string {
    return this.view.state.doc.toString();
  }

  flush(): void {
    this.accumulator.flush();
  }

  setHighlights(ranges: HighlightRange[]): void {
    // Raw mode IS canonical text — offsets are exact.
    this.view.dispatch({ effects: setCmHighlights.of(ranges) });
    if (ranges[0]) {
      this.view.dispatch({ selection: { anchor: ranges[0].from } });
    }
    if (this.highlightTimer) {
      clearTimeout(this.highlightTimer);
    }
    this.highlightTimer = setTimeout(() => {
      this.view.dispatch({ effects: setCmHighlights.of([]) });
    }, HIGHLIGHT_MS);
  }

  getSelection(): { from: number; to: number } | null {
    const { from, to } = this.view.state.selection.main;
    return from === to ? null : { from, to };
  }

  getSelectionText(): string | null {
    const selection = this.view.state.selection.main;
    return selection.empty ? null : this.view.state.sliceDoc(selection.from, selection.to);
  }

  getCursor(): number {
    return this.view.state.selection.main.head;
  }

  // Raw mode IS canonical text — search offsets are exact.

  search(query: string, caseSensitive: boolean): SearchMatch[] {
    if (!query) {
      return [];
    }
    const text = this.view.state.doc.toString();
    const hay = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    const matches: SearchMatch[] = [];
    let idx = hay.indexOf(needle);
    while (idx >= 0) {
      matches.push({ from: idx, to: idx + needle.length });
      idx = hay.indexOf(needle, idx + needle.length);
    }
    return matches;
  }

  setSearchHighlights(matches: SearchMatch[], current: number): void {
    this.view.dispatch({ effects: setCmSearch.of({ matches, current }) });
  }

  revealMatch(match: SearchMatch): void {
    this.view.dispatch({
      selection: { anchor: match.from, head: match.to },
      effects: EditorView.scrollIntoView(match.from, { y: 'center' }),
    });
  }

  replaceMatch(match: SearchMatch, replacement: string): void {
    this.view.dispatch({
      changes: { from: match.from, to: match.to, insert: replacement },
    });
  }

  replaceAll(matches: SearchMatch[], replacement: string): void {
    // matches are ascending and non-overlapping — valid as one CM change set
    this.view.dispatch({
      changes: matches.map((m) => ({ from: m.from, to: m.to, insert: replacement })),
    });
  }

  navigateToHeading(headingText: string): boolean {
    const doc = this.view.state.doc;
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const m = /^(#{1,6})\s+(.*)$/.exec(line.text);
      if (m && m[2].trim() === headingText) {
        const from = line.from + m[1].length + 1;
        this.view.focus();
        this.view.dispatch({
          selection: { anchor: from, head: line.to },
          effects: EditorView.scrollIntoView(from, { y: 'center' }),
        });
        return true;
      }
    }
    return false;
  }

  undo(): boolean {
    return cmUndo(this.view);
  }

  redo(): boolean {
    return cmRedo(this.view);
  }

  setCursor(offset: number): void {
    const anchor = Math.max(0, Math.min(offset, this.view.state.doc.length));
    this.view.dispatch({ selection: { anchor } });
  }

  focus(): void {
    this.view.focus();
  }
}
