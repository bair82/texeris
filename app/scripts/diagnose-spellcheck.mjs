/**
 * Focused spellcheck diagnostic. Unlike smoke tests, this opens a real window
 * because Chromium only spellchecks a focused document. It right-clicks a
 * known misspelling in each editable and records Electron's context-menu
 * spelling metadata, which is independent of underline rendering.
 *
 * Usage: pnpm build, then node scripts/diagnose-spellcheck.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ELECTRON = process.env.TEXERIS_ELECTRON_BINARY
  ?? new URL('../node_modules/electron/dist/electron', import.meta.url).pathname;
const APP_DIR = new URL('..', import.meta.url).pathname;
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-spellcheck-project-'));
const temporaryConfig = !process.env.TEXERIS_SPELLCHECK_CONFIG_DIR;
const configDir = process.env.TEXERIS_SPELLCHECK_CONFIG_DIR
  ?? fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-spellcheck-config-'));
const WORD = 'mispellled';
let proc;

try {
  proc = spawn(ELECTRON, ['.', '--no-sandbox', '--remote-debugging-port=0'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configDir,
      TEXERIS_FAUX_PROVIDER: '1',
      TEXERIS_PROJECT_DIR: projectDir,
      TEXERIS_SPELLCHECK_DIAGNOSTIC: '1',
      ELECTRON_ENABLE_LOGGING: '1',
    },
  });

  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  const wsUrl = await new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearInterval(timer);
        resolve(match[1]);
      } else if (Date.now() - started > 20_000) {
        clearInterval(timer);
        reject(new Error('timeout waiting for DevTools'));
      }
    }, 50);
    proc.on('exit', () => reject(new Error('Electron exited early')));
  });

  const port = wsUrl.match(/ws:\/\/[^:/]+:(\d+)/)?.[1];
  let ws;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = targets.find((target) => target.type === 'page' && target.url.includes('index.html'));
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve) => { ws.onopen = resolve; });
        break;
      }
    } catch { /* retry while the renderer starts */ }
    await sleep(250);
  }
  if (!ws) throw new Error('renderer target never appeared');

  let nextId = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (message) => message.error ? reject(new Error(message.error.message)) : resolve(message.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (expression) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (await evaluate(expression)) return;
      await sleep(250);
    }
    throw new Error(`timeout: ${expression}`);
  };
  const rightClick = async (selector, offset) => {
    const point = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      const rect = node.getBoundingClientRect();
      node.focus();
      return { x: rect.left + ${offset.x}, y: rect.top + ${offset.y} };
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'right', clickCount: 1, ...point });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'right', clickCount: 1, ...point });
    await sleep(500);
  };
  const diagnosticCount = () => (stderr.match(/\[spellcheck-diagnostic\]/g) ?? []).length;
  const probe = async (name, selector, offset, setup) => {
    await setup();
    await sleep(7000);
    const before = diagnosticCount();
    await rightClick(selector, offset);
    const line = stderr.split('\n').filter((entry) => entry.includes('[spellcheck-diagnostic]')).at(-1);
    if (diagnosticCount() === before || !line) throw new Error(`${name}: no context-menu event`);
    const data = JSON.parse(line.slice(line.indexOf('{')));
    const detected = data.misspelledWord === WORD && data.dictionarySuggestions.length > 0;
    console.log(`${detected ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(data)}`);
    return detected;
  };

  await waitFor(`document.hasFocus && !!document.querySelector('.chat-input textarea') && !!document.querySelector('.tiptap-rendered')`);
  console.log(`document.hasFocus=${await evaluate('document.hasFocus()')}`);
  const results = [];
  const requestedProbe = process.env.TEXERIS_SPELLCHECK_PROBE ?? 'all';
  if (requestedProbe === 'all' || requestedProbe === 'textarea') {
    results.push(await probe('textarea', '.chat-input textarea', { x: 25, y: 20 }, async () => {
      await evaluate(`document.querySelector('.chat-input textarea').focus()`);
      await send('Input.insertText', { text: `${WORD} ` });
    }));
  }
  if (requestedProbe === 'all' || requestedProbe === 'tiptap') {
    results.push(await probe('Tiptap', '.tiptap-rendered', { x: 35, y: 30 }, async () => {
    await evaluate(`document.querySelector('.tiptap-rendered').focus()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
    await send('Input.insertText', { text: ` ${WORD} ` });
  }));
  }
  if (requestedProbe === 'all' || requestedProbe === 'codemirror') {
    results.push(await probe('CodeMirror', '.cm-content', { x: 25, y: 15 }, async () => {
    await evaluate(`Array.from(document.querySelectorAll('.toggle-group button')).find((b) => b.textContent === 'Raw').click()`);
    await waitFor(`!!document.querySelector('.cm-content')`);
    await evaluate(`document.querySelector('.cm-content').focus()`);
    await send('Input.insertText', { text: ` ${WORD} ` });
  }));
  }

  process.exitCode = results.every(Boolean) ? 0 : 1;
} finally {
  proc?.kill('SIGTERM');
  fs.rmSync(projectDir, { recursive: true, force: true });
  if (temporaryConfig) fs.rmSync(configDir, { recursive: true, force: true });
}
