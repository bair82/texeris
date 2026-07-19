/**
 * Project-flow smoke: with no project configured, the picker shows; creating
 * a project through IPC switches into it; recents persist.
 *
 * Usage: pnpm build first, then: node scripts/smoke-project.mjs
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

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-projcfg-'));
const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-projparent-'));
let proc;
try {
  proc = spawn(ELECTRON, ['.', '--no-sandbox', '--remote-debugging-port=0'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configDir, // no recents → picker should show
      TEXERIS_FAUX_PROVIDER: '1',
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

  await waitFor(`!!window.texeris`, 'preload API never attached');
  await waitFor(`!!document.querySelector('.project-picker')`, 'picker never showed');
  check('picker shows when no project is configured', true);
  check(
    'no project is current',
    (await evaluate('window.texeris.project.current()')) === null,
  );

  // create a project through IPC → app reloads into it
  await evaluate(`window.texeris.project.create(${JSON.stringify(parentDir)}, 'smoke-proj')`);
  // the reload tears down the page context; reconnect
  await sleep(2000);
  await waitFor(`!!window.texeris && !!document.querySelector('.tiptap-rendered, .cm-raw, .editor-host')`, 'app did not reload into the new project', 80);
  const current = await evaluate('window.texeris.project.current()');
  check(
    'created project is current',
    current?.root === path.join(parentDir, 'smoke-proj'),
    JSON.stringify(current),
  );
  const recents = await evaluate('window.texeris.project.recents()');
  check(
    'recents persist the new project',
    Array.isArray(recents) && recents[0] === path.join(parentDir, 'smoke-proj'),
  );

  proc.kill('SIGTERM');
} finally {
  proc?.kill('SIGKILL');
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(parentDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps passed');
process.exit(failures ? 1 : 0);
