/**
 * CodeMirror 6 editor: the Markdown text IS the state. Rendered mode is a
 * decoration layer over the text (hide syntax away from the cursor, citation
 * pills, superscript footnote refs, styled tables); raw mode switches the
 * decoration compartment off, leaving plain highlighted Markdown.
 */

import { Annotation, Compartment, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { defaultHighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { citationLabel, findCitations } from '../lib/citations';
import {
  findFootnotesInLine,
  isFootnoteContinuation,
  parseFootnoteDefLine,
} from '../lib/footnotes';
import { applyPatch, type ApplyResult, type DocumentPatch } from '../lib/patch';
import type { RevisionEventInput } from '../lib/revisions';
import type { EditorHandle, EditorMode } from '../ui/handle';

export const programAnnotation = Annotation.define<boolean>();
const patchAnnotation = Annotation.define<boolean>();

// ---------------------------------------------------------------------------
// Patch highlight (temporary, ~3s)
// ---------------------------------------------------------------------------

const setPatchHighlight = StateEffect.define<{ from: number; to: number }[] | null>();

const patchHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setPatchHighlight)) {
        if (e.value === null) return Decoration.none;
        return Decoration.set(
          e.value
            .filter((r) => r.to > r.from)
            .map((r) => Decoration.mark({ class: 'patch-highlight' }).range(r.from, r.to)),
        );
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

class CitationPillWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly raw: string,
  ) {
    super();
  }
  eq(other: CitationPillWidget): boolean {
    return other.label === this.label && other.raw === this.raw;
  }
  toDOM(): HTMLElement {
    const s = document.createElement('span');
    s.className = 'cite-pill';
    s.textContent = this.label;
    s.title = this.raw;
    return s;
  }
}

class FootnoteRefWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  eq(other: FootnoteRefWidget): boolean {
    return other.label === this.label;
  }
  toDOM(): HTMLElement {
    const s = document.createElement('sup');
    s.className = 'fn-ref';
    s.textContent = `[${this.label}]`;
    s.title = `footnote ${this.label}`;
    return s;
  }
}

// ---------------------------------------------------------------------------
// Live-render decorations
// ---------------------------------------------------------------------------

/** Exported for the smoke test; the live-render ViewPlugin wraps this. */
export function buildLiveDecorations(state: EditorState): DecorationSet {
  const decos: { from: number; to: number; deco: Decoration }[] = [];
  const claimedReplaces: { from: number; to: number }[] = [];
  const selTouches = (from: number, to: number) =>
    state.selection.ranges.some((r) => r.from <= to && r.to >= from);
  const addReplace = (from: number, to: number, deco: Decoration) => {
    if (from >= to) return;
    if (claimedReplaces.some((r) => from < r.to && to > r.from)) return; // keep first
    claimedReplaces.push({ from, to });
    decos.push({ from, to, deco });
  };
  const hide = (from: number, to: number) => {
    if (!selTouches(from, to)) addReplace(from, to, Decoration.replace({}));
  };
  const addMark = (from: number, to: number, cls: string) => {
    if (from < to) decos.push({ from, to, deco: Decoration.mark({ class: cls }) });
  };
  const addLineClass = (lineFrom: number, cls: string) => {
    decos.push({ from: lineFrom, to: lineFrom, deco: Decoration.line({ class: cls }) });
  };

  // Tree-driven constructs: headings, emphasis, code spans, links, tables, quotes.
  syntaxTree(state).iterate({
    enter(node) {
      const name = node.type.name;
      if (name.startsWith('ATXHeading')) {
        const level = Number(name.slice('ATXHeading'.length)) || 1;
        addLineClass(state.doc.lineAt(node.from).from, `cm-h${level}`);
        const mark = node.node.getChild('HeaderMark');
        if (mark) {
          let to = mark.to;
          while (to < node.to && state.sliceDoc(to, to + 1) === ' ') to++;
          hide(mark.from, to);
        }
      } else if (name === 'Emphasis' || name === 'StrongEmphasis') {
        addMark(node.from, node.to, name === 'Emphasis' ? 'cm-em' : 'cm-strong');
        for (const m of node.node.getChildren('EmphasisMark')) hide(m.from, m.to);
      } else if (name === 'InlineCode') {
        addMark(node.from, node.to, 'cm-code');
        for (const m of node.node.getChildren('CodeMark')) hide(m.from, m.to);
      } else if (name === 'Link') {
        // Only inline links `[text](url "title")`. Shortcut reference links
        // (which include our footnote refs and citations) are left to the
        // line pass below.
        if (!node.node.getChild('URL')) return;
        const marks = node.node.getChildren('LinkMark');
        if (marks.length < 2 || selTouches(node.from, node.to)) return;
        addReplace(marks[0].from, marks[0].to, Decoration.replace({})); // "["
        addReplace(marks[1].from, node.to, Decoration.replace({})); // "](url "title")"
        addMark(marks[0].to, marks[1].from, 'cm-link');
      } else if (name === 'Table') {
        const fromLine = state.doc.lineAt(node.from);
        const toLine = state.doc.lineAt(node.to);
        for (let n = fromLine.number; n <= toLine.number; n++) {
          addLineClass(state.doc.line(n).from, 'cm-table-line');
        }
      } else if (name === 'TableDelimiter') {
        if (node.to - node.from === 1) {
          addMark(node.from, node.to, 'cm-table-pipe');
        } else {
          // Delimiter row: style the row and each pipe inside it.
          addLineClass(state.doc.lineAt(node.from).from, 'cm-table-delimiter-row');
          const text = state.sliceDoc(node.from, node.to);
          for (let i = 0; i < text.length; i++) {
            if (text[i] === '|') addMark(node.from + i, node.from + i + 1, 'cm-table-pipe');
          }
        }
      } else if (name === 'Blockquote') {
        const fromLine = state.doc.lineAt(node.from);
        const toLine = state.doc.lineAt(node.to);
        for (let n = fromLine.number; n <= toLine.number; n++) {
          addLineClass(state.doc.line(n).from, 'cm-quote-line');
        }
      }
    },
  });

  // Line-driven constructs: citations, footnote refs/defs (unknown to lezer).
  let inFootnoteDef = false;
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const text = line.text;
    if (parseFootnoteDefLine(text)) {
      addLineClass(line.from, 'cm-fn-def');
      inFootnoteDef = true;
    } else if (inFootnoteDef && isFootnoteContinuation(text)) {
      addLineClass(line.from, 'cm-fn-def');
    } else if (text.trim() !== '') {
      inFootnoteDef = false;
    }
    for (const span of findCitations(text)) {
      const from = line.from + span.from;
      const to = line.from + span.to;
      if (selTouches(from, to)) continue;
      addReplace(
        from,
        to,
        Decoration.replace({ widget: new CitationPillWidget(citationLabel(span.items), span.raw) }),
      );
    }
    for (const fn of findFootnotesInLine(text)) {
      if (fn.isDefinition) continue;
      const from = line.from + fn.from;
      const to = line.from + fn.to;
      if (selTouches(from, to)) continue;
      addReplace(from, to, Decoration.replace({ widget: new FootnoteRefWidget(fn.label) }));
    }
  }

  return Decoration.set(
    decos.map((d) => d.deco.range(d.from, d.to)),
    true,
  );
}

const liveRenderPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildLiveDecorations(view.state);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildLiveDecorations(u.view.state);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ---------------------------------------------------------------------------
// Shared extension pieces (raw Tiptap editor reuses these)
// ---------------------------------------------------------------------------

export function baseMarkdownExtensions(): Extension[] {
  return [
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown({ base: markdownLanguage }),
    EditorView.lineWrapping,
    syntaxHighlighting(defaultHighlightStyle),
  ];
}

/** updateListener + paste tracking that feeds the revision grouper. */
export function revisionListener(emit: (ev: RevisionEventInput) => void): Extension {
  let pastePending = false;
  return [
    EditorView.domEventHandlers({
      paste: () => {
        pastePending = true;
      },
    }),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      if (u.transactions.some((tr) => tr.annotation(programAnnotation))) return;
      const isPatch = u.transactions.some((tr) => tr.annotation(patchAnnotation));
      let inserted = 0;
      let deleted = 0;
      let fromB = 0;
      let snippet = '';
      let first = true;
      u.changes.iterChanges((fromA, toA, fb, _tb, ins) => {
        deleted += toA - fromA;
        inserted += ins.length;
        if (first) {
          fromB = fb;
          snippet =
            ins.length > 0
              ? ins.sliceString(0, 60)
              : u.startState.sliceDoc(fromA, Math.min(toA, fromA + 60));
          first = false;
        }
      });
      const kind = isPatch ? 'patch' : pastePending ? 'paste' : 'edit';
      pastePending = false;
      emit({
        time: Date.now(),
        actor: isPatch ? 'agent' : 'user',
        kind,
        line: u.state.doc.lineAt(Math.min(fromB, u.state.doc.length)).number,
        inserted,
        deleted,
        snippet: snippet.trim().slice(0, 60),
      });
    }),
  ];
}

// ---------------------------------------------------------------------------
// Editor handle
// ---------------------------------------------------------------------------

export function createCMEditor(opts: {
  doc: string;
  onRevisionEvent: (ev: RevisionEventInput) => void;
}): EditorHandle {
  const modeCompartment = new Compartment();
  let mode: EditorMode = 'rendered';
  let highlightTimer: ReturnType<typeof setTimeout> | null = null;

  const view = new EditorView({
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        ...baseMarkdownExtensions(),
        patchHighlightField,
        modeCompartment.of([liveRenderPlugin]),
        revisionListener(opts.onRevisionEvent),
      ],
    }),
  });

  let parent: HTMLElement | null = null;

  function scheduleHighlightClear() {
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => {
      view.dispatch({ effects: setPatchHighlight.of(null) });
    }, 3000);
  }

  const handle: EditorHandle = {
    kind: 'codemirror',

    mount(el: HTMLElement) {
      parent = el;
      el.classList.add('cm-host');
      el.appendChild(view.dom);
    },

    destroy() {
      if (highlightTimer) clearTimeout(highlightTimer);
      view.destroy();
    },

    getCanonicalText() {
      return view.state.doc.toString();
    },

    setCanonicalText(text: string) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: [programAnnotation.of(true)],
        selection: { anchor: 0 },
      });
      view.dispatch({ effects: setPatchHighlight.of(null) });
    },

    setMode(m: EditorMode) {
      mode = m;
      view.dispatch({
        effects: modeCompartment.reconfigure(m === 'rendered' ? [liveRenderPlugin] : []),
      });
      parent?.classList.toggle('raw-mode', m === 'raw');
    },

    getMode() {
      return mode;
    },

    applyDocumentPatch(patch: DocumentPatch, groupIds?: string[]): ApplyResult {
      const current = view.state.doc.toString();
      const result = applyPatch(current, patch, groupIds);
      if (!result.ok) return result;
      // Dispatch the individual changes (bottom-up, original-doc offsets) so
      // the ChangeDesc — and thus the revision entry — reflects real edits.
      const groups = patch.groups.filter((g) => !groupIds || groupIds.includes(g.id));
      const changes = groups
        .flatMap((g) => g.changes)
        .sort((a, b) => b.from - a.from)
        .map((c) => ({ from: c.from, to: c.to, insert: c.insert }));
      view.dispatch({ changes, annotations: [patchAnnotation.of(true)] });
      view.dispatch({ effects: setPatchHighlight.of(result.appliedRanges) });
      scheduleHighlightClear();
      const first = result.appliedRanges[0];
      if (first) {
        view.dispatch({ selection: { anchor: first.to } });
      }
      return result;
    },

    replaceLiteral(find: string, insert: string): boolean {
      const idx = view.state.doc.toString().indexOf(find);
      if (idx < 0) return false;
      view.dispatch({
        changes: { from: idx, to: idx + find.length, insert },
        selection: { anchor: idx + insert.length },
      });
      return true;
    },

    onRevisionEvent() {
      // Wired at construction; kept for interface symmetry.
    },

    focus() {
      view.focus();
    },
  };
  // Debug surface for the smoke test / manual poking (not part of the contract).
  (handle as unknown as Record<string, unknown>).__view = view;
  return handle;
}
