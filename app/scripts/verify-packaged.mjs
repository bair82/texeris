/**
 * Verify the packaged artifact. By default this launches the AppImage (or
 * another packaged binary) with a temp project dir, attaches over CDP, and
 * checks the preload API + document round trip. `--resources-only` is the
 * displayless CI variant: it verifies the unpacked application and bundled
 * Pandoc executable without attempting to launch Electron.
 *
 * Usage: node scripts/verify-packaged.mjs [path-to-binary]
 */
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const args = process.argv.slice(2);
const resourcesOnly = args.includes('--resources-only');
const BIN =
  args.find((arg) => arg !== '--resources-only') ??
  new URL('../dist/texeris-0.1.0-x86_64.AppImage', import.meta.url).pathname;
const UNPACKED = new URL('../dist/linux-unpacked/resources/', import.meta.url).pathname;

if (resourcesOnly) {
  let failures = 0;
  const check = (label, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
  };
  const appAsar = path.join(UNPACKED, 'app.asar');
  const pandoc = path.join(UNPACKED, 'pandoc', 'linux-amd64', 'pandoc');
  check('packaged app.asar exists', fs.existsSync(appAsar));
  check('bundled Pandoc exists and is executable', fs.existsSync(pandoc) && (fs.statSync(pandoc).mode & 0o111) !== 0);
  const cslDir = path.join(UNPACKED, 'csl');
  for (const file of ['chicago-author-date.csl', 'apa.csl', 'ieee.csl', 'vancouver.csl']) {
    const csl = path.join(cslDir, file);
    const valid =
      fs.existsSync(csl) &&
      fs.readFileSync(csl, 'utf8').includes('http://purl.org/net/xbiblio/csl');
    check(`bundled citation style ${file}`, valid);
  }
  try {
    const version = execFileSync(pandoc, ['--version'], { encoding: 'utf8' });
    check('bundled Pandoc launches', version.startsWith('pandoc '), version.split('\n')[0]);
  } catch (err) {
    check('bundled Pandoc launches', false, err instanceof Error ? err.message : String(err));
  }
  console.log(failures ? 'packaged-resource verification FAILED' : 'packaged-resource verification passed');
  process.exit(failures ? 1 : 0);
}

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-pkg-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(BIN, ['--no-sandbox', '--remote-debugging-port=0'], {
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
  proc.on('exit', (code) => reject(new Error(`binary exited early (${code})`)));
  setTimeout(() => reject(new Error('timeout waiting for DevTools')), 30000);
});

const httpPort = wsUrl.match(/ws:\/\/[^:/]+:(\d+)/)[1];
let page;
for (let i = 0; i < 40 && !page; i++) {
  try {
    const targets = await fetch(`http://127.0.0.1:${httpPort}/json/list`).then((r) => r.json());
    page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
  } catch {
    /* not up yet */
  }
  if (!page) await sleep(250);
}
if (!page) {
  console.error('FAIL no page target found');
  proc.kill('SIGKILL');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });

let texerisUp = false;
for (let i = 0; i < 40 && !texerisUp; i++) {
  const res = await send('Runtime.evaluate', {
    expression: '!!window.texeris',
    returnByValue: true,
  });
  texerisUp = res.result.value === true;
  if (!texerisUp) await sleep(250);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures += 1;
};
check('preload API attached in packaged app', texerisUp);

if (texerisUp) {
  const doc = await send('Runtime.evaluate', {
    expression: 'window.texeris.doc.getText()',
    awaitPromise: true,
    returnByValue: true,
  });
  const value = doc.result.value;
  check(
    'document round trip works in packaged app',
    value?.text?.includes('Geometry of Attention') && value?.revision >= 1,
  );
  // The IPC stack comes up before the editor session mounts — poll.
  let editorUp = false;
  for (let i = 0; i < 40 && !editorUp; i++) {
    const editor = await send('Runtime.evaluate', {
      expression: `!!document.querySelector('.tiptap-rendered, .cm-raw')`,
      returnByValue: true,
    });
    editorUp = editor.result.value === true;
    if (!editorUp) await sleep(250);
  }
  check('editor mounted in packaged app', editorUp);
}

proc.kill('SIGTERM');
await sleep(500);
fs.rmSync(projectDir, { recursive: true, force: true });
console.log(failures ? 'packaged-app verification FAILED' : 'packaged-app verification passed');
process.exit(failures ? 1 : 0);
