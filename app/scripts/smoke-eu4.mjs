/**
 * EU4 smoke (proofreading & statistics): word count updates live while
 * typing, selection count appears on select-all, and the spellcheck
 * setting round-trips over IPC (enabled toggle + language).
 *
 * Usage: pnpm build first, then: node scripts/smoke-eu4.mjs
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

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-eu4proj-'));
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-eu4cfg-'));
let proc;
try {
  proc = spawn(ELECTRON, ['.', '--no-sandbox', '--remote-debugging-port=0'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configDir, // isolate the workspace config
      TEXERIS_FAUX_PROVIDER: '1',
      // Faux normally never writes a user's config; this smoke owns a tmp dir
      // and explicitly verifies persistence.
      TEXERIS_PERSIST_FAUX_CONFIG: '1',
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
  const waitFor = async (expression, label, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      if (await evaluate(expression)) return true;
      await sleep(250);
    }
    check(label, false, `timed out: ${expression}`);
    return false;
  };
  const wordCount = async () => {
    const text = await evaluate(`document.querySelector('.word-count')?.textContent ?? ''`);
    const m = text.match(/([\d,]+) words/);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };

  await waitFor(`!!window.texeris && !!document.querySelector('.tiptap-rendered')`, 'editor never mounted');
  await waitFor(
    `/[\\d,]+ words/.test(document.querySelector('.word-count')?.textContent ?? '')`,
    'word count never appeared',
  );
  const before = await wordCount();
  check('word count visible in the status bar', before !== null && before > 0, String(before));

  // type five words — the count must follow live (500 ms poll)
  await evaluate(`(() => {
    const el = document.querySelector('.tiptap-rendered');
    el.focus();
    const sel = window.getSelection();
    sel.selectAllChildren(el);
    sel.collapseToEnd();
    return true;
  })()`);
  const send = (method, params) => {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  await send('Input.insertText', { text: ' alpha beta gamma delta epsilon' });
  let after = before;
  for (let i = 0; i < 40 && after !== null && after < (before ?? 0) + 5; i++) {
    await sleep(250);
    after = await wordCount();
  }
  check('word count updates live while typing', after === (before ?? 0) + 5, `${before} → ${after}`);

  // selection count on select-all
  await evaluate(`document.querySelector('.tiptap-rendered').focus(); document.execCommand('selectAll'); true`);
  await waitFor(
    `(document.querySelector('.word-count')?.textContent ?? '').includes('selected')`,
    'selection count never appeared',
  );
  check('selection count appears on select-all', true);

  // spellcheck setting round-trips over IPC (default: off since 2026-07-21)
  const settings = await evaluate(`window.texeris.settings.get()`);
  check(
    'spellcheck settings exposed (off by default)',
    settings?.spellcheck?.enabled === false && Array.isArray(settings.spellcheck.availableLanguages),
    JSON.stringify(settings?.spellcheck),
  );
  await evaluate(`window.texeris.settings.setSpellcheck({ enabled: true, language: 'en-US' })`);
  const enabled = await evaluate(`window.texeris.settings.get().then(s => s.spellcheck.enabled)`);
  check('spellcheck enable applies + persists', enabled === true);
  const persisted = JSON.parse(fs.readFileSync(path.join(configDir, 'texeris', 'config.json'), 'utf8'));
  check('spellcheck persisted to config.json', persisted.spellcheck?.enabled === true);
  await evaluate(`window.texeris.settings.setSpellcheck({ enabled: false, language: 'en-US' })`);
  check(
    'spellcheck disable works',
    (await evaluate(`window.texeris.settings.get().then(s => s.spellcheck.enabled)`)) === false,
  );

  proc.kill('SIGTERM');
} finally {
  proc?.kill('SIGKILL');
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps passed');
process.exit(failures ? 1 : 0);
