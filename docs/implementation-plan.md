# Texeris — Implementation Plan: Milestone 1

**Status:** Draft. Editor-dependent sections are marked **CM** / **PM** and stay
conditional until decision D0 (spike evaluation) is recorded.
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
| 3 | Minimum patch schema | Architecture §11.2 as implemented in the spike (`TextChange{from,to,expectedText,insert,prefixContext?,suffixContext?}` inside ordered `PatchGroup`s). |
| 4 | Agent tools (v1) | §10.2 — six read/propose tools; no fs, no shell, no web. |
| 5 | Supported Markdown profile | Architecture §17.1 minus YAML metadata: ATX headings, emphasis/strong, lists, blockquotes, links, code spans/blocks, pipe tables, footnotes, Pandoc citations. Same profile as the spike. |
| 6 | Model credentials | Development: `MOONSHOT_API_KEY` / `DEEPSEEK_API_KEY` env vars via Pi's `CredentialStore` (in-memory). Post-M1: OS keychain via Electron `safeStorage`. Never in project files. |
| 7 | Pandoc | Not needed in M1 (no export). When reached: configured system Pandoc in dev, bundle for distribution. |
| 8 | Project identity | `project.json` with `formatVersion`, `projectId` (uuid), `mainDocument`. Documents addressed by uuid in DB, looked up by relative path on open; renames reconcile path→uuid, never re-id. |
| 9 | Workspace vs project data | Workspace: platform config dir (`~/.config/texeris`, `~/Library/Application Support/texeris`) — `config.json` (model modes), later style profile + archive index. Project: user folder with `.texeris/` (history DB, cache). |
| 10 | Recoverable autosave | Every revision commit triggers atomic file write (tmp + rename). DB keeps change records + periodic snapshots. Startup reconciles hash mismatches; incomplete tmp writes are cleaned, never silently chosen. |

## 5. Pending decision D0: editor

Gate before WP2. The owner evaluates `spikes/editor/` against its checklist
(cursor/selection/deletion near hidden syntax, copy/paste, IME, tables,
footnotes, mode switching, patch feel). Record the outcome in this section.

- **Prefer CM6** if its rendered mode feels natural enough — canonical text,
  revisions, and patches stay simple.
- **Prefer Tiptap** if CM6 still feels like editing source — accept the
  round-trip boundary and guard it (§13 PM variant).

The spike also answers: does live-render survive our full Markdown profile,
and where does Tiptap normalization actually bite?

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

Grouping rules v1 (from spike, tune after use): new revision on — 1000 ms
idle after last change · paste · selection jump across a paragraph boundary ·
applied patch · mode switch does **not** create one · restore/checkpoint does.

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
    "deep": { "provider": "moonshotai", "model": "<kimi flagship id — confirm against Moonshot docs at integration time>" } } }
```

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
agent gets: current text of its scope + `read_revision_changes` summary
since `baseRevision` of its last patch (spec §10.6).

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

**CM variant:** `onGroupedChanges` maps transactions → text offsets directly;
`applyTextChanges` = `dispatch`; raw mode = same state, decoration
compartment off. Revision capture is lossless.

**PM variant:** grouped commit = serialize → diff against last snapshot to
derive text changes (approximation — flagged in spike README);
`applyTextChanges` = serialize → apply → reparse → remap selection
approximately; raw mode = separate CM instance; **normalization guard**: the
round-trip checker becomes a CI test over the golden sample docs, plus a
warn-on-mode-switch badge when `serialize(parse(x)) ≠ x`.

## 14. Build sequence

Dependencies flow downward; each WP has a definition of done (DoD).

**WP0 — App skeleton.** `app/` electron-vite project, React, TS strict,
preload bridge + one round-trip IPC with validation, vitest wired.
*DoD:* empty window from `pnpm dev`; `pnpm typecheck && pnpm test` green.

**WP1 — Storage & domain core (headless).** SQLite layer + migration 0001,
project service (create/open/format version), document service (atomic
write), revision engine (§8), checkpoint service. Pure Node tests.
*DoD:* unit tests green — grouping, atomic write, snapshot replay,
external-change import, restore-as-new-revision.

**WP2 — Editor integration.** Editor adapter + D0 winner (ported from spike,
not imported), rendered + raw modes, commit-on-group over IPC, outline,
autosave path. *DoD:* type → restart app → content + full revision history
intact; mode switch creates no revision.

**WP3 — Chat & agent.** Pi adapter (§10), Fast/Deep config + env keys,
conversation persistence, streaming to renderer, context assembly (§11)
with manifest, cancel. *DoD:* question about a selection streams an answer;
conversation + manifest survive restart; cancel stops mid-stream.

**WP4 — Patch pipeline.** `propose_patch` tool → validation → storage →
review UI (per-group) → application → outcome records → conflict path.
*DoD:* e2e — ask for a rewrite, partially accept, history shows linked
agent revision; stale-base patch fails safely with visible conflict.

**WP5 — Hardening & packaging.** Crash recovery, external-change UI, model
failure retry (context preserved), usage record view, error surfaces,
electron-builder artifacts for macOS + Linux. *DoD:* e2e suite green;
installable artifact on both platforms.

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
  same DB; `references` table + citation-chip rendering behind editor
  decorations (both spike-proven); Pandoc in a utility process with golden
  export tests.
- Schema discipline: M1 migrations must not preclude `skill_id` on runs,
  `references`, `archive_documents` tables — they simply aren't created yet.

## 17. Risks

| Risk | Mitigation |
|------|------------|
| Editor choice wrong (D0) | Spike evaluation against checklist; adapter isolates blast radius. |
| Tiptap round-trip drift (if PM) | CI round-trip tests on golden samples; warn badge; raw mode always authoritative-recoverable. |
| Pi 0.x breaking changes | Pinned versions; adapter boundary; integration notes document gotchas. |
| Electron Node < 22.19 | Startup assertion; choose Electron version accordingly. |
| Patch anchors rot on fast-moving text | Short propose→review window; conservative rebase; conflict path asks agent to regenerate. |
| Long-document context cost | Section/selection scopes; manifest + truncation notices; Deep only when asked. |
| Scope creep toward M2 features | §3 exclusions; skills/archive/citations have no UI entry points in M1. |
