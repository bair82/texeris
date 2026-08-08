/**
 * Checkpoint UX end-to-end smoke (deterministic, offline): the history panel
 * checkpoint section is collapsed by default; one click creates a checkpoint
 * with a generated name and description; inline rename edits both; restore
 * still lands as a new revision.
 *
 * Usage: pnpm build first, then: node scripts/smoke-checkpoint.mjs
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

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.msgId = 0;
    this.pending = new Map();
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) =>
        msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result),
      );
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

async function connectPage(wsUrl) {
  const httpPort = wsUrl.match(/ws:\/\/[^:/]+:(\d+)/)[1];
  for (let i = 0; i < 40; i++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${httpPort}/json/list`).then((r) => r.json());
      const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r) => (ws.onopen = r));
        return ws;
      }
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('no page target found');
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      `page eval failed: ${JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)}`,
    );
  }
  return result.result.value;
}

async function waitFor(cdp, expression, label, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(cdp, expression)) return true;
    await sleep(250);
  }
  check(label, false, `timed out waiting for: ${expression}`);
  return false;
}

const setInput = (selector, value) => `(async () => {
  const input = document.querySelector(${JSON.stringify(selector)});
  if (!input) return false;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-checkpoint-smoke-'));
let app;
try {
  app = await launchApp(projectDir);
  const ws = await connectPage(app.wsUrl);
  const cdp = new Cdp(ws);
  await waitFor(cdp, `!!window.texeris && !!document.querySelector('.tiptap-rendered')`, 'editor never mounted');

  // open the history panel
  await evaluate(
    cdp,
    `[...document.querySelectorAll('button')].find(b => b.className.includes('history-toggle') && b.textContent === 'History').click(); true`,
  );
  await waitFor(cdp, `!!document.querySelector('.history-panel')`, 'history panel never opened');

  // checkpoint section exists, collapsed by default
  const collapsed = await evaluate(
    cdp,
    `(() => { const d = document.querySelector('.checkpoint-section'); return !!d && !d.open; })()`,
  );
  check('checkpoint section is collapsed by default', collapsed === true);

  // expand, one click creates a checkpoint with generated name + description
  await evaluate(cdp, `document.querySelector('.checkpoint-section summary').click(); true`);
  await evaluate(
    cdp,
    `[...document.querySelectorAll('.checkpoint-form button')].find(b => b.textContent === 'Checkpoint now').click(); true`,
  );
  await waitFor(cdp, `!!document.querySelector('.checkpoint-list li')`, 'checkpoint never appeared');
  const generated = await evaluate(
    cdp,
    `(() => {
      const row = document.querySelector('.checkpoint-list li');
      return { name: row.querySelector('.checkpoint-name')?.textContent ?? '', text: row.textContent };
    })()`,
  );
  check(
    'generated checkpoint has an auto name and description',
    generated.name.includes('checkpoint rev') && generated.text.includes('·'),
    JSON.stringify(generated),
  );

  // inline rename edits name and description
  await evaluate(
    cdp,
    `[...document.querySelectorAll('.checkpoint-list button')].find(b => b.title === 'Rename checkpoint').click(); true`,
  );
  await waitFor(cdp, `!!document.querySelector('.checkpoint-rename input')`, 'rename inputs never appeared');
  await evaluate(cdp, setInput('.checkpoint-rename input', 'before submission'));
  await evaluate(cdp, setInput('.checkpoint-rename input[placeholder="description…"]', 'draft the committee saw'));
  await evaluate(
    cdp,
    `document.querySelector('.checkpoint-rename input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`,
  );
  await waitFor(
    cdp,
    `document.querySelector('.checkpoint-list .checkpoint-name')?.textContent.includes('before submission')`,
    'rename never landed',
  );
  const renamed = await evaluate(
    cdp,
    `document.querySelector('.checkpoint-list li')?.textContent ?? ''`,
  );
  check('rename updated name and description', renamed.includes('before submission') && renamed.includes('draft the committee saw'), renamed);

  // restore still lands as a new revision: edit the document first so the
  // restore has something to roll back
  await evaluate(
    cdp,
    `(async () => {
      const doc = await window.texeris.doc.getText();
      await window.texeris.doc.commit({
        documentId: doc.documentId,
        splices: [{ from: doc.text.length, to: doc.text.length, deletedText: '', insertedText: '\\n\\nSMOKE-MARKER\\n' }],
        kind: 'typing',
      });
    })()`,
  );
  await waitFor(
    cdp,
    `(async () => (await window.texeris.doc.getText()).text.includes('SMOKE-MARKER'))()`,
    'edit never landed',
  );
  const edited = await evaluate(cdp, 'window.texeris.doc.getText()');
  await evaluate(
    cdp,
    `[...document.querySelectorAll('.checkpoint-list button')].find(b => b.textContent === 'Restore').click(); true`,
  );
  await waitFor(
    cdp,
    `(async () => !(await window.texeris.doc.getText()).text.includes('SMOKE-MARKER'))()`,
    'restore never rolled the edit back',
  );
  const restored = await evaluate(cdp, 'window.texeris.doc.getText()');
  check(
    'checkpoint restore rolls the edit back as a new revision',
    restored.revision > edited.revision && !restored.text.includes('SMOKE-MARKER'),
    `rev ${edited.revision} -> ${restored.revision}`,
  );

  app.proc.kill('SIGTERM');
} finally {
  app?.proc.kill('SIGKILL');
  fs.rmSync(projectDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps passed');
process.exit(failures ? 1 : 0);
