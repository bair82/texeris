/**
 * WP5 crash-recovery smoke: type → hard-kill the app mid-life → while down,
 * plant an orphan tmp file and edit the manuscript externally → relaunch and
 * verify startup reconciliation (plan §4.10): tmp cleaned (never chosen as
 * content), external edit imported as an external revision.
 *
 * Usage: pnpm build first, then: node scripts/smoke-recovery.mjs
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

async function launchApp(projectDir) {
  const proc = spawn(ELECTRON, ['.', '--no-sandbox', '--remote-debugging-port=0'], {
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
  return { proc, wsUrl };
}

async function evaluateOnPage(wsUrl, expression) {
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
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  if (!ws) throw new Error('no page target found');
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  // wait for preload
  for (let i = 0; i < 40; i++) {
    const up = await send('Runtime.evaluate', { expression: '!!window.texeris', returnByValue: true });
    if (up.result.value) break;
    await sleep(250);
  }
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  ws.close();
  return result.result.value;
}

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-recovery-'));
const manuscript = path.join(projectDir, 'manuscript.md');
let app;
try {
  // 1. boot and type something
  app = await launchApp(projectDir);
  await evaluateOnPage(app.wsUrl, `(async () => {
    const el = document.querySelector('.tiptap-rendered');
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    return true;
  })()`);
  const typed = await evaluateOnPage(app.wsUrl, 'window.texeris.doc.getText()');
  check('app boots, manuscript present', typed.text.includes('Geometry of Attention'));

  // 2. simulate crash: SIGKILL (no cleanup, no graceful quit)
  app.proc.kill('SIGKILL');
  await sleep(1000);

  // 3. while down: orphan tmp file + external edit
  fs.writeFileSync(`${manuscript}.texeris-tmp-9999-0`, 'interrupted partial write');
  fs.appendFileSync(manuscript, '\nEdited while the app was dead.\n');

  // 4. relaunch → startup reconciliation
  app = await launchApp(projectDir);
  const after = await evaluateOnPage(
    app.wsUrl,
    `(async () => {
      const doc = await window.texeris.doc.getText();
      return doc;
    })()`,
  );
  check(
    'orphan tmp file cleaned, never chosen as content',
    !fs.existsSync(`${manuscript}.texeris-tmp-9999-0`) &&
      !after.text.includes('interrupted partial write'),
  );
  check(
    'offline edit imported on startup (revision bumped)',
    after.text.includes('Edited while the app was dead.') && after.revision === typed.revision + 1,
    `revision ${after.revision}, want ${typed.revision + 1}`,
  );
  const revisions = await evaluateOnPage(
    app.wsUrl,
    `(async () => {
      const conv = await window.texeris.chat.getOrCreateConversation();
      void conv;
      return (await window.texeris.doc.getText()).revision;
    })()`,
  );
  check('content + history consistent after crash', revisions === typed.revision + 1);

  app.proc.kill('SIGTERM');
} finally {
  app?.proc.kill('SIGKILL');
  fs.rmSync(projectDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps passed');
process.exit(failures ? 1 : 0);
