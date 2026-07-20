/**
 * EU1 workspace smoke: activity-bar toggles collapse the nav/side regions,
 * layout state persists over ui:get/ui:set, and a full window reload
 * restores the collapsed layout.
 *
 * Usage: pnpm build first, then: node scripts/smoke-ui.mjs
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

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-uiproj-'));
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

  await waitFor(`!!window.texeris && !!document.querySelector('.tiptap-rendered')`, 'editor never mounted');
  check('activity bar renders', await evaluate(`!!document.querySelector('.activity-bar')`));
  check('nav region visible by default', await evaluate(`!!document.querySelector('.project-nav')`));
  check('side column visible by default', await evaluate(`!!document.querySelector('.side-column')`));

  // Collapse both regions via the activity bar.
  await evaluate(`document.querySelector('.activity-button[title="Toggle files"]').click(); true`);
  await evaluate(`document.querySelector('.activity-button[title="Toggle assistant"]').click(); true`);
  check('nav collapses', !(await evaluate(`!!document.querySelector('.project-nav')`)));
  check('side column collapses', !(await evaluate(`!!document.querySelector('.side-column')`)));
  const saved = await evaluate(`window.texeris.ui.get()`);
  check(
    'collapsed state persisted to ui state',
    saved?.navVisible === false && saved?.sideVisible === false,
    JSON.stringify(saved),
  );

  // Reload the window — the collapsed layout must come back.
  await evaluate('window.location.reload(); true');
  await sleep(2000);
  await waitFor(`!!window.texeris && !!document.querySelector('.tiptap-rendered')`, 'app never came back after reload', 80);
  check('nav stays collapsed after reload', !(await evaluate(`!!document.querySelector('.project-nav')`)));
  check('side column stays collapsed after reload', !(await evaluate(`!!document.querySelector('.side-column')`)));

  // Re-open the nav — state must update again.
  await evaluate(`document.querySelector('.activity-button[title="Toggle files"]').click(); true`);
  check('nav reopens', await evaluate(`!!document.querySelector('.project-nav')`));
  const reopened = await evaluate(`window.texeris.ui.get()`);
  check('reopened state persisted', reopened?.navVisible === true, JSON.stringify(reopened));

  proc.kill('SIGTERM');
} finally {
  proc?.kill('SIGKILL');
  fs.rmSync(projectDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps passed');
process.exit(failures ? 1 : 0);
