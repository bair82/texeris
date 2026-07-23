/**
 * WP3 end-to-end smoke: drives the real Electron app over CDP with the
 * scripted faux provider (no API keys needed). Verifies the DoD:
 *  1. app boots; conversation is created
 *  2. a question about the document streams an answer into the renderer
 *  3. conversation + run manifest survive an app restart
 *  4. cancel is accepted while a run is active
 *
 * Usage: pnpm build first, then:
 *   node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ELECTRON = new URL('../node_modules/electron/dist/electron', import.meta.url)
  .pathname;
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
  const proc = spawn(
    ELECTRON,
    ['.', '--no-sandbox', '--remote-debugging-port=0'],
    {
      cwd: APP_DIR,
      env: {
        ...process.env,
        TEXERIS_FAUX_PROVIDER: '1',
        TEXERIS_PROJECT_DIR: projectDir,
        ELECTRON_ENABLE_LOGGING: '1',
      TEXERIS_SMOKE: '1',
      },
    },
  );
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
      const targets = await fetch(`http://127.0.0.1:${httpPort}/json/list`).then((r) =>
        r.json(),
      );
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

async function waitForPreload(cdp, tries = 80) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(cdp, "typeof window.texeris !== 'undefined'")) return;
    await sleep(250);
  }
  throw new Error('renderer preload bridge never became available');
}

// Full chat turn driven from the page context; resolves with collected events.
const RUN_TURN_JS = `
(async () => {
  const { conversationId } = await window.texeris.chat.getOrCreateConversation();
  const events = [];
  const done = new Promise((resolve) => {
    const unsub = window.texeris.chat.onEvent((ev) => {
      events.push(ev);
      if (ev.type === 'run_end') { unsub(); resolve(); }
    });
  });
  const { runId } = await window.texeris.chat.startTurn({
    conversationId,
    text: 'What is this document about?',
    mode: 'fast',
    scope: { kind: 'document' },
  });
  await done;
  const messages = await window.texeris.chat.listMessages(conversationId);
  const runs = await window.texeris.chat.listRuns(conversationId);
  return { conversationId, runId, events, messages, runs };
})()
`;

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-wp3-smoke-'));
let app;
try {
  // --- phase 1: boot, ask, stream -------------------------------------------
  app = await launchApp(projectDir);
  let ws = await connectPage(app.wsUrl);
  let cdp = new Cdp(ws);
  await waitForPreload(cdp);

  const docList = await evaluate(cdp, 'window.texeris.doc.list()');
  check('dev project seeded with a manuscript', docList?.[0]?.currentRevision >= 1);

  const outline = await evaluate(cdp, 'window.texeris.doc.outline()');
  check(
    'outline exposes manuscript headings',
    outline?.some((h) => h.text === 'Introduction'),
  );

  const turn1 = await evaluate(cdp, RUN_TURN_JS);
  const deltas = turn1.events.filter((e) => e.type === 'text_delta');
  const answer = deltas.map((d) => d.delta).join('');
  check(
    'question about the document streamed an answer',
    answer.includes('scripted offline response'),
    `got: ${answer.slice(0, 80)}`,
  );
  check(
    'run ended completed with a context manifest',
    turn1.events.at(-1)?.type === 'run_end' &&
      turn1.events.at(-1)?.status === 'completed' &&
      turn1.events.at(-1)?.manifest?.baseRevision >= 1,
  );
  check(
    'turn persisted in the transcript',
    turn1.messages.some((m) => m.role === 'user') &&
      turn1.messages.some((m) => m.role === 'assistant' && m.text.includes('scripted')),
  );
  check(
    'agent_runs row has provider/model/manifest',
    turn1.runs.length === 1 && turn1.runs[0].provider === 'faux' &&
      turn1.runs[0].manifest !== null,
  );

  // --- phase 2: cancel path ---------------------------------------------------
  const cancelResult = await evaluate(
    cdp,
    `
    (async () => {
      const { conversationId } = await window.texeris.chat.getOrCreateConversation();
      const { runId } = await window.texeris.chat.startTurn({
        conversationId, text: 'again', mode: 'fast', scope: { kind: 'document' },
      });
      const ack = await window.texeris.chat.cancel(runId);
      return ack;
    })()
    `,
  );
  check('cancel accepted while a run is active', cancelResult?.cancelled === true);
  await sleep(500);

  app.proc.kill('SIGTERM');
  await sleep(1000);

  // --- phase 3: restart survival ----------------------------------------------
  app = await launchApp(projectDir);
  ws = await connectPage(app.wsUrl);
  cdp = new Cdp(ws);
  await waitForPreload(cdp);
  const after = await evaluate(
    cdp,
    `
    (async () => {
      const { conversationId } = await window.texeris.chat.getOrCreateConversation();
      const messages = await window.texeris.chat.listMessages(conversationId);
      const runs = await window.texeris.chat.listRuns(conversationId);
      return { messages, runs };
    })()
    `,
  );
  check(
    'conversation survives an app restart',
    after.messages.some((m) => m.role === 'assistant' && m.text.includes('scripted')),
  );
  check(
    'run manifest survives an app restart',
    after.runs.length >= 1 && after.runs[0].manifest?.scope?.kind === 'document',
  );
  app.proc.kill('SIGTERM');
} finally {
  app?.proc.kill('SIGKILL');
  fs.rmSync(projectDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps passed');
process.exit(failures ? 1 : 0);
