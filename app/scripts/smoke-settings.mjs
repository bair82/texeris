/**
 * Settings/credentials verification: boot without env keys, set a provider
 * key through the settings IPC (stored encrypted via safeStorage in the real
 * workspace config dir), confirm keySource transitions, and — when
 * SMOKE_TEST_API_KEY is a real DeepSeek key — run a live turn with the
 * stored key. Leaves the key stored (that's the point: the app works after).
 *
 * Usage: SMOKE_TEST_API_KEY=sk-... node scripts/smoke-settings.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ELECTRON = new URL('../node_modules/electron/dist/electron', import.meta.url).pathname;
const APP_DIR = new URL('..', import.meta.url).pathname;
const KEY = process.env.SMOKE_TEST_API_KEY;

if (!KEY) {
  console.error('SMOKE_TEST_API_KEY is required');
  process.exit(2);
}

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-settings-'));
let proc;
try {
  const env = { ...process.env, TEXERIS_PROJECT_DIR: projectDir, ELECTRON_ENABLE_LOGGING: '1' };
  delete env.DEEPSEEK_API_KEY;
  delete env.MOONSHOT_API_KEY;
  proc = spawn(ELECTRON, ['.', '--no-sandbox', '--remote-debugging-port=0'], { cwd: APP_DIR, env });
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

  for (let i = 0; i < 40; i++) {
    if (await evaluate('!!window.texeris')) break;
    await sleep(250);
  }

  const before = await evaluate('window.texeris.settings.get()');
  const ds = before.providers.find((p) => p.id === 'deepseek');
  check('deepseek starts unset (no env key)', ds.keySource === 'none', ds.keySource);
  check('encryption available (OS keychain)', before.encryptionAvailable === true);

  await evaluate(`window.texeris.settings.setApiKey('deepseek', ${JSON.stringify(KEY)})`);
  const after = await evaluate('window.texeris.settings.get()');
  const dsAfter = after.providers.find((p) => p.id === 'deepseek');
  check('key stored via settings → keychain', dsAfter.keySource === 'keychain', dsAfter.keySource);

  console.log('running a live turn with the stored key…');
  const turn = await evaluate(`
    (async () => {
      const { conversationId } = await window.texeris.chat.getOrCreateConversation();
      const done = new Promise((resolve) => {
        let last = null;
        const unsub = window.texeris.chat.onEvent((ev) => {
          if (ev.type === 'run_end') { last = ev; unsub(); resolve(ev); }
        });
      });
      await window.texeris.chat.startTurn({
        conversationId,
        text: 'Reply with exactly one word: the section heading of the second section of this document.',
        mode: 'fast',
        scope: { kind: 'document' },
      });
      return await done;
    })()
  `);
  check('live turn completed with the stored key', turn.status === 'completed', turn.errorMessage ?? turn.status);

  proc.kill('SIGTERM');
} finally {
  proc?.kill('SIGKILL');
  fs.rmSync(projectDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps passed — key left stored in the keychain');
process.exit(failures ? 1 : 0);
