/**
 * G3 writing archive smoke: import a local work, search it, attach a passage
 * to chat, and verify that the turn manifest records the explicit attachment.
 *
 * Usage: pnpm build first, then: node scripts/smoke-archive.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ELECTRON = new URL('../node_modules/electron/dist/electron', import.meta.url).pathname;
const APP_DIR = new URL('..', import.meta.url).pathname;

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures += 1;
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-archive-project-'));
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-archive-config-'));
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-archive-fixture-'));
const fixture = path.join(fixtureDir, 'earlier-paper.md');
fs.writeFileSync(
  fixture,
  '# Earlier Paper\n\n## Discussion\n\nThe orrery metaphor clarifies the geometry of attention.\n',
);

let proc;
try {
  proc = spawn(ELECTRON, ['.', '--no-sandbox', '--remote-debugging-port=0'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configDir,
      TEXERIS_FAUX_PROVIDER: '1',
      TEXERIS_PROJECT_DIR: projectDir,
      TEXERIS_ARCHIVE_IMPORT_PATH: fixture,
      ELECTRON_ENABLE_LOGGING: '1',
      TEXERIS_SMOKE: '1',
    },
  });
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = '';
    proc.stderr.on('data', (data) => {
      buffer += data;
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    proc.on('exit', (code, signal) =>
      reject(new Error(`electron exited early (${code ?? signal})\n${buffer}`)));
    setTimeout(() => reject(new Error('timeout waiting for DevTools')), 20000);
  });

  const httpPort = wsUrl.match(/ws:\/\/[^:/]+:(\d+)/)[1];
  let ws;
  for (let i = 0; i < 40; i += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${httpPort}/json/list`).then((r) => r.json());
      const page = targets.find((target) => target.type === 'page' && target.url.includes('index.html'));
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve) => { ws.onopen = resolve; });
        break;
      }
    } catch { /* retry */ }
    await sleep(250);
  }

  let messageId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  const evaluate = async (expression) => {
    const id = ++messageId;
    const response = await new Promise((resolve, reject) => {
      pending.set(id, (message) =>
        message.error ? reject(new Error(message.error.message)) : resolve(message.result));
      ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const waitFor = async (expression, label, tries = 80) => {
    for (let i = 0; i < tries; i += 1) {
      if (await evaluate(expression)) return true;
      await sleep(250);
    }
    check(label, false, `timed out: ${expression}`);
    return false;
  };
  const setInput = (selector, value, prototype = 'HTMLInputElement') => `(async () => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return false;
    const set = Object.getOwnPropertyDescriptor(window.${prototype}.prototype, 'value').set;
    set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`;

  await waitFor(`!!window.texeris && !!document.querySelector('.tiptap-rendered')`, 'app never mounted');
  await evaluate(`document.querySelector('.activity-button[title="Writing archive"]').click(); true`);
  await waitFor(`!!document.querySelector('.archive-empty-state')`, 'archive empty state never appeared');

  await evaluate(`[...document.querySelectorAll('.archive-empty-state button')].find((button) => button.textContent.includes('Choose files')).click(); true`);
  await waitFor(
    `[...document.querySelectorAll('.archive-source strong')].some((node) => node.textContent === 'Earlier Paper')`,
    'imported work never appeared',
  );
  check('local work imported into archive', true);

  check('search query entered', await evaluate(setInput('.archive-search input', 'orrery')));
  await waitFor(`!!document.querySelector('.archive-result')`, 'archive search returned no passage');
  check(
    'search result includes source and matching text',
    await evaluate(`document.querySelector('.archive-result')?.textContent.includes('Earlier Paper') && document.querySelector('.archive-result')?.textContent.includes('orrery')`),
  );

  await evaluate(`[...document.querySelectorAll('.archive-result > button')].find((button) => button.textContent.includes('Use in chat')).click(); true`);
  await waitFor(`!!document.querySelector('.archive-context-chips')`, 'archive passage was not attached');
  check('attached passage is visible above the composer', true);

  check(
    'chat prompt entered',
    await evaluate(setInput('.chat-input textarea', 'How does this resemble my earlier writing?', 'HTMLTextAreaElement')),
  );
  await evaluate(`[...document.querySelectorAll('.chat-input > button')].find((button) => button.textContent.includes('Send')).click(); true`);
  await waitFor(
    `document.querySelector('.manifest-chip')?.textContent.includes('1 archive')`,
    'turn manifest did not record archive context',
  );
  check('explicit archive context reached the chat turn', true);
  await waitFor(`!document.querySelector('.archive-context-chips')`, 'used attachment chip did not clear');
  check('attachment clears after a successful send', true);

  proc.kill('SIGTERM');
} finally {
  proc?.kill('SIGKILL');
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps passed');
process.exit(failures ? 1 : 0);
