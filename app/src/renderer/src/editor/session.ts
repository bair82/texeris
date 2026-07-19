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
import { Plugin, PluginKey } from '@tiptap/pm/state';
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
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown as markdownLang } from '@codemirror/lang-markdown';
import type { TextSplice } from '../../../shared/domain-types';
import { ChangeAccumulator } from './accumulator';
import type { HighlightRange } from './editorBridge';
import { buildExtensions } from './tiptap/nodes';
import { markdownIn, type PMNodeJSON } from './lib/markdown-in';
import { markdownOut } from './lib/markdown-out';

export type EditorMode = 'rendered' | 'raw';

export interface EditorSession {
  readonly mode: EditorMode;
  mount(el: HTMLElement): void;
  destroy(): void;
  /** Current canonical text. */
  getText(): string;
  /** Approximate canonical-text selection offsets (null when empty). */
  getSelection(): { from: number; to: number } | null;
  /** Commit any pending changes now (mode switch, patch application). */
  flush(): void;
  /** Temporarily mark ranges in the editor (patch review indication, D0). */
  setHighlights(ranges: HighlightRange[]): void;
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
      extensions: [...buildExtensions(), highlightExtension],
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
    // Approximate canonical offsets (plan §13 PM variant): serialize the doc
    // prefix up to each PM position. O(doc) per call, exact enough for
    // context slicing.
    const doc = this.editor.state.doc;
    const topType = this.editor.schema.topNodeType;
    const toOffset = (pos: number): number => {
      const slice = topType.create(null, doc.slice(0, pos).content);
      return markdownOut(slice.toJSON() as PMNodeJSON).length;
    };
    return { from: toOffset(from), to: toOffset(to) };
  }

  focus(): void {
    this.editor.commands.focus();
  }
}

// ---------------------------------------------------------------------------
// Raw mode: CodeMirror 6 over the same canonical text
// ---------------------------------------------------------------------------

const setCmHighlights = StateEffect.define<HighlightRange[]>();
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

  focus(): void {
    this.view.focus();
  }
}
