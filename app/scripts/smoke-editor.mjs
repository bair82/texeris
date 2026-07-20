/**
 * WP2 end-to-end smoke: drives the real app's editor over CDP (faux agent
 * provider; no API keys). Verifies the DoD:
 *  1. typing in the rendered editor commits a revision (idle flush)
 *  2. switching rendered → raw → rendered creates NO revision
 *  3. typing in raw mode commits as well
 *  4. restart → content and full revision history intact
 *
 * Usage: pnpm build first, then: node scripts/smoke-editor.mjs
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

async function waitFor(cdp, expression, label, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(cdp, expression)) return true;
    await sleep(250);
  }
  check(label, false, `timed out waiting for: ${expression}`);
  return false;
}

const FOCUS_END_JS = `
(() => {
  const el = document.querySelector('.cm-raw .cm-content') || document.querySelector('.tiptap-rendered');
  if (!el) return false;
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
})()
`;

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-wp2-smoke-'));
let app;
try {
  app = await launchApp(projectDir);
  let ws = await connectPage(app.wsUrl);
  let cdp = new Cdp(ws);
  await waitFor(cdp, `!!window.texeris`, 'preload API never attached');

  // 1. boot with the seeded manuscript
  const boot = await evaluate(cdp, 'window.texeris.doc.getText()');
  check('editor boots with the seeded manuscript', boot.text.includes('Geometry of Attention'));
  const baseRevision = boot.revision;

  // 2. type into the rendered editor → idle flush commits a revision
  await waitFor(cdp, `!!document.querySelector('.tiptap-rendered')`, 'rendered editor never mounted');
  await evaluate(cdp, FOCUS_END_JS);
  await cdp.send('Input.insertText', { text: '\n\nTyped by the smoke test.' });
  await sleep(6500); // idle flush (5s) + commit
  const afterType = await evaluate(cdp, 'window.texeris.doc.getText()');
  check(
    'typing in rendered mode committed a revision',
    afterType.revision === baseRevision + 1 && afterType.text.includes('Typed by the smoke test.'),
    `revision ${afterType.revision}, want ${baseRevision + 1}`,
  );

  // 3. mode switch rendered → raw → rendered: no new revisions
  await evaluate(
    cdp,
    `[...document.querySelectorAll('.editor-status button')].find(b => b.textContent === 'Raw').click(); true`,
  );
  await waitFor(cdp, `!!document.querySelector('.cm-raw')`, 'raw mode never mounted');
  const rawText = await evaluate(
    cdp,
    `document.querySelector('.cm-raw .cm-content').textContent.includes('Typed by the smoke test.')`,
  );
  check('raw mode shows the same canonical text', rawText === true);

  // type in raw mode too
  const caretStyles = await evaluate(
    cdp,
    `(async () => {
      const content = document.querySelector('.cm-raw .cm-content');
      if (!content) return null;
      content.focus();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        native: getComputedStyle(content).caretColor,
      };
    })()`,
  );
  check(
    'raw mode leaves the native caret hidden for custom drawing',
    caretStyles?.native === 'rgba(0, 0, 0, 0)',
    JSON.stringify(caretStyles),
  );
  await cdp.send('Input.insertText', { text: '\n\nRaw edit.' });
  await sleep(6500);
  const afterRaw = await evaluate(cdp, 'window.texeris.doc.getText()');
  check(
    'typing in raw mode committed a revision',
    afterRaw.revision === baseRevision + 2 && afterRaw.text.includes('Raw edit.'),
    `revision ${afterRaw.revision}, want ${baseRevision + 2}`,
  );

  await evaluate(
    cdp,
    `[...document.querySelectorAll('.editor-status button')].find(b => b.textContent === 'Rendered').click(); true`,
  );
  await waitFor(cdp, `!!document.querySelector('.tiptap-rendered')`, 'rendered mode never remounted');
  await sleep(1200); // any stray flush would have fired by now
  const afterSwitch = await evaluate(cdp, 'window.texeris.doc.getText()');
  check(
    'mode switching created no revision of its own',
    afterSwitch.revision === baseRevision + 2,
    `revision ${afterSwitch.revision}, want ${baseRevision + 2}`,
  );

  // 4. restart → content + history intact
  app.proc.kill('SIGTERM');
  await sleep(1000);
  app = await launchApp(projectDir);
  ws = await connectPage(app.wsUrl);
  cdp = new Cdp(ws);
  await waitFor(cdp, `!!window.texeris`, 'preload API never attached after restart');
  const afterRestart = await evaluate(cdp, 'window.texeris.doc.getText()');
  check(
    'content survives restart',
    afterRestart.text.includes('Typed by the smoke test.') && afterRestart.text.includes('Raw edit.'),
  );
  check(
    'revision history survives restart',
    afterRestart.revision === baseRevision + 2,
    `revision ${afterRestart.revision}, want ${baseRevision + 2}`,
  );

  app.proc.kill('SIGTERM');
} finally {
  app?.proc.kill('SIGKILL');
  fs.rmSync(projectDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps passed');
process.exit(failures ? 1 : 0);
