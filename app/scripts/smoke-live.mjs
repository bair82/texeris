/**
 * WP4 live smoke: real DeepSeek turn. Requires DEEPSEEK_API_KEY in the env.
 * Asks for a small concrete rewrite, waits for the run, accepts whatever
 * patch was proposed, and reports. LLM output is non-deterministic — the
 * hard assertion is that the pipeline works (patch proposed via the tool,
 * outcome recorded); offset accuracy of the model is reported, not asserted.
 *
 * Usage: pnpm build first, then:
 *   DEEPSEEK_API_KEY=... node scripts/smoke-live.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ELECTRON = new URL('../node_modules/electron/dist/electron', import.meta.url).pathname;
const APP_DIR = new URL('..', import.meta.url).pathname;

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('DEEPSEEK_API_KEY is required');
  process.exit(2);
}

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function note(label, detail) {
  console.log(`note ${label} — ${detail}`);
}

async function launchApp(projectDir) {
  const proc = spawn(ELECTRON, ['.', '--no-sandbox', '--remote-debugging-port=0'], {
    cwd: APP_DIR,
    env: { ...process.env, TEXERIS_PROJECT_DIR: projectDir, ELECTRON_ENABLE_LOGGING: '1' },
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

async function evaluate(cdp, expression, timeout = 180_000) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout,
  });
  if (result.exceptionDetails) {
    throw new Error(
      `page eval failed: ${JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)}`,
    );
  }
  return result.result.value;
}

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-live-smoke-'));
let app;
try {
  app = await launchApp(projectDir);
  const ws = await connectPage(app.wsUrl);
  const cdp = new Cdp(ws);
  for (let i = 0; i < 40; i++) {
    if (await evaluate(cdp, '!!window.texeris')) break;
    await sleep(250);
  }

  console.log('asking the model for a small rewrite (live DeepSeek)…');
  const turn = await evaluate(
    cdp,
    `
    (async () => {
      const { conversationId } = await window.texeris.chat.getOrCreateConversation();
      const events = [];
      const done = new Promise((resolve) => {
        const unsub = window.texeris.chat.onEvent((ev) => {
          events.push(ev.type === 'text_delta' ? { ...ev, delta: undefined } : ev);
          if (ev.type === 'run_end') { unsub(); resolve(); }
        });
      });
      const { runId } = await window.texeris.chat.startTurn({
        conversationId,
        text: 'In the Method section, replace the word "probe" with "examine". Use propose_patch with exact offsets; the change is one word.',
        mode: 'fast',
        scope: { kind: 'document' },
      });
      await done;
      const patches = await window.texeris.patch.list();
      return { runId, events, patches };
    })()
    `,
  );

  const toolCalls = turn.events.filter((e) => e.type === 'tool_start').map((e) => e.toolName);
  note('tools called by the model:', toolCalls.join(', ') || '(none)');
  check('model called propose_patch', toolCalls.includes('propose_patch'));
  check(
    'a patch was proposed and stored',
    turn.patches.length >= 1,
    `patches: ${turn.patches.length}`,
  );

  if (turn.patches.length >= 1) {
    const patch = turn.patches[0];
    note(
      'proposed patch:',
      `${patch.title} (${patch.groups.length} group(s), base rev ${patch.baseRevision})`,
    );
    const accepted = await evaluate(
      cdp,
      `window.texeris.patch.accept(${JSON.stringify(patch.id)})`,
    );
    if ('conflict' in accepted) {
      note('accept result:', `conflict — model's offsets were stale (${accepted.conflict.length} item(s)); pipeline failed safely as designed`);
    } else {
      const doc = await evaluate(cdp, 'window.texeris.doc.getText()');
      check(
        'patch applied as agent revision',
        doc.revision === accepted.seq && accepted.previousSeq < accepted.seq,
      );
      note('text now contains "examine":', String(doc.text.includes('examine')));
      const after = await evaluate(cdp, 'window.texeris.patch.list()');
      check('outcome recorded (accepted)', after[0].status === 'accepted');
    }
  }

  app.proc.kill('SIGTERM');
} finally {
  app?.proc.kill('SIGKILL');
  fs.rmSync(projectDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps passed');
process.exit(failures ? 1 : 0);
