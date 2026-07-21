/**
 * EU5 smoke (keyboard UX): Ctrl+K opens the command palette, filtering
 * narrows commands, Enter runs one (find panel, focus mode, mode toggle).
 *
 * Usage: pnpm build first, then: node scripts/smoke-eu5.mjs
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

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-eu5proj-'));
let proc;
try {
  proc = spawn(ELECTRON, ['.', '--no-sandbox', '--remote-debugging-port=0'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      TEXERIS_FAUX_PROVIDER: '1',
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
  const waitFor = async (expression, label, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      if (await evaluate(expression)) return true;
      await sleep(250);
    }
    check(label, false, `timed out: ${expression}`);
    return false;
  };
  const setInput = (selector, value) => `(async () => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`;
  // the AppShell palette listener is on window; a body dispatch bubbles there
  const ctrlK = `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })); true`;
  const runPaletteCommand = async (query) => {
    await evaluate(ctrlK);
    await sleep(300);
    await evaluate(setInput('.palette-input', query));
    await sleep(300);
    await evaluate(`document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); true`);
    await sleep(300);
  };

  await waitFor(`!!window.texeris && !!document.querySelector('.tiptap-rendered')`, 'editor never mounted');

  // Ctrl+K opens the palette
  await evaluate(ctrlK);
  await waitFor(`!!document.querySelector('.command-palette')`, 'palette never opened');
  check('Ctrl+K opens the command palette', true);

  // filtering narrows the command list
  await evaluate(setInput('.palette-input', 'find doc'));
  await sleep(300);
  const rows = await evaluate(`[...document.querySelectorAll('.palette-row')].map(r => r.textContent)`);
  check(
    'filtering narrows commands to the match',
    rows.length === 1 && rows[0].includes('Find in Document'),
    JSON.stringify(rows),
  );

  // Enter runs the command (find panel opens)
  await evaluate(`document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); true`);
  await waitFor(`!!document.querySelector('.search-panel')`, 'find panel never opened');
  check('palette runs the command (find panel opened)', true);

  // focus mode via palette: both panels hide, then return
  await runPaletteCommand('focus mode');
  check(
    'focus mode hides both panels',
    !(await evaluate(`!!document.querySelector('.project-nav')`)) &&
      !(await evaluate(`!!document.querySelector('.side-column')`)),
  );
  await runPaletteCommand('focus mode');
  await waitFor(`!!document.querySelector('.project-nav')`, 'nav never returned');
  check('focus mode toggles back', true);

  // mode toggle via palette: rendered → raw
  await runPaletteCommand('toggle rendered');
  await waitFor(`!!document.querySelector('.cm-raw')`, 'raw mode never mounted');
  check('mode toggle command switches to raw', true);

  // shortcuts overlay opens via palette and closes on Esc
  await runPaletteCommand('keyboard shortcuts');
  await waitFor(`!!document.querySelector('.shortcuts-panel')`, 'shortcuts overlay never opened');
  check('shortcuts overlay opens via palette', true);
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true`);
  await sleep(300);
  check(
    'Esc closes the shortcuts overlay',
    !(await evaluate(`!!document.querySelector('.shortcuts-panel')`)),
  );

  proc.kill('SIGTERM');
} finally {
  proc?.kill('SIGKILL');
  fs.rmSync(projectDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps passed');
process.exit(failures ? 1 : 0);
