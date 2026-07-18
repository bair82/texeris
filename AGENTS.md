# AGENTS.md

## What this is

Texeris — a personal desktop academic writing workspace with revision-aware AI
editing. See `docs/product-spec.md` (the what/why) and
`docs/architecture-options.md` (the how). Those two are living documents;
when product or architecture decisions change, update them.

## Layout

- `docs/` — living documents: product spec, architecture options,
  implementation plan, Pi integration notes.
- `spikes/` — disposable Milestone 0 prototypes. Spike code is allowed to be
  rough; it exists to answer a narrow question, not to be reused blindly.

## Conventions

- TypeScript everywhere; pnpm workspaces.
- Canonical writing format: Pandoc-oriented Markdown. References: CSL JSON +
  Pandoc citation keys. Export: Pandoc.
- Agent runtime: Pi — repo <https://github.com/earendil-works/pi>
  (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`), embedded behind
  an application adapter. Pi has no built-in permission sandbox, so the agent
  only ever gets domain-specific application tools, never raw fs/shell.
- The agent never mutates documents directly; it proposes structured patches
  against a base revision. The application validates and applies them.
- Rendered and raw editor modes are two views of one canonical document —
  never separate editable copies.
- Keep changes minimal and scoped; don't build speculative features beyond the
  current milestone (see architecture-options.md §26).

## Commands

- Install: `pnpm install`
- Editor spike dev server: `pnpm --filter @texeris/spike-editor dev`
- Editor spike tests/build: `pnpm --filter @texeris/spike-editor test` /
  `pnpm --filter @texeris/spike-editor build`

## Git

- Commit locally; do not push unless the user explicitly asks.
- Repo-local identity is set to the owner's GitHub noreply address.
