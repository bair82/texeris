# Texeris — General Development Plan

**Status:** active plan, established 2026-07-22 after the M1/M1.5 audit.
**Supersedes for current priorities:** `implementation-plan.md`, which remains
the historical record of the first implementation milestones.

## 1. Purpose

Texeris has crossed the line from prototype to a useful personal application.
The next phase should not be driven by the old milestone labels or by adding
isolated features whenever their local implementation looks inexpensive. It
should make the existing application trustworthy as an integrated whole, then
close the largest remaining academic-writing workflows.

The product thesis remains unchanged:

> A revision-aware AI collaborator inside a serious writing environment should
> be safer, clearer, and faster than moving text between an editor and a chat
> window.

This plan is ordered around that thesis and the application that exists now.

## 2. Audited baseline (2026-07-22)

### 2.1 What works on `codex/main`

| Area | Current state |
|---|---|
| Project and document lifecycle | Create/open/switch projects; multiple documents; main-document designation; rename, duplicate, trash, restore, and permanent delete. |
| Editor | Tiptap rendered mode and CodeMirror raw mode over one canonical Markdown file; autosave, revisions, checkpoints, find/replace, outline, tables, footnotes, images, and appearance settings. |
| Agent loop | Fast/Deep chat, explicit selection/section/document scope, context manifest, edit awareness between turns, structured patch proposal/review, partial acceptance, conflicts, retry, cancel, and usage records. |
| Conversations | Multiple named conversations with persistence, reopening, deletion, and native context menus. |
| Writing profile | One built-in profile skill, scoped corpus grants, deterministic conversion, bounded corpus reads, delegated analysis, reviewable artifacts, explicit activation, and an optional patch-style critic. |
| Interchange | Markdown, DOCX, ODT, and RTF import/export; image preservation; text-bearing PDF import; fixed-layout A4 PDF export. |
| Recovery and security boundaries | Atomic canonical-file writes, startup reconciliation, append-oriented revision history, sandboxed renderer, narrow preload bridge, main-owned filesystem and credentials, and no agent shell/filesystem tools. |
| Packaging | Linux AppImage builds and launches; pinned Pandoc is bundled and verified. macOS targets are configured but unbuilt. |

The local verification baseline is strong but narrower than the documentation
has sometimes implied: TypeScript passes; Vitest reports 185 passing tests and
2 conditional compatibility tests skipped; focused Electron smokes and the
packaged-app verifier pass.

### 2.2 What is partial or absent

| Area | Status |
|---|---|
| References and citations | The first G2 slice is operational: canonical project CSL JSON with a rebuildable SQLite index, CSL JSON/BibTeX/RIS import, search-first insert/replace UI, unresolved-key audit, and automatic citeproc PDF/office export. Reference-detail editing and export-time CSL style selection remain. |
| Writing archive | Profile corpus grants are private, conversation-scoped inputs—not a browsable, searchable archive. There is no FTS5 archive UI or reusable attachment workflow. |
| Skills | The runtime boundary exists, but the registry is hard-coded and only the writing-profile workflow is user-facing. Conservative rewrite and verbal-tick cleanup are not packaged skills with evaluations. |
| PDF/source research | Text extraction exists; OCR, a source library, PDF viewing, page-linked reading, annotations, and question-answering over saved sources do not. |
| Spellcheck | Chromium spellcheck remains unreliable in rendered mode and structurally unsuitable for CodeMirror decorations. The app-level replacement is undecided. |
| Release engineering | No CI, no automated macOS artifact, no signing/notarisation, no application icon, no Linux `desktopName`, no release/versioning procedure, and no dependency-update policy. |

## 3. Audit findings

These findings are work items, not accusations. Most are normal consequences of
rapidly turning a prototype into a real application.

### 3.1 P0 — integration and verification truth

1. **The integrated product is not on `main`.** `codex/main` is 14 commits and
   89 changed files ahead of `origin/main`. Open PR #3 is titled “Make
   onboarding reachable from an active project,” while it now contains writing
   profiles, import/export, images, context menus, PDF support, and later UI
   changes. Its body reports the old 150-test baseline and it has no automated
   checks. Independent agent review is temporarily unavailable; this is not a
   blocker, because the active maintainer owns self-review and integration.
   The original integration checkout is also behind `origin/main`. Until this
   is reconciled, “done” means branch-local, not repository-integrated.
2. **There is no CI.** Round-trip safety is described as CI-guarded, but there
   is no `.github/workflows` directory. Tests rely on whoever last ran them.
   **Resolved 2026-07-22:** Linux CI now installs from the lockfile, typechecks,
   tests, builds, prepares the pinned Pandoc resource, packages Linux, and
   inspects the packaged result headlessly. Packaged launch remains a named
   local desktop gate; the first remote run remains the evidence gate.
3. **The aggregate offline smoke is not truthful.** `smoke-all.mjs` includes
   EU6, whose final assertion requires a persisted `config.json`; faux-provider
   mode explicitly skips settings persistence. The test therefore cannot pass
   as written. The suite retries broad failures rather than identifying known
   deterministic versus environmental failures. The credential smoke is
   separate and requires a real key, which is reasonable but should be
   classified clearly. **Resolved 2026-07-22:** isolated persistence smokes
   explicitly opt into faux-config writes while normal faux runs remain
   disposable; EU4 and EU6 pass. A follow-up restart-race in the primary smoke
   also now waits for the preload bridge, rather than only a CDP page target.
   The aggregate runner now reports every attempt and emits a machine-readable
   final summary rather than relying on an unstructured long-lived stream.
4. **The default Vitest command has an intermittent shutdown stall.** The same
   185 tests complete under the explicit `forks` pool, but the documented
   `pnpm test` command has also reached the end of execution without emitting
   a result or exiting. The test runner/pool choice needs to be stabilized and
   encoded instead of worked around ad hoc. **Resolved 2026-07-22:** the
   Vitest config now selects the `forks` pool and the documented command exits
   cleanly with the 185-test baseline.
5. **A dependency audit is not clean.** The current lockfile reports one high
   severity advisory in the development packaging chain (`fast-uri` 3.1.3 via
   electron-builder; patched in 3.1.4). It is not a shipped runtime path, but it
   is part of the artifact-producing toolchain.

### 3.2 P0 — correctness and lifecycle blind spots

1. **Deleting a profile conversation can violate foreign keys.** Conversation
   deletion removes messages and agent runs, but migration 0003 added
   `corpus_grants` and `delegated_results` referencing the conversation without
   cascades. The existing deletion test covers only a plain conversation. A
   profile conversation can therefore fail to delete, and deleting a running
   conversation is not explicitly handled. **Resolved 2026-07-22:** deletion
   removes delegated results, corpus sources, and grants in one transaction;
   an active run is aborted and detached before deletion.
2. **Run context is global while the runtime model is per conversation.**
   `PiAgentRuntime` permits agents/runs for multiple conversations but stores one
   `activeRunContext`; coordinator event routing also reads that singleton.
   Concurrent turns, or switching conversations and starting another turn,
   can misattribute document ids, patch origins, profile events, or delegated
   results. The near-term product should either enforce one foreground run
   globally or make every tool/event path explicitly run-scoped. **Resolved
   2026-07-22 (near-term invariant):** Texeris now rejects all overlapping
   foreground turns and detaches the current run before a project switch.
3. **The active-document outline is partially regressed.** Chat correctly
   builds scopes with the active document id, but `startTurn` refreshes the
   outline without that id and can reset the scope picker to the main
   document’s headings after a send. **Resolved 2026-07-22:** the refresh keeps
   the active document id, with an Electron smoke covering the non-main case.
4. **Corpus “snapshot” semantics are inconsistent.** Converted derivatives are
   cached, but every later read re-hashes the original absolute path and fails
   if the source moved, disappeared, or changed. This is a linked source, not an
   immutable snapshot. Grants and cached plaintext derivatives have no delete,
   retention, or garbage-collection workflow; partial grant creation is not
   transactional; recursive imports have no general byte/file-count cap.
   **Resolved 2026-07-26 (owner decision: immutable snapshots):** source bytes
   are copied into `<projectRoot>/.texeris/corpus` at grant time; reads never
   touch the original path and rebuild missing derivatives from the snapshot.
   Grant creation converts first and commits one DB transaction; limits are
   200 files / 500 MB total / 100 MB per file / depth 8. Grants can be
   inspected and deleted in Settings (with the plaintext-retention
   disclosure); deletion and conversation removal GC unreferenced blobs.
   Legacy workspace-cache rows keep the old behavior. (PR #5)
5. **Heavy deterministic work still blocks the Electron main process.** Pandoc
   uses synchronous subprocess calls; recursive corpus conversion and hashing
   are sequential; large-file reads are synchronous. PDF extraction is async
   at its API boundary but CPU work still shares the application process. Large
   imports and exports need cancellable jobs behind the existing service
   boundary. **Resolved 2026-07-26:** all Pandoc conversion/export, unpdf
   extraction, and PDF print-HTML preparation run on `node:worker_threads`
   (`main/jobs/`: pure `tasks.ts`, thin `worker.ts` entry, `JobRunner` with
   AbortSignal cancellation); `printToPDF` stays in main fed the prepared
   artifact. Import/export/corpus-grant IPC report progress over
   `texeris:job-event` and cancel via `texeris:job-cancel`; the status bar
   shows live progress with a Cancel button. (kimi/background-jobs)
6. **File and DB durability has a known split point.** A canonical file is
   atomically renamed before its revision transaction commits. Startup
   reconciliation can recover after a crash, but an injected DB failure can
   leave the running process temporarily inconsistent. This needs explicit
   fault tests and a defined immediate-recovery path.

### 3.3 P1 — privacy, permission, and contract gaps

1. Corpus derivatives, profiles, absolute source paths, and evidence are stored
   as plaintext in the workspace config area. That can be a valid local-first
   design, but the UI does not disclose retention or provide deletion.
2. Publication metadata lookup sends titles to Crossref and OpenAlex. The tool
   asks the model for `publicEvidence`; this is not the user-mediated approval
   promised by the profile instructions. Network disclosure should be enforced
   by application state, not by an agent-authored justification string.
3. IPC requests are generally validated in main, but the shared contract’s
   claim that every payload is validated “on both sides” is false. Most preload
   responses and trusted push events are only cast. Either add boundary
   validation systematically or document the actual trust model.
4. Credentials are encrypted, but cache/profile retention and diagnostic/test
   environment switches do not yet have one documented privacy model.

### 3.4 P1 — product and UX gaps

1. The product spec’s minimum coherent release still depends on references,
   bibliography-aware export, an archive, and a small evaluated skill set.
2. Persistent undo across document/mode switches is revision-based in theory
   but not presented as a normal undo experience.
3. **Conversation/document rewind is available through user-message editing.**
   **Resolved 2026-07-29:** Edit message previews the rollback, creates a
   non-destructive conversation branch, restores the scoped document at its
   exact revision/change boundary, and resends with the original mode and
   scope. Regenerate on the latest assistant response reuses the same safe
   branch/restore operation without changing the prompt. Checkpoints retain
   their existing document-only restore semantics.
4. Section movement/folding and math remain meaningful document-authoring
   gaps. Split view and more themes are lower-value until real use says
   otherwise.
5. Workspace status messages are now standardized. A general console is not
   justified yet; introduce one only when background jobs produce durable,
   inspectable logs that cannot fit the status/job UI.
6. Context-menu AI shortcuts remain intentionally deferred until repeated
   writing sessions identify specific useful actions.

### 3.5 P1 — documentation and release gaps

1. The old implementation plan still calls itself a draft Milestone 1 plan,
   lists already-built capabilities as out of scope, describes migration 0001
   as the only migration, and projects current features into M2–M4.
2. Architecture milestone labels similarly place multi-file projects,
   profiles, subagents, PDF, and export in the future.
3. The README still presents the spike as the development entry point and does
   not explain how to run or package the real app.
4. Packaging succeeds with warnings for missing application icon and Linux
   desktop identity. The artifact remains version `0.1.0`; there is no release
   manifest, changelog, checksum publication flow, licence/third-party notice,
   or macOS build verification.

## 4. Development principles from this point

1. **Trust before breadth.** No new major product subsystem starts while the
   P0 baseline is red or exists only on an unintegrated omnibus branch.
2. **One canonical source per domain.** Markdown remains canonical for prose;
   reference and archive canonicality must be decided explicitly before their
   UIs are built.
3. **Derived data must declare lifecycle.** Every cache, conversion, index, and
   generated artifact needs provenance, integrity checks, retention, deletion,
   and rebuild rules.
4. **Agent authority stays narrower than application authority.** New tools
   operate on typed domain services. Network disclosure and durable activation
   require application-enforced user approval.
5. **Long work is a job.** Anything that can noticeably block the UI needs
   progress, cancellation, an atomic terminal result, and recovery after app
   restart where appropriate.
6. **Main stays releasable.** Work lands in small scoped PRs with current
   descriptions and checks. A long-running agent branch is not a release line.
7. **Tests state what they prove.** Offline deterministic checks, desktop
   smokes, platform checks, private-fixture compatibility tests, and live-model
   evaluations are separate named gates.
8. **Evidence decides speculative UI.** AI shortcuts, a console, embeddings,
   split view, and additional themes wait for observed workflow pressure.

## 5. Roadmap

### G0 — Integrate and establish a truthful baseline

**Goal:** one authoritative branch with checks whose green state has a precise
meaning.

Work:

- Self-review and land the current `codex/main` work as a correctly titled and
  described integration PR; do not wait for an unavailable peer reviewer.
  Reconcile the integration checkout and close or replace the completed
  EU1–EU7 coordination issue.
- Add Linux CI for install-lockfile integrity, typecheck, Vitest, production
  build, Markdown round-trip fixtures, Pandoc preparation checksum, and package
  resource inspection. Run desktop smokes under an explicit supported display
  strategy or keep them as a clearly named local gate.
- Fix EU6’s faux-settings contradiction. Split checks into:
  `test` (headless deterministic), `smoke:offline`, `smoke:packaged`,
  `smoke:platform`, `compat:private`, and `smoke:live`.
- Make the default Vitest pool deterministic and add a timeout/open-handle
  diagnostic so a worker-shutdown hang is useful evidence rather than an
  indefinite command.
- Make smoke retries report the first failure and retry reason; do not use a
  blind retry to redefine a red test as environmental.
- Resolve the packaging-chain advisory and record dependency-update policy.
- Refresh README, commands, version/release metadata, package comments, and
  current architecture references.

Exit gate:

- `main` contains the audited feature set.
- A clean clone can run the documented headless checks in CI.
- The offline aggregate suite has no deterministic failures or silent skips.
- Linux packaging and packaged launch verification are repeatable.

### G1 — Integrity, lifecycle, and daily reliability

**Goal:** make existing workflows safe under deletion, interruption, large
inputs, and navigation—not only on the happy path.

Work packages, in order:

1. **Relational lifecycle:** migration and service changes for profile
   conversation deletion, grants, sources, delegations, runs, and generated
   artifacts; tests for delete/cancel/project-switch combinations.
2. **Run invariant:** initially enforce one foreground agent run application-
   wide, including safe cancel-and-wait on project switch or deletion. Move to
   per-run tool contexts only when simultaneous foreground jobs become a real
   requirement.
3. **Corpus ownership:** choose immutable snapshot semantics (recommended) or
   explicit linked-source semantics; make creation transactional; add file,
   total-byte, and per-format limits; deletion and cache GC; disclose plaintext
   local retention.
4. **Background jobs:** move conversion, hashing, extraction, and HTML
   preparation off the main event loop. Keep Electron-only printing in main,
   fed by a self-contained prepared artifact. Add progress/cancel/error status.
5. **Fault injection:** test DB failure after file rename, interrupted export,
   missing source/cache, corrupted profile manifest, and startup reconciliation.
   **Resolved 2026-07-29:** a failed revision transaction now restores the
   canonical file immediately (including typing-tip amendments); focused tests
   cover that split point, interrupted export cleanup, malformed profile
   manifests, missing/tampered corpus derivatives, and startup reconciliation.
6. **Contract hardening:** validate security-relevant IPC responses/events or
   narrow the documented guarantee to the actual boundary.
   **Resolved 2026-07-29:** renderer requests remain runtime-decoded in main;
   preload now decodes main push events that trigger actions or state changes.
   Trusted invoke responses and display-only chat streams remain statically
   typed, and the architecture now states that boundary explicitly.
7. **Daily editor reliability:** fix active-document outline refresh; implement
   the app-level spellchecker after deciding initial languages and dictionary
   distribution; expose revision restore as the cross-session undo story.
8. **Conversation/document rewind:** let the user choose an earlier completed
   chat turn or checkpoint, preview the affected document revision and message
   boundary, then restore the document as a new revision and fork/reopen the
   conversation from that boundary. Preserve the abandoned conversation and
   revision history; invalidate or clearly retain pending patches by origin,
   never silently delete evidence.
   **Resolved 2026-07-29:** the chosen UI is Edit message on persisted user
   messages. Hover and native context-menu actions open an inline editor with a
   rollback warning and optional compact diff. Save creates a transcript fork,
   restores the one scoped document as a new revision, and resends; original
   messages, revisions, and patches remain intact. The latest assistant response
   also offers Regenerate through the same branch/restore path. General
   checkpoint-linked conversation rewind is deferred rather than inferred from
   legacy data.

Exit gate:

- No known delete path violates foreign keys or strands user-visible state.
- Project switching and conversation deletion are defined during active work.
- Large imports do not freeze the renderer and are cancellable.
- Corpus/profile data can be inspected and deleted.
- The full baseline gate stays green through injected failure cases.

### G2 — References, citations, and bibliography-aware export

**Goal:** complete the academic manuscript workflow that is still only
syntactically represented.

Decision first:

- Choose a portable canonical CSL JSON representation and its relationship to
  SQLite indexing. Recommended shape: a user-inspectable project CSL JSON file
  as canonical data, with SQLite as a rebuildable search/index layer.

**Decision (2026-07-30):** `references.csl.json` in the project root is the
portable canonical library. SQLite’s `reference_index` is a disposable search
projection and is rebuilt whenever the canonical file’s content hash changes.
The first UI stays deliberately small: one Cite action opens a search palette;
an empty palette offers bibliography import in place, and double-clicking a
rendered marker reuses the palette to replace it. Export invokes citeproc
automatically when the document cites records in the library.

**Implemented first slice (2026-07-30):** stable-key validation, duplicate/key
conflict reporting, external-file index repair, CSL JSON/BibTeX/RIS import,
compact manual creation with generated keys and optional Crossref DOI autofill,
author/title/year/key search, rendered and raw insertion, rendered replacement,
missing/unused-key audit, and bibliography-aware PDF/DOCX/ODT/RTF export. The
remaining G2 work is editing existing reference details, explicit missing-key
resolution, export-time CSL style selection, and broader golden fixtures.

Work:

- Reference service with stable citation keys, validation, duplicate detection,
  unresolved-key states, and revision/audit semantics for changes.
- Import CSL JSON, BibTeX, and RIS with a conversion report; preserve unknown or
  ambiguous fields rather than guessing.
- Searchable insert-citation UI; rendered markers remain text-like and editable.
- Reference detail editing and explicit resolution of missing keys.
- Pandoc citeproc export for DOCX and PDF with chosen CSL style, bibliography,
  project-owned images, and one structured export report.
- Golden fixtures for multiple citation forms, notes, bibliography ordering,
  Unicode, missing records, and round trips.

Exit gate:

- A real manuscript can import references, insert/edit citations, identify
  unresolved keys, and export a rendered bibliography without manual surgery.

### G3 — Writing archive and source retrieval

**Goal:** turn one-off profile corpora into a reusable local writing archive
without conflating sources with bibliographic references.

Work:

- Workspace archive with immutable source snapshots, provenance, metadata,
  content hashes, duplicate detection, delete/retention controls, and FTS5.
- Import status UI and conversion warnings for Markdown, text, office formats,
  and text-bearing PDFs; retain PDF page markers.
- Search results with excerpts and source/page locations; attach selected
  results explicitly to a conversation or skill run.
- Re-index and integrity repair commands.
- Evaluate actual FTS misses before selecting embeddings or a vector store.

Exit gate:

- The user can find a passage from prior work, inspect its provenance, attach
  it to a conversation, and remove the source and derivatives predictably.

### G4 — Skills and personalisation maturity

**Goal:** make AI workflows discoverable, bounded, and evaluable rather than a
collection of prompts hidden in code.

Work:

- Small application-owned skill registry and launcher with explicit scope,
  mode, allowed tools, output type, and version.
- Ship conservative rewrite and verbal-tick audit/rewrite as the next two
  skills; preserve patch review as the only prose mutation route.
- Add compact deterministic/model-assisted evaluation fixtures before adding
  more skills.
- Finish profile lifecycle: update/rebuild, provenance, genre variants,
  activation history, disable/delete, and clear distinction between observed
  habits and desired rules.
- Replace agent-authored `publicEvidence` with a user-visible network approval
  record for metadata/research tools.
- Revisit context-menu AI shortcuts only after telemetry or notes identify a
  few repeated selection/document actions.

Exit gate:

- Each visible skill has a bounded contract, at least one representative
  evaluation, a reviewable result, and a clear permission story.

### G5 — Sources and PDF research

**Goal:** support research material as first-class local sources after archive
and permission semantics are stable.

Possible work, driven by use:

- Source library and document/source distinction in the UI.
- PDF viewer with page-linked extracted text and citations back to source.
- OCR as an explicit cancellable derivative job with confidence and language
  settings; never present OCR as faithful layout reconstruction.
- Notes, evidence tables, literature matrices, and bounded question answering
  over user-selected sources.
- DOI/OpenAlex/Crossref/Zotero connections behind explicit network disclosure
  and provenance.

### G6 — Release readiness

**Goal:** make installation and upgrades boring on supported platforms.

Work:

- App icon, Linux desktop identity, licence and third-party notices, semantic
  versioning, changelog, checksums, and reproducible release notes.
- Automated Linux artifacts and a real macOS build/test lane; signing and
  notarisation when distribution extends beyond personal use.
- Migration compatibility tests from every released project schema.
- Accessibility pass for keyboard, focus, semantics, contrast, and reduced
  motion; performance budgets for large manuscripts and archives.
- Backup/export documentation for project and workspace-global profile/archive
  data.

## 6. Prioritised next queue

Do not begin G2 until items 1–7 are closed:

1. ~~Integrate the current branch and replace the stale omnibus PR description.~~
2. ~~Add CI and repair/classify the aggregate smoke suite.~~
3. ~~Fix profile-conversation deletion and add relational lifecycle tests.~~
4. ~~Enforce the agent-run invariant and safe project/conversation transitions.~~
5. ~~Fix active-document outline refresh.~~
6. ~~Decide corpus snapshot/retention semantics; add delete and transactional
   creation.~~ Done 2026-07-26 (immutable snapshots, PR #5).
7. ~~Move expensive conversion/extraction work into cancellable jobs.~~ Done
   2026-07-26 (worker-thread jobs with progress/cancel).
8. ~~Add safe conversation/document rewind with preview and non-destructive
   conversation branching.~~ Done 2026-07-29 through Edit message; checkpoints
   remain document-only.
9. Build references/citation library and bibliography-aware export (G2).
10. Build archive + FTS5 retrieval (G3).
11. Productise and evaluate the next two skills (G4).
12. Resume app-level spellcheck as a bounded daily-use package; it may move
   earlier if current writing sessions make it more costly than items 6–7.
13. Only then consider math, section manipulation, PDF viewing/OCR, split view,
   additional themes, a console, or generic AI shortcuts.

## 7. Definition of done for every work package

A package is complete only when:

- the user-visible outcome works through the real renderer/preload/main path;
- canonical data, derived data, rollback, deletion, and recovery are defined;
- security and network effects are explicit;
- unit/integration coverage exercises failure as well as success;
- the relevant desktop or packaged smoke is updated;
- product, architecture, command, and migration docs are updated in the same
  change;
- the branch is pushed as a scoped PR with current verification evidence;
- `main` is green after integration.

## 8. Decisions still requiring the owner

These are real product decisions; do not bury them in implementation:

1. Which languages must the first app-level spellchecker support, and is
   downloading dictionaries acceptable?
2. Should the reference library’s canonical CSL JSON be a visible project file
   or application-managed data with explicit export?
3. ~~Are writing-archive imports immutable snapshots (recommended) or live links
   to originals?~~ **Decided 2026-07-26 (owner): immutable snapshots**, applied
   to profile corpus grants in PR #5; the same semantics carry into the G3
   archive. Retention follows the conservative default: derivatives persist
   locally until explicit user deletion (inspect/delete in Settings).
4. Should Texeris enforce one foreground agent run, or is simultaneous work in
   multiple conversations a near-term requirement?
5. How long should corpus/profile/archive derivatives be retained by default?
6. What event would justify a persistent console: background job history,
   diagnostics, research logs, or none?
7. Is the next distributable target personal Linux only, or should macOS
   signing/notarisation become a release gate now?

Until these decisions are made, use the conservative choice that preserves
local data, minimizes disclosure, and avoids irreversible schema commitments.
