/**
 * Rewind end-to-end smoke (deterministic, offline): the faux provider scripts
 * a patch turn followed by a plain turn (TEXERIS_FAUX_REWIND=1). The patch is
 * accepted, then the rewind dialog rewinds to the first turn's boundary: the
 * document is restored as a NEW revision and the conversation is forked —
 * the original conversation stays intact.
 *
 * Usage: pnpm build first, then: node scripts/smoke-rewind.mjs
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
      TEXERIS_FAUX_REWIND: '1',
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

async function runTurn(cdp, conversationId, text) {
  await evaluate(
    cdp,
    `
    (async () => {
      const done = new Promise((resolve) => {
        const unsub = window.texeris.chat.onEvent((ev) => {
          if (ev.type === 'run_end') { unsub(); resolve(); }
        });
      });
      await window.texeris.chat.startTurn({
        conversationId: ${JSON.stringify(conversationId)},
        text: ${JSON.stringify(text)},
        mode: 'fast',
        scope: { kind: 'document' },
      });
      await done;
    })()
    `,
  );
}

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-rewind-smoke-'));
let app;
try {
  app = await launchApp(projectDir);
  const ws = await connectPage(app.wsUrl);
  const cdp = new Cdp(ws);
  await waitFor(cdp, `!!window.texeris`, 'preload API never attached');

  const boot = await evaluate(cdp, 'window.texeris.doc.getText()');
  const baseRevision = boot.revision;
  const { conversationId } = await evaluate(
    cdp,
    'window.texeris.chat.getOrCreateConversation()',
  );

  // turn 1: faux scripts propose_patch → accept it via the patch API
  await runTurn(cdp, conversationId, 'sharpen the terminology');
  await waitFor(cdp, `!!document.querySelector('.patch-card')`, 'patch review card never appeared');
  await evaluate(
    cdp,
    `[...document.querySelectorAll('.patch-card button')].find(b => b.textContent === 'Accept all').click(); true`,
  );
  await waitFor(
    cdp,
    `(async () => (await window.texeris.doc.getText()).text.includes('algebraic'))()`,
    'patched text never appeared',
  );

  // turn 2: plain scripted reply, no document change
  await runTurn(cdp, conversationId, 'anything else?');

  const messageCount = await evaluate(
    cdp,
    `(async () => (await window.texeris.chat.listMessages(${JSON.stringify(conversationId)})).length)()`,
  );
  check('both turns recorded in the original conversation', messageCount === 6, `got ${messageCount}`);

  // rewind points: two completed turns, described by their user message
  const points = await evaluate(
    cdp,
    `(async () => window.texeris.rewind.list(${JSON.stringify(conversationId)}, (await window.texeris.doc.getText()).documentId))()`,
  );
  check(
    'two turn rewind points with short descriptions, newest first',
    points.length === 2 &&
      points[0].description.includes('anything else?') &&
      points[1].description.includes('sharpen the terminology'),
    JSON.stringify(points),
  );

  // open the rewind dialog from the chat header and pick the first turn
  await evaluate(
    cdp,
    `[...document.querySelectorAll('.chat-controls button')].find(b => b.textContent === 'rewind').click(); true`,
  );
  await waitFor(cdp, `!!document.querySelector('.rewind-panel')`, 'rewind dialog never opened');
  await evaluate(
    cdp,
    `[...document.querySelectorAll('.rewind-point')].find(b => b.textContent.includes('sharpen the terminology')).click(); true`,
  );
  await waitFor(
    cdp,
    `!!document.querySelector('.rewind-diff') && document.querySelector('.rewind-diff').textContent.includes('algebraic')`,
    'rewind preview diff never appeared',
  );

  // rewind: document restored as a NEW revision, conversation forked
  await evaluate(cdp, `document.querySelector('.rewind-apply').click(); true`);
  await waitFor(
    cdp,
    `(async () => (await window.texeris.doc.getText()).text.includes('geometric'))()`,
    'rewound text never landed',
  );
  const rewound = await evaluate(cdp, 'window.texeris.doc.getText()');
  check(
    'document restored to the turn boundary as a new revision',
    rewound.revision === baseRevision + 2 &&
      rewound.text.includes('geometric') &&
      !rewound.text.includes('algebraic'),
    `rev=${rewound.revision}`,
  );

  const conversations = await evaluate(cdp, 'window.texeris.chat.listConversations()');
  const fork = conversations.find((c) => c.title.endsWith('(rewind)'));
  check('conversation forked with a marked title', !!fork, JSON.stringify(conversations));
  check(
    'fork holds only the messages up to the boundary',
    fork?.messageCount === 4,
    `got ${fork?.messageCount}`,
  );
  const original = conversations.find((c) => c.id === conversationId);
  check(
    'original conversation preserved intact',
    original?.messageCount === 6,
    `got ${original?.messageCount}`,
  );

  // the chat panel switched to the fork
  await waitFor(
    cdp,
    `document.querySelector('.conv-toggle')?.textContent.includes('(rewind)')`,
    'chat panel never switched to the forked conversation',
  );

  app.proc.kill('SIGTERM');
} finally {
  app?.proc.kill('SIGKILL');
  fs.rmSync(projectDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps passed');
process.exit(failures ? 1 : 0);
