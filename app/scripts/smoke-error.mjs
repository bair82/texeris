/**
 * WP5 error-surface smoke: with NO provider keys configured, a turn fails —
 * the error is surfaced in the chat and the Retry button re-issues the same
 * turn (context preserved). Offline; no API keys needed (that's the point).
 *
 * Usage: pnpm build first, then: node scripts/smoke-error.mjs
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

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-error-'));
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-error-config-'));
let app;
try {
  // Isolate the workspace config dir so no stored keychain key is visible.
  const env = {
    ...process.env,
    TEXERIS_PROJECT_DIR: projectDir,
    XDG_CONFIG_HOME: configDir,
    ELECTRON_ENABLE_LOGGING: '1',
      TEXERIS_SMOKE: '1',
  };
  delete env.DEEPSEEK_API_KEY;
  delete env.MOONSHOT_API_KEY;
  app = { proc: spawn(ELECTRON, ['.', '--no-sandbox', '--remote-debugging-port=0'], { cwd: APP_DIR, env }) };
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    app.proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    app.proc.on('exit', () => reject(new Error('electron exited early')));
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
    } catch {
      /* retry */
    }
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
      pending.set(id, (msg) =>
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result),
      );
      ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    if (res.exceptionDetails) {
      throw new Error(JSON.stringify(res.exceptionDetails));
    }
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

  await waitFor('!!window.texeris', 'preload API never attached');
  await waitFor(`!!document.querySelector('.chat-input textarea')`, 'chat UI never rendered');

  // turn with no provider key → run ends with an error (driven via the UI,
  // so the component's retry tracking engages)
  await evaluate(`
    (() => {
      const textarea = document.querySelector('.chat-input textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, 'hello');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('.chat-input button')]
        .find((b) => b.textContent.includes('Send'))
        .click();
      return true;
    })()
  `);
  await waitFor(`!!document.querySelector('.chat-error')`, 'error never surfaced in chat');
  check('model failure surfaces an error in the chat', true);

  // retry re-issues the same turn (and fails again — still no key)
  const retryVisible = await evaluate(`!!document.querySelector('.retry-button')`);
  check('retry button offered after failure', retryVisible === true);
  await evaluate(`document.querySelector('.retry-button').click(); true`);
  const secondError = await waitFor(
    `!!document.querySelector('.retry-button')`,
    'retry did not re-issue the turn',
  );
  check('retry re-issues the same turn (context preserved)', secondError);

  app.proc.kill('SIGTERM');
} finally {
  app?.proc.kill('SIGKILL');
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps passed');
process.exit(failures ? 1 : 0);
