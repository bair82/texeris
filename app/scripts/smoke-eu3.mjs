/**
 * EU3 smoke (document & conversation management): rename a document through
 * the nav menu, set it as main, duplicate it, trash the duplicate, then
 * rename a conversation and reopen it after starting a new one.
 *
 * Usage: pnpm build first, then: node scripts/smoke-eu3.mjs
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

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-eu3proj-'));
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
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
    set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`;
  const openMenu = (rowText) => `(() => {
    const row = [...document.querySelectorAll('.nav-file-row')].find(r => r.textContent.includes(${JSON.stringify(rowText)}));
    if (!row) return false;
    row.querySelector('.nav-file-menu-btn').click();
    return true;
  })()`;
  const clickItem = (itemText) => `(() => {
    const item = [...document.querySelectorAll('.nav-menu button')].find(b => b.textContent.includes(${JSON.stringify(itemText)}));
    if (!item) return false;
    item.click();
    return true;
  })()`;
  const clickMenuItem = async (rowText, itemText) => {
    if (!(await evaluate(openMenu(rowText)))) return 'no row';
    await sleep(150); // React renders the menu after the click returns
    return evaluate(clickItem(itemText));
  };

  await waitFor(`!!window.texeris && !!document.querySelector('.tiptap-rendered')`, 'editor never mounted');
  check(
    'main document is marked',
    await evaluate(`!!document.querySelector('.nav-main-dot')`),
  );

  // create a second document through the nav
  await evaluate(`document.querySelector('.nav-action:not(.import-action)').click(); true`);
  await evaluate(setInput('.nav-new-form input', 'notes'));
  await evaluate(`document.querySelector('.nav-new-form input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
  await waitFor(
    `[...document.querySelectorAll('.nav-file')].some(b => b.textContent.includes('notes.md'))`,
    'notes.md never appeared in the nav',
  );

  // rename it through the row menu
  check('rename menu item clicked', (await clickMenuItem('notes.md', 'Rename')) === true);
  await evaluate(setInput('.nav-rename-form input', 'journal.md'));
  await evaluate(`document.querySelector('.nav-rename-form input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
  await waitFor(
    `[...document.querySelectorAll('.nav-file')].some(b => b.textContent.includes('journal.md'))`,
    'journal.md never appeared',
  );
  check(
    'rename moved the file on disk',
    fs.existsSync(path.join(projectDir, 'journal.md')) && !fs.existsSync(path.join(projectDir, 'notes.md')),
  );

  // set it as the main document
  check('set-main menu item clicked', (await clickMenuItem('journal.md', 'Set as main')) === true);
  await sleep(400);
  const json = JSON.parse(fs.readFileSync(path.join(projectDir, '.texeris', 'project.json'), 'utf8'));
  check('project.json points at the new main document', json.mainDocument === 'journal.md', json.mainDocument);

  // duplicate it
  check('duplicate menu item clicked', (await clickMenuItem('journal.md', 'Duplicate')) === true);
  await waitFor(
    `[...document.querySelectorAll('.nav-file')].some(b => b.textContent.includes('journal copy.md'))`,
    'duplicate never appeared',
  );

  // trash the duplicate (with inline confirm)
  check('trash menu item clicked', (await clickMenuItem('journal copy.md', 'Move to trash')) === true);
  await evaluate(`document.querySelector('.nav-confirm-yes').click(); true`);
  await waitFor(
    `![...document.querySelectorAll('.nav-file')].some(b => b.textContent.includes('journal copy.md'))`,
    'trashed document still in the nav',
  );
  const trashFiles = fs.readdirSync(path.join(projectDir, '.texeris', 'trash'));
  check('trashed file moved to .texeris/trash', trashFiles.length === 1 && trashFiles[0].endsWith('.md'), trashFiles.join(','));

  // send a chat turn so the conversation has content
  await evaluate(setInput('.chat-input textarea', 'smoke question'));
  await evaluate(`[...document.querySelectorAll('.chat-input button')].find(b => b.textContent.includes('Send')).click(); true`);
  await waitFor(
    `[...document.querySelectorAll('.msg-assistant')].some(m => m.textContent.includes('scripted offline response'))`,
    'assistant answer never arrived',
    80,
  );

  // rename the conversation through the picker
  await evaluate(`document.querySelector('.conv-toggle').click(); true`);
  await waitFor(`!!document.querySelector('.conv-picker')`, 'picker never opened');
  await evaluate(`document.querySelector('.conv-row-action').click(); true`);
  await evaluate(setInput('.conv-rename-input', 'smoke chat'));
  await evaluate(`document.querySelector('.conv-rename-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
  await sleep(400);
  const toggleTitle = await evaluate(`document.querySelector('.conv-toggle').textContent`);
  check('conversation renamed', toggleTitle.includes('smoke chat'), toggleTitle);

  // start a new chat, then reopen the renamed one. (Synthetic .click() emits
  // no mousedown, so the picker's outside-click close never fires here —
  // open it idempotently instead of toggling.)
  await evaluate(`[...document.querySelectorAll('.usage-toggle')].find(b => b.textContent === 'new chat').click(); true`);
  await sleep(400);
  check(
    'new chat starts empty',
    (await evaluate(`document.querySelectorAll('.msg-assistant').length`)) === 0,
  );
  await evaluate(`(() => {
    if (!document.querySelector('.conv-picker')) document.querySelector('.conv-toggle').click();
    return true;
  })()`);
  await waitFor(`!!document.querySelector('.conv-picker')`, 'picker never reopened');
  await evaluate(`[...document.querySelectorAll('.conv-open')].find(b => b.textContent.includes('smoke chat')).click(); true`);
  await waitFor(
    `[...document.querySelectorAll('.msg-assistant')].some(m => m.textContent.includes('scripted offline response'))`,
    'reopened conversation did not restore messages',
  );
  check('renamed conversation reopens with its messages', true);

  proc.kill('SIGTERM');
} finally {
  proc?.kill('SIGKILL');
  fs.rmSync(projectDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps passed');
process.exit(failures ? 1 : 0);
