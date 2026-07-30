/**
 * Patch + Conservative rewrite end-to-end smoke (deterministic, offline):
 * the command palette opens the bounded skill launcher, the faux provider
 * scripts a propose_patch call, and review/accept/undo complete through UI.
 *
 * Usage: pnpm build first, then: node scripts/smoke-patch.mjs
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
      TEXERIS_FAUX_PATCH: '1',
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

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-wp4-smoke-'));
let app;
try {
  app = await launchApp(projectDir);
  const ws = await connectPage(app.wsUrl);
  const cdp = new Cdp(ws);
  await waitFor(cdp, `!!window.texeris`, 'preload API never attached');
  await waitFor(cdp, `!!document.querySelector('.tiptap-rendered')`, 'editor never mounted');

  const boot = await evaluate(cdp, 'window.texeris.doc.getText()');
  const baseRevision = boot.revision;

  const openSkill = async (query, commandTitle) => {
    await evaluate(
      cdp,
      `document.body.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'k', ctrlKey: true, bubbles: true, cancelable: true,
      })); true`,
    );
    await waitFor(cdp, `!!document.querySelector('.palette-input')`, 'command palette never opened');
    await evaluate(
      cdp,
      `(() => {
        const input = document.querySelector('.palette-input');
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(input, ${JSON.stringify(query)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
    );
    await waitFor(
      cdp,
      `[...document.querySelectorAll('.palette-row')].some(
        (row) => row.textContent.includes(${JSON.stringify(commandTitle)}),
      )`,
      `${commandTitle} was not discoverable`,
    );
    await evaluate(
      cdp,
      `document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true,
      })); true`,
    );
    await waitFor(cdp, `!!document.querySelector('.skill-launch-dialog')`, `${commandTitle} launcher never opened`);
  };

  // The audit-first skill is discoverable and explains its two bounded paths.
  await openSkill('verbal ticks', 'Audit LLM Verbal Ticks');
  const launcherText = await evaluate(cdp, `document.querySelector('.skill-launch-dialog').textContent`);
  check(
    'verbal-tick launcher is audit-first and keeps changes reviewable',
    launcherText.includes('Whole document') &&
      launcherText.includes('Audit first') &&
      launcherText.includes('Audit + rewrite clear cases') &&
      launcherText.includes('never applied automatically'),
  );

  await evaluate(
    cdp,
    `document.body.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    })); true`,
  );
  await waitFor(
    cdp,
    `!document.querySelector('.skill-launch-dialog')`,
    'Escape did not close skill launcher',
  );
  check('Escape closes the skill launcher', true);

  // Launch Conservative Rewrite next; the faux provider scripts a valid patch.
  await openSkill('conservative rewrite', 'Conservative Rewrite');
  await evaluate(
    cdp,
    `[...document.querySelectorAll('.skill-launch-dialog button')]
      .find((button) => button.textContent === 'Start review').click(); true`,
  );

  // review card appears
  await waitFor(cdp, `!!document.querySelector('.patch-card')`, 'patch review card never appeared');
  const cardText = await evaluate(
    cdp,
    `document.querySelector('.patch-card').textContent`,
  );
  check(
    'review card shows title, explanation and diff',
    cardText.includes('Sharpen the terminology') && cardText.includes('terminology'),
  );

  // "Show" highlights the range in the editor
  await evaluate(
    cdp,
    `[...document.querySelectorAll('.patch-group button')].find(b => b.textContent === 'Show').click(); true`,
  );
  const highlighted = await evaluate(
    cdp,
    `!!document.querySelector('.review-highlight')`,
  );
  check('affected range is highlighted in the editor', highlighted === true);

  // accept-all → applied as an agent revision, undo offered
  await evaluate(
    cdp,
    `[...document.querySelectorAll('.patch-card button')].find(b => b.textContent === 'Accept all').click(); true`,
  );
  await waitFor(
    cdp,
    `(async () => (await window.texeris.doc.getText()).text.includes('algebraic'))()`,
    'patched text never appeared',
  );
  const applied = await evaluate(cdp, 'window.texeris.doc.getText()');
  check(
    'patch applied as a new revision',
    applied.revision === baseRevision + 1 && applied.text.includes('algebraic'),
  );
  await waitFor(cdp, `!!document.querySelector('.patch-undo')`, 'undo button never appeared');

  // undo → restored as a new revision
  await evaluate(
    cdp,
    `document.querySelector('.patch-undo button').click(); true`,
  );
  await waitFor(
    cdp,
    `(async () => (await window.texeris.doc.getText()).text.includes('geometric'))()`,
    'restore never landed',
  );
  const restored = await evaluate(cdp, 'window.texeris.doc.getText()');
  check(
    'undo restored the text as a new revision',
    restored.revision === baseRevision + 2 && restored.text.includes('geometric'),
  );

  // history shows the agent revision linked to the patch, then the restore
  const list = await evaluate(cdp, 'window.texeris.patch.list()');
  check('patch outcome recorded as accepted', list[0]?.status === 'accepted');

  app.proc.kill('SIGTERM');
} finally {
  app?.proc.kill('SIGKILL');
  fs.rmSync(projectDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps passed');
process.exit(failures ? 1 : 0);
