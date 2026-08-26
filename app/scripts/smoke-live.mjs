/**
 * WP4 live smoke: real DeepSeek turn. Requires DEEPSEEK_API_KEY in the env.
 * Asks for a small concrete rewrite, waits for the run, accepts whatever
 * patch was proposed, and reports. LLM output is non-deterministic — the
 * hard assertion is that the pipeline works (patch proposed via the tool,
 * outcome recorded); offset accuracy of the model is reported, not asserted.
 *
 * Usage: pnpm build first, then:
 *   DEEPSEEK_API_KEY=... node scripts/smoke-live.mjs
 * The app's encrypted stored DeepSeek key is also supported.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ELECTRON = new URL('../node_modules/electron/dist/electron', import.meta.url).pathname;
const APP_DIR = new URL('..', import.meta.url).pathname;
const SCREENSHOT_MANUSCRIPT = `# Governing Through Visibility

## Abstract

Digital labour platforms increasingly present dashboards, ratings, and automated feedback as instruments of worker autonomy. This article draws on 42 semi-structured interviews with freelance translators in Germany and Poland to examine how workers interpret these systems. We find that increased visibility can improve short-term planning while leaving the rules that govern ranking, allocation, and suspension difficult to contest.

## Introduction

Existing accounts often present dashboard visibility as if it were equivalent to worker control, even though workers may see more information while remaining unable to contest how rankings, task allocation, or account sanctions are produced [@rosenblat2018]. This distinction matters because transparency can reorganize dependence without reducing it.

We therefore ask when platform visibility becomes actionable for workers and when it merely makes managerial decisions more legible. Our analysis distinguishes informational access from procedural control and traces how that distinction shapes everyday strategies.

## Method

We conducted 42 semi-structured interviews between September 2024 and March 2025. Participants were recruited through professional associations and platform-specific forums. Interviews were coded iteratively, with attention to moments when information changed a worker's capacity to challenge or anticipate a platform decision.
`;
const SCREENSHOT_PROMPT =
  'Could you tighten the first paragraph of the Introduction? Keep the distinction between visibility and control, preserve the citation, and do not make the claim stronger. Please propose the revision as a reviewable patch.';

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
    env: { ...process.env, TEXERIS_PROJECT_DIR: projectDir, ELECTRON_ENABLE_LOGGING: '1', TEXERIS_SMOKE: '1' },
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
        const pending = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(`${pending.method}: ${msg.error.message}`));
        else pending.resolve(msg.result);
      }
    };
    const rejectPending = () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`CDP connection closed while waiting for ${pending.method}`));
      }
      this.pending.clear();
    };
    ws.onclose = rejectPending;
    ws.onerror = rejectPending;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
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

async function captureScreenshot(cdp, target) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(target, Buffer.from(screenshot.data, 'base64'));
}

async function waitFor(cdp, expression, label, tries = 720) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(cdp, expression)) return;
    await sleep(250);
  }
  throw new Error(`${label}: timed out waiting for ${expression}`);
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
  let turn;
  if (process.env.TEXERIS_LIVE_PATCH_SCREENSHOT) {
    await waitFor(cdp, `!!document.querySelector('.tiptap-rendered')`, 'editor never mounted', 80);
    await evaluate(
      cdp,
      `(async () => {
        const document = await window.texeris.doc.getText();
        await window.texeris.doc.commit({
          splices: [{
            from: 0,
            to: document.text.length,
            deletedText: document.text,
            insertedText: ${JSON.stringify(SCREENSHOT_MANUSCRIPT)},
          }],
          kind: 'paste',
        });
        return true;
      })()`,
    );
    await cdp.send('Page.reload');
    await waitFor(cdp, `!!window.texeris`, 'preload API did not return after fixture reload', 80);
    await waitFor(cdp, `!!document.querySelector('.tiptap-rendered')`, 'editor did not remount after fixture reload', 80);
    await waitFor(
      cdp,
      `document.querySelector('.tiptap-rendered')?.textContent.includes('Governing Through Visibility')`,
      'showcase manuscript did not reach the editor',
      80,
    );
    await waitFor(cdp, `!!document.querySelector('.chat-input textarea')`, 'chat input never mounted', 80);
    await evaluate(
      cdp,
      `(() => {
        window.__texerisLiveRun = { events: [], done: false };
        const unsubscribe = window.texeris.chat.onEvent((event) => {
          window.__texerisLiveRun.events.push(
            event.type === 'text_delta' ? { ...event, delta: undefined } : event,
          );
          if (event.type === 'run_end') {
            window.__texerisLiveRun.done = true;
            unsubscribe();
          }
        });
        return true;
      })()`,
    );
    await evaluate(
      cdp,
      `(() => {
        const input = document.querySelector('.chat-input textarea');
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        set.call(input, ${JSON.stringify(SCREENSHOT_PROMPT)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
    );
    await waitFor(cdp, `!document.querySelector('.chat-input button').disabled`, 'send button stayed disabled', 80);
    await evaluate(
      cdp,
      `document.querySelector('.chat-input button').click(); true`,
    );
    await waitFor(cdp, `window.__texerisLiveRun?.done === true`, 'live run never ended');
    turn = await evaluate(
      cdp,
      `(async () => ({
        events: window.__texerisLiveRun.events,
        patches: await window.texeris.patch.list(),
      }))()`,
    );
    const end = turn.events.findLast((event) => event.type === 'run_end');
    if (end?.status !== 'completed') {
      throw new Error(`live run ended ${end?.status ?? 'without status'}: ${end?.errorMessage ?? 'unknown provider error'}`);
    }
    if (turn.patches.length === 0) {
      const toolNames = turn.events
        .filter((event) => event.type === 'tool_start')
        .map((event) => event.toolName)
        .join(', ');
      throw new Error(`live run completed without a patch; tools called: ${toolNames || '(none)'}`);
    }
    await waitFor(cdp, `!!document.querySelector('.patch-card')`, 'live patch review card never appeared', 80);
  } else {
    turn = await evaluate(
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
  }

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
    if (process.env.TEXERIS_LIVE_PATCH_SCREENSHOT) {
      for (let i = 0; i < 40; i++) {
        if (await evaluate(cdp, `!!document.querySelector('.patch-card')`)) break;
        await sleep(250);
      }
      await evaluate(
        cdp,
        `[...document.querySelectorAll('.patch-group button')]
          .find((button) => button.textContent === 'Show')?.click(); true`,
      );
      await evaluate(
        cdp,
        `(() => {
          const messages = document.querySelector('.chat-messages');
          if (messages) messages.scrollTop = 0;
          return true;
        })()`,
      );
      await sleep(Number(process.env.TEXERIS_SCREENSHOT_DELAY_MS ?? 300));
      await captureScreenshot(cdp, process.env.TEXERIS_LIVE_PATCH_SCREENSHOT);
    }
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
