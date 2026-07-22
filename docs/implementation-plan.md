# Texeris — Implementation Plan: Milestone 1

**Status:** Draft. Decision D0 recorded 2026-07-19 (§5): **Tiptap / PM
variant.** CM-variant notes remain for context only.
**Feeds into:** Milestones 2–3 sketched in §16.

---

## 1. Purpose

This plan turns the product spec's "minimum coherent release" and the
architecture note's Milestone 1 into an ordered, testable build sequence. It
records the ten "first technical decisions" from architecture §29, fixes the
boundaries that are expensive to change, and defers everything the spike or
real use should decide.

Milestone 1 contents (architecture §26): Electron shell · editor behind an
adapter · local persistence · revisions and checkpoints · chat panel ·
Fast/Deep models · selection/document context · patch proposal and review.

## 2. What Milestone 1 must prove

The product thesis (product spec §23): *a revision-aware AI collaborator
inside a serious text editor is materially better than a conventional editor
plus a separate chat window.* Success signals (spec §19.1): the user writes
real work in it voluntarily; patch review beats copy/paste; no text loss;
context is understandable; accept/reject behaviour visibly improves later
turns.

Everything in this plan is ordered so that the loop
*write → ask → propose patch → review → recorded history*
works end-to-end as early as possible, then hardens.

## 3. Scope

**In:** one project at a time (folder-based); one main manuscript plus extra
Markdown files; rendered + raw editing; autosave; revision history;
checkpoints; one conversation per project; selection/section/document
context; Fast/Deep chat; structured patch proposals with per-group
accept/reject; agent awareness of user edits between turns.

**Out (M2/M3):** skills registry and the skill catalogue, style profile,
writing archive, citations/references, export, semantic search, multiple
conversations, agent jobs beyond single turns. §16 notes the seams left for
them.

## 4. Recorded first decisions (architecture §29)

| # | Decision | Resolution |
|---|----------|------------|
| 1 | Canonical data | **File-centric hybrid** (owner decision 2026-07-18): Markdown files canonical; SQLite holds revisions, conversations, patches, indexes. |
| 2 | Revision unit for patches | A **committed change group** = one revision: monotonically increasing integer per document + content hash. Agent patches declare the revision id of the text they were generated against. |
| 3 | Minimum patch schema | Architecture §11.2 as implemented in the spike (`TextChange{from,to,expectedText,insert,prefixContext?,suffixContext?}` inside ordered `PatchGroup`s). **2026-07-19:** `from`/`to` now optional — the app resolves anchors from `expectedText` (+ context); LLMs count offsets poorly. |
| 4 | Agent tools (v1) | §10.2 — six read/propose tools; no fs, no shell, no web. |
| 5 | Supported Markdown profile | Architecture §17.1 minus YAML metadata: ATX headings, emphasis/strong, lists, blockquotes, links, code spans/blocks, pipe tables, footnotes, Pandoc citations. Same profile as the spike. |
| 6 | Model credentials | Development: `MOONSHOT_API_KEY` / `DEEPSEEK_API_KEY` env vars as fallback; **primary: settings UI storing keys via Electron `safeStorage`** (gnome-keyring on the dev box; landed 2026-07-19 with the settings panel). Linux needs `--password-store=gnome-libsecret` under Hyprland (auto-detect fails). Never in project files. |
| 7 | Pandoc | **2026-07-21:** configured system Pandoc remains a development convenience; Linux release builds download, checksum-verify, and bundle pinned Pandoc 3.10 for corpus conversion. |
| 8 | Project identity | `project.json` with `formatVersion`, `projectId` (uuid), `mainDocument`. Documents addressed by uuid in DB, looked up by relative path on open; renames reconcile path→uuid, never re-id. |
| 9 | Workspace vs project data | Workspace: platform config dir (`~/.config/texeris`, `~/Library/Application Support/texeris`) — `config.json` (model modes), later style profile + archive index. Project: user folder with `.texeris/` (history DB, cache). |
| 10 | Recoverable autosave | Every revision commit triggers atomic file write (tmp + rename). DB keeps change records + periodic snapshots. Startup reconciles hash mismatches; incomplete tmp writes are cleaned, never silently chosen. |

## 5. Decision D0: editor — resolved: **Tiptap (ProseMirror)**

Evaluated by the owner against the spike checklist on 2026-07-19. CM6's
live-render mode still felt like editing source — most visibly, pipe tables
never become real tables — while Tiptap's rendered mode felt like a document
editor. The round-trip boundary is accepted and guarded (§13 PM variant,
§17). Spike answers recorded: live render survives the full Markdown profile
(both samples round-trip byte-for-byte, enforced by tests), and Tiptap
normalization only bites on non-canonical source formatting (cases
enumerated in the spike README).

Owner feedback from the evaluation, binding for M1:

- Patch proposals were hard to evaluate in the spike: PatchReview must make
  *what changes where* visually obvious — per-group in-editor indication of
  the affected ranges, not only text cards — and an accepted patch must be
  reversible (it commits as its own revision, so undo = restore-as-new-
  revision, §8). Feeds §12 and WP4's DoD.
- Citations in rendered mode should stay close to normal text: inline,
  text-like, editable, distinguished by subtle color/background tint — not
  opaque pill widgets. Feeds §16 (M3 seam).

## 6. Application shape

Repo: add `app/` workspace member (`@texeris/app`), electron-vite + React +
TypeScript strict. `spikes/` stays disposable; nothing imports from it —
adapter interfaces may be *copied* from spike code that proves itself.

```text
app/
  electron.vite.config.ts
  src/
    main/            # Node/Electron main process
      index.ts       # lifecycle, windows
      services/      # project, document, revision, checkpoint,
                     # conversation, patch, agent, settings
      db/            # sqlite layer + migrations
      ipc/           # typed channel handlers + payload validation
    preload/         # contextBridge, narrow API surface
    renderer/        # React UI (no Node access)
      components/    # ProjectNav, EditorRegion, ConversationPanel,
                     # PatchReview, HistoryPanel, StatusBar
      stores/        # small local stores + query cache
    shared/          # types + IPC contract shared by both sides
      ipc-contract.ts
      domain-types.ts
```

Process model: renderer is unprivileged UI (sandbox, contextIsolation). Main
owns fs/db/credentials. The Pi adapter runs **in-process in main** for M1
(architecture §12.1 suggested progression), but the `AgentRuntime` interface
is message-shaped so moving it to a `utilityProcess` later is mechanical.
Electron version: newest stable whose bundled Node ≥ 22.19 (Pi requirement);
assert `process.version` at startup and fail loudly.

Validation: TypeBox schemas for IPC payloads and tool parameters (Pi already
depends on TypeBox; one validation library throughout).

## 7. Data model

### 7.1 Project folder

```text
my-paper/
  manuscript.md
  notes.md
  project-instructions.md      # always-on context, small
  .texeris/
    project.json               # formatVersion, projectId, mainDocument
    history.sqlite             # tables below
    cache/                     # rebuildable derived data
```

### 7.2 SQLite schema v1 (`history.sqlite`)

```text
meta(key, value)                          -- schema version (PRAGMA user_version)
documents(id uuid PK, path UNIQUE, title, created_at, current_revision, content_hash)
revisions(document_id, seq, parent_seq, actor, source_json, created_at,
          summary, content_hash, snapshot_text NULL,
          PRIMARY KEY(document_id, seq))
revision_changes(document_id, seq, idx, from_off, to_off, deleted_text, inserted_text,
          PRIMARY KEY(document_id, seq, idx))
checkpoints(id uuid PK, document_id, revision_seq, name, created_at, snapshot_text)
conversations(id uuid PK, title, created_at)
messages(id uuid PK, conversation_id, seq, role, payload_json, created_at)
agent_runs(id uuid PK, conversation_id, model_mode, provider, model,
           status, started_at, ended_at, usage_json, context_manifest_json, error_json)
patches(id uuid PK, document_id, base_revision, origin_json, title, summary,
        status, created_at, resolved_at)      -- status: proposed|accepted|partial|rejected|conflict
patch_groups(id uuid PK, patch_id, idx, explanation, status)  -- per-group accept/reject
patch_changes(id uuid PK, group_id, idx, from_off, to_off,
              expected_text, insert_text, prefix_context, suffix_context)
settings(key, value)
```

Snapshots: full text on every checkpoint and every 25th revision; any state
reconstructs from nearest snapshot + replayed `revision_changes`. Simple,
bounded, and compaction of old typing revisions stays possible later.
Migrations: `PRAGMA user_version` + ordered migration functions; v1 ships
with migration 0001 only.

### 7.3 Actors and sources

`actor ∈ user | agent | external | system`. `source_json` links a revision to
`{conversationId, agentRunId, patchId, skillId?}` — the audit trail that later
feeds style learning and product signals (spec §18.1).

## 8. Revision engine (main process)

Grouping rules v1 (from spike, tuned after first real use 2026-07-19): new
revision on — **5 s** idle after last change (was 1 s; a typing burst is one
revision) · paste · caret jump (**>8 chars** between consecutive change
starts; was a >1-line rule until 2026-07-20 — line numbering near the
document end shifts by two per Enter, which broke groups every other
keystroke and made the save-state chip flap at several Hz) ·
applied patch · mode switch does **not** create one · restore/checkpoint
does.

Revision coalescing (owner decision 2026-07-20, option 2 of the revision
spam discussion): renderer flushes land as often as the rules above say,
but in main a user-typing commit **amends the tip revision** instead of
appending when the tip is user/typing on the same document and younger
than 15 min — one revision per sitting, not per burst. The tip stays
immutable when it is checkpointed or the base of an unresolved patch
(status proposed/partial/conflict: the agent's expectedText validation
must never see its base move). Amending appends to the tip's change list
and refreshes its snapshot when present, so replay stays exact. The
agent's between-turns diff (`summarizeChangesSince`) is anchored by
(revision, change count) via `manifest.baseChangeCount`, since the
revision number no longer moves under the agent between turns. (M2
candidate, kept in mind as option 4: fully decouple autosave-to-disk from
revision creation — semantic revisions only.)

Commit flow: renderer sends grouped text changes → validate against current
revision → apply to canonical text → atomic write → insert revision + change
records (+ snapshot when due) → ack with new seq. The editor never writes
files directly.

External changes: watch project files (mtime+size, then hash). If hash
differs from last known revision and no commit is in flight → import as
`actor: external` revision and reload the editor with a notice. If a commit
is in flight → keep both, show conflict UI (never overwrite external edits).

Restore/checkpoint: restore writes the old content as a **new** revision
(history is append-only); checkpoints are durable named snapshots, comparable
via diff.

## 9. Patch system

Same semantics as the spike, hardened:

1. Agent calls `propose_patch` with `baseRevision` = revision it read.
2. Validate: base exists; every `expectedText` matches at offsets; groups
   don't overlap. Failure → structured conflict returned to the agent (it may
   re-read and regenerate).
3. Store as `proposed`; emit `patch.proposed` event; review UI opens.
4. User accepts all / per-group / rejects (edit-before-accept: post-M1).
5. Apply chosen groups in one transaction → agent-actor revision linked to
   the patch; record outcome (accepted / partial / rejected / later modified).

Rebase policy v1 (architecture §11.5): exact base → apply; document moved
but target spans unchanged (hash of span + context still matches) → auto-
rebase with notice; otherwise `conflict` — ask the agent to regenerate. No
merge engine. Diff display: `diff` (jsdiff) word-level, generated for
display only, never authoritative.

## 10. Agent integration (Pi)

Per `docs/pi-integration-notes.md`. Pin `@earendil-works/pi-agent-core` +
`pi-ai` exact versions.

### 10.1 Adapter

```ts
interface AgentRuntime {
  startTurn(input: AgentTurnInput): Promise<{ runId: string }>;
  events(runId: string): AsyncIterable<AgentEvent>;   // normalized union
  cancel(runId: string): Promise<void>;
}
```

Wraps one `Agent` per conversation. Normalized events map Pi's
`agent_start/end`, `message_update(text_delta)`, `tool_execution_*` onto
architecture §12.3's union. Gotchas honoured: explicit `streamFn` bound to
our `Models` collection, explicit `model`, mid-run input via `steer()`,
abort via `agent.abort()`, fast non-blocking subscribers.

### 10.2 Tools v1 (all validated, all read-only except propose_patch)

```text
list_project_documents()                       → paths + titles + revision ids
read_document(documentId?)                     → full text + revision + outline
read_document_range(documentId?, heading)      → one section + revision
read_revision_changes(documentId?, sinceRevision) → compact change list/summary
read_project_instructions()                    → project-instructions.md
propose_patch(documentId, baseRevision, title, summary, groups)
                                               → { patchId } | { conflict }
```

`propose_patch` is the **only** write path. `beforeToolCall` hook reserved as
the approval gate for later broad-change jobs.

### 10.3 Models

```json
// ~/.config/texeris/config.json
{ "modes": {
    "fast": { "provider": "deepseek",   "model": "deepseek-v4-flash" },
    "deep": { "provider": "moonshotai", "model": "kimi-k3" } } }
```

(`kimi-k3` confirmed as the Moonshot flagship on 2026-07-19: 2.8T MoE,
1M-token context, $3/$15 per M tokens.)

One `Models` collection registering only `deepseekProvider()` +
`moonshotaiProvider()` (lazy SDK loading keeps the rest out). Keys from env
in dev. `agent_runs` records provider/model/usage/duration per run (spec
§13.2 signal collection).

### 10.4 Conversations

Persisted in SQLite as UI messages; Pi `AgentMessage` JSON stored verbatim
(provider fields preserved for replay). One conversation per project in M1.
Re-inject history via `agent.state.messages` on restart.

## 11. Context assembly v1

Scopes: **selection · section · document** (+ project instructions always,
it's small). Section = heading-delimited slice, computed in main with
remark/mdast (only heading structure needed; footnote/citation nodes ride
along as raw text).

Every run stores a **context manifest**: item list, char counts, base
revision, truncation notices. Truncation v1: if the document exceeds the
model budget — selection/section verbatim + full heading outline + explicit
notice; UI shows when summarisation occurred (spec §11.5). Between turns the
agent gets a **compact change summary since the last revision it saw**
(previous run's manifest `baseRevision` → current), injected into the system
prompt (`<recent-changes>`), plus "no changes" when nothing moved —
implemented 2026-07-19. Rationale (owner feedback): edit groups and
agent-facing diffs are separate concerns — user edits are stored
fine-grained for history/undo (every group restorable); the agent only ever
receives the diff since its last turn, so context stays small and on-task.

## 12. UI plan

Three regions (spec §9), editor is the visual centre:

- **ProjectNav:** file list, heading outline (click → scroll), checkpoints.
- **EditorRegion:** rendered mode default; raw toggle; patch highlights;
  status bar with revision seq, save state, actor of last change.
- **ConversationPanel:** messages with streaming; **context indicator chip**
  (scope selector: selection/section/document — visible at all times);
  Fast/Deep toggle; proposed patches appear as cards → open PatchReview.
- **PatchReview:** summary, per-group word diffs with explanations,
  accept/reject per group + accept-all; conflict state when rebased/failed.
  Selecting a group highlights the affected ranges in the editor — what
  changes where must be visually obvious (D0 feedback) — and an accepted
  patch offers one-click undo (restore-as-new-revision).
- **HistoryPanel:** revision timeline (actor badges, summaries, patch
  linkage), restore button, checkpoint naming.

State: TanStack Query over IPC data + small zustand stores for panel/UI
state. No other state framework.

## 13. Editor adapter

The rest of the app consumes only this (architecture §6.2 requirement):

```ts
interface EditorAdapter {
  getCanonicalText(): string;
  getSelection(): TextRange | null;
  setSelection(range: TextRange): void;
  applyTextChanges(changes: TextChange[], meta: ChangeMeta): void;
  onGroupedChanges(cb: (group: TextChangeGroup) => void): Unsubscribe;
  getHeadings(): HeadingInfo[];
  setHighlights(ranges: HighlightRange[]): void;   // patches, findings
  focusRange(range: TextRange): void;
  // rendered/raw mode is adapter-internal; canonical text is always exposed
}
```

**CM variant (not chosen — D0):** `onGroupedChanges` maps transactions →
text offsets directly; `applyTextChanges` = `dispatch`; raw mode = same
state, decoration compartment off. Revision capture is lossless.

**PM variant (chosen — D0):** grouped commit = serialize → diff against last
snapshot to derive text changes (approximation — flagged in spike README);
`applyTextChanges` = serialize → apply → reparse → remap selection
approximately; raw mode = separate CM instance; **normalization guard**: the
round-trip checker becomes a CI test over the golden sample docs, plus a
warn-on-mode-switch badge when `serialize(parse(x)) ≠ x`.

## 14. Build sequence

Dependencies flow downward; each WP has a definition of done (DoD).

**WP0 — App skeleton.** `app/` electron-vite project, React, TS strict,
preload bridge + one round-trip IPC with validation, vitest wired.
*DoD:* empty window from `pnpm dev`; `pnpm typecheck && pnpm test` green.
**Done 2026-07-19** — Electron 43 (bundled Node 24.18), sandbox +
contextIsolation on; DoD verified: window from `pnpm dev`, typecheck clean,
3 tests green, IPC round trip logged from the renderer.

**WP1 — Storage & domain core (headless).** SQLite layer + migration 0001,
project service (create/open/format version), document service (atomic
write), revision engine (§8), checkpoint service. Pure Node tests.
*DoD:* unit tests green — grouping, atomic write, snapshot replay,
external-change import, restore-as-new-revision.
**Done 2026-07-19** — 32 tests green covering every DoD item. Uses Node's
built-in `node:sqlite` (Electron 43 bundles Node 24.18): no native modules,
no ABI rebuilds. Startup reconcile (openProject) cleans orphan tmp files
and imports offline edits as external revisions.

**WP2 — Editor integration.** Editor adapter + D0 winner (ported from spike,
not imported), rendered + raw modes, commit-on-group over IPC, outline,
autosave path. *DoD:* type → restart app → content + full revision history
intact; mode switch creates no revision.
**Done 2026-07-19** — Tiptap rendered + CM6 raw sessions over one canonical
text (`renderer/editor/session.ts`); both derive minimal splices per update
and group them with the §8 rules (idle flush 1 s). Spike round-trip code
ported (byte-exact on golden samples, CI-enforced); citations now render
text-like tinted (D0 feedback). Main watches the file and imports external
edits; editor reloads. `app/scripts/smoke-editor.mjs` (8 CDP steps) green:
typing commits in both modes, mode switch creates no revision, content +
history survive restart, and raw mode keeps the native caret hidden while
CodeMirror draws its own. Selection scope is live for chat (approximate
PM→text offset mapping, as planned).

**WP3 — Chat & agent.** Pi adapter (§10), Fast/Deep config + env keys,
conversation persistence, streaming to renderer, context assembly (§11)
with manifest, cancel. *DoD:* question about a selection streams an answer;
conversation + manifest survive restart; cancel stops mid-stream.
**Done 2026-07-19 (adapted)** — built ahead of WP2; selection scope is a
wired seam in context assembly (`assembleContext` already slices ranges),
so the selection-question DoD verifies in WP2. Everything else verified:
Pi pinned at exact 0.80.10; offline faux provider
(`TEXERIS_FAUX_PROVIDER=1`) drives the full loop; `app/scripts/smoke.mjs`
(9 CDP steps against the real app) green — streaming, manifest, cancel,
restart survival of conversation + manifest. Live-provider smoke pending
API keys.

**WP4 — Patch pipeline.** `propose_patch` tool → validation → storage →
review UI (per-group) → application → outcome records → conflict path.
*DoD:* e2e — ask for a rewrite, partially accept, history shows linked
agent revision; stale-base patch fails safely with visible conflict.
**Done 2026-07-19** — `PatchService` (validate against current text,
auto-rebase on intact anchors, partial acceptance shifts remaining spans),
review UI with per-group word diffs + in-editor range highlights +
one-click undo (restore-as-new-revision). `app/scripts/smoke-patch.mjs`
(offline, scripted) green. Live DeepSeek smoke (`smoke-live.mjs`) green —
the model exercised the conflict→re-read→regenerate loop (5 propose calls)
and landed a clean patch.

**WP5 — Hardening & packaging.** Crash recovery, external-change UI, model
failure retry (context preserved), usage record view, error surfaces,
renderer CSP, electron-builder artifacts for macOS + Linux. *DoD:* e2e suite
green; installable artifact on both platforms.
**Done 2026-07-19** — retry button re-issues a failed turn (verified against
the missing-API-key path); usage panel over `agent_runs`; external-change
conflict offers explicit reload (never silent loss); strict CSP in
production (stripped in dev by a vite transform); smoke suite
(`app/scripts/smoke-all.mjs`: chat, editor, patch, crash-recovery incl.
SIGKILL + orphan tmp + offline edit, error/retry) all green. Linux
AppImage (`app/dist/`) built and verified booting. **macOS artifact
configured (dmg+zip) but needs a Mac to build** — electron-builder cannot
cross-build dmg from Linux.

### First-use polish (2026-07-19, after the owner's first real run)

- `propose_patch` is **anchor-based**: offsets optional, the app resolves
  `expectedText` (+prefix/suffix context). LLMs count characters poorly.
- Chat: messages render as Markdown; reasoning in collapsed `<details>`;
  user echo is immediate; Retry + usage panel; settings panel with
  keychain-backed API keys (plan §4.6 landed early).
- Context: between turns the agent gets a compact `<recent-changes>` diff
  since the last revision it saw (§11), plus "no changes" when idle.
- Grouping tuned: idle window 1 s → 5 s (§8).
- Documents: switcher + new-document creation; `doc:*` channels take
  `documentId`; watcher covers all registered documents. Conversations:
  "new chat" starts a fresh conversation (old ones stay in storage).
- Rendered mode: formatting toolbar (bold/italic/strike/code, H1–H3,
  lists, blockquote, table, link, undo/redo) for Word-style workflows.
- Raw mode: CodeMirror is configured with a dark `EditorView.theme`, including
  an explicit light custom-cursor color. `drawSelection` owns cursor rendering;
  its transparent native caret must not be overridden by application CSS.
- Projects: first-run flow — picker with recents + open/create/switch
  (`ProjectManager` + native folder dialogs; dev harness now only via
  `TEXERIS_PROJECT_DIR`). History: HistoryPanel with the revision
  timeline (actor badges, summaries, patch linkage), restore, and
  checkpoint create/restore.

**Known remaining gaps (next in line):** chat scopes follow the main
document only (other documents are agent-readable via tools), and macOS
packaging needs a Mac.

---

## M1.5 — Daily-use ergonomics

**Complete 2026-07-21** — all seven packages (EU1–EU7) landed on `main`.

Approved 2026-07-20 (plan file `plans/…/psylocke-batgirl-groot.md`; codex's
12-item review + kimi's list reconciled). Fills the product-spec §11.1 gaps
("Search and replace", "Navigate by headings") before M2. Out of scope:
selection quick actions, ghost text, whole-project search, figures (M2+).

**EU1 — Layout rehaul + persistent workspace.** ✅ done 2026-07-20 (kimi).
Three-region plan §12 layout (ProjectNav | editor | side column) with
drag-resizable/collapsible regions and an always-visible activity rail
(files/assistant/focus toggles + settings); per-project UI state (pane
sizes, visibility, open doc, editor mode, per-doc cursor/scroll) as one
JSON blob in the `settings` table over `ui:get`/`ui:set`; focus mode; chat
copy buttons. Deviation from the original bullet: open-conversation
persistence dropped — `getOrCreateConversation` already restores the
latest conversation, and there is no picker to switch until EU3.
*DoD:* full workspace state survives relaunch; smokes green (incl. new
`smoke-ui.mjs`).

**EU2 — Find & replace + heading navigation.** ✅ done 2026-07-20 (kimi).
One custom search panel over BOTH editor modes (deviation from the plan
text's `@codemirror/search` for raw — a single UX, no new dependency):
case toggle, next/prev (Enter/Shift+Enter), replace one/all; replacements
are ordinary editor transactions, so they commit through the normal path.
Session search API in `editor/session.ts` (PM text-node scan + CM exact
offsets); match + current-match decorations in both modes. Ctrl/Cmd+F or
the status-bar Find button opens it. ProjectNav shows the open document's
heading outline with click-to-scroll (selects the heading text, focuses
the editor — synchronously, since Tiptap's focus command defers into a
rAF that never fires in hidden/smoke windows). Outline refetches on doc
switch and after commits (debounced via EditorRegion's onRevisionChange).
*DoD:* `smoke-find.mjs`: search → cycle → replace one; outline click
selects/reveals the heading.

Follow-ups (2026-07-20, owner feedback): the find panel docks at the
bottom and toggles from the status-bar Find button (the pattern for all
document panels: bottom-docked, status-bar toggle, active state).
Ctrl/Cmd+Z / Ctrl+Shift+Z / Ctrl+Y are forwarded to the editor's undo
while the panel has focus (text inputs keep native undo). Known
limitation: editor-local undo history is per session — mode or document
switches recreate the session and lose it (PM history state is not
serializable; carrying it across sessions is a separate project).

**EU3 — Document & conversation management.** ✅ done 2026-07-20 (kimi).
Documents (all id-addressed, ids never change): rename (moves the file,
updates project.json when it's the main doc), trash (file →
`.texeris/trash/<id>.md`, row + revision history kept under a new
`trashed_at` column — migration 0002 — so EU7 can restore; the main doc
cannot be trashed; watcher/reconciliation/list skip trashed), duplicate
(`<name> copy.md` + own history), import `.md` via file dialog (conflict
→ numbered), set-main (project.json), reveal in file manager
(`shell.showItemInFolder`). Nav rows get a hover ⋯ menu; rename and
delete are inline in the row (no native dialogs). Conversations: picker
in the chat header (switch/rename/delete with inline confirms),
auto-title from the first user message, active conversation persisted in
ui state (`openConversationId`, used at last). Deleting cascades
messages + runs.
*DoD:* unit tests incl. trash (13 docs + 7 conversation cases);
`smoke-eu3.mjs`: rename doc through the menu, set-main, duplicate,
trash, rename a conversation and reopen it after starting a new one.

**EU4 — Proofreading & statistics.** ✅ done 2026-07-21 (kimi), with the
spellcheck underline descoped to the post-M1.5 backlog (item 2, app-level
checker). Electron
spellcheck (`session.defaultSession`) with an enable toggle + language
picker in Settings; the preference lives in the workspace `config.json`
(`spellcheck: {enabled, language}`) and applies at boot and on change.
Native Chromium underlines are unreliable in rendered mode and cannot remain
stable in raw CodeMirror mode: CM redraws text nodes and destroys the native
marker (confirmed by a brief underline flash during a real-key test).
Raw mode therefore needs an application-level checker with CM decorations.
Native right-click suggestions and Add to Dictionary are available whenever
Chromium reports a misspelling, but do not solve the unreliable-underline gap.
Word count + selection count (words/chars) in the editor status bar,
polled at 500 ms; Markdown syntax tokens don't count as words.
*DoD:* `smoke-eu4.mjs`: live count while typing, select-all selection
count, spellcheck setting round-trips over IPC and persists. (The wavy
underline itself is descoped — native Chromium spellcheck is unreliable
here, so it defaults OFF; the app-level checker is backlog item 2.
See `spellcheck-notes.md`.)

**EU5 — Keyboard UX.** ✅ done 2026-07-21 (kimi). Shared command
definitions in `shared/commands.ts` feed three surfaces that cannot
drift: the Electron app menu (File/Edit/View/Chat/Help + quit;
accelerators fire with the menu bar hidden), the Ctrl+K command palette
(token filter, arrows/Enter/Esc), and the shortcuts overlay (Ctrl+/).
Menu clicks forward the command id to the renderer's registry
(`texeris:menu-command`); the registry drives panels via AppShell and
the editor/chat via bridge command surfaces (`registerEditorCommands`,
`registerChatCommands`). Undo/redo deliberately have no menu accelerator
(the editors own Ctrl+Z natively); Ctrl+K also works via a renderer
fallback for environments where menu accelerators don't fire.
*DoD:* `smoke-eu5.mjs`: palette opens, filter narrows, commands run
(find panel, focus mode, mode toggle).

**EU6 — Structural editing + surface preferences.** ✅ done 2026-07-21
(kimi). Toolbar gains table row/col add+delete (visible inside tables),
footnote insert (next numeric label, ref at cursor + definition block at
doc end, cursor lands in the definition), and link edit (prefills the
existing href). Appearance prefs in Settings — theme (dark/light/system,
system follows `prefers-color-scheme` live), editor font (serif/sans/
mono), font size, editor width (comfortable/wide/full) — persisted as
`appearance` in the workspace `config.json`; changes broadcast over
`settings:appearance-changed` and apply as CSS vars/`data-theme` on the
document root, so they repaint without reload. Light theme is a full
second palette; straggler hard-coded colors are var-parametrized.
*DoD:* `smoke-eu6.mjs`: table ops round-trip to Markdown, footnote ref +
definition commit, theme/font/width repaint live and persist across
reload.

Follow-up (2026-07-21, owner feedback): footnotes are MANAGED, not just
inserted — a renumber plugin (`editor/tiptap/footnote-renumber.ts`)
keeps labels in document order after every footnote-affecting
transaction: inserting before an existing footnote renumbers everything,
deleting a ref heals the numbering, and definition blocks are physically
re-sorted to match the numbering (anchored at the first def). Insert uses transient unique labels
(max+1) and puts ref + def out in ONE PM transaction (the plugin must
run after both exist, or the def attaches to a stale label — caught by
`smoke-eu6`). Orphaned definitions keep their content (never silent
data loss; deleting the last ref leaves all defs untouched so cut →
paste restores cleanly). Unit tests in `footnote-renumber.test.ts`.

**EU7 — Recovery & onboarding.** ✅ done 2026-07-21 (kimi). Trash dialog
(nav header icon, overlay pattern like settings/shortcuts, Esc closes)
lists trashed documents from `documents WHERE trashed_at IS NOT NULL` with
restore and permanent delete. Restore moves the file back from
`.texeris/trash/<id>.md` under the same id with history intact (falls back
to "<name> (restored).md" when the path was taken) and opens it; permanent
delete removes row + revisions + checkpoints + patches (FK children first,
one transaction) and the trash file. `welcome.md` is seeded as rev 1 in
`createProject` (`services/welcome.ts`; an existing file is registered,
never overwritten) and `ui.state.openDocumentId` points new projects at
it; the dev harness re-points at the manuscript so smokes are unaffected.
Three latent issues fixed along the way: `createDocument` now refuses a
path owned by a trashed row (UNIQUE path would entangle the new file with
the trashed history), the agent's `list_project_documents` filters
trashed docs, and AppShell's beforeunload ui-state flush no longer fires
on project-switch reloads (`PROJECT_SWITCH_FLAG` in sessionStorage) — it
used to write the outgoing project's blob into the incoming project's db.
*DoD:* `smoke-eu7.mjs`: trash → restore (reopens, trash empty) → trash →
permanent delete; a freshly created project opens on welcome.md.

**Image authoring.** ✅ done 2026-07-22 (codex). Paste and drag/drop work in
both rendered and raw editor modes through a typed, main-process-owned asset
ingest path (PNG/JPEG/GIF/WebP/AVIF, 20 MB limit, content-hash deduplication).
Rendered image selection exposes alt-text and optional-caption fields; the
existing Markdown/controlled-HTML bridge and `texeris-asset:` protocol keep
the canonical reference portable and the preview sandboxed. Revision-time and
startup reconciliation removes true orphans while hiding files used only by
older revisions in `.texeris/asset-trash/`; revision/document restore brings
them back, and permanent document deletion prunes them. Unit tests cover
ingest, deduplication, validation, orphan cleanup, revision recovery, and
document trash/restore.
`smoke-editor.mjs` also pastes a real PNG, edits its alt text/caption, and
verifies the canonical figure and rendered image survive restart.

**Native context menus.** ✅ done 2026-07-22 (codex). A typed renderer/main
handshake describes the element under a real right-click while Electron owns
the platform menu and privileged edit, spelling, link, and image-copy actions.
Renderer-routed actions cover editor history and image details/deletion,
document open/rename/duplicate/reveal/set-main/trash, conversation
open/rename/delete, and message copy. Document and conversation ellipsis
buttons open the same native menu definitions. Main-process unit tests cover
menu policy and action routing; `smoke-eu5.mjs` verifies both a real editor
right-click and a document launcher produce the expected native labels.

**PDF import/export.** ✅ done 2026-07-22 (codex). Text-bearing PDFs import as
revisioned editable Markdown or page-marked corpus derivatives through the
shared pinned `unpdf` extractor; scanned/image-only files explain that OCR is
not available. PDF is now the default export, using sanitized Pandoc HTML and
an isolated Electron `printToPDF` renderer for a fixed A4 academic layout.
Size/page limits, atomic output, focused extraction/sanitization tests, and a
real Electron export→import smoke cover the boundary. OCR, a PDF viewer,
annotations, layout reconstruction, templates, and export options stay out of
this increment.

### Post-M1.5 backlog (owner review 2026-07-21, ranked)

1. **App-level spellchecker**: native is unreliable (PR #2); codex's
   nspell + dictionary-en design (~0.6 MB) is the seed; needs a
   dictionary-distribution decision for the language picker.
2. **Citations UI** (M2 core): CSL JSON library per project, insert-
   citation picker with search, bibliography rendering.
5. **Math (KaTeX)**: inline/block render + Markdown round trip.
6. **Section manipulation**: outline fold + move-section up/down.
7. **Undo story beyond per-session**: designed answer (revision-based),
   mode/doc switches currently wipe editor undo history.
8. **More UI themes** (owner: not important now).
9. **Split view** (two documents side by side) — later.
10. **Context-menu AI shortcuts** — intentionally deferred until real writing
    sessions reveal a small set of repeated, context-sensitive actions that are
    genuinely faster from a right-click menu. Avoid adding generic AI commands
    merely to fill the surface; promote workflows here only after their utility
    is clear.

Execution order: EU1 → EU7, one commit per package. Coordination:
`agent:kimi` / `agent:codex` issues per package (codex picks what it
wants; notes on the board).

## 15. Testing plan

- **Unit (vitest, node env):** revision grouping/replay, patch
  validate/apply/rebase, citation-span parser, section slicing, context
  truncation, migration.
- **Integration (main process, tmp dirs):** commit→file→DB consistency,
  crash-recovery simulation, external edit import, patch lifecycle.
- **E2E (Playwright Electron), the five critical flows from architecture
  §23.3** minus citations/archive (M3): edit-restart-verify · rewrite +
  partial accept · modify accepted patch → history classification · (M3
  flows deferred).
- **Model-dependent evals:** none in M1 (arrive with skills in M2); smoke
  script for Fast/Deep connectivity only.

## 16. Path beyond M1 (seams, not work)

- **M2 (skills, style profile):** skill registry reads `skill.json`
  metadata; skills reuse v1 tools + a `create_report` tool; style profile =
  a workspace/project Markdown file injected by context assembly; outcome
  records from §9 already capture the accept/modify/reject signal.
- **M3 (archive, citations, export):** FTS5 table + import pipeline in the
  same DB; `references` table + citation rendering behind editor decorations
  — text-like tinted inline citations, editable, not pill widgets (D0
  feedback); Pandoc in a utility process with golden export tests.
- Schema discipline: M1 migrations must not preclude `skill_id` on runs,
  `references`, `archive_documents` tables — they simply aren't created yet.

## 17. Risks

| Risk | Mitigation |
|------|------------|
| Editor choice wrong (D0) | D0 recorded (§5: Tiptap); adapter isolates the blast radius of a reversal. |
| Tiptap round-trip drift (now applies) | CI round-trip tests on golden samples; warn badge; raw mode always authoritative-recoverable. |
| Pi 0.x breaking changes | Pinned versions; adapter boundary; integration notes document gotchas. |
| Electron Node < 22.19 | Startup assertion; choose Electron version accordingly. |
| Patch anchors rot on fast-moving text | Short propose→review window; conservative rebase; conflict path asks agent to regenerate. |
| Long-document context cost | Section/selection scopes; manifest + truncation notices; Deep only when asked. |
| Scope creep toward M2 features | §3 exclusions; skills/archive/citations have no UI entry points in M1. |
