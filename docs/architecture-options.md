# Scholarly Writing Workspace — Architecture Options and Initial Recommendations

**Status:** Living architecture record; initial alternatives are retained for
decision history, while implemented outcomes and the current sequence are
called out explicitly
**Primary platforms:** macOS and Linux  
**Assumed application type:** Local desktop application  
**Purpose:** Record structural boundaries, implemented decisions, remaining
options, and expensive-to-change risks

---

## 1. How to use this document

This is not a final technical design. It began as a starting architecture and
now retains those alternatives alongside implemented outcomes. Current
delivery priorities live in [`development-plan.md`](development-plan.md).

The most important architectural objective is not to choose the perfect framework. It is to preserve the ability to change product decisions after real use. The architecture should therefore establish a few strong boundaries while avoiding elaborate abstractions for unproven features.

A useful distinction:

- **Structural decisions:** Expensive to change and worth considering early.
- **Default choices:** Reasonable starting points that can be replaced.
- **Deferred choices:** Should not be decided until a workflow requires them.

---

## 2. Architectural goals

### 2.1 Required qualities

- Runs well on macOS and Linux.
- Supports a high-quality text editor.
- Provides local file and database access.
- Can embed or communicate with a TypeScript agent framework such as Pi.
- Can run external conversion tools such as Pandoc.
- Preserves document integrity during AI and user editing.
- Supports inspectable revision history and patch application.
- Keeps the UI responsive during model calls, indexing, export, and agent jobs.
- Makes it possible to replace models, providers, or the agent harness.
- Can evolve from a personal tool without needing a complete rewrite.

### 2.2 Non-goals for the first architecture

- Distributed multi-user collaboration.
- Cloud-native storage.
- Mobile clients.
- Microservices.
- A general plugin marketplace.
- A universal scholarly data model.
- Perfect isolation of untrusted third-party code.
- Real-time collaborative CRDT design.

---

## 3. Decisions worth protecting early

Several boundaries are more important than the exact libraries used.

## 3.1 Application owns document state

The editor and persistence layer are authoritative. The agent never receives unrestricted permission to rewrite project files behind the application's back.

The agent may:

- Read document content through application tools.
- Read explicitly permitted project or archive content.
- Propose patches against a base revision.
- Add comments or reports through application tools.
- Request deterministic export or reference operations.

The application validates and applies changes.

This boundary enables review, undo, conflict detection, model replacement, and testing.

## 3.2 Separate document content from derived indexes

The canonical document should remain recoverable without search indexes, embeddings, model caches, or conversation summaries.

Derived data may include:

- Full-text indexes.
- Embeddings.
- Generated section summaries.
- Style-analysis results.
- Search caches.
- Model token estimates.

Any derived data should be rebuildable.

## 3.3 Agent framework behind an internal interface

Pi is a sensible initial engine, especially because it is TypeScript-based and supports SDK embedding, tools, extensions, providers, and on-demand skills. The rest of the application should nevertheless communicate with it through an internal service interface.

For example:

```ts
interface AgentRuntime {
  startTurn(input: AgentTurnInput): AsyncIterable<AgentEvent>;
  runJob(input: AgentJobInput): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
}
```

Application code should not depend everywhere on Pi-specific session or event types. A thin adapter is enough; a large generic framework is not needed.

## 3.4 Patches are structured internally

Unified diff is useful for display and logs, but the internal edit representation should be structured enough to validate and apply safely.

A patch should include:

- Document identifier.
- Base revision.
- Ordered change groups.
- Expected old text or contextual anchors.
- Replacement text.
- Skill or request origin.
- Optional explanation.

The exact operation format can evolve.

## 3.5 Rendered and raw modes share one canonical document

The default visual editor and the raw Markdown editor must not become separate documents that can drift. They should share one canonical representation, one revision history, and one patch protocol. The implementation may use an intermediate editor model, but conversion must be deterministic, testable, and loss-aware.

## 3.6 Skills have contracts

A skill should be more than a prompt file. Even when implemented through Pi skills, the application should know basic metadata:

- Stable skill ID.
- Name and description.
- Expected input scope.
- Default model mode.
- Allowed tools.
- Expected result types.
- Whether it may propose document changes.
- Whether it may access the web.
- Whether it may operate across an entire project.

This makes skills easier to present, test, and constrain.

---

## 4. Recommended starting architecture

A reasonable first implementation is:

```text
┌─────────────────────────────────────────────────────────────┐
│ Electron application                                        │
│                                                             │
│  Renderer process                                           │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ React or similar UI                                   │  │
│  │ Rendered Markdown editor behind an editor adapter     │  │
│  │ Chat, patch review, project navigation               │  │
│  └───────────────────────────┬───────────────────────────┘  │
│                              │ narrow typed IPC              │
│  Main process                ▼                               │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Project service                                       │  │
│  │ Document/revision service                             │  │
│  │ Reference service                                     │  │
│  │ Archive/index service                                 │  │
│  │ Settings and credential service                      │  │
│  │ Job coordinator                                       │  │
│  └───────────────┬───────────────────┬───────────────────┘  │
│                  │                   │                      │
│          utility/worker       utility/worker                │
│          Agent runtime        Pandoc/indexing                │
│          Pi adapter           extraction/export             │
└─────────────────────────────────────────────────────────────┘

Local project files + SQLite application/project database
External model providers and optional online research services
```

This is a starting shape, not a requirement to create a large service architecture. The “services” can initially be ordinary TypeScript modules with clear ownership.

---

## 5. Desktop shell: Electron versus Tauri

## 5.1 Electron as the initial default

Electron is a pragmatic initial choice because:

- The UI, desktop integration, and agent runtime can all be written primarily in TypeScript.
- It embeds Chromium and Node.js and officially targets macOS and Linux as well as Windows.
- Its main/renderer process model fits an application where privileged file operations should be separated from the editor UI.
- Utility processes or workers can host agent and conversion work away from the renderer.
- The ecosystem for editors, React, packaging, debugging, and Node-based libraries is mature.

The main cost is application size and memory use. For a personal academic tool, development speed and ecosystem compatibility may matter more initially.

### Electron recommendation

Use Electron unless early testing reveals a concrete problem that Tauri solves. Keep desktop-shell APIs behind a small boundary so the choice is not spread throughout the codebase.

## 5.2 Tauri as a credible alternative

Tauri 2 uses system webviews and a Rust host. It supports macOS and Linux and can produce smaller applications. It may become attractive when:

- Binary size and idle memory are important.
- A Rust core is desirable for indexing or file operations.
- The team is comfortable maintaining Rust and platform-webview differences.
- The agent runtime can run cleanly as a sidecar or separate process.

Potential costs for this product:

- Pi and much of the likely application stack are TypeScript-first.
- A Node-based agent or tool ecosystem may require a bundled sidecar or an additional runtime boundary.
- System webviews can produce more platform variation than an embedded Chromium version.
- Packaging external tools and resolving environment paths still require care.

### Tauri recommendation

Do not optimise for Tauri before the product loop is proven. Revisit after measuring Electron's actual footprint and packaging experience.

## 5.3 Preserve optionality

Regardless of shell:

- Keep renderer code as ordinary web application code.
- Keep filesystem and database APIs behind typed application services.
- Avoid importing Electron APIs directly throughout UI components.
- Treat agent communication as messages/events rather than in-process UI calls.

This does not make shell migration cheap, but it prevents needless coupling.

---

## 6. Renderer and UI framework

## 6.1 UI framework

React with TypeScript is a reasonable default because of ecosystem support and developer familiarity. Alternatives such as Solid, Svelte, or Vue could also work.

This decision is reversible if application logic is kept outside presentation components, but changing UI frameworks later would still be substantial. Choose the framework the developer can iterate fastest in.

## 6.2 Editor choice is an early product risk

The default editor is expected to render Markdown into a restrained, word-processor-like surface while still offering a complete raw Markdown mode. That makes the editor choice less obvious than it would be for a conventional Markdown source editor.

Two approaches are credible.

### Option A: CodeMirror 6 with a live rendered layer

CodeMirror remains a text editor whose authoritative state is Markdown. Extensions, syntax trees, decorations, replaced ranges, and widgets can make headings, emphasis, links, citations, footnotes, and other constructs appear rendered in place. Markup can be hidden when the cursor is elsewhere and revealed when editing the relevant span.

Advantages:

- The canonical Markdown and the active editor document are the same text.
- Transactions and change descriptions map naturally to revision history and AI patches.
- Raw Markdown mode is straightforward.
- Unsupported or unusual Markdown remains editable rather than being discarded by a schema.
- Citation and patch ranges remain comparatively easy to express as text positions.

Risks:

- Achieving genuinely natural word-processor behaviour may require substantial custom work.
- Hidden syntax can create surprising cursor movement, selection, deletion, and copy/paste behaviour.
- Tables, nested structures, footnotes, inline widgets, and input-method composition need careful testing.
- The result may still feel like a beautified source editor rather than a document editor.

### Option B: ProseMirror or Tiptap for rendered mode

A structured rich-text editor can provide more conventional document editing behaviour. Markdown is parsed into an editor document model and serialized back to the canonical format. Raw mode can use CodeMirror or another text editor over the same canonical content.

Advantages:

- Headings, emphasis, lists, quotations, links, and tables naturally behave as document structures.
- The default surface is more likely to feel familiar to a Word user.
- Rich selection, commands, input rules, and block manipulation are mature concepts in the editor model.

Risks:

- Markdown parse/serialize round-tripping becomes a critical correctness boundary.
- Unsupported Markdown, custom citation syntax, comments, and footnotes require schema extensions.
- Switching modes may expose normalization changes unless serialization is exceptionally disciplined.
- AI patches expressed against Markdown text must be mapped into the rich editor state, or applied through a controlled serialize/patch/reparse cycle.

### Suggested decision process

Do not settle this choice from architectural preference alone. Build a small disposable spike for both approaches using representative academic material:

- Several pages of prose with nested headings.
- Emphasis and links.
- Bulleted and numbered lists.
- Footnotes.
- Pandoc citation markers.
- A table.
- AI insertion, deletion, and replacement patches.
- Switching repeatedly between rendered and raw modes.

Test the spike with the actual user. Prefer CodeMirror if its rendered mode feels sufficiently natural, because it keeps Markdown, revisions, and patches simple. Prefer ProseMirror/Tiptap if the CodeMirror version still feels materially like editing source code.

**Outcome (2026-07-19):** the spike (`spikes/editor/`) was built for both approaches and evaluated by the user. **Tiptap was chosen** — the CodeMirror rendered layer still felt like editing source (most visibly, tables never render as tables), while Tiptap felt like a document editor. The Markdown⇄ProseMirror round trip is the accepted cost: the spike demonstrated byte-exact round trips for the supported profile, guarded going forward by round-trip tests over golden samples and a normalization warn badge. Two pieces of evaluation feedback carry into the product: patch review needs an obvious visual indication of what changes where, plus reversibility of accepted patches; and rendered citations should be text-like, tinted, and editable rather than opaque pill widgets.

Whichever implementation is chosen, put it behind an internal editor adapter. The rest of the application should consume concepts such as current canonical text, selection, transaction/change events, decorations, commands, and patch application rather than importing one editor library throughout the codebase.

Monaco remains a possible source-mode or diff-view component, but is likely too code-oriented for the default writing surface. A custom `contenteditable` implementation is not recommended because cursor, selection, undo, composition, accessibility, and cross-platform behaviour become product-sized problems.

## 6.3 Rendered and raw editing modes

The two modes are views of one canonical document.

**Rendered mode is the default.** It should:

- Render headings with hierarchy and spacing.
- Display emphasis without persistent Markdown punctuation.
- Lay out lists and block quotations conventionally.
- Render links as readable text while preserving access to the destination.
- Display citations as chips or compact references.
- Provide usable footnote and table interactions where supported.
- Show AI patch highlights and comments without exposing implementation syntax.
- Avoid simulating final printed pages unless a separate preview is opened.

**Raw Markdown mode** should:

- Show the complete source without hidden syntax.
- Support ordinary source editing, search, and precise troubleshooting.
- Use the same revision history, autosave, and AI context as rendered mode.
- Make unsupported constructs recoverable even if rendered mode cannot edit them elegantly.

Mode switching should not itself change document content. If parsing or serialization would normalize or lose text, the application should warn, preserve the original, or keep the affected region in a source-only representation rather than silently rewriting it.

The user may benefit from a hybrid behaviour in rendered mode where markup becomes temporarily visible around the cursor. This is a usability hypothesis to test, not a requirement.

## 6.4 State management

Do not begin with a large application state framework unless needed.

A likely split:

- The editor adapter owns active editor state and exposes canonical text plus normalized change events.
- A query/cache layer manages asynchronous data from the main process.
- Small local stores manage panel state, current project, active conversation, and UI preferences.
- Persisted domain state lives in the main process and storage layer, not only in renderer memory.

---

## 7. Electron process boundaries

Electron uses a main process and one or more renderer processes. The renderer should be treated as an unprivileged UI environment.

## 7.1 Main process responsibilities

- Window and application lifecycle.
- Project opening and closing.
- Filesystem access.
- Database access.
- Settings and credentials.
- Document locks and external-change detection.
- Starting and stopping utility processes.
- Coordinating exports and agent jobs.
- Exposing a narrow IPC API through a preload bridge.

## 7.2 Renderer responsibilities

- Displaying and editing text.
- Collecting commands and chat messages.
- Rendering diffs and reports.
- Displaying job progress.
- Requesting operations through typed IPC.

The renderer should not receive unrestricted Node.js access.

## 7.3 Utility processes or workers

Potential separate execution contexts:

- Pi agent runtime.
- Pandoc export.
- PDF/DOCX text extraction.
- Archive indexing.
- Embedding generation.

Not all of these need separate processes initially. The principle is to move long-running, crash-prone, or CPU-heavy work away from the renderer and, where useful, away from the main process.

A minimal version might run the Pi adapter in the main process and move it later. If model streaming or tool execution begins to interfere with app responsiveness, a utility process becomes worthwhile.

## 7.4 Typed IPC

Define a small set of request/response and event contracts. Examples:

```ts
type AppRequest =
  | { type: "project.open"; path: string }
  | { type: "document.read"; documentId: string }
  | { type: "document.commitChanges"; input: CommitChangesInput }
  | { type: "agent.startTurn"; input: AgentTurnInput }
  | { type: "patch.apply"; patchId: string; groups?: string[] }
  | { type: "export.run"; input: ExportInput };
```

Treat renderer-to-main requests as untrusted and decode them at runtime in
main; TypeScript types alone do not protect that process boundary. Decode
main-to-renderer push events in preload when they trigger renderer actions or
state changes. Ordinary invoke responses and streaming chat display events
originate in trusted main code and remain statically typed; any renderer
request they lead to is decoded again in main. This is the current trust model,
not a claim that every value crossing IPC is redundantly decoded.

## 7.5 Native context menus

Electron's main process owns platform context-menu construction. On a native
`webContents` context event it asks the sandboxed renderer for a narrow typed
descriptor of the target (generic editor, image, document, conversation, or
message), validates the reply, and combines it with Electron's trusted edit,
selection, link, and spelling metadata. Privileged operations such as opening
external links, replacing misspellings, and copying image pixels remain in the
main process. Domain actions return as typed renderer events and reuse the
same handlers as explicit ellipsis launchers. This keeps native behaviour
without granting the renderer Node or arbitrary menu authority.

---

## 8. Project storage model

Two broad approaches are plausible.

## 8.1 Option A: file-centric projects

Example:

```text
my-paper/
  manuscript.md
  notes.md
  references.csl.json
  style.md
  sources/
  .scholar-workspace/
    project.json
    history.sqlite
    conversations.sqlite
    cache/
```

### Advantages

- The user's core documents are ordinary files.
- Git and external tools can inspect them.
- Recovery is straightforward.
- Markdown remains portable.
- Export and command-line tooling are easy to integrate.

### Costs

- External edits and file watching must be handled.
- Atomic multi-file operations require care.
- Some metadata lives beside the documents.
- Moving or renaming files can complicate identifiers.

## 8.2 Option B: database-centric projects

All document content and history live in SQLite; files are exported or materialised when needed.

### Advantages

- Strong transaction boundaries.
- Simple revision linkage.
- Easier querying across project entities.
- No external-edit conflicts unless explicitly supported.

### Costs

- User documents are less transparent.
- Recovery and interoperability depend on the application.
- External editors and Git are harder to use.
- Export must be treated as a first-class workflow.

## 8.3 Suggested starting position

Prefer a hybrid, file-centric model:

- Markdown files and reference/style files are canonical or easily recoverable.
- SQLite stores history, conversations, indexes, jobs, checkpoints, and derived metadata.
- The application writes files atomically.
- The database stores file hashes and known versions.
- External changes are detected and imported as revisions.

This is a default, not an irreversible commitment. A prototype may initially keep everything in SQLite if that accelerates the revision loop. Before real projects accumulate, choose and document the canonical source of truth.

## 8.4 Project format versioning

Include a project format version from the beginning. Migrations can remain simple, but the application should know how to distinguish versions.

Example:

```json
{
  "formatVersion": 1,
  "projectId": "...",
  "title": "...",
  "mainDocument": "manuscript.md"
}
```

---

## 9. SQLite usage

SQLite is a strong fit for local project and workspace metadata.

Potential uses:

- Documents and stable IDs.
- Revision metadata.
- Change groups or snapshots.
- Conversations and messages.
- Agent runs and events.
- Checkpoints.
- Reference indexes.
- Archive metadata.
- Full-text search through FTS5.
- Settings that belong to a project or workspace.

Write-ahead logging may be useful for responsive local reads and writes, but configuration should be tested with the application's actual process model and backup behaviour.

## 9.1 Keep the schema ordinary

Avoid an overly generic entity system. Initial tables can be explicit:

```text
projects
documents
revisions
revision_changes
checkpoints
conversations
messages
agent_runs
agent_events
patches
patch_groups
archive_documents
references
```

Not all tables are required immediately.

## 9.2 Snapshots versus event reconstruction

### Pure event sourcing

Store every edit operation and reconstruct the document.

- Powerful audit trail.
- Complex recovery and migration.
- Unnecessary for an initial personal editor.

### Full snapshot per revision

Store the complete document after every grouped change.

- Very simple.
- Potentially wasteful, though text compresses well and personal project sizes may remain manageable.

### Hybrid recommendation

- Store grouped changes for recent history.
- Store periodic full snapshots.
- Store named checkpoints as durable snapshots.
- Allow compaction of old low-level typing revisions while preserving meaningful events.

Begin with the simplest reliable implementation. Storage efficiency is unlikely to be the first bottleneck.

---

## 10. Revision and change model

## 10.1 Editor transaction capture

The selected editor should expose transactions or normalized change events that the application can group into revisions. CodeMirror provides text transactions and change descriptions directly; ProseMirror/Tiptap provides document transactions that would need to be translated into canonical Markdown changes or another stable revision representation. With Tiptap selected (§6.2), the spike-proven approach is to serialize and line-diff at group-commit time rather than per keystroke: PM steps do not map to Markdown ranges, and an O(document) diff per revision group is acceptable at manuscript scale.

Possible grouping signals:

- Idle time after typing.
- Selection or cursor discontinuity.
- Paste operation.
- Command execution.
- Structural edit such as moving a paragraph.
- AI patch application.
- Manual save or checkpoint.

The correct grouping will require testing. Preserve low-level data temporarily if it helps refine the grouping algorithm.

## 10.2 Proposed revision record

```ts
interface Revision {
  id: string;
  documentId: string;
  parentRevisionId?: string;
  actor: "user" | "agent" | "external" | "system";
  source?: {
    conversationId?: string;
    agentRunId?: string;
    patchId?: string;
    skillId?: string;
  };
  createdAt: string;
  summary?: string;
  contentHash: string;
}
```

This is illustrative, not a required schema.

## 10.3 What the agent needs between turns

Do not blindly send the full revision log. Build a context item such as:

```text
Changes since the agent last read this document:
- User softened two causal claims in the current section.
- User rejected the phrase “plays a pivotal role.”
- User restored a limitation concerning sample size.
- The conclusion paragraph was moved after the comparison paragraph.
```

For precise patch reasoning, include the actual current text and selected recent diffs. For preference learning, include a higher-level summary.

The summarisation may initially be deterministic for simple changes and model-assisted for complex changes.

## 10.4 Accepted, modified, and rejected patches

Record at least:

- Patch proposed.
- Patch accepted unchanged.
- Patch partially accepted.
- Patch rejected.
- Accepted text later modified.
- Accepted text later reverted.

These states are valuable for product evaluation and future style-profile suggestions.

---

## 11. Patch format and application

## 11.1 Requirements

A patch system should:

- Verify the base revision.
- Identify expected old content.
- Apply multiple ordered changes.
- Detect overlapping changes.
- Support partial acceptance.
- Produce a readable diff.
- Fail safely when anchors no longer match.

## 11.2 Possible internal representation

```ts
interface DocumentPatch {
  id: string;
  documentId: string;
  baseRevisionId: string;
  title: string;
  summary?: string;
  groups: PatchGroup[];
}

interface PatchGroup {
  id: string;
  explanation?: string;
  changes: TextChange[];
}

interface TextChange {
  from: number;
  to: number;
  expectedText: string;
  insert: string;
  prefixContext?: string;
  suffixContext?: string;
}
```

Character offsets are convenient when the base revision is exact. Context anchors help when attempting a safe rebase.

## 11.3 Canonical patch coordinates and editor mapping

Prefer to define AI patches against a known canonical document revision rather than against transient rendered DOM positions. A text-backed editor can usually apply those changes directly. A structured editor needs an adapter that can either map Markdown ranges to document positions or safely serialize, apply, reparse, and restore the user's selection.

This mapping is one of the criteria for the editor spike. It is more important than small differences in toolbar convenience.

## 11.4 Display versus storage

- Store structured operations and the base revision.
- Generate unified or word-level diff for display.
- Optionally store the rendered diff for audit/debugging, but do not make it authoritative.

## 11.5 Rebase policy

Start conservatively:

1. Exact base revision: apply after validation.
2. Different revision with unchanged target spans: rebase automatically.
3. Non-overlapping changes with strong anchors: offer rebased preview.
4. Ambiguous overlap: mark conflict and ask the agent to regenerate against current text.

Do not build a sophisticated merge engine before actual conflict patterns are observed.

## 11.6 Patch size

Large whole-document patches are hard to review. Skills should prefer semantic groups such as one paragraph or one issue per group.

The UI may collapse low-risk repetitive changes while highlighting substantive ones. This is a product experiment rather than a hard architecture requirement.

---

## 12. Agent runtime and Pi integration

Pi's current project provides an agent runtime, multi-provider model support, SDK embedding, custom tools/extensions, and on-demand skills. That makes it a strong initial fit.

The canonical Pi repository is <https://github.com/earendil-works/pi> (MIT). Relevant packages: `@earendil-works/pi-ai` (unified multi-provider LLM API), `@earendil-works/pi-agent-core` (agent runtime with tool calling and state management), `@earendil-works/pi-coding-agent` (CLI) and `@earendil-works/pi-tui`. Note that Pi includes no built-in permission system — it runs with the launching process's permissions — so the domain-specific tool boundary (§12.2) and the process isolation decisions (§7) carry the full weight of constraining agent behaviour.

## 12.1 Integration options

### Option A: Pi SDK in an Electron process

- Import Pi packages directly.
- Create sessions programmatically.
- Register application tools.
- Stream events to the renderer.

**Advantages:** Simple TypeScript integration and direct access to APIs.  
**Costs:** Agent lifecycle and application lifecycle share a runtime unless separated.

### Option B: Pi RPC/child process

- Launch Pi or an adapter as a child/utility process.
- Communicate over JSON-RPC or another message protocol.

**Advantages:** Crash isolation, easier upgrades, clearer resource boundary.  
**Costs:** More protocol and process-management work.

### Suggested progression

Begin with the SDK behind an internal `AgentRuntime` adapter. Move it to a utility process when there is a demonstrated reason, or begin there if the developer already has a reliable process/RPC pattern.

## 12.2 Application tools exposed to the agent

Initial tools might include:

```text
get_active_context
read_document
read_document_range
read_revision_changes
search_project
search_archive
read_style_profile
list_references
get_reference
propose_patch
add_comment
create_report
run_reference_audit
run_export
web_search          (later/permissioned)
fetch_web_page      (later/permissioned)
```

Avoid exposing unrestricted filesystem and shell tools as the default writing-agent interface. Pi can remain extensible while the product defines safer, domain-specific tools.

## 12.3 Agent event stream

The UI benefits from a normalised event stream:

```ts
type AgentEvent =
  | { type: "run.started"; runId: string }
  | { type: "message.delta"; text: string }
  | { type: "tool.started"; tool: string; callId: string }
  | { type: "tool.completed"; callId: string; summary?: string }
  | { type: "patch.proposed"; patchId: string }
  | { type: "report.created"; reportId: string }
  | { type: "run.completed"; usage?: Usage }
  | { type: "run.failed"; error: PublicError };
```

Normalising events prevents UI code from becoming tightly coupled to one provider or Pi release.

## 12.4 Session persistence

Persist application-level conversations independently of Pi's native session format. Pi-specific session data may be retained for continuity or debugging, but the product should be able to reconstruct a conversation and relevant context from its own records.

User-message editing is the first conversation/document rewind surface. Each
persisted user message stores a compact, application-owned turn context: model
mode, scope, document id, base revision, and the change count within that
revision. The change count matters because recent typing can amend the tip
revision after a turn starts. Saving an edited message copies only earlier
transcript messages into a new conversation, records the fork origin, restores
the scoped document as a new append-only revision, and resends with the
original mode and scope. Runs, delegations, corpus grants, and patches are not
copied; pending patches remain visibly attributable to the preserved original
conversation. Regenerating the latest completed assistant response uses this
same operation at its preceding user message without changing the prompt; the
fork is labelled `regenerated` and the original response remains available.
Checkpoints remain document-only until a demonstrated workflow requires linking
them to conversation boundaries.

## 12.5 Context assembly

Create a context-building layer that takes:

- User message.
- Selected context scope.
- Active document revision.
- Project instructions.
- Style profile.
- Recent relevant edits.
- Pinned sources or archive passages.
- Skill instructions.
- Model limits.

It returns:

- Model messages or Pi session input.
- A manifest of included items.
- Truncation or summarisation notices.

The context manifest should be stored with the run for reproducibility and debugging.

---

## 13. Model abstraction

The product has only two primary modes, but configuration should remain provider-independent.

```ts
interface ModelModeConfig {
  mode: "fast" | "deep";
  provider: string;
  model: string;
  reasoning?: string;
  maxOutputTokens?: number;
}
```

## 13.1 Routing

- Each skill declares a default mode.
- The user can override it.
- Ordinary chat remembers the current mode or uses a project default.
- Deterministic operations should not call a model merely because one is available.

## 13.2 Usage records

Record enough information to understand cost and regressions:

- Provider/model identifier.
- Mode.
- Token or usage estimates when available.
- Duration.
- Skill.
- Context size.
- Outcome state.

This can remain local.

## 13.3 Provider credentials

Store credentials using the operating system's secure credential facility where practical, or rely on Pi/provider authentication mechanisms behind the runtime adapter. Avoid writing raw API keys into project files.

---

## 14. Skill architecture

## 14.1 Skill package shape

A skill may include:

```text
remove-llm-ticks/
  skill.json
  SKILL.md
  examples/
  tests/
  scripts/          (optional)
  defaults.json     (optional)
```

Illustrative metadata:

```json
{
  "id": "remove-llm-ticks",
  "name": "Remove LLM verbal ticks",
  "version": 1,
  "defaultModelMode": "fast",
  "allowedTools": [
    "read_document",
    "read_style_profile",
    "search_archive",
    "propose_patch",
    "create_report"
  ],
  "resultTypes": ["report", "patch"],
  "supportsScopes": ["selection", "section", "document"]
}
```

Pi's own skill mechanism can load the instructions; application metadata supports UI, permissions, and testing.

## 14.2 Skill result contracts

Prefer structured outputs through tools rather than hoping the model formats prose correctly.

Examples:

- `propose_patch(...)`
- `create_finding_report(...)`
- `suggest_style_profile_patch(...)`
- `create_reference_audit(...)`

The final conversational message can summarise the structured result.

## 14.3 Skill versioning

Record the skill version with every run. Prompt and tool changes can alter behaviour as much as code changes.

## 14.4 Skill tests

Each skill should have:

- Small deterministic unit tests for parsers or scripts.
- Golden examples for expected output shape.
- Model evaluations on representative passages.
- Regression examples from actual failures.

Do not require a large evaluation platform initially. A directory of cases and a command that runs them against Fast and Deep models is enough.

---

## 15. Architecture of the LLM-verbal-ticks skill

This skill deserves special attention because it is likely to be used often and can easily damage legitimate prose.

## 15.1 Prefer a hybrid pipeline

Possible stages:

1. **Deterministic candidate detection**
   - Known phrases.
   - Repeated transitions.
   - Excessive punctuation patterns.
   - Repeated syntactic templates where detectable.

2. **Model-based contextual review**
   - Determine whether the candidate is actually formulaic in context.
   - Look for patterns that cannot be captured by a phrase list.
   - Compare against style profile and selected previous works.

3. **Structured findings**
   - Location.
   - Category.
   - Confidence.
   - Explanation.
   - Suggested action.

4. **Minimal rewrite generation**
   - Generate patches only for selected or high-confidence findings.

A pure phrase blacklist will have too many false positives. A pure model pass will be inconsistent and harder to evaluate.

## 15.2 Findings schema

```ts
interface StyleFinding {
  id: string;
  documentId: string;
  revisionId: string;
  range: { from: number; to: number };
  category: string;
  confidence: "high" | "medium" | "low";
  excerpt: string;
  explanation: string;
  recommendation: "rewrite" | "delete" | "review" | "allow";
}
```

## 15.3 Preserve author-specific language

The skill can consult:

- Explicit allowlist.
- Explicit discourage list.
- Style profile.
- Frequency in pre-AI or approved previous works.

Archive frequency should be treated as evidence, not an automatic decision. A repeated phrase may be a genuine preference or an old habit the user now wants to change.

## 15.4 Protect meaning and citations

Before accepting a generated rewrite, automated validation can check:

- All citation keys in the original span remain present unless explicitly changed.
- Footnote markers remain present.
- Numerals and named entities have not unexpectedly changed.
- Negation has not disappeared.
- Key qualifiers remain, using heuristic or model comparison.

These checks will not prove semantic equivalence, but they can catch common failures.

## 15.5 User-configurable rules

Keep configuration readable, perhaps in Markdown or YAML:

```yaml
allow:
  - "Taken together"
  - "However"

discourage:
  - "It is important to note"
  - "plays a pivotal role"

preferences:
  em_dash: "rare"
  rhetorical_questions: "avoid"
```

Do not prematurely design a complex rule language.

---

## 16. Citations and references

## 16.1 Text syntax

Pandoc-compatible citation syntax is a good default:

```markdown
This result has been reproduced [@smith2024].

Smith argues the opposite [-@smith2024, p. 14].

Several studies report similar findings [@smith2024; @jones2023].
```

It preserves plain-text portability and allows citation style to change during export.

## 16.2 Editor representation

Use a parser or syntax tree to identify citation spans. In a text-backed editor they can be rendered through decorations or replaced widgets; in a structured editor they can be represented as dedicated inline nodes that serialize deterministically to the Markdown citation marker.

The underlying document remains text. Clicking a marker can open a reference popover or side panel.

## 16.3 Reference storage

CSL JSON is a strong default for structured reference records because Pandoc and CSL processors can consume it.

Implemented arrangement:

```text
references.csl.json
```

**Outcome (2026-07-30):** the project-root CSL JSON file is canonical and
user-inspectable. SQLite’s `reference_index` is only a rebuildable search
projection; a content hash detects external edits and repairs the index before
reads. Imports preserve complete CSL records in the canonical file. This keeps
Pandoc interoperability and recovery independent of Texeris while retaining
fast local search.

Manual creation requires only a title; authors, year, type, DOI, URL, and the
generated citation key remain editable. DOI enrichment is an explicit user
action against Crossref’s public single-work endpoint. Only the DOI is sent;
document text and project metadata stay local. A failed or missing lookup never
blocks manual creation, and successful metadata is copied into the canonical
CSL record rather than becoming a live external dependency.

## 16.4 Parsing and validation

Citation validation should be deterministic:

- Parse marker syntax.
- Extract keys.
- Compare with reference records.
- Identify unresolved and unused records.
- Avoid asking a model to perform operations a parser can do reliably.

## 16.5 Citation formatting

Use Pandoc with citeproc and a chosen CSL style during export. The application can provide a preview, but the canonical manuscript need not contain formatted citation text.

Implemented export settings are deliberately narrow: `.texeris/project.json`
stores the selected style ID, four common CSL styles ship as offline resources,
and a user-selected journal style is validated then copied to
`.texeris/citation-style.csl`. The worker receives only the resolved
application-owned style path and passes it to Pandoc with `--csl`; the
unprivileged renderer never receives filesystem paths. Custom files must be
independent styles containing their formatting rules; dependent CSL aliases
are rejected with a focused message rather than failing later inside Pandoc.

## 16.6 Deferred evidence verification

Do not mix reference resolution with claim verification in the first implementation. Evidence verification requires source acquisition, text extraction, page mapping, and uncertain model judgement. Preserve architecture room for source links later, but do not block the citation-marker feature on it.

Complex citation maintenance is also not a reason to grow the core reference UI
into a full reference manager. Batch reconciliation, metadata repair, and
cross-document normalization can be packaged later as custom agent workflows.
They should operate through domain-specific reference audit/proposal tools and
produce reviewable structured changes against the canonical CSL JSON and
document revisions. The application remains responsible for validation and
apply; an agent never mutates either file directly.

---

## 17. Markdown and Pandoc

Pandoc's Markdown supports academic features including footnotes, citations, tables, metadata, math, and conversion to multiple output formats. It is a suitable interchange and export foundation.

## 17.1 Define a supported Markdown profile

Do not claim support for every Pandoc extension immediately. Define and test a subset, for example:

- ATX headings.
- Emphasis and strong emphasis.
- Ordered and unordered lists.
- Block quotations.
- Links and images.
- Pipe tables or another chosen table syntax.
- Controlled raw-HTML tables for imported structures that pipe tables cannot
  represent (merged cells, alignment, and multi-paragraph cells).
- Footnotes.
- Citation syntax.
- Inline and display math, possibly later.
- Inline underline as controlled `<u>` markup for word-processor interchange.
- YAML metadata, possibly later.

The parser, editor decorations, preview, and export tests should agree on this profile.

## 17.2 Export process

A typical export job:

1. Save or snapshot the current revision.
2. Validate Markdown and citation keys.
3. Materialise reference data.
4. Select CSL style and optional template/reference DOCX.
5. Run Pandoc in a utility process.
6. Capture stdout, stderr, exit code, and produced files.
7. Return warnings and an artifact path.

## 17.3 Bundled versus system Pandoc

### Bundled Pandoc

- Predictable version.
- Easier support.
- Larger package and platform-specific bundling.

### System Pandoc

- Smaller application.
- Version and availability vary.
- GUI applications on macOS and Linux may not inherit the user's shell PATH as expected.

A personal prototype can use a configured system Pandoc. Texeris now uses that
only as a development convenience; Linux distributions bundle the pinned
converter so release behaviour is independent of the user's PATH.

### Current PDF derivative path

PDF export deliberately does not depend on a second typesetting engine. The
main process asks the pinned Pandoc build for an HTML fragment, embeds only
allowlisted project-owned images as data URLs, sanitizes the fragment, and
loads the self-contained result in a hidden sandboxed Electron window with
JavaScript disabled and a deny-by-default content security policy. Chromium's
`printToPDF` produces a fixed A4 academic layout and page-number footer. The
result is validated as PDF bytes and atomically renamed into place. This is a
derived snapshot; it cannot mutate the canonical Markdown or revision history.

## 17.4 Golden export tests

Maintain sample manuscripts covering:

- Footnotes.
- Multiple citation forms.
- Tables.
- Quotations.
- Headings.
- Links and images.
- Non-ASCII text.

Generate DOCX, LaTeX, and PDF-related outputs and compare structural expectations after upgrades.

---

## 18. Writing archive and search

## 18.1 Initial full-text search

SQLite FTS5 is a sufficient first search engine for a personal archive.

Ingestion pipeline:

1. Import or reference a file.
2. Extract text.
3. Store metadata and a content hash.
4. Split into searchable sections or passages.
5. Insert into FTS index.
6. Re-index when the source changes.

Search results should return:

- Document title.
- Section or passage.
- Matched excerpt.
- Metadata.
- Stable location if possible.

## 18.2 Passage segmentation

Start with simple boundaries:

- Markdown headings.
- Paragraph groups.
- Page-based chunks for extracted PDFs when page mapping is available.

Do not optimise chunking before observing retrieval failures.

## 18.3 Semantic search later

Embeddings may help with conceptual retrieval but introduce:

- Model selection.
- Re-indexing costs.
- Vector storage.
- Harder-to-explain rankings.
- Potential privacy/provider concerns.

Add semantic search when full-text search demonstrably misses important use cases. A hybrid ranker can combine FTS and embeddings later.

## 18.4 Archive versus current project

Keep them logically separate. Searching “the project” and searching “all previous writing” should be distinct operations with visible scope.

## 18.5 Implemented local archive boundary

The G3 first slice stores workspace-global archive state under the application
workspace directory, separate from project databases and bibliographic
references:

```text
archive/
  archive.sqlite       # source metadata, passages, FTS5 projection
  snapshots/           # immutable imported bytes
  markdown/            # integrity-checked searchable derivatives
```

The Electron main process owns import, conversion, indexing, preview,
retrieval, and deletion. The sandboxed renderer receives only typed archive
records through the preload bridge. Search never adds model context by itself:
the user attaches stable passage IDs, main resolves those IDs to raw saved
passages for the turn, and the context manifest records the IDs. Profile builds
reuse archived snapshots through the existing conversation-scoped corpus grant
path. This intentionally leaves embeddings, live-folder watching, OCR, tags,
and automatic retrieval outside the first slice.

---

## 19. Context construction and token management

## 19.1 Context items

Represent context as typed items rather than one concatenated string:

```ts
type ContextItem =
  | { type: "selection"; documentId: string; revisionId: string; text: string }
  | { type: "section"; documentId: string; heading: string; text: string }
  | { type: "document"; documentId: string; revisionId: string; text: string }
  | { type: "style-profile"; scope: "workspace" | "project"; text: string }
  | { type: "revision-summary"; text: string }
  | { type: "archive-passage"; sourceId: string; text: string }
  | { type: "reference-records"; keys: string[]; data: unknown };
```

## 19.2 Context policies

Each skill may declare a policy:

- Required items.
- Optional items.
- Maximum archive results.
- Whether whole-document context is appropriate.
- Whether revision history is relevant.
- Whether sources may be summarised.

The policy should be overridable by the user.

## 19.3 Truncation strategy

A reasonable order:

1. Preserve system and skill instructions.
2. Preserve the user request.
3. Preserve the active selection or target section.
4. Preserve relevant style rules.
5. Preserve recent direct revision changes.
6. Reduce or summarise broader document context.
7. Drop low-ranked archive results.

Store a manifest showing what was included and omitted.

## 19.4 Section extraction

Markdown headings provide a simple way to locate the current section. Use a Markdown parser rather than only regular expressions once nested structure and code blocks matter.

---

## 20. Reference architecture for project services

Keep initial modules small and explicit.

```text
src/domain/
  projects/
  documents/
  revisions/
  patches/
  conversations/
  references/
  archive/
  styles/
  skills/
  exports/

src/infrastructure/
  sqlite/
  filesystem/
  pandoc/
  pi/
  models/
  ipc/
```

This is an organisational suggestion, not a demand for strict domain-driven design.

### Conversion components

Texeris ships a pinned Pandoc executable with every Linux release and invokes
it only from the main process for user-selected corpus files. Pandoc is the
primary semantic converter for DOCX, ODT, RTF, and HTML: its Markdown output
is the corpus derivative, never a replacement for the original file. The
release build verifies the upstream asset checksum before placing the
executable outside `app.asar`; conversion uses `--sandbox` and does not enable
filters or custom writers.

Word-processor imports extract embedded media into a document-specific
`assets/<document-name>/media/` directory and keep project-relative references
in canonical Markdown. The sandboxed renderer loads only allowlisted image
extensions beneath the active project root through the `texeris-asset:`
protocol; traversal and arbitrary filesystem URLs are rejected. Export gives
Pandoc the project root as its resource path so those images are re-embedded.
Paste and drag/drop use the same layout: the renderer sends validated image
bytes over the narrow preload bridge, the main process writes a content-hashed
asset, and the editor inserts only its project-relative reference. Alt text and
captions are image-node attributes serialized into controlled HTML. Asset
reconciliation runs after canonical revisions and at project open: current
references stay public, files needed only by an older revision move to hidden
`.texeris/asset-trash/`, and files referenced by no actual revision are
removed. Restoring a revision moves its assets back before they are rendered.

PDF is a distinct, lower-fidelity case. The main process uses pinned
`unpdf` 1.6.2 (PDF.js server build) to extract selectable text without a native
binary, rendering, or network access. Imports are capped at 100 MB and 1,000
pages. Editable document imports receive conservative escaped plain Markdown;
corpus derivatives additionally retain `texeris:pdf-page` markers. Texeris
always reports the conversion as lossy and does not infer headings, columns,
tables, or equations. Files with too little selectable text are rejected with
an explicit scanned/image-only explanation; OCR remains deferred.

## 20.1 Document service

Responsibilities:

- Open/read/write documents.
- Track current revision.
- Commit editor changes.
- Create snapshots.
- Detect external changes.

## 20.2 Revision service

Responsibilities:

- Group transactions.
- Store revision metadata and changes.
- Produce diffs and summaries.
- Compare checkpoints.

## 20.3 Patch service

Responsibilities:

- Validate patch schema.
- Check base revision.
- Preview and rebase.
- Apply accepted groups.
- Record outcomes.

## 20.4 Agent service

Responsibilities:

- Build context.
- Start Pi sessions/jobs.
- Register application tools.
- Normalise events.
- Persist run metadata.
- Handle cancellation.

## 20.5 Reference service

Responsibilities:

- Parse citation markers.
- Index reference records.
- Import/export formats.
- Validate keys.
- Prepare data for Pandoc.

## 20.6 Archive service

Responsibilities:

- Import files.
- Extract and segment text.
- Maintain FTS index.
- Search and return passages.

---

## 21. Error handling and recovery

## 21.1 Autosave and atomic writes

- Write to a temporary file and atomically rename where appropriate.
- Keep a recent snapshot in the database or recovery area.
- Never truncate the only copy before a replacement is safely written.

## 21.2 Database transactions

Operations that link document files and database records need careful ordering. A simple approach:

1. Record intended operation.
2. Write the new file atomically.
3. Commit revision metadata.
4. Mark operation complete.

On startup, recover or reconcile incomplete operations.

An alternative is to make SQLite authoritative and materialise files after commit. Choose based on the canonical-data decision.

## 21.3 Crash recovery

On launch:

- Check for incomplete writes.
- Compare known hashes with files.
- Restore unsaved editor buffer if one exists.
- Offer recovery rather than silently choosing a version.

## 21.4 Agent cancellation

Cancellation should stop model streaming and prevent further tool calls where possible. A tool already writing an export or index should either complete atomically or roll back.

---

## 22. Security boundaries for a personal tool

Security is not the initial product differentiator, but several defaults prevent avoidable problems.

- Enable renderer sandboxing and context isolation in Electron.
- Expose only the required preload APIs.
- Runtime-validate untrusted renderer requests and action/state push events at
  their receiving boundary.
- Keep provider credentials outside project files.
- Treat imported HTML/web content as untrusted text.
- Do not render arbitrary source HTML with application privileges.
- Give agent skills domain-specific tools rather than unrestricted shell access.
- Require explicit configuration before a skill can access the web.
- Record which tool calls produced document changes.

Third-party Pi packages or skills can execute code or influence agent behaviour; installation should therefore be an explicit developer/user action, not automatic discovery and execution.

---

## 23. Testing strategy

## 23.1 Unit tests

Prioritise:

- Markdown citation parsing.
- Footnote and heading extraction.
- Patch validation and application.
- Revision grouping rules.
- Reference import/export.
- Context selection.
- File reconciliation.

## 23.2 Integration tests

- Renderer transaction to persisted revision.
- Agent tool call to patch preview.
- Partial patch acceptance.
- Conflict after user edits.
- Archive import and search.
- Pandoc export.
- Application restart and recovery.

## 23.3 End-to-end tests

A small set of critical flows:

1. Open a project, edit, restart, and verify content/history.
2. Ask for a conservative rewrite and accept part of the patch.
3. Modify an accepted patch and verify history classification.
4. Insert citations and export DOCX with bibliography.
5. Run LLM-tick audit across a document.

## 23.4 Model-dependent evaluations

Model output is non-deterministic. Test properties and failure rates rather than exact wording:

- Valid structured result.
- No citation keys lost.
- No numbers unexpectedly changed.
- No new claims introduced.
- Target verbal pattern reduced.
- Patch applies to the expected revision.

Keep model evaluations separate from ordinary fast unit tests.

---

## 24. Observability and debugging

Local structured logs are valuable even for one user.

Log categories:

- Project/file operations.
- Revision commits.
- Patch creation/application.
- Agent run lifecycle.
- Tool calls and durations.
- Export commands and warnings.
- Index operations.
- Recoverable errors.

Avoid logging complete sensitive document text by default. Store run context manifests and references to local revisions rather than duplicating all text into logs.

A developer panel could show:

- Current project path.
- Active document and revision.
- Context manifest.
- Agent events.
- Raw patch object.
- Database migration version.
- Pandoc version.

This can save substantial debugging time during early experimentation.

---

## 25. Packaging for macOS and Linux

## 25.1 macOS

Potential deliverables:

- Signed `.app` bundle.
- DMG or ZIP distribution.
- Universal build or separate Apple Silicon/Intel builds, depending on need.
- Notarisation if distribution extends beyond personal use.

For personal use, signing and notarisation can be deferred, but the build process should not assume that forever.

## 25.2 Linux

Potential deliverables:

- AppImage for broad convenience.
- `.deb` for Debian/Ubuntu-based systems.
- Possibly Flatpak later.

Test on at least the actual target distribution rather than relying only on CI.

## 25.3 Native and external dependencies

Potential packaged components:

- SQLite native bindings.
- Pandoc binary.
- PDF extraction tools.
- Pi/Node runtime, already present through Electron if integrated directly.

Native Node modules complicate cross-platform builds. Prefer pure JavaScript libraries where performance is sufficient, or establish repeatable per-platform builds early.

## 25.4 Continuous integration

Build macOS artifacts on macOS runners and Linux artifacts on Linux runners. Do not expect reliable cross-compilation of every native dependency from one platform.

---

## 26. Current implementation sequence

The original M0–M4 forecast is now historical: the application already has a
multi-file editor, revision-aware agent patches, a first skill and writing
profile, bounded delegation, office/PDF interchange, and source conversion.
The active sequence is therefore architectural consolidation followed by the
remaining academic data domains:

1. **Integrated baseline:** land the current feature set on one authoritative
   branch; add CI; make deterministic, desktop, compatibility, live-model, and
   packaged checks distinct and truthful.
2. **Integrity and jobs:** close relational deletion/run-context/corpus-
   lifecycle gaps; move expensive conversion and extraction behind cancellable
   job boundaries instead of blocking Electron main.
3. **References and citations:** choose portable canonical CSL JSON, build a
   rebuildable index and reference UI, then render citations/bibliographies in
   deterministic export.
4. **Writing archive:** immutable local source snapshots, provenance,
   retention/deletion, FTS5 search, and explicit attachment to conversations.
5. **Skills and research:** productise a small evaluated skill catalogue and
   add network/source tools only behind application-enforced permission and
   provenance.
6. **Release readiness:** supported-platform CI/artifacts, migrations, identity,
   accessibility, backup, and distribution metadata.

The detailed gates and audited findings live in
[`development-plan.md`](development-plan.md). Architecture work should keep
the existing service boundaries so ordering can change without replacing the
canonical document, revision, or agent-tool models.

---

## 27. Decisions to defer deliberately

Do not decide these before they are needed:

- CRDT versus operational transformation for collaboration.
- Cloud sync architecture.
- Multi-tenant user accounts.
- Plugin marketplace security model.
- Vector database technology.
- A publisher-grade or fully semantic document schema beyond what the selected editor requires.
- JATS internal representation.
- General-purpose multi-agent orchestration beyond the existing bounded,
  application-owned delegation roles.
- Kubernetes or remote job infrastructure.
- Mobile architecture.
- Fine-grained enterprise permissions.

The architecture should avoid making these impossible, but should not pay their complexity cost now.

---

## 28. Recommended provisional stack

A practical default stack, subject to developer preference and spikes:

- **Desktop shell:** Electron.
- **Language:** TypeScript.
- **UI:** React or another familiar web UI framework.
- **Editor:** Tiptap (ProseMirror) for rendered mode, chosen via the Milestone 0 spike (§6.2); CodeMirror 6 for raw mode; behind an editor adapter, with a complete raw Markdown mode retained. The raw editor uses CodeMirror's dark `EditorView.theme` and `drawSelection`; application CSS must leave the native caret transparent so the custom light cursor is the sole caret.
- **Local database:** SQLite with FTS5.
- **Canonical writing format:** Pandoc-oriented Markdown.
- **References:** CSL JSON-compatible records and Pandoc citation keys.
- **Export:** Pandoc.
- **Agent runtime:** Pi through its SDK, behind an application adapter.
- **Models:** Configurable Fast and Deep modes.
- **Validation:** Runtime schemas for IPC, tools, and persisted structured data.
- **Tests:** Unit/integration tests plus small model-evaluation fixtures.

None of these choices should become an ideological commitment. They form a low-friction route to testing the product thesis.

---

## 29. Suggested first technical decisions

The following are worth deciding before implementation begins:

1. What is canonical: Markdown file, SQLite document record, or a defined hybrid?
2. What exact document revision is the unit against which patches are created?
3. What is the minimum structured patch schema?
4. Which application tools may the agent call?
5. What Markdown features are officially supported in rendered mode, and what happens to unsupported source constructs?
6. How are model credentials configured?
7. Is Pandoc bundled or configured externally during development?
8. How are project IDs preserved when files move?
9. Which data is workspace-global versus project-local?
10. What constitutes a recoverable autosave state?

These decisions should be written down briefly, implemented, and revisited after the first serious writing sessions.

---

## 30. Source notes

The recommendations in this document are informed by the current official documentation for:

- Electron's main, renderer, and utility process model.
- Tauri 2's cross-platform architecture.
- CodeMirror 6's transaction-based editor state and decoration model, and ProseMirror/Tiptap's structured editing and transaction model.
- Pi's SDK, agent runtime, tools/extensions, providers, and skills (repository: <https://github.com/earendil-works/pi>).
- SQLite WAL and FTS5.
- Pandoc Markdown, footnotes, citations, and citeproc export.

Before implementation, pin concrete dependency versions and use documentation matching those versions. The specific APIs and packaging requirements may change.

---

## 31. Closing architecture thesis

The architecture should optimise for learning, not hypothetical scale.

A successful first architecture has four dependable properties:

1. User edits become coherent revisions.
2. The agent can read explicit context and propose structured patches.
3. The application can safely review, apply, reject, and recover those patches.
4. The user's Markdown, references, and history remain portable and understandable.

Everything else can evolve around that loop.
