# AGENTS.md

## What this is

Texeris — a personal desktop academic writing workspace with revision-aware AI
editing. See `docs/product-spec.md` (the what/why) and
`docs/architecture-options.md` (the how). Those two are living documents;
when product or architecture decisions change, update them.

## Layout

- `docs/` — living documents: product spec, architecture options,
  implementation plan, Pi integration notes.
- `app/` — the real application (`@texeris/app`): Electron + electron-vite +
  React, TypeScript strict. Main process owns fs/db/credentials; the renderer
  is unprivileged (sandbox, contextIsolation); IPC contract in `src/shared/`.
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
- Pi is pinned to exact **0.80.10** (0.x, fast cadence — bump deliberately).
  Agent tools use pi-ai's re-exported `Type` (typebox v1); IPC validation
  uses `@sinclair/typebox`. Don't mix the two dialects.
- The agent never mutates documents directly; it proposes structured patches
  against a base revision. The application validates and applies them.
- Rendered and raw editor modes are two views of one canonical document —
  never separate editable copies.
- Keep changes minimal and scoped; don't build speculative features beyond the
  current milestone (see architecture-options.md §26).
- DB access uses Node's built-in `node:sqlite` (`DatabaseSync`) — no native
  modules. Main-process services are Electron-free and unit-tested with
  vitest against tmp directories; Electron wiring happens at the IPC layer.
- Editor: Tiptap (rendered) and CodeMirror 6 (raw) are two sessions over ONE
  canonical text (`app/src/renderer/src/editor/session.ts`) — never separate
  editable copies. Both commit grouped text splices over IPC; main validates
  and applies them. The Markdown⇄PM round trip (`editor/lib/markdown-in/out`)
  is CI-guarded and must stay byte-exact on the golden samples.

## Commands

- Install: `pnpm install`
- App dev server: `pnpm --filter @texeris/app dev`
- App dev server, offline scripted provider (no API keys needed):
  `TEXERIS_FAUX_PROVIDER=1 pnpm --filter @texeris/app dev`
- App checks: `pnpm --filter @texeris/app typecheck` /
  `pnpm --filter @texeris/app test` / `pnpm --filter @texeris/app build`
- App e2e smoke suite (CDP, offline): `pnpm --filter @texeris/app smoke`
- Package (Linux AppImage): `pnpm --filter @texeris/app dist:linux`
  (macOS dmg/zip configured in `app/electron-builder.yml`, needs a Mac)
- App e2e smoke (CDP, offline faux provider): after `pnpm --filter
  @texeris/app build`, run `node app/scripts/smoke.mjs`
- Editor e2e smoke (typing, mode switch, restart survival):
  `node app/scripts/smoke-editor.mjs`
- Patch pipeline e2e smoke (offline scripted patch):
  `node app/scripts/smoke-patch.mjs`
- Live provider smoke (needs `DEEPSEEK_API_KEY` in env):
  `node app/scripts/smoke-live.mjs`
- Editor spike dev server: `pnpm --filter @texeris/spike-editor dev`
- Editor spike tests/build: `pnpm --filter @texeris/spike-editor test` /
  `pnpm --filter @texeris/spike-editor build`

## Dev environment

- Dev machine runs Omarchy (Arch + Hyprland, Wayland). Electron launches
  against the live session (`DISPLAY`/`WAYLAND_DISPLAY` are set); the app
  runs fine via Wayland/Xwayland.
- `--ozone-platform=headless` segfaults on this box — don't use it; smoke
  launches go to the real display (short `timeout` is fine).
- gnome-keyring runs and owns `org.freedesktop.secrets`, so Electron
  `safeStorage` is viable for post-M1 credential storage.

## Git

- Git is delegated to the agent (owner decision 2026-07-19): commit and push
  as work completes, in clear scoped commits. No force-push, no history
  rewrites on `main` without explicit approval.
- Repo-local identity is set to the owner's GitHub noreply address.
