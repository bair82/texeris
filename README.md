# Texeris

A desktop writing environment for academic work in which a person and an AI
agent can work on the same document without losing control, context,
authorship, or revision history.

The core interaction is the **revision loop**: write or select text → ask for
discussion or transformation → the AI reads an explicit context scope → it
discusses, comments, or proposes a reviewable patch → the user accepts,
rejects, or modifies it → the application records what happened.

## Documents

- [Product specification](docs/product-spec.md) — living product spec (Core /
  Likely / Exploratory commitment levels).
- [Architecture options](docs/architecture-options.md) — provisional
  architecture: Electron + TypeScript + SQLite (FTS5) + Pandoc-oriented
  Markdown + [Pi](https://github.com/earendil-works/pi) agent runtime behind
  an adapter.
- [Implementation plan](docs/implementation-plan.md) — Milestone 1 build
  sequence, recorded first decisions, editor decision gate.
- [Pi integration notes](docs/pi-integration-notes.md) — findings from
  studying the Pi repo: embedding layer, tools, providers, gotchas.

## Repository layout

- `docs/` — living product and architecture documents.
- `spikes/` — disposable technical prototypes (Milestone 0). Each spike
  answers one narrow risk and is not production code.
  - `spikes/editor/` — rendered-editor comparison: CodeMirror 6 live-render
    vs ProseMirror/Tiptap, with raw-mode switching, revision capture, and
    patch application.

## Development

Requires Node.js (via mise) and pnpm.

```sh
pnpm install
pnpm --filter @texeris/spike-editor dev
```
