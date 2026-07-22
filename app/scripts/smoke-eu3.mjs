/**
 * EU3 smoke (document & conversation management): rename a document, set it
 * as main, duplicate it, trash the duplicate, then
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
  const send = (method, params = {}) => {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, (msg) => msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result));
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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
  const withDocument = (path, operation) => `(async () => {
    const document = (await window.texeris.doc.list()).find(d => d.path === ${JSON.stringify(path)});
    if (!document) throw new Error('missing document: ${path}');
    return window.texeris.doc.${operation}(document.id${operation === 'rename' ? ", 'journal.md'" : ''});
  })()`;
  const reload = async () => {
    await evaluate(`location.reload(); true`);
    await waitFor(`!!window.texeris && !!document.querySelector('.tiptap-rendered')`, 'app did not reload');
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

  // Native menus are OS-owned and cannot be selected reliably over CDP. EU5
  // checks the actual popup; this lifecycle smoke exercises the same services.
  await evaluate(withDocument('notes.md', 'rename'));
  await reload();
  await waitFor(
    `[...document.querySelectorAll('.nav-file')].some(b => b.textContent.includes('journal.md'))`,
    'journal.md never appeared',
  );
  check(
    'rename moved the file on disk',
    fs.existsSync(path.join(projectDir, 'journal.md')) && !fs.existsSync(path.join(projectDir, 'notes.md')),
  );

  // set it as the main document
  await evaluate(withDocument('journal.md', 'setMain'));
  await reload();
  const json = JSON.parse(fs.readFileSync(path.join(projectDir, '.texeris', 'project.json'), 'utf8'));
  check('project.json points at the new main document', json.mainDocument === 'journal.md', json.mainDocument);

  // duplicate it
  await evaluate(withDocument('journal.md', 'duplicate'));
  await reload();
  await waitFor(
    `[...document.querySelectorAll('.nav-file')].some(b => b.textContent.includes('journal copy.md'))`,
    'duplicate never appeared',
  );

  // trash the duplicate
  await evaluate(withDocument('journal copy.md', 'trash'));
  await reload();
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

  // rename the current conversation
  await evaluate(`(async () => {
    const [conversation] = await window.texeris.chat.listConversations();
    await window.texeris.chat.renameConversation(conversation.id, 'smoke chat');
  })()`);
  await reload();
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
