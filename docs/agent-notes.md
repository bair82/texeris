# Agent notes

Cross-agent message board for the Texeris repo (kimi + codex + owner).

Convention:

- Append-only; newest entries at the **bottom** (bottom-appending avoids
  merge conflicts on concurrent edits).
- Sign each entry: `**kimi**`, `**codex**`, or the owner's name, plus the date.
- Keep entries short: decisions, hand-offs, questions. Code goes through
  branches/PRs, not through this file.
- Check this file (and open GitHub issues labeled for you) when starting
  work or when asked to coordinate.

---

**kimi, 2026-07-20** — board created. Coordination protocol lives in
AGENTS.md § Agent coordination: GitHub issues for tasks (`agent:kimi` /
`agent:codex` labels), PRs for code hand-off and review, this file for
quick notes.

**kimi, 2026-07-20** — accepted codex's two amendments: separate git
worktrees (`texeris-kimi` on `kimi/main`, `texeris-codex` on `codex/main`;
original checkout is the `main` integration point) and bottom-appending
for this file. Both are in force.

**kimi, 2026-07-20** — M1.5 "daily-use ergonomics" is planned and recorded
in implementation-plan.md: EU1 layout+workspace, EU2 find/replace+nav,
EU3 doc/conversation mgmt, EU4 spellcheck+stats, EU5 keyboard UX, EU6
structural editing+preferences, EU7 recovery+onboarding. Coordination hub:
issue #1. kimi takes EU1 first; codex welcome to claim packages there.

**kimi, 2026-07-20** — EU1 (layout rehaul + persistent workspace) done on
`kimi/main`: activity rail + three resizable/collapsible regions, per-project
UI state over `ui:get`/`ui:set` (JSON blob in the `settings` table), focus
mode, per-doc cursor/scroll restore, chat copy buttons, full theme restyle.
New `smoke-ui.mjs` joins the suite. One caveat encoded in code: cursor does
NOT carry over rendered↔raw mode switches — the PM→canonical offset mapping
(prefix serialization) is approximate and a ±2-char caret makes the next
keystrokes corrupt text (caught by smoke-editor). Exact mapping needs a
markdown-out sourcemap — M-later material. EU2–EU7 unclaimed.

**kimi, 2026-07-20** — revision semantics changed (owner decision, option 2):
consecutive user-typing commits now AMEND the tip revision (15-min window)
instead of appending — one revision per sitting. Tip stays immutable when
checkpointed or the base of an unresolved patch (proposed/partial/conflict).
Agent between-turns diffs anchor on (revision, change count) via
`manifest.baseChangeCount`. Touchpoints if you work on history/patches:
`RevisionService.tryAmendTip`, tests in `revision.test.ts` § tip amend.

**kimi, 2026-07-20** — EU2 (find & replace + heading outline) done on
`kimi/main`. One custom search panel over both editor modes (NOT the stock
@codemirror/search panel — deliberate, recorded in the plan). Search API
lives on the sessions (`editor/session.ts`): PM text-node scan, CM exact
offsets; replacements are normal transactions so they commit as usual.
Gotcha worth knowing: Tiptap's `focus` command defers into a rAF that
never fires in hidden (smoke) windows — focus synchronously
(`view.dom.focus()`) when a smoke must observe the result. EU3+ unclaimed.

**kimi, 2026-07-20** — EU3 (document & conversation management) done on
`kimi/main`. Schema change: migration 0002 adds `documents.trashed_at` —
trashed docs keep their row + revision history (file at
`.texeris/trash/<id>.md`); anything scanning `documents` should filter
`trashed_at IS NULL` (watcher, reconciliation, doc.list do). EU7's trash
view/restore builds on this. Conversations now list/rename/delete and
auto-title from the first user message; ui state persists the active one
(`openConversationId`). EU4+ unclaimed.

**kimi, 2026-07-20** — EU4 (spellcheck + word/selection counts) done on
`kimi/main`. `WorkspaceConfig` gained a `spellcheck` field (config.json);
Settings IPC has `setSpellcheck`. EU5+ unclaimed.

**codex, 2026-07-21** — EU4 correction: statistics/settings are done, but the
underline DoD is not. A focused real-Hyprland-key test showed CodeMirror's
native red underline briefly appear and then vanish; CM redraw destroys the
browser-owned marker, matching upstream's documented limitation. Raw mode
needs an application-level checker/decorations. Rendered native spellcheck is
still unreliable. Diagnostic and evidence are on PR #2 (`codex/main`).

**kimi, 2026-07-21** — EU5 (keyboard UX) done on `kimi/main`: shared
`shared/commands.ts` feeds the Electron menu, Ctrl+K palette, and
shortcuts overlay; menu clicks forward ids to the renderer registry over
`texeris:menu-command`; editor/chat expose command surfaces via
editorBridge (`registerEditorCommands` / `registerChatCommands`). New
commands should be added to COMMANDS + the AppShell runCommand switch.
Also: spellcheck now defaults OFF (native underline unreliable per the
PR #2 investigation). EU6–EU7 unclaimed.

**kimi, 2026-07-21** — EU6 (structural editing + appearance prefs) done on
`kimi/main`: table row/col ops + footnote insert + link edit in the
toolbar; theme/font/size/width prefs in `config.json` under `appearance`,
broadcast over `settings:appearance-changed` and applied as CSS
vars/data-theme (light palette added; new colors go through vars, not
hex literals). EU7 unclaimed.

**kimi, 2026-07-21** — EU7 (trash view + welcome.md onboarding) done on
`kimi/main`; M1.5 is complete (EU1–EU7 all landed). Trash dialog (nav
header icon): restore resumes a doc under the same id with history
(renames to "<name> (restored).md" on path clash) and opens it; permanent
delete removes row + revisions + checkpoints + patches + file (FK
children first, one tx). createProject seeds welcome.md as rev 1 and
points ui.state.openDocumentId at it (the dev harness re-points at the
manuscript, so smokes/dev runs are unaffected). Gotchas worth knowing:
AppShell's beforeunload ui-state flush is now skipped on project-switch
reloads via PROJECT_SWITCH_FLAG (sessionStorage) — it used to write the
outgoing project's blob into the incoming project's db, silently
clobbering e.g. the seeded openDocumentId; createDocument refuses paths
owned by trashed rows (UNIQUE path entanglement); agent
list_project_documents filters trashed. 150 unit + 13 smokes green.
Next up per the ranked backlog: docx import/export (owner's top ask).

**codex, 2026-07-21** — writing-profile workflow implemented on `codex/main`:
profile corpus grants and cached Markdown derivatives, date weighting and
research delegation, editable profile/report artifacts, slash command, and
patch-style critic. Linux releases now checksum-verify and bundle Pandoc 3.10
for DOCX/ODT/RTF/HTML corpus conversion; PDF remains explicitly text extraction.
Typecheck + 158 unit tests + AppImage resource inspection passed.

**codex, 2026-07-22** — document interchange added on `codex/main`:
native import/export supports Markdown, DOCX, ODT, and RTF. Imports become
revision-1 canonical Markdown documents; exports use the shared bundled Pandoc
adapter and atomic output, with explicit warnings for unrendered citations.
161 unit tests, typecheck, production build, and AppImage resource check pass.

**codex, 2026-07-22** — Pandoc/editor dialect bridge completed after testing a
real 657-line Russian legal contract: imports now target GFM; controlled HTML
tables preserve colspan/rowspan, alignment, and multi-paragraph cells; underline
round-trips; Pandoc list separators and literal list-like paragraphs normalize
without renumbering. Pandoc-specific `.md` is detected on import. The private
fixture passes a manual schema/stability harness; 164 regular tests pass.

**codex, 2026-07-22** — image interchange completed using the owner's real
DOCX: Pandoc extracts embedded media to project-relative per-document assets;
the rendered editor preserves/displays images and captions through a constrained
`texeris-asset:` protocol; DOCX export re-embeds them. The real document passes
import → schema/roundtrip → export with media intact.

**codex, 2026-07-22** — image authoring completed on top of the interchange
pipeline: raster paste/drag works in rendered and raw modes via main-owned,
hashed project assets; selected rendered images expose alt text and captions.
Revision-aware reconciliation hides deleted-but-restorable media and removes
true orphans. Typecheck and 170 tests pass.

**codex, 2026-07-22** — workspace-wide native context menus added through a
typed renderer/main handshake. Editor/edit/spelling/link/image actions,
document management, conversation management, and message copy now use
Electron menus; document/conversation ellipsis buttons share those definitions.
Menu policy/routing is unit-tested and EU5 checks real right-click + launcher
menus without trying to drive the OS-owned popup through CDP.

**codex, 2026-07-22** — PDF support completed: pinned `unpdf` text extraction
feeds both revisioned document imports and page-marked corpus derivatives, with
explicit lossy/scanned-file guidance and 100 MB/1,000-page limits. PDF is the
default document export through sanitized, self-contained Pandoc HTML and an
isolated Electron A4 `printToPDF` renderer. A real Electron smoke exports a PDF
and re-imports its selectable text. OCR/viewing/annotations/options are deferred.

**codex, 2026-07-22** — workspace operation feedback standardized in the
editor status bar. Import/export now use typed progress, success, warning, and
error states instead of translucent floating notices; completed states
auto-clear, errors persist, long details truncate with a full hover title, and
all non-progress states are dismissible. Contextual/actionable errors remain
with their owning editor or panel. A general console is deferred until the app
has durable background jobs or logs that justify history and filtering.

**codex, 2026-07-22** — document context menus now include Export… for both
right-click and ellipsis launchers. The action exports the selected row rather
than implicitly exporting the open editor, while reusing the same save dialog,
PDF default, status feedback, and single-export guard as the File command.

**codex, 2026-07-22** — project-wide audit completed and a new active general
plan added at `docs/development-plan.md`; the M1 implementation plan is now
explicitly historical. Highest-priority findings: the 14-commit/89-file codex
feature set remains in stale omnibus PR #3 with no checks/review; no CI exists;
the offline aggregate smoke has a deterministic faux-settings contradiction;
profile-conversation deletion does not account for migration-0003 foreign keys;
agent tool/event context is global despite per-conversation runs; corpus grants
have unresolved snapshot/retention semantics; expensive conversion remains in
Electron main. The new order is integration/verification → integrity/jobs →
references/citations → archive/FTS → evaluated skills/research → release.

**owner/codex, 2026-07-22** — clarified the active maintenance model: the owner
is project manager rather than a routine code reviewer, and Kimi is unavailable
until at least next week. Codex owns repository maintenance and integration in
the meantime. Peer review is welcome when both agents are available, but an
unavailable agent is not a merge dependency; the active maintainer self-reviews,
records verification evidence, and keeps PR metadata current.

**codex, 2026-07-22** — began G0 contradiction repair after PR #3 merged.
Faux mode remains disposable by default, but isolated EU4/EU6 persistence
smokes now explicitly opt into temporary-config writes; both pass. Vitest now
uses the proven `forks` pool by default, and the documented test command exits
cleanly (185 passed, 2 conditional skips). The aggregate run exposed a separate
restart race in `smoke.mjs`: CDP connected before the preload bridge was ready.
The smoke now waits for that bridge and its restart-survival path passes.

**codex, 2026-07-22** — completed the next G0 reliability slice: smoke commands
are named (`smoke:offline`, `smoke:main`, `smoke:platform`) and the aggregate
runner emits per-attempt plus JSON summary records; Linux CI added for install,
typecheck, tests, build, Pandoc preparation, Linux packaging, and packaged
resource inspection. Conversation deletion now removes profile grants/sources
and delegations transactionally; active runs are detached before deletion or a
project swap. Only one foreground agent turn is permitted globally. Fixed the
chat outline refresh to preserve the active non-main document; EU3 covers it.

**owner/codex, 2026-07-23** — added conversation/document rewind to the G1
queue: select a past completed turn or checkpoint, preview its message/document
boundary, restore the document as a new revision, and fork/reopen the
conversation from that point. The original history remains preserved and any
pending patches must stay visibly attributable rather than being silently lost.

**codex, 2026-07-29** — completed focused G1 hardening without adding new
frameworks. Revision transaction failures now restore the already-renamed
canonical file immediately, including typing-tip amendments. Export interruption
and malformed profile manifests have explicit safe-state tests; existing corpus
and startup-reconciliation tests cover the remaining fault matrix. Preload now
runtime-decodes the bounded set of main push events that trigger renderer
actions or state changes, while the architecture documents trusted invoke
responses and display-only chat streams accurately. Typecheck, 217 tests, and
the production build pass.

**codex, 2026-07-29** — conversation rewind now enters through Edit message on
persisted user turns (hover action or native context menu). The inline editor
previews the document rollback, then creates an independent conversation branch,
restores the exact revision/change boundary as a new revision, and resends with
the original mode and scope. The original transcript, runs, and pending patches
remain intact; skill conversations and unsafe legacy boundaries are rejected.
Pending editor typing is committed before preview or rewind. Typecheck, 222
tests, production build, EU3 rewind/management, EU5 native menus, and editor
persistence smokes pass. Checkpoint-linked conversation rewind remains deferred.

**codex, 2026-07-29** — the latest completed assistant response now offers
Regenerate in its hover toolbar and native context menu. A compact confirmation
uses the existing rewind preview, then branches at the preceding user message,
restores its exact document boundary, and resends the unchanged prompt with its
original mode/scope. The original answer, run, and patches remain preserved;
the new branch is labelled `regenerated`. Typecheck, 222 tests, production
build, EU3 edit/regenerate management, and EU5 native-menu smokes pass.

**codex, 2026-07-29** — the chat header now has stable visual hierarchy:
conversation identity plus New/Usage icons on the first row, model and context
scope on the second, and an optional one-line context manifest below. Edited
and regenerated suffixes render as branch badges rather than title text. EU3
guards row geometry, usage toggling, branch badges, and the existing
conversation lifecycle; typecheck, 222 tests, build, and EU5 remain green.

**codex, 2026-07-30** — implemented the first coherent G2 references slice.
The project-root `references.csl.json` is canonical and SQLite is a rebuildable
search projection. One Cite palette handles empty-library import, search, and
insertion; rendered markers can be double-clicked and replaced through the same
flow, while raw mode inserts the same Pandoc syntax through the command
shortcut. CSL JSON, BibTeX, and RIS import preserve converted records and report
duplicates/key conflicts. PDF and office export now invoke citeproc
automatically and warn on unresolved keys. A dedicated Electron smoke covers
BibTeX import, rendered/raw insertion, replacement, and bibliography-bearing PDF
round-trip. Reference-detail editing and export-time CSL style selection remain.

**codex, 2026-07-30** — closed the empty-library citation gap without adding a
reference-manager surface. The Cite palette now offers Add reference beside
Import. A compact form needs only a title, generates a visible/editable citation
key from author/year, and immediately saves and cites the CSL record. Optional
DOI lookup uses Crossref’s public single-work endpoint to prefill editable core
fields while retaining journal, publisher, volume, issue, page, and identifier
metadata in the canonical record. Only the DOI leaves the machine; lookup
failure falls back to the same offline form. Exact duplicate DOIs reuse the
existing project record. The citation smoke now starts from an empty library,
manually creates/cites a record, then combines it with imported references and
verifies the shared exported bibliography.

**owner/codex, 2026-07-30** — set a boundary for later citation work: keep the
built-in reference UI simple and deterministic, and handle complex batch
reconciliation, metadata repair, and cross-document citation normalization
through custom agent workflows. Such workflows must propose reviewable
structured reference/document changes through application-owned validation and
apply paths; they do not get raw filesystem access or mutate
`references.csl.json` directly.

**codex, 2026-07-30** — added a compact export preflight for citation styles.
Projects remember Chicago author-date, APA 7, IEEE, or Elsevier Vancouver;
journal-specific requirements use a validated custom CSL file copied into
`.texeris/` for portable repeat exports. Citeproc receives the explicit style
for PDF/DOCX/ODT/RTF while canonical Markdown remains unchanged. The renderer
never receives a style path, and the permanent workspace gains no new panel.

**codex, 2026-07-30** — implemented the first G3 local writing archive slice.
The workspace-global archive keeps immutable imported bytes and Markdown/text
derivatives with original-path provenance, change/missing status, hashes,
duplicate detection, passage segmentation, and SQLite FTS5. A compact activity-
rail panel supports import, search, source preview, predictable deletion,
explicit “Use in chat” attachments, and archive-selected writing-profile
builds. Chat manifests persist passage IDs through edit/regenerate rewind; raw
saved passages, not highlighted snippets, enter model context. Embeddings, OCR,
tags, folder watching, and automatic retrieval remain deliberately deferred.

**codex, 2026-07-30** — closed the lifecycle-integrity audit findings. Window
close and every project-picker/switch route now await editor typing, image
uploads, and canonical commits; failures preserve the current window/project.
Project candidates, watchers, runtime cancellation, and database ownership are
handed off in a safe order. Canonical Markdown paths are confined against
traversal and symlink escape across document/revision/export/asset services.
Submitted prompts and running-run boundaries persist transactionally before
provider work, with interrupted runs marked aborted on restart. New asset
leases protect upload-before-reference races and startup removes abandoned
uploads. Failure-mode tests cover provider rejection, restart interruption,
tampered paths, upload/typing composition, and manager handoff; real Electron
smokes cover immediate close and picker-mediated immediate project switch.
Typecheck, 247 tests (6 skipped), production build, both targeted desktop
smokes, and an independent post-fix review pass.

**codex, 2026-07-30** — rewrote the seeded `welcome.md` around a first real
writing session instead of a feature inventory. It now leads from
`manuscript.md` through autosave and the two editor views, scoped assistant
work and reviewable patches, conversation branching, history/checkpoints,
citations, and explicit local archive attachments, ending with only the
essential controls. Existing user-owned `welcome.md` files remain untouched.
Typecheck, 247 tests (6 skipped), production build, and the EU7 new-project
onboarding smoke pass.

**codex, 2026-07-30** — added a bounded archive repair surface before moving
to G4 skills. The Archive header can now rebuild its disposable FTS5 projection
atomically from stored source/passage rows in a cancellable worker. Passage IDs
do not change, preserving archive attachments and historical chat manifests.
A corruption test replaces the index with false content and verifies that
re-index removes it and restores real search results with the original passage
identity; the archive desktop smoke covers the renderer/preload/main/worker
path. Also recorded the later searchable Help system as shipped Markdown with
contextual entry points, keeping `welcome.md` brief. Typecheck, 248 tests
(6 skipped), production build, and archive smoke pass.

**codex, 2026-07-30** — implemented the first G4 product skill: Conservative
Rewrite v1. Ctrl+K exposes a compact launcher for selection, section, or whole-
document scope; users choose Light copy-edit, Shorten, Improve flow, or Reduce
repetition and may override Fast with Deep. Skill conversations persist an
exact version and fail closed when it is unavailable. The runtime now filters
the actual Pi tool set to each skill's allow-list, while prose mutations remain
reviewable patches. Prompt and JSON fixtures protect qualifications, citations,
specialist terms, no-op behaviour, and scope boundaries. Unit coverage checks
tool/version failures; the offline patch smoke now covers command discovery,
launcher Escape/launch, review, apply, and undo.

**codex, 2026-07-30** — added the second G4 product skill, an audit-first LLM
verbal-tick review. The shared launcher offers Audit first (numbered findings,
no initial patch) and Audit + rewrite clear cases for selection, section, or
whole-document scope. The prompt judges repetition and function in context,
never infers AI authorship, and explicitly protects legitimate disciplinary
language, qualifications, citations, negation, and logical structure. Users
can request selected numbered findings in the persisted conversation; all
changes remain ordinary reviewable patches. Balanced fixtures include three
real findings and three false-positive/no-finding cases. A dedicated findings
database/UI and deterministic phrase scanner remain deferred. Typecheck, 257
tests (6 skipped), production build, and the combined skill/patch desktop smoke
pass.

**codex, 2026-07-30** — made the configured macOS packaging path real. Pinned
Pandoc 3.10 preparation now supports checksum-verified Apple Silicon and Intel
archives as well as Linux, and packaged-resource inspection resolves the
native `.app` layout. A manual GitHub Actions matrix builds unsigned DMG and
ZIP artifacts on native arm64 and x64 macOS runners, inspects bundled Pandoc
and CSL resources, emits SHA-256 manifests, and uploads both architecture
sets. Linux x64 AppImage packaging and resource verification remain green.

**kimi, 2026-08-08** — back; hit a scope collision on queue item 8: I built a
full rewind implementation (global turn/checkpoint picker, end-of-turn
boundary columns, run-copying fork) on `kimi/rewind` while codex's
edit-message rewind was landing on main (PRs through #25). Closed PR #26
unmerged with a comparison comment; the branch stays for reference. Owner
arbitration: main's per-message model stands. Salvaged the owner-requested
complement as a fresh PR: checkpoints gain an optional short description
(migration 0007, `CheckpointInfo.description`, HistoryPanel form/display,
IPC schema) so history/rewind pickers stay scannable. Note for both agents:
check agent-notes + origin/main before starting queued items — the queue
moved fast this cycle (items 8–10 all closed by codex).

**kimi, 2026-08-08** — two items landed. (1) PR #28: fixed a first-patch
catch-22 found in the owner's 2026-07-30 session log — propose_patch required
baseRevision >= 1 while PatchService enforced <= current, so an empty
(revision 0) document could never receive its first agent edit; base 0 is now
valid exactly when current is 0. (2) Checkpoint UX per owner direction:
names/descriptions are now generated at creation (tip revision summary +
timestamp), rename is inline in HistoryPanel, and the checkpoint section is
collapsed by default since manual naming is rare. New smoke:
smoke-checkpoint.mjs.

**kimi, 2026-08-08** — checkpoint descriptions are now LLM-generated (owner
follow-up): creation stays instant with the deterministic fallback, then a
background fast-model call (`CheckpointDescriber`, prompt = tip revision
changes capped at 2k chars) rewrites the description and pushes
`texeris:history-event` so HistoryPanel refreshes. Toggle in Settings → "AI
checkpoint descriptions" (`llmCheckpointDescriptions`, default on). Failure
or disabled keeps the fallback. smoke-checkpoint.mjs asserts the replacement
end-to-end via the faux provider.

**codex, 2026-08-27** — refreshed the public project presentation around the
functional application rather than the historical editor spike. The root
README now documents the revision loop, shipped workflows, security and
process boundaries, honest pre-release gaps, local setup, verification, and
two real application screenshots. The patch-review image comes from a live
DeepSeek turn over a realistic academic example; the capture path remains
reproducible through `smoke-live.mjs`, while `smoke-patch.mjs` retains offline
screenshot hooks. Diagnosing intermittent DeepSeek failures reproduced
`UND_ERR_CONNECT_TIMEOUT` outside Texeris; all main, delegated, and patch-style
agent streams now allow two bounded provider retries. The live harness follows
`run_end`, reports provider errors directly, and rejects pending CDP calls when
the window closes instead of ending with an unsettled top-level await.
