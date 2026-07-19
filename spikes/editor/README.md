# spikes/editor — Texeris Milestone 0: editor-comparison spike

Disposable prototype. Its only job is to let the developer **feel and compare**
two rendered-editing approaches over the same academic Markdown material, then
choose one for the real app. Code here is throwaway: readable, but not hardened.

**Outcome (2026-07-19): Tiptap chosen** — recorded as decision D0 in
`docs/implementation-plan.md` §5. This spike is kept for reference; the real
editor is ported (not imported) per the plan, with the D0 feedback on patch
visuals and citation styling applied.

## What it is deciding

Texeris' canonical document format is Pandoc-oriented Markdown. Two candidate
editing architectures:

- **Tab A · CodeMirror 6** — the Markdown text *is* the editor state. Rendered
  mode is a decoration layer over the text (hide syntax away from the cursor,
  citation pills, styled tables). Raw mode is the same state with decorations
  switched off.
- **Tab B · Tiptap (ProseMirror)** — a structured document. Markdown is parsed
  into the PM doc on load and serialized back out; the Markdown is a derived
  view, not the state.

Questions to answer by playing with it: which editing feel do we want, how lossy
is the Tiptap round trip in practice, and how does revision capture differ when
the state is text vs a node tree.

## Run

```bash
pnpm install
pnpm --filter @texeris/spike-editor dev
```

Tests / build / interaction smoke test:

```bash
pnpm --filter @texeris/spike-editor test     # vitest, 24 tests
pnpm --filter @texeris/spike-editor build    # tsc --noEmit && vite build

pnpm --filter @texeris/spike-editor dev --port 5199 --strictPort &
node spikes/editor/scripts/smoke.mjs         # headless-chromium CDP smoke, 13 steps
```

## What's in the UI

- Two tabs (CodeMirror / Tiptap) over identical starting content; a sample
  switcher (main-sample.md ≈ 1200 words with the full supported profile, plus
  an adversarial edge-sample.md).
- Per tab: Rendered/Raw toggle, round-trip checker with badge + diff view,
  four sample patches (A–D) plus a partial-accept variant and a conflict demo,
  and a revision side panel.
- A collapsible **evaluation checklist** (bottom of the page) — the manual
  tests this spike exists for: cursor movement near hidden syntax, selection +
  deletion across a citation chip, copy/paste of rendered text, IME/dead-key
  composition, table editing, footnote navigation, repeated mode switching,
  partial patch acceptance.

## Supported Markdown profile (all that must round-trip)

ATX headings, emphasis/strong, ordered/unordered lists, blockquotes, links
(with titles), pipe tables, footnotes (`[^x]` refs + definitions with
continuation paragraphs), Pandoc citations (`[@a]`, `[-@a, p. 1]`,
`[@a; @b, ch. 2]`), paragraphs, code spans. Anything else degrades to literal
text or is dropped.

## Implementation notes

### Pure logic (`src/lib/`, DOM-free, unit-tested)

- `citations.ts` — hand parser for the five citation marker forms;
  deterministic serializer; pill labels (`smith2024` → `Smith 2024`).
- `markdown-in.ts` — remark (mdast + GFM) → ProseMirror doc JSON. Citations
  are split out of text nodes into `citation` atom nodes; footnote refs/defs
  become `footnoteRef`/`footnoteDef` nodes; tables map to Tiptap tables.
- `markdown-out.ts` — PM doc JSON → canonical Markdown, written to be a fixed
  point: `markdownOut(markdownIn(x)) === x` exactly when `x` is already
  canonical. **Both samples round-trip byte-for-byte** (enforced by tests,
  including validation through the real Tiptap schema).
- `patch.ts` — `validatePatch` (base revision + expectedText + context checks)
  and `applyPatch` (atomic; structured conflicts; partial group acceptance).
  Sample patches resolve their offsets against the shipped sample at module
  load, so a broken anchor fails loudly.
- `revisions.ts` — revision grouper: new group after 1000 ms idle, on paste,
  on a >1-line jump between consecutive changes, on patch application.
- `diff.ts` — tiny LCS line diff for the round-trip checker and the Tiptap
  revision capture.

### CodeMirror: how rendered mode reveals syntax near the cursor

A `ViewPlugin` rebuilds a `DecorationSet` on every doc/selection change from
two sources: the lezer syntax tree (headings, emphasis, code spans, inline
links, tables, blockquotes) and a per-line regex pass (citations, footnote
refs/defs — lezer doesn't know them). Constructs intersecting the selection
are skipped, so markers reappear exactly where the cursor is. Heading `#`s,
emphasis `*`s and link destinations are hidden with `Decoration.replace`;
citations become pill widgets (`Smith 2024`, raw marker in the tooltip);
footnote refs become superscript widgets; footnote definitions get a muted
line style. Raw mode is a **Compartment** reconfigured to drop the plugin —
same state, same undo history, no revision entry (reconfigure transactions
don't touch the doc). Shortcut-reference `Link` nodes (which is what lezer
thinks `[@citation]` and `[^footnote]` are) are deliberately left to the line
pass.

### Tiptap: round trip and where normalization can appear

Load: `markdownIn` → PM doc. Serialize on demand: `markdownOut(getJSON())`.
The canonical form is whatever the serializer emits; the round-trip badge
compares the current canonical text against one parse→serialize cycle and
shows a compact diff on mismatch. Sources of normalization found while
building this:

- **v3 StarterKit's `trailingNode` extension** appends empty paragraphs at the
  doc end (it fired on the first focus transaction) — disabled in
  `src/tiptap/nodes.ts`; leaving it on silently corrupts the canonical text.
- Non-canonical source formatting (blank-line counts, table separator widths,
  alignment colons, reference-style links, `1)` list markers, `_underscore_
  emphasis, citation item separators other than `; `) is normalized on the
  first round trip. The samples are written in canonical form; type something
  non-canonical in raw mode and the badge shows the diff — that is the feature.
- Citation *spans* survive exactly (items stored as node attrs, serialized
  deterministically); locators are kept verbatim.

### Revision capture: CM ChangeDesc vs Tiptap snapshot diff

- CM: `updateListener` + `ChangeDesc` give exact inserted/deleted counts and
  the first-change range — cheap and precise.
- Tiptap: PM steps don't map to Markdown ranges, so every `update`
  re-serializes the doc and line-diffs against the previous snapshot; counts
  come from the diff. Fine at spike scale (≈ 80 lines), but it's O(doc) per
  keystroke and the "changed line" is diff-derived, not step-derived — a real
  finding for the architecture decision. Patch applications bypass this and
  emit their entry from the patch diff directly.
- Mode switches and programmatic reloads are annotated/suppressed so they
  never create revision entries.

### Patches

`validatePatch(text, patch, currentRevisionId)` checks the base revision id
and expectedText; `applyPatch` is atomic — any mismatch returns a structured
conflict and leaves the text untouched (the ⚠ conflict demo button races a
local edit against patch A and shows `conflict: expected text not found`).
UI behavior on base-revision mismatch with still-valid expectedText: applies
and shows an "auto-rebase" notice — expectedText is the hard guard, the base
id is the concurrency hint. Applied ranges get a ~3 s highlight (CM: real
ranges from the ChangeDesc; Tiptap: approximate — inserted snippet is searched
in the re-parsed doc).

## Known limitations

- **CM table rendering**: pipe tables stay monospace text with styled pipe
  "column guides" and a delimiter-row style — no genuine table grid. This is
  *the* CM limitation to weigh in the evaluation (Tiptap renders a real,
  editable table).
- Tiptap patch highlight/selection restore after reparse is approximate
  (first text node containing the inserted snippet); pure deletions get no
  highlight there (CM highlights via real ranges; deletion ranges are empty
  and likewise get none).
- Reference-style links/images and anything outside the profile are not
  rendered specially (shown raw / dropped on the Tiptap round trip).
- "Selection jump > 1 line" is approximated by the distance between
  consecutive change locations, not actual selection tracking.
- CM virtualizes: only viewport lines are in the DOM (relevant when counting
  widgets in tests).
- No persistence; checklist state is not saved. `window.__texeris` and
  `handle.__view` are debug handles for the smoke test and manual poking.

## Dependency versions (resolved)

- `@codemirror/state` 6.7.1, `@codemirror/view` 6.43.6, `@codemirror/language` 6.12.4,
  `@codemirror/commands` 6.10.4, `@codemirror/lang-markdown` 6.5.1
- `@tiptap/core` / `@tiptap/starter-kit` / `@tiptap/extension-table` / `@tiptap/pm` 3.28.0
- `unified` 11.0.5, `remark-parse` 11.0.0, `remark-gfm` 4.0.1
- dev: `typescript` 7.0.2, `vite` 8.1.5, `vitest` 4.1.10, `@types/mdast` 4.0.4

## Layout

```
spikes/editor/
  package.json  tsconfig.json  vite.config.ts  index.html  README.md
  scripts/smoke.mjs          (headless interaction smoke test)
  src/main.ts  styles.css
  src/lib/{patch,revisions,diff,citations,footnotes,markdown-in,markdown-out}.ts
  src/lib/*.test.ts          (roundtrip, patch, citations)
  src/samples/{main-sample,edge-sample}.md
  src/patches/samples.ts
  src/cm/editor.ts           (live-render decorations, raw compartment, revision hookup)
  src/cm/editor.test.ts      (decoration-build smoke test)
  src/tiptap/{editor,nodes}.ts
  src/ui/{tabs,panels,checklist,handle}.ts
```
