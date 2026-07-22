/**
 * EU6 smoke (structural editing + surface preferences): table row/col
 * add/delete round-trips to Markdown, footnote insert lands a ref +
 * definition, and theme/font/width prefs repaint without reload and
 * persist across one.
 *
 * Usage: pnpm build first, then: node scripts/smoke-eu6.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ELECTRON = new URL('../node_modules/electron/dist/electron', import.meta.url).pathname;
const APP_DIR = new URL('..', import.meta.url).pathname;

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-eu6proj-'));
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-eu6cfg-'));
let proc;
try {
  proc = spawn(ELECTRON, ['.', '--no-sandbox', '--remote-debugging-port=0'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configDir,
      TEXERIS_FAUX_PROVIDER: '1',
      // Faux normally never writes a user's config; this smoke owns a tmp dir
      // and explicitly verifies persistence.
      TEXERIS_PERSIST_FAUX_CONFIG: '1',
      TEXERIS_PROJECT_DIR: projectDir,
      ELECTRON_ENABLE_LOGGING: '1',
      TEXERIS_SMOKE: '1',
    },
  });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    proc.on('exit', () => reject(new Error('electron exited early')));
    setTimeout(() => reject(new Error('timeout waiting for DevTools')), 20000);
  });

  const httpPort = wsUrl.match(/ws:\/\/[^:/]+:(\d+)/)[1];
  let ws;
  for (let i = 0; i < 40; i++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${httpPort}/json/list`).then((r) => r.json());
      const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r) => (ws.onopen = r));
        break;
      }
    } catch { /* retry */ }
    await sleep(250);
  }
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const evaluate = async (expression) => {
    const id = ++msgId;
    const res = await new Promise((resolve, reject) => {
      pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
    return res.result.value;
  };
  const send = (method, params = {}) => {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  const waitFor = async (expression, label, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      if (await evaluate(expression)) return true;
      await sleep(250);
    }
    check(label, false, `timed out: ${expression}`);
    return false;
  };
  const clickTitle = (title) =>
    `[...document.querySelectorAll('.toolbar button')].find(b => b.title === ${JSON.stringify(title)})?.click(); true`;

  await waitFor(`!!window.texeris && !!document.querySelector('.tiptap-rendered')`, 'editor never mounted');

  // ---- structural editing: footnote insert + management
  await evaluate(`document.querySelector('.footnote-insert').click(); true`);
  await waitFor(
    `window.texeris.doc.getText().then(d => d.text.includes('[^1]') && d.text.includes('[^1]:'))`,
    'footnote ref/definition never committed',
    40,
  );
  check('footnote insert lands ref + definition', true);

  // insert another footnote BEFORE the existing one → document-order renumber
  const caretToStart = `(() => {
    const el = document.querySelector('.tiptap-rendered');
    el.focus();
    window.getSelection().collapse(el, 0);
    return true;
  })()`;
  await evaluate(caretToStart);
  await sleep(300);
  await evaluate(`document.querySelector('.footnote-insert').click(); true`);
  const renumbered = await waitFor(
    `window.texeris.doc.getText().then(d => {
      const t = d.text;
      return t.includes('[^1]:') && t.includes('[^2]:')
        && t.indexOf('[^1]') < t.indexOf('[^2]')
        && t.indexOf('[^1]:') < t.indexOf('[^2]:');
    })`,
    'footnotes never renumbered after inserting before an existing one',
    40,
  );
  check('inserting before an existing footnote renumbers + reorders in document order', renumbered);

  // delete the first ref → numbering heals, orphaned definition kept
  await evaluate(caretToStart);
  await sleep(300);
  // a trusted CDP key event — synthetic keydowns can't edit content
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  const healed = await waitFor(
    `window.texeris.doc.getText().then(d => {
      const t = d.text;
      return t.includes('[^1]:') && t.includes('[^2]:')
        && !/\\[\\^2\\](?!:)/.test(t)
        && t.indexOf('[^1]:') < t.indexOf('[^2]:');
    })`,
    'footnote numbering never healed after delete',
    40,
  );
  check('deleting a footnote heals numbering and keeps the orphaned definition', healed);

  // ---- structural editing: table ops
  await evaluate(clickTitle('Insert table'));
  await waitFor(`!!document.querySelector('.editor-host table')`, 'table never inserted');
  const dims = () =>
    evaluate(`(() => {
      const rows = document.querySelectorAll('.editor-host table tr').length;
      const cols = document.querySelector('.editor-host table tr')?.children.length ?? 0;
      return { rows, cols };
    })()`);
  check('table inserted 3×3', JSON.stringify(await dims()) === JSON.stringify({ rows: 3, cols: 3 }));
  await evaluate(`document.querySelector('.tbl-row-add').click(); true`);
  check('add row → 4', (await dims()).rows === 4);
  await evaluate(`document.querySelector('.tbl-col-add').click(); true`);
  check('add column → 4', (await dims()).cols === 4);
  await waitFor(
    `window.texeris.doc.getText().then(d => /(\\|[^|\\n]*){4}\\|/.test(d.text))`,
    'table ops never reached the canonical Markdown',
    40,
  );
  check('table ops round-trip to Markdown', true);
  await evaluate(`document.querySelector('.tbl-row-del').click(); true`);
  check('delete row → 3', (await dims()).rows === 3);
  await evaluate(`document.querySelector('.tbl-col-del').click(); true`);
  check('delete column → 3', (await dims()).cols === 3);

  // ---- surface preferences repaint without reload
  check(
    'dark theme is the default',
    (await evaluate(`document.documentElement.dataset.theme`)) === 'dark',
  );
  await evaluate(`window.texeris.settings.setAppearance({ theme: 'light' })`);
  await waitFor(
    `document.documentElement.dataset.theme === 'light'`,
    'theme never repainted to light',
  );
  const lightBg = await evaluate(`getComputedStyle(document.body).backgroundColor`);
  check('theme repaints without reload', lightBg !== 'rgb(13, 17, 23)', lightBg);

  // raw mode follows the theme (was hard-coded near-white — invisible on light)
  await evaluate(`[...document.querySelectorAll('.editor-status button')].find(b => b.textContent === 'Raw').click(); true`);
  await waitFor(`!!document.querySelector('.cm-raw')`, 'raw mode never mounted');
  const cmColor = await evaluate(`getComputedStyle(document.querySelector('.cm-raw .cm-content')).color`);
  check('raw mode text is readable on light', cmColor === 'rgb(29, 39, 51)', cmColor);
  const selColor = await evaluate(`(() => {
    const host = document.querySelector('.cm-raw');
    const probe = document.createElement('div');
    probe.className = 'cm-selectionBackground';
    host.appendChild(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  })()`);
  check('raw mode selection follows the theme', selColor === 'rgba(47, 111, 222, 0.16)', String(selColor));
  await evaluate(`[...document.querySelectorAll('.editor-status button')].find(b => b.textContent === 'Rendered').click(); true`);
  await waitFor(`!!document.querySelector('.tiptap-rendered')`, 'rendered mode never remounted');

  await evaluate(`window.texeris.settings.setAppearance({ fontSize: 20 })`);
  await sleep(400);
  check(
    'font size applies live',
    (await evaluate(`getComputedStyle(document.querySelector('.tiptap-rendered')).fontSize`)) === '20px',
  );
  await evaluate(`window.texeris.settings.setAppearance({ editorWidth: 'wide' })`);
  await sleep(400);
  check(
    'editor width applies live',
    (await evaluate(`getComputedStyle(document.querySelector('.tiptap-rendered')).maxWidth`)) === '960px',
  );

  // ---- prefs persist across a reload
  await evaluate('window.location.reload(); true');
  await sleep(2000);
  await waitFor(`!!window.texeris && !!document.querySelector('.tiptap-rendered')`, 'app never came back', 80);
  check(
    'theme persists across reload',
    (await evaluate(`document.documentElement.dataset.theme`)) === 'light',
  );
  const persisted = JSON.parse(fs.readFileSync(path.join(configDir, 'texeris', 'config.json'), 'utf8'));
  check(
    'prefs persist to config.json',
    persisted.appearance?.theme === 'light' &&
      persisted.appearance?.fontSize === 20 &&
      persisted.appearance?.editorWidth === 'wide',
    JSON.stringify(persisted.appearance),
  );

  proc.kill('SIGTERM');
} finally {
  proc?.kill('SIGKILL');
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps passed');
process.exit(failures ? 1 : 0);
