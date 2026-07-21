# Spellcheck: investigation notes (2026-07-20/21)

Status: **partially diagnosed, unresolved in rendered mode**. Raw mode's
failure mechanism is now understood; the fix shipped so far does not satisfy
the EU4 underline requirement.

## Symptoms (owner reports)

1. Rendered mode: no underline from boot; appears only after toggling
   spellcheck off→on in Settings, and then only ~5–7 s after closing the
   settings window.
2. After switching rendered → raw → rendered, underline is gone again and
   takes another ~5–7 s to reappear.
3. Raw mode (CodeMirror): an underline may flash briefly after real keyboard
   input, then disappears (and sometimes is never visibly painted).

## Verified facts

- The session setting is correct from boot:
  `session.defaultSession.spellCheckerEnabled === true`, languages `['en-US']`,
  `availableSpellCheckerLanguages` lists 57 entries (queried live via CDP).
- DOM attributes are correct: PM's contentDOM has no `spellcheck` attribute
  (inherits → checkable); CM's contentDOM has `spellcheck="true"` (CM
  hard-codes `"false"` by default — `@codemirror/view` ~line 8255 — which we
  override via `EditorView.contentAttributes`).
- Chromium downloads language dictionaries lazily into
  `<userData>/Dictionaries` (shared here:
  `~/.config/@texeris/app/Dictionaries/en-US-10-1.bdic`). First enable →
  ~90 s on this box; persists afterwards. **No dictionary → no underline,
  regardless of configuration.** This fully explains the original "toggle
  ritual" (the toggle just coincided with the download finishing).
- Hidden/unfocused windows never satisfy Chromium's document-focus
  requirement: `document.hasFocus === false` in smoke windows, and
  `Target.activateTarget` does not change that. Spellcheck does not run
  there, so **smoke tests cannot assert the underline**; all scripted
  screenshot attempts showed nothing by construction.
- One focused-window scripted run (document.hasFocus === true, dictionary
  present, everything configured) still showed no underline in either mode —
  inconclusive, harness visuals were flaky, but recorded for honesty.
- `scripts/diagnose-spellcheck.mjs` now inserts `mispellled` through CDP and
  right-clicks it in a focused window. Electron's `context-menu` event reports
  `isEditable: true` but an empty `misspelledWord` for both the plain chat
  textarea and Tiptap on this machine. This rules out a simple selector/focus
  mistake, but is not yet definitive: CDP's synthetic right-click may not
  perform Chromium's normal spelling hit-test. Run probes independently with
  `TEXERIS_SPELLCHECK_PROBE=textarea|tiptap|codemirror` because opening a
  context menu can disrupt the remainder of a CDP sequence.
- The BrowserWindow now explicitly sets `webPreferences.spellcheck: true`,
  matching Electron's documented setup instead of relying on its default.
  This did not change the focused textarea probe result.
- A focused Hyprland test delivered real compositor keyboard events rather
  than CDP text insertion. `mispellled` was visibly entered in Tiptap and
  CodeMirror. Tiptap had no stable underline. In CodeMirror the owner observed
  the red underline appear briefly and then disappear; a repeat did not paint
  it visibly at all.
- **Raw-mode cause confirmed:** Chromium can initially mark the spelling
  range, but CodeMirror redraws the affected text nodes and the browser-owned
  marker is lost. This matches CodeMirror's documented native-spellcheck
  limitation. Setting `spellcheck="true"` is necessary to permit checking but
  cannot make the marker durable.
- The `did-finish-load` + 3 s re-apply existed only in local debugging until
  2026-07-21; the owner never tested a build containing it before this note.

## Hypotheses

- **H1 (boot arming):** on Linux/Electron 43 the checker only "arms" for
  editable content that exists at apply time. Boot-time apply (no renderer
  yet) registers the setting but never arms the first page; a toggle with
  the editor present arms it. The shipped candidate fix: re-apply on
  `did-finish-load` + once more after 3 s (`app/src/main/index.ts`).
- **H2 (per-field scan delay):** each freshly created editable is queued
  for a full scan on a slow timer — the observed ~5–7 s after every
  toggle/mode switch. Not a bug per se, but makes H1's arming look flaky.

## Next diagnostics (when resumed)

1. **Rendered-mode isolation:** manually type and right-click the same typo in
   the plain chat textarea and Tiptap after the toggle ritual. The automated
   real-key test gets no stable marker in either, but a synthetic CDP
   right-click may not reproduce Chromium's spelling hit-test.
2. Search electron issues: "spellcheck linux not working",
   "setSpellCheckerLanguages no effect" — check for 43.x regressions.
3. **Raw-mode fix:** use an app-level checker with CodeMirror decorations.
   More session toggles or DOM attributes cannot survive CodeMirror redraws.
   `codemirror-v6-spell-checker@1.0.1` was examined but is not a good default:
   it is new, has no tests, and unpacks to about 66 MB. A smaller explicit
   implementation around `nspell` plus `dictionary-en` is roughly 0.6 MB of
   package data, but supporting the current multi-language picker requires a
   deliberate dictionary/distribution design.

## Reproduction recipe (visual, on Omarchy)

`TEXERIS_SHOW_INACTIVE=1` shows the window without focus steal; move it to
a free workspace: `hyprctl dispatch movetoworkspacesilent N,address:0x…`
(ids from `hyprctl clients -j`). Screenshot via CDP `Page.captureScreenshot`.
Hidden smoke windows hang screenshots and never get document focus.

Programmatic diagnostic (requires a built app and a focused desktop session):

```sh
TEXERIS_SPELLCHECK_CONFIG_DIR="$HOME/.config" \
  node app/scripts/diagnose-spellcheck.mjs
```

The config override deliberately reuses the downloaded dictionary. Omitting it
creates an isolated config and exercises the slow first-download path instead.
Set `TEXERIS_SPELLCHECK_PROBE=textarea|tiptap|codemirror` to isolate a field,
and `TEXERIS_SPELLCHECK_REAL_KEYS=1` under Hyprland to send compositor keyboard
events. `TEXERIS_SPELLCHECK_TIMELINE_PREFIX=/tmp/name` captures screenshots at
100, 400, 1000, 3000, and 7000 ms after input.
