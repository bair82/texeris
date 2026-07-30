# AGENTS.md

## What this is

Texeris — a personal desktop academic writing workspace with revision-aware AI
editing. See `docs/product-spec.md` (the what/why) and
`docs/architecture-options.md` (the how). Those two are living documents;
when product or architecture decisions change, update them.

## Layout

- `docs/` — living documents: product spec, architecture options,
  general development plan, historical implementation plan, Pi integration
  notes.
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
  active queue and gates in `docs/development-plan.md`.
- DB access uses Node's built-in `node:sqlite` (`DatabaseSync`) — no native
  modules. Main-process services are Electron-free and unit-tested with
  vitest against tmp directories; Electron wiring happens at the IPC layer.
- Heavy work (Pandoc, unpdf extraction, PDF print-HTML prep) runs on
  `node:worker_threads` via `app/src/main/jobs/` — pure `tasks.ts`
  (vitest-tested in-process), a thin `worker.ts` entry, and `JobRunner`
  (AbortSignal cancellation). Progress/cancel ride `texeris:job-event` /
  `texeris:job-cancel`; `printToPDF` stays in main. Never reintroduce
  `execFileSync` on a user-triggerable path. Build gotchas: the main build
  is multi-input (index + jobs/worker) with CJS output pinned explicitly,
  and the `external: ['electron']` list must stay — without it the electron
  npm installer stub gets bundled and the app crashes at startup.
- Editor: Tiptap (rendered) and CodeMirror 6 (raw) are two sessions over ONE
  canonical text (`app/src/renderer/src/editor/session.ts`) — never separate
  editable copies. Both commit grouped text splices over IPC; main validates
  and applies them. The Markdown⇄PM round trip (`editor/lib/markdown-in/out`)
  is test-guarded and must stay byte-exact on the golden samples.
- CM styling belongs in CM theme extensions, never stylesheet rules keyed on
  editor classes: CM rewrites the editor's `class` attribute on updates
  (`updateAttrs`), so imperatively-added classes get wiped. `cm-raw` itself
  is registered via `EditorView.editorAttributes` to keep it stable; theme
  values are CSS variables so dark/light repaint needs no session rebuild.

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
- Workspace layout e2e smoke (collapse/expand, persistence across reload):
  `node app/scripts/smoke-ui.mjs`
- Find & outline e2e smoke (search, cycle, replace one, outline click):
  `node app/scripts/smoke-find.mjs`
- References/citations e2e smoke (manual add, BibTeX import, search,
  insert/replace, rendered/raw canonicality, citeproc PDF): `node
  app/scripts/smoke-citations.mjs`
- Doc & conversation management e2e smoke (rename, set-main, duplicate,
  trash, reopen renamed conversation): `node app/scripts/smoke-eu3.mjs`
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
- Hidden smoke windows can't be screenshotted (capture hangs) and never
  satisfy Chromium's document-focus requirement (spellcheck stays off).
  For visual/spellcheck diagnostics, `TEXERIS_SHOW_INACTIVE=1` shows the
  window without stealing focus; move it to a free workspace with
  `hyprctl dispatch movetoworkspacesilent N,address:0x…` so it doesn't
  tile next to the terminal.
- Spellcheck dictionaries are downloaded lazily by Chromium on first
  enable into `<userData>/Dictionaries` (shared:
  `~/.config/@texeris/app/Dictionaries`) — until the download finishes,
  no underline appears even when everything is configured. Full
  spellcheck investigation record (open issues): `docs/spellcheck-notes.md`.
- gnome-keyring runs and owns `org.freedesktop.secrets`, so Electron
  `safeStorage` is viable for credential storage — but only with
  `--password-store=gnome-libsecret` (set in `app/src/main/index.ts`);
  auto-detection fails under Hyprland.

## Git

- Git is delegated to the agent (owner decision 2026-07-19): commit and push
  as work completes, in clear scoped commits. No force-push, no history
  rewrites on `main` without explicit approval.
- Repo-local identity is set to the owner's GitHub noreply address.

## Agent coordination

Two coding agents work in this repo: **kimi** (Kimi Code CLI) and **codex**.
The owner acts as project manager and is not a routine code reviewer. Both
agents keep their own long-running sessions and context; coordination happens
through shared surfaces, never by re-running each other headlessly. Agent
availability can differ, so peer review is useful when available but must not
become a maintenance or integration dependency.

- **Worktrees (hard isolation):** each agent works only in its own
  worktree on its own branch namespace —
  `/home/bair82/Work/texeris-kimi` (branches `kimi/*`, main line
  `kimi/main`) and `/home/bair82/Work/texeris-codex` (branches `codex/*`,
  main line `codex/main`). The original `/home/bair82/Work/texeris`
  checkout stays on `main` and is the integration point only.
- **Tasks:** GitHub issues, labeled `agent:kimi` / `agent:codex` (the owner
  assigns; either agent may file and self-assign).
- **Code:** hand off via PRs into `main`. When both agents are available, the
  other agent reviews through PR comments (`gh pr comment` / `gh pr review`).
  When only one is available, that agent owns self-review, records verification
  evidence, keeps PR metadata current, and may merge without waiting for the
  unavailable agent.
- **Quick notes:** `docs/agent-notes.md` — append-only, **newest at the
  bottom**, signed and dated (bottom-appending avoids merge conflicts on
  concurrent edits). Check it when starting coordinated work.
- **Escalation:** disagreements go to the owner in the PR/issue thread;
  the owner arbitrates.
