/**
 * EU2 smoke (find & replace + outline navigation): open the search panel,
 * verify match counting and case toggle, cycle matches, replace one (the
 * edit commits through the normal path), and click an outline heading.
 *
 * Usage: pnpm build first, then: node scripts/smoke-find.mjs
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

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-findproj-'));
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
  // React-compatible input setter (controlled inputs ignore raw .value).
  const setInput = (selector, value) => `(async () => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`;

  await waitFor(`!!window.texeris && !!document.querySelector('.tiptap-rendered')`, 'editor never mounted');

  // open the panel and search
  await evaluate(`document.querySelector('.find-toggle').click(); true`);
  await waitFor(`!!document.querySelector('.search-panel')`, 'search panel never opened');
  check('search input present', await evaluate(setInput('.search-input', 'attention')));
  await waitFor(
    `/^\\d+\\/\\d+$/.test(document.querySelector('.search-count')?.textContent ?? '')`,
    'match count never appeared',
  );
  const count0 = await evaluate(`document.querySelector('.search-count').textContent`);
  const insensitiveTotal = Number(count0.split('/')[1]);
  check('matches found and counted', insensitiveTotal > 1, count0);
  check(
    'match decorations rendered',
    await evaluate(`document.querySelectorAll('.search-match, .search-match-current').length > 1`),
  );

  // cycle to the next match
  await evaluate(`document.querySelector('.search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
  await sleep(300);
  const count1 = await evaluate(`document.querySelector('.search-count').textContent`);
  check('Enter cycles to the next match', count1.startsWith('2/'), count1);

  // case toggle narrows the matches (the manuscript has capitalized hits)
  await evaluate(`document.querySelector('.search-toggle').click(); true`);
  await sleep(600);
  const count2 = await evaluate(`document.querySelector('.search-count').textContent`);
  const sensitiveTotal = Number(count2.split('/')[1]);
  check(
    'case toggle narrows matches',
    Number.isFinite(sensitiveTotal) && sensitiveTotal < insensitiveTotal,
    `${count0} → ${count2}`,
  );

  // replace one occurrence; the edit commits through the normal path
  check('replace input present', await evaluate(setInput('.search-input', 'Grassmann')));
  await sleep(600);
  check('replacement set', await evaluate(setInput('.search-replace', 'Stiefel')));
  await evaluate(`[...document.querySelectorAll('.search-action')].find(b => b.textContent === 'Replace').click(); true`);
  await waitFor(
    `window.texeris.doc.getText().then(d => d.text.includes('Stiefel'))`,
    'replacement never committed',
    48,
  );
  check('replace one committed as a revision', true);

  // Ctrl+Z while the panel has focus (target outside the inputs) undoes the
  // replacement in the editor — and the revert commits through as well.
  await evaluate(`document.querySelector('.search-panel').dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })); true`);
  await waitFor(
    `window.texeris.doc.getText().then(d => d.text.includes('Grassmann') && !d.text.includes('Stiefel'))`,
    'undo never committed',
    48,
  );
  check('Ctrl+Z with panel focus reverts the replacement', true);

  // outline navigation selects and reveals the heading
  const outlineHasMethod = await evaluate(
    `[...document.querySelectorAll('.nav-heading')].some(b => b.textContent === 'Method')`,
  );
  check('outline lists the manuscript headings', outlineHasMethod);
  await evaluate(`[...document.querySelectorAll('.nav-heading')].find(b => b.textContent === 'Method').click(); true`);
  await sleep(400);
  const selection = await evaluate(`window.getSelection()?.toString() ?? ''`);
  check('outline click selects the heading in the editor', selection.includes('Method'), selection);

  proc.kill('SIGTERM');
} finally {
  proc?.kill('SIGKILL');
  fs.rmSync(projectDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps passed');
process.exit(failures ? 1 : 0);
