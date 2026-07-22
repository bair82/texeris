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
- [General development plan](docs/development-plan.md) — audited current
  baseline, gaps, priorities, and delivery gates.
- [Historical implementation plan](docs/implementation-plan.md) — the M1/M1.5
  build sequence and early decision record.
- [Pi integration notes](docs/pi-integration-notes.md) — findings from
  studying the Pi repo: embedding layer, tools, providers, gotchas.

## Repository layout

- `docs/` — living product and architecture documents.
- `app/` — the real Electron + React application.
- `spikes/` — disposable technical prototypes (Milestone 0). Each spike
  answers one narrow risk and is not production code.
  - `spikes/editor/` — rendered-editor comparison: CodeMirror 6 live-render
    vs ProseMirror/Tiptap, with raw-mode switching, revision capture, and
    patch application.

## Development

Requires Node.js 22.19 or newer and pnpm 11.

```sh
pnpm install
TEXERIS_FAUX_PROVIDER=1 pnpm --filter @texeris/app dev
pnpm --filter @texeris/app typecheck
pnpm --filter @texeris/app test
pnpm --filter @texeris/app build
pnpm --filter @texeris/app smoke
pnpm --filter @texeris/app dist:linux
```

The offline faux provider exercises the complete application without API
keys. See [AGENTS.md](AGENTS.md) for individual smoke commands and the current
platform notes.
