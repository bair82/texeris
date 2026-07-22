# Scholarly Writing Workspace — Product Specification

**Status:** Living product specification  
**Audience:** Product owner, designer, developer, early testers  
**Primary platforms:** macOS and Linux  
**Initial deployment:** Personal, local desktop application  
**Working title:** Scholarly Writing Workspace (placeholder)

---

## 1. How to use this document

This specification describes the intended product direction and the minimum coherent product, while deliberately leaving many implementation and interaction details open.

It is not meant to predict the final application in detail. Academic writing practices differ by discipline, person, project stage, publication venue, and collaborator. Many assumptions in this document will be wrong or incomplete. Real use should be treated as the main source of product knowledge.

The document distinguishes three levels of commitment:

- **Core:** The product probably does not make sense without this capability or principle.
- **Likely:** A strong current hypothesis that should be implemented when practical, but may change after testing.
- **Exploratory:** A possible direction that should not shape the initial architecture unless doing so is inexpensive.

When this document conflicts with observed user behaviour, observed behaviour should normally win.

---

## 2. Product summary

The product is a desktop writing environment for academic work in which a person and an AI agent can work on the same document without losing control, context, authorship, or revision history.

The application combines:

1. A document-oriented editor that stores portable Markdown while presenting a clean, word-processor-like editing view by default.
2. A side-panel conversation for discussion, commands, and review.
3. Revision-aware AI editing, with inspectable patches rather than silent replacement.
4. A searchable archive of the user's previous work.
5. An explicit and editable model of the user's writing preferences.
6. Structured citation markers and bibliographic records.
7. An agent runtime with reusable scholarly-writing skills.
8. Two practical model modes: a strong model and a cheaper capable model.
9. Reliable export to common academic formats.

The product should feel less like “chat attached to a text box” and more like a writing environment in which the AI understands what is being worked on, what changed, what it is allowed to change, and what kinds of assistance the user prefers.

---

## 3. Product vision

### 3.1 Vision statement

Create a calm, trustworthy writing workspace in which AI can participate deeply in academic writing while the human remains the author, editor, and final decision-maker.

### 3.2 The central product idea

The most important interaction is not prompting. It is the revision loop:

1. The user writes or selects text.
2. The user asks a question or requests a transformation.
3. The AI reads an explicit scope of context.
4. The AI discusses the issue, comments on it, or proposes a patch.
5. The user accepts, rejects, or modifies the proposal.
6. The application records what happened and makes the result available as context for later turns.

This loop should be fast enough for ordinary editing and robust enough for substantial operations such as reviewing a chapter, standardising references, or removing formulaic LLM language throughout a manuscript.

### 3.3 Long-term aspiration

Over time, the workspace may become able to support much of the scholarly-writing process:

- Formulating and testing an argument.
- Organising notes and sources.
- Drafting and revising manuscripts.
- Maintaining terminology and citation consistency.
- Searching previous work.
- Preparing a document for a journal or publisher.
- Reviewing likely weaknesses before submission.
- Incorporating reviewer feedback.
- Producing final exports and supplementary materials.

The initial product should not attempt to implement this entire vision.

---

## 4. The problem

### 4.1 Problems with ordinary AI chat tools

General AI chat products are useful for isolated writing tasks but poorly suited to sustained academic work:

- The document and the conversation usually live in separate places.
- It is unclear which part of the document the model can see.
- The model often receives only the current text, not the user's intervening edits.
- Rewrites are returned as replacement prose instead of reviewable changes.
- Accepted and rejected edits do not become durable preference signals.
- Previous writing is difficult to retrieve in a controlled way.
- Citations are treated as ordinary text and can be damaged or invented.
- Complex tasks require repeated manual prompting and tool coordination.
- Model-generated language can converge on generic verbal patterns that do not match the author's voice.

### 4.2 Problems with ordinary writing applications

Conventional word processors and Markdown editors provide text editing, formatting, comments, and revision history, but AI is usually added as a shallow command layer. The AI often cannot:

- Maintain a coherent view of project context.
- Use a personal writing archive intelligently.
- Observe and learn from the user's editing decisions.
- Execute a multi-step writing workflow through tools and skills.
- Preserve a transparent relationship between an instruction and the resulting changes.

### 4.3 Product opportunity

A personal desktop tool can focus on depth rather than broad organisational requirements. It can keep the writing workflow local, make strong assumptions about a single primary user, and evolve quickly through direct use.

---

## 5. Primary user and usage context

### 5.1 Initial user

The first user is an academic writer who:

- Writes long-form research material.
- Already uses AI frequently.
- Wants assistance with both language and reasoning.
- Has a corpus of previous work that should inform future assistance.
- Needs citations and footnotes, but not elaborate visual page layout while drafting.
- Is comfortable with Markdown as the underlying storage and interchange format, but should not need to look at markup during ordinary writing.
- Uses macOS or Linux.

### 5.2 Likely document types

- Journal articles.
- Book chapters.
- Research notes.
- Grant or project proposals.
- Literature reviews.
- Conference papers.
- Reviewer responses.
- Essays and other long-form academic prose.

Different document types may eventually have separate style profiles or skills, but that is not required initially.

### 5.3 Initial deployment assumptions

- One primary user.
- Local projects.
- No real-time collaboration requirement.
- No institutional administration requirement.
- No need for enterprise permission systems.
- Internet access is available when online research or hosted models are used.
- Privacy is still respected, but enterprise compliance is not an initial product requirement.

---

## 6. Product principles

### 6.1 The document belongs to the application and the user

The AI does not silently mutate text. It proposes changes against a known document revision. The application controls how those changes are applied.

### 6.2 Normal writing must remain normal

The editor must be pleasant without AI. Typing, selecting, moving text, undoing, searching, and navigating headings should not depend on a model or network connection. Ordinary writing should happen in a clean rendered document view that feels closer to a conventional word processor than to a source-code editor. A raw Markdown mode should remain readily available when the user wants to inspect or edit the underlying syntax.

### 6.3 Markdown is an implementation format, not the default visual experience

Markdown should remain portable, inspectable, and suitable for export, but ordinary drafting should not require the user to read punctuation such as `#`, `**`, or citation syntax continuously. The rendered and raw modes are two views of the same document, not separate authoring pipelines. Visual convenience must not make the underlying file difficult to recover or edit elsewhere.

### 6.4 Context should be visible and controllable

The user should be able to understand whether the AI is seeing a selection, section, document, project, archive results, or attached sources.

### 6.5 Prefer reversible operations

AI edits, imports, style-profile changes, batch transformations, and reference operations should be reversible or reviewable whenever practical.

### 6.6 Preserve meaning by default

Language-editing skills should avoid changing claims, qualifications, terminology, citations, or logical relationships unless the task explicitly permits substantive changes.

### 6.7 Personalisation should be inspectable

Writing preferences should be represented in an editable form. The product should avoid building an opaque “personality” that the user cannot inspect or correct.

### 6.8 Use structured data only where it pays for itself

Plain text is valuable. Rich structure should be introduced where it enables an important capability, such as citation markers, revisions, comments, references, or named checkpoints. The product should not begin by modelling every paragraph and sentence as a complex object.

### 6.9 The agent is a component, not the owner of the product

The editor, project data, revision history, reference records, and style profile should not be inseparable from one agent framework or model provider.

### 6.10 Real use outranks speculative completeness

A smaller workflow that is used every day is more valuable than a comprehensive system built around imagined needs.

---

## 7. Product boundaries

### 7.1 Included in the initial direction

- Rendered document editing over canonical Markdown, with raw Markdown/source mode available.
- Footnotes and citation markers.
- AI chat and commands beside the document.
- Explicit context selection.
- Reviewable AI patches.
- History of user and AI changes.
- Search across previous works.
- Editable style guidance.
- A small set of writing skills.
- Fast and Deep model modes.
- Export through a robust conversion pipeline.

### 7.2 Not an initial goal

- Full replacement for Microsoft Word.
- Pixel-perfect page layout editing.
- Full replacement for Zotero or another reference manager.
- Automated proof that a cited source supports a claim.
- Real-time multi-user collaboration.
- Mobile applications.
- Publisher production systems.
- Institutional identity, billing, administration, or compliance.
- Autonomous submission of manuscripts.
- A general-purpose coding environment.

### 7.3 Deliberately unresolved

- Whether the product should eventually become file-centric or database-centric.
- The exact Markdown dialect.
- Whether semantic search is needed early.
- How much automatic style learning is desirable.
- Whether projects should be ordinary folders visible to other tools.
- How much of Pi should be embedded versus adapted behind an internal interface.
- The exact implementation strategy for rendered editing: text-editor decorations, a structured rich-text editor, or a hybrid approach.

---

## 8. Core concepts

### 8.1 Workspace

The top-level application environment containing projects, the writing archive, shared preferences, models, and installed skills.

### 8.2 Project

A bounded writing effort containing one or more documents, references, sources, project instructions, conversations, and checkpoints.

Examples: a journal article, a book chapter, or a grant proposal.

### 8.3 Document

A document whose portable representation is Markdown. By default it is edited through a rendered document view; the same content can also be opened in raw Markdown/source mode. One document may be designated as the main manuscript, but a project may also contain notes, outlines, appendices, or reviewer responses.

### 8.4 Revision

A recorded document state or grouped change. Revisions allow the application to identify what changed and to ensure that an AI patch was produced against an appropriate base state.

### 8.5 Patch

A proposed or applied set of document changes associated with:

- A base revision.
- The originating user request or skill.
- The model used.
- A summary or rationale.
- One or more change operations.
- An acceptance state.

### 8.6 Conversation

A sequence of messages connected to a project or document. A conversation may have attached context and may produce comments, reports, or patches.

### 8.7 Context scope

The material intentionally exposed to the model for a turn or job. Likely scopes include selection, current section, whole document, project, and writing archive.

### 8.8 Source

A project file or external item used as reading material. A source may be a PDF, text file, note, webpage snapshot, or previous work. A source is not automatically a bibliographic reference.

### 8.9 Reference

A structured bibliographic record identified by a stable citation key and used by citation markers in a document.

### 8.10 Style profile

An editable set of writing preferences, examples, disallowed patterns, terminology choices, and possibly genre-specific guidance.

### 8.11 Skill

A reusable task definition that tells the agent how to perform a specific workflow, what tools it may use, what result it should return, and which model mode is normally appropriate.

### 8.12 Agent job

A possibly multi-step execution of a task. A job may read multiple files, search the archive, inspect references, propose many patches, and return a report.

### 8.13 Checkpoint

A named project or document snapshot created to represent a meaningful stage, such as “before supervisor review” or “submitted version.”

---

## 9. High-level application layout

A likely initial desktop layout has three main regions:

1. **Navigation/project region**
   - Projects and files.
   - Outline or heading navigation.
   - Sources and references.

2. **Editor region**
   - Main rendered document editor, visually closer to a conventional word processor than a source editor.
   - A clear switch to raw Markdown/source mode.
   - Inline citation chips, footnote affordances, comments, and patch highlights.

3. **Conversation/agent region**
   - Chat messages.
   - Context indicator.
   - Skill and model selection.
   - Patch summaries and job status.

The exact arrangement is not fixed. The application may allow panels to collapse, resize, or move.

The editor should remain the visual centre of the product.

---

## 10. Core user workflows

## 10.1 Create or open a project

The user can:

- Create an empty project.
- Open an existing project.
- Import a Markdown document.
- Import Markdown, DOCX, ODT, RTF, or a text-bearing PDF as a new revisioned
  Markdown document.
- Add previous documents to the writing archive.

A new project may begin with:

- A main manuscript.
- A project instructions file.
- An empty reference library.
- An optional style profile inherited from the workspace.

## 10.2 Write normally

The user can edit the document without involving AI. The default view renders Markdown structure directly: headings look like headings, emphasis appears as emphasis, lists are laid out normally, and citation or footnote markers use appropriate visual affordances. The user can switch to raw Markdown mode whenever direct access to all markup is useful.

The user can:

- Type and delete text.
- Select and move text.
- Use headings, lists, emphasis, block quotations, links, tables, footnotes, and citations.
- Search within the document.
- Navigate by heading.
- Undo and redo.
- Save automatically.

The application groups low-level keystrokes into meaningful revisions for history and AI context. The grouping algorithm may evolve after testing.

## 10.3 Ask a question about text

The user selects text or places the cursor in a section and asks, for example:

- “Is this argument clear?”
- “What assumption is missing here?”
- “Does the conclusion follow from the previous paragraph?”
- “Suggest a shorter version without changing the claim.”

The context indicator shows what the AI can see. The result may be a conversational answer, comments, or a patch.

## 10.4 Request an edit

The user requests a transformation and chooses or implies an application mode:

- Propose edits.
- Replace selection.
- Insert after selection.
- Comment only.
- Run across the document.

For non-trivial edits, the default should be to propose a patch.

## 10.5 Review an AI patch

The application shows:

- A concise summary of the proposed change.
- Insertions, deletions, and replacements.
- The affected region.
- Optional rationale or warnings.

The user can:

- Accept all.
- Reject all.
- Accept or reject individual change groups.
- Edit the proposed result before accepting.
- Return to the conversation and ask for another version.

After acceptance, the application records whether the patch was accepted unchanged or subsequently modified.

## 10.6 Continue after manual edits

Between agent turns, the user may revise the document. On the next turn, the agent can receive a compact account of relevant changes since it last saw the document.

This supports interactions such as:

- The user softens a claim introduced by the model.
- The user restores a qualification removed by the model.
- The user rejects a stylistic expression.
- The user reorganises the section after receiving structural advice.

The application should not send an unlimited raw history to the model. Recent and relevant changes should be selected or summarised.

## 10.7 Search previous work

The user can search the writing archive using ordinary text search and, later, possibly semantic search.

Search results should show enough context to distinguish relevant passages. The user can:

- Open a previous document.
- Attach a result to the current conversation.
- Ask how a topic was handled previously.
- Compare current phrasing with previous work.
- Use selected works as examples for style analysis.

Archive retrieval should be intentional rather than silently applied to every request.

## 10.8 Work with citations

The user can insert and edit citation markers such as:

```markdown
Recent evidence supports this interpretation [@smith2024].

The result was limited to one subgroup [@smith2024, pp. 18–20].
```

In the default rendered mode, the editor should display these markers as visually distinct citation chips or compact inline references while retaining the plain-text Markdown representation underneath. Raw mode shows the complete marker syntax.

The user can:

- Search existing references.
- Insert one or more references.
- See unresolved citation keys.
- Import bibliographic records.
- Change the bibliography style at export time.

The first version does not need to determine whether a citation substantively supports the claim.

## 10.9 Run a skill

The user can invoke a named skill from the command interface, chat, or command palette.

Examples:

- Conservative rewrite.
- Remove LLM verbal ticks.
- Review structure and argument.
- Check terminology and consistency.
- Audit citation markers and references.
- Search previous writing.
- Propose style-profile updates.
- Export the manuscript.

A skill may ask for scope or use the current selection/document context. It should produce a predictable type of result: report, comments, patch, reference changes, or exported file.

## 10.10 Create a named checkpoint

The user can name a stable document state. Checkpoints should be easy to compare and restore.

Example names:

- Initial complete draft.
- Before coauthor review.
- Submitted manuscript.
- After reviewer 1.
- Accepted version.

---

## 11. Functional requirements

## 11.1 Editor

### Core

- Provide a rendered document mode as the default editing experience. It should resemble a restrained academic word processor rather than a code editor, without attempting pixel-perfect page layout.
- Provide a raw Markdown/source mode that exposes all underlying syntax.
- Keep both modes synchronized over one canonical document, with no separate editable copy. Switching modes should not create a content revision by itself.
- Preserve responsive and predictable cursor, selection, keyboard, composition, undo, and redo behaviour in both modes.
- Support a defined Markdown dialect.
- Support headings, lists, emphasis, links, quotations, code where useful, tables, footnotes, and citation markers.
- Support pasting and dragging common raster images into project-owned assets, with editable alt text and optional captions; deleting an image must not strand public asset files or break revision restore.
- Provide undo and redo.
- Provide platform-native context menus for editing, links, images, documents, conversations, and messages; toolbar/ellipsis launchers should reuse the same actions rather than maintain parallel menus.
- Show transient workspace operations in the editor status bar with consistent
  progress, success, warning, and error states. Keep actionable recovery
  notices and panel-specific errors beside the surface they affect; do not use
  floating translucent notifications for routine completion feedback.
- Search and replace.
- Navigate by headings.
- Automatically preserve work.
- Handle long academic documents without obvious degradation.

### Likely

- Render headings, emphasis, links, lists, quotations, citations, footnotes, and common tables directly in the editing surface.
- Reveal otherwise hidden Markdown syntax near the cursor or selection when that makes editing clearer.
- Inline visual treatment for citations and footnote markers.
- Focus mode.
- Soft wrapping and configurable line width.
- Basic document statistics.
- Spellchecking through platform or application support.
- Command palette.
- Multiple open documents or tabs.

### Exploratory

- Optional read-only preview or page-oriented print simulation in addition to the primary rendered editing mode.
- Inline comments anchored to text.
- Equation assistance.
- Table editing UI.
- Distraction-free full-screen mode.

## 11.2 Revision history

### Core

- Assign a monotonically increasing revision identity to document states or grouped changes.
- Record user changes and applied AI patches.
- Identify the base revision used for an AI proposal.
- Detect when a proposal no longer applies cleanly.
- Support restoration of earlier states.
- Preserve a human-readable audit trail.

### Likely

- Group typing bursts into coherent history entries.
- Distinguish manual edits, AI proposals, accepted AI edits, modified AI edits, and reverts.
- Summarise changes since the agent's previous turn.
- Compare checkpoints.

### Exploratory

- Branching document versions.
- Semantic change summaries.
- Automatic detection of preference signals from accepted and rejected patches.

## 11.3 AI patches

### Core

- AI writes through an application-controlled patch tool.
- Every patch declares a base revision.
- Patches can contain multiple change groups.
- A patch is reviewable before application.
- The user can accept or reject the proposal.
- Applied patches become normal document history.

### Likely

- Partial acceptance.
- Explanations attached to individual change groups.
- Automatic rebase for simple non-overlapping changes.
- Explicit conflict state for ambiguous changes.
- Preview of document after patch application.

### Exploratory

- Ranked alternative patches.
- Side-by-side versions.
- Patch policies specific to skills.

## 11.4 Conversation panel

### Core

- Send and receive messages within a project.
- Associate messages with current document context.
- Display the active context scope.
- Invoke tools and skills.
- Display proposed patches and reports.
- Preserve conversation history.

### Likely

- Multiple conversations per project.
- Rename conversations.
- Attach files, sources, archive passages, and references.
- Retry with Fast or Deep model.
- Convert a conversation conclusion into a project note or style rule.

### Exploratory

- Threaded side discussions.
- Voice input.
- Reusable prompt templates.

## 11.5 Context control

### Core

At minimum, the user can choose among:

- Selection.
- Current section.
- Whole document.
- Project.
- Writing archive.

The actual content sent to the model may be reduced to fit model limits, but the application should indicate when selection or summarisation occurs.

### Likely

- Pin context items to a conversation.
- Exclude a document or source.
- Show approximate context size.
- Show which archive results were retrieved.
- Use recent revision summaries when relevant.

### Exploratory

- Visual context graph.
- Saved context sets.
- Automatic context policies per skill.

## 11.6 Writing archive

### Core

- Import previous works in at least Markdown and plain-text form.
- Store document metadata such as title, date, type, and tags when available.
- Full-text search.
- View search results with excerpts.
- Attach selected results to a conversation.

### Likely

- Import DOCX and PDF text through conversion or extraction. PDF corpus
  derivatives retain page markers for later source attribution.
- Filter by document type, project, date, or status.
- Detect duplicate imports.
- Re-index changed files.

### Exploratory

- Embedding-based semantic search.
- Passage-level citation to previous work.
- Similarity warnings for possible self-reuse.
- Topic maps.

## 11.7 Style profile

### Core

- Store style preferences in an editable, readable representation.
- Make the profile available to relevant skills and conversations.
- Allow project-specific additions or overrides.
- Never silently convert one editing decision into a permanent rule.

### Likely

The profile may contain:

- Claim-strength preferences.
- Preferred and disallowed phrases.
- Terminology choices.
- Structural tendencies.
- Examples from approved writing.
- Genre-specific notes.
- An allowlist and discourage list for LLM-like language.

The user can ask the system to review recent editing behaviour and propose profile updates.

### Exploratory

- Confidence scores and evidence for inferred rules.
- Separate profiles by genre.
- Style drift reports.
- “Challenge my usual reasoning” mode.

## 11.8 Citation markers and references

### Core

- Recognise structured citation markers in the document.
- Maintain references separately from display formatting.
- Warn about citation keys missing from the reference library.
- Preserve citation markers during AI rewriting.
- Generate citations and bibliography during export.

### Likely

- Use Pandoc-compatible citation syntax.
- Store reference metadata in CSL JSON or a readily convertible equivalent.
- Import BibTeX, RIS, and CSL JSON.
- Resolve a DOI into a reference record.
- Search references by author, year, title, or key.
- Detect obvious duplicates.

### Exploratory

- Direct Zotero integration.
- Citation autocomplete from online scholarly databases.
- Retraction or correction warnings.
- Evidence-level claim checking.
- Quotation and page-location verification.

## 11.9 Models

### Core

Expose two user-facing modes:

- **Fast:** Cheap and capable; used for routine rewriting, formatting, extraction, search-result processing, and simple audits.
- **Deep:** The strongest available model; used for difficult reasoning, structural review, synthesis, and complex agent jobs.

The application should not require the user to choose among many provider-specific model names for routine use.

### Likely

- Skills declare a default mode.
- The user may override the mode.
- The application records which model handled a job or patch.
- Provider/model configuration is replaceable.

### Exploratory

- Escalation from Fast to Deep when a task exceeds a skill's confidence threshold.
- Local model support.
- Automatic cost budgets.

## 11.10 Agent jobs

### Core

- The agent can call a narrow set of application-provided tools.
- Jobs have a visible task description and result.
- Document-changing jobs produce patches rather than bypassing the editor.
- Tool activity is recorded sufficiently for debugging and review.
- Jobs can be cancelled.

### Likely

- Jobs can contain multiple steps.
- Long jobs show meaningful progress states.
- A job can return both a report and proposed changes.
- A job may request approval before broad document changes.
- Jobs have configurable model and context limits.

### Exploratory

- Resumable jobs.
- Parallel subtasks.
- Multiple specialised agents.
- Scheduled or background research.

## 11.11 Export

### Core

- Export Markdown.
- Export DOCX.
- Export PDF or a PDF-producing source format.
- Render citations and bibliography using a selected style.
- Preserve headings, emphasis, quotations, lists, tables, footnotes, and citations as far as the target format permits.

### Likely

- Export LaTeX.
- Export BibTeX and CSL JSON.
- Use templates or reference documents.
- Store export presets per project.
- Produce an export report containing warnings.

The first deterministic interchange workflow exports PDF, Markdown, DOCX, ODT,
and RTF through a native save dialog. PDF is the default: a fixed A4 academic
layout is produced from sanitized Pandoc HTML by an isolated Electron print
renderer. Exports are derived artifacts and never replace the canonical project
Markdown; citation markers may be preserved, but a formatted bibliography
awaits the reference-library workflow.

### Exploratory

- ODT.
- JATS XML.
- Journal-specific packages.
- Submission-ready bundles.

---

## 12. Initial skill catalogue

The initial catalogue should be small enough to test and refine thoroughly.

## 12.1 Conservative rewrite

**Purpose:** Improve clarity, grammar, and concision while preserving substantive meaning.

**Default model:** Fast, with optional Deep override.

**Constraints:**

- Do not add new factual claims.
- Do not remove meaningful qualifications.
- Do not change specialist terminology without explanation.
- Do not damage citation markers or footnotes.
- Prefer minimal edits.
- Return a patch.

**Possible options:**

- Light copy-edit.
- Shorten.
- Improve flow.
- Reduce repetition.
- Preserve sentence structure where possible.

## 12.2 Remove typical LLM verbal ticks

**Purpose:** Find and rewrite formulaic language commonly introduced by LLM-assisted drafting while preserving the author's actual meaning and voice.

**Default model:** Fast for detection and straightforward rewrites; Deep for ambiguous whole-document review.

**Detection categories may include:**

- Empty emphasis such as “it is important to note.”
- Inflated claims such as “plays a crucial role.”
- Generic grand framing such as “the broader landscape.”
- Formulaic contrasts such as “not merely X, but Y.”
- Repeated mechanical transitions.
- Overuse of three-part lists.
- Artificial paragraph symmetry.
- Repetitive concluding sentences.
- Vague abstract nouns replacing concrete statements.
- Unsupported intensifiers.
- Excessive em dashes or parenthetical flourishes.
- Meta-commentary that states importance instead of explaining it.
- Unnecessary restatement of the user's prompt or section topic.

**Important behaviour:**

- The skill should not treat a word as forbidden merely because it is associated with AI prose.
- It should consider frequency, context, repetition, and the user's prior writing.
- It should distinguish strong findings from possible findings.
- It should preserve legitimate disciplinary language.
- It should prefer deletion or simplification over replacing one decorative phrase with another.
- It should support an editable allowlist and discourage list.

**Modes:**

1. **Audit:** Return findings with locations, category, confidence, and explanation.
2. **Rewrite:** Propose minimal changes for high-confidence findings.
3. **Audit and rewrite:** Produce a report and a patch.

**Evaluation examples should include:**

- Genuine LLM-like prose that should be changed.
- Academic prose containing the same vocabulary legitimately.
- The user's own recurring expressions that should normally be preserved.
- Text where removing a phrase would alter caution or argumentative structure.

## 12.3 Structure and argument review

**Purpose:** Evaluate whether the text has a coherent purpose, progression, and argument.

**Default model:** Deep.

**Output:** Primarily a report or comments; rewriting is optional and should be separately requested.

**Questions may include:**

- What is the section trying to establish?
- Does each paragraph advance that purpose?
- Are there missing logical steps?
- Are conclusions stronger than the preceding reasoning?
- Is important material repeated?
- Are counterarguments or limitations misplaced?

## 12.4 Consistency review

**Purpose:** Find inconsistent terminology, abbreviations, capitalisation, naming, cross-references, and repeated factual formulations.

**Default model:** Fast.

**Output:** Report and optional patch.

The skill should distinguish mechanical consistency from cases where variation may be meaningful.

## 12.5 Reference audit and formatting

**Purpose:** Check the relationship between citation markers, bibliographic records, and export settings.

**Default model:** Fast, with deterministic tools doing as much work as possible.

**Checks:**

- Unresolved citation keys.
- Unused reference records.
- Duplicate or suspiciously similar references.
- Missing required metadata.
- Citation marker syntax errors.
- Consistent locator formatting.
- Successful rendering in the selected citation style.

This skill does not initially judge whether a source supports a claim.

## 12.6 Search previous writing

**Purpose:** Retrieve relevant passages from the writing archive and make them available to the user or another skill.

**Default model:** Fast.

**Output:** Ranked results with source document and excerpt. The user may attach results to a conversation.

## 12.7 Propose style-profile updates

**Purpose:** Review selected previous works or recent accepted/rejected edits and propose explicit additions or changes to the style profile.

**Default model:** Deep.

**Output:** A reviewable patch to the style-profile file, with examples or reasons.

## 12.8 Export document

**Purpose:** Produce a selected output format and report any conversion problems.

**Default model:** None for ordinary conversion. The agent may help interpret warnings, but deterministic tools should perform the export.

---

## 13. Suggested minimum coherent release

The first usable release should prioritise the complete writing loop over feature breadth.

### 13.1 Required

1. Desktop application on macOS and Linux.
2. Project creation and opening.
3. Markdown editor with headings, footnotes, and citation markers.
4. Reliable autosave and local history.
5. Chat panel with selection, section, and document context.
6. Fast and Deep model configuration.
7. AI patch proposal and accept/reject workflow.
8. The agent receives relevant user edits between turns.
9. Basic writing archive import and full-text search.
10. Editable workspace and project style profiles.
11. Conservative rewrite skill.
12. Remove LLM verbal ticks skill.
13. Structured references with unresolved-key warnings.
14. DOCX and Markdown export; PDF if practical in the first release.
15. Named checkpoints.

### 13.2 Can wait until the core loop is proven

- Semantic archive search.
- DOI resolution.
- Zotero integration.
- Complex batch reference repair.
- Multi-document agent planning.
- Extensive source/PDF research.
- Collaboration.
- Claim-evidence verification.
- Journal-specific automation.

---

## 14. Product phases

These phases are hypotheses, not commitments.

## Phase A — Writing loop prototype

Goal: Determine whether revision-aware AI editing is genuinely better than copy/paste between a text editor and chat.

Possible contents:

- One Markdown document.
- Basic editor.
- One conversation.
- Selection/document context.
- Fast/Deep model switch.
- Proposed patches.
- Simple history.
- Conservative rewrite and LLM-tick skills.

Key learning questions:

- Does the patch UI feel faster than manual copy/paste?
- How often does the user partially accept changes?
- What information about manual edits is useful to the model?
- What size of editing operation remains understandable?

## Phase B — Real project use

Goal: Use the application for a complete academic document.

Possible additions:

- Projects and multiple files.
- Checkpoints.
- Style profile.
- Writing archive search.
- Citation markers and references.
- DOCX/PDF export.
- Structure and consistency review.

Key learning questions:

- Which contexts are actually used?
- Does the style profile improve results?
- Which history events matter over weeks of editing?
- Where does Markdown interoperability fail?

## Phase C — Agent workflows

Goal: Make multi-step tasks reliable enough to save substantial time.

Possible additions:

- Persistent agent jobs.
- Reference audit.
- Batch changes.
- Online research tools.
- Source ingestion.
- More formal skill contracts and evaluations.

## Phase D — Broader scholarly workflow

Possible additions:

- Zotero integration.
- Reviewer-response workflow.
- Journal templates and compliance checks.
- Evidence tables.
- Semantic search.
- Collaboration.

---

## 15. Future features

The following ideas should remain available without being allowed to dominate initial design.

### 15.1 Research and sources

- Search scholarly databases and the open web.
- Save search results into a project.
- OCR and layout-aware extraction for scanned or structurally complex PDFs.
- Ask questions over attached papers.
- Preserve page-level source locations.
- Build literature matrices or evidence tables.
- Detect duplicate papers across sources.

### 15.2 Citation intelligence

- DOI and identifier resolution.
- Zotero synchronisation.
- Retraction and correction warnings.
- Citation-context review.
- Claim-to-source linking.
- Quotation verification.
- Bibliographic metadata repair.

### 15.3 More sophisticated personalisation

- Separate style profiles for articles, proposals, reviews, and correspondence.
- Examples attached to style rules.
- Confidence and provenance for inferred preferences.
- Detection of style drift.
- Deliberate mode for challenging the user's usual argument structure.

### 15.4 Review and submission

- Reviewer-comment tracker.
- Linked manuscript changes and response-letter paragraphs.
- Journal instruction import.
- Anonymisation for blind review.
- Reporting-guideline checklists.
- Submission package generation.

### 15.5 Collaboration

- Comments and suggestions from collaborators.
- Import and export of tracked DOCX changes.
- Authorship attribution.
- Shared project storage.
- Real-time or asynchronous collaboration.

### 15.6 Expanded document types

- LaTeX-first projects.
- Jupyter or Quarto documents.
- Slide manuscripts.
- Grant templates.
- Book-length projects with many chapters.

### 15.7 Additional agent capabilities

- Saved multi-step workflows.
- Research plans.
- Parallel source screening.
- Reusable project agents.
- Local models for selected tasks.
- Scheduled archive or reference maintenance.
- A meta-skill for skill creation: interview the user about a recurring workflow and scaffold a new skill package (metadata, SKILL.md, examples, tests) that follows the skill contract. Prior art worth studying: Anthropic's skill-creator skill.
- Automatic skill polishing: evaluation-driven refinement — run a skill against its test set, analyse failures, and propose reviewable patches to the skill's instructions, examples, or defaults. The document patch-review loop applies unchanged; skill edits are just another reviewable artifact. Relevant methods: automatic prompt-optimisation research (OPRO, TextGrad, GEPA-style reflective mutation against evals).

---

## 16. Error and edge-case behaviour

The product should make common failures understandable.

### 16.1 Patch conflicts

When the document changed after a patch was generated:

- Apply automatically only when the change is clearly non-conflicting.
- Otherwise show the affected passage and ask the user to review a rebased proposal.
- Never silently apply a patch to uncertain text.

### 16.2 Model failure

If the model call fails:

- Preserve the prompt and context selection.
- Allow retry with the same or other model mode.
- Do not lose document changes.

### 16.3 Tool or job failure

If a job partially succeeds:

- Report completed and failed steps.
- Keep generated artifacts or patches that are independently valid.
- Avoid applying incomplete document changes automatically.

### 16.4 Invalid citation marker

- Highlight the marker.
- Explain the syntax problem.
- Do not silently rewrite a citation key unless the match is unambiguous.

### 16.5 Missing reference

- Mark the citation as unresolved.
- Allow the user or a future resolver to attach a record.
- Preserve the textual key during editing and export attempts.

### 16.6 External file changes

If project files can be edited outside the application:

- Detect changes.
- Import them as a revision when possible.
- Avoid overwriting external edits.
- Show a conflict if both versions changed incompatibly.

### 16.7 Very large context

When requested context exceeds a model's practical limit:

- Explain that not all content can be sent verbatim.
- Use a documented selection or summarisation strategy.
- Show which sections or sources were included.
- Allow the user to narrow or pin context.

---

## 17. Data ownership and trust

Although enterprise security is not an initial concern, the product should follow several basic trust principles:

- Project data is stored locally by default.
- The user can locate and export their files.
- Model requests are attributable to a configured provider.
- The application does not conceal when text is sent to an external model.
- AI-generated edits remain identifiable in history.
- Destructive operations are recoverable.
- Third-party skills should not automatically receive unrestricted filesystem or command access.

These principles are inexpensive to establish early and costly to retrofit later.

---

## 18. Product analytics and evaluation

For a personal tool, formal analytics infrastructure is unnecessary. The product can still collect useful local signals or support manual observation.

### 18.1 Behavioural signals

- Frequency of AI use per writing session.
- Percentage of patches accepted, partially accepted, rejected, or heavily modified.
- Typical patch size.
- Most-used context scopes.
- Most-used skills.
- Model-mode overrides.
- Time between proposal and acceptance.
- Frequency of undoing an accepted AI patch.
- Search results attached from the archive.

These signals should be interpreted carefully. A rejected patch can still be valuable if it helps the user think.

### 18.2 Qualitative questions

- Does the application reduce context switching?
- Does the user trust the AI more because changes are reviewable?
- Does seeing diffs become tiring for small edits?
- Does the style profile produce visibly better results?
- Does the application preserve the user's own thinking, or encourage premature rewriting?
- Which tasks feel substantially easier than in an ordinary editor plus chat?
- Which features are ignored?

### 18.3 Skill evaluations

Each important skill should have a small, growing test set containing real or representative examples.

For rewriting skills, evaluate:

- Meaning preservation.
- Qualification preservation.
- Citation preservation.
- Terminology preservation.
- Reduction of the targeted problem.
- Similarity to the user's preferred style.
- False positives.

The purpose is not to create a perfect benchmark before launch. It is to prevent obvious regressions as prompts, models, and tools change.

---

## 19. Success criteria

### 19.1 Early prototype success

The prototype is promising when:

- The user voluntarily writes in it for real work.
- AI patch review is less cumbersome than copying text between applications.
- The application rarely loses or corrupts text.
- The user can understand what context the AI used.
- Accepted and rejected changes improve subsequent interactions.
- The LLM-tick skill catches meaningful problems without flattening legitimate academic prose.

### 19.2 First-release success

The first release is successful when the user can complete a substantial manuscript with it and reliably:

- Write and reorganise text.
- Ask for discussion and review.
- Apply controlled AI edits.
- Search previous work.
- Use personal style guidance.
- Maintain citation markers and references.
- Export a document suitable for sharing with collaborators or submission preparation.

### 19.3 Failure signals

- The user repeatedly returns to another editor for ordinary work.
- Patch review feels slower than manual replacement.
- The AI frequently changes meaning or damages citations.
- Context selection is confusing.
- Archive retrieval introduces irrelevant or recycled prose.
- Style personalisation merely makes all writing more uniform.
- Export failures make the tool unsuitable for real projects.

---

## 20. Open product questions

These should be answered through prototypes and use rather than prolonged speculation.

### Editing and document format

- Which Markdown constructs should be fully hidden in rendered mode, and which should become visible near the cursor?
- Does the rendered editing surface feel natural enough to replace Word for ordinary drafting?
- How quickly and confidently can the user switch to raw Markdown mode when needed?
- Should citation chips be editable inline or through a popover?
- How should footnotes be navigated?
- Is one main manuscript enough, or are multiple files essential immediately?

### Patches and history

- What is the right unit for accepting changes: operation, sentence, paragraph, or semantic group?
- When should trivial edits be applied immediately rather than reviewed?
- How much manual edit history should be sent to the agent?
- How should the system represent a user rewriting an accepted AI patch?

### Context

- Which context scope should be the default?
- Should project instructions always be included?
- How visible should context assembly be?
- When should the archive be searched automatically?

### Style

- Does an explicit style file improve results enough to justify maintenance?
- Which preferences should be global and which project-specific?
- How should the system avoid reinforcing undesirable habits?

### Agent experience

- Should skills be selected explicitly or inferred from natural-language requests?
- How much job planning should be shown?
- What progress information is genuinely useful?
- When should Fast escalate to Deep?

### References and export

- Is a simple internal reference library sufficient before Zotero integration?
- Which import/export formats matter in actual use?
- How often does DOCX round-tripping break important structure?
- Should Pandoc syntax be exposed directly or mediated through UI controls?

---

## 21. Tentative prioritisation rule

When considering a feature, prefer it when it improves one or more of the following:

1. The speed and quality of the core revision loop.
2. The user's control over AI changes.
3. The agent's understanding of relevant context.
4. Preservation of academic meaning, citations, and authorship.
5. Interoperability with existing academic workflows.
6. Learning from real use.

Deprioritise features that mainly make the product appear comprehensive without improving real writing sessions.

---

## 22. Glossary

**AI edit:** Any change proposed or generated by a model.  
**Archive:** Searchable collection of previous writing.  
**Base revision:** Document revision against which a patch was created.  
**Checkpoint:** Named, durable snapshot of a meaningful stage.  
**Citation key:** Stable identifier used in a textual citation marker.  
**Context:** Material made available to a model for a turn or job.  
**Deep model:** Strongest configured model mode.  
**Fast model:** Cheaper capable model mode.  
**Job:** Agent execution that may involve multiple tools or steps.  
**Patch:** Reviewable set of proposed text changes.  
**Project:** Collection of documents, sources, references, conversations, and settings for a writing effort.  
**Reference:** Structured bibliographic record.  
**Revision:** Recorded document state or grouped edit.  
**Skill:** Reusable instructions and tools for a defined task.  
**Style profile:** User-editable writing guidance derived from preferences and examples.

---

## 23. Closing product thesis

The product should first prove one thing:

> A revision-aware AI collaborator inside a serious text editor is materially better for academic writing than a conventional editor and a separate chat window.

If that is true in daily use, the archive, style system, citations, agent skills, research tools, and submission workflows have a strong foundation. If it is not true, adding more scholarly features will not rescue the core experience.
