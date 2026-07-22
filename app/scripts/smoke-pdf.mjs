/**
 * PDF smoke: renderer bridge -> IPC -> Pandoc HTML -> isolated Chromium print,
 * followed by renderer bridge -> IPC -> shared PDF text extraction/import.
 *
 * Usage: pnpm build first, then: node scripts/smoke-pdf.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ELECTRON = new URL('../node_modules/electron/dist/electron', import.meta.url).pathname;
const APP_DIR = new URL('..', import.meta.url).pathname;
const PANDOC = path.join(
  APP_DIR,
  'vendor',
  'resources',
  'pandoc',
  `${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`,
  process.platform === 'win32' ? 'pandoc.exe' : 'pandoc',
);

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`ok   ${label}`);
  else {
    failures += 1;
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-pdf-project-'));
const outputPath = path.join(projectDir, 'round-trip.pdf');
let proc;
try {
  proc = spawn(ELECTRON, ['.', '--no-sandbox', '--remote-debugging-port=0'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      TEXERIS_FAUX_PROVIDER: '1',
      TEXERIS_PROJECT_DIR: projectDir,
      TEXERIS_SMOKE: '1',
      TEXERIS_PDF_SMOKE_OUTPUT: outputPath,
      TEXERIS_PDF_SMOKE_IMPORT: outputPath,
      ...(fs.existsSync(PANDOC) ? { TEXERIS_PANDOC_PATH: PANDOC } : {}),
      ELECTRON_ENABLE_LOGGING: '1',
    },
  });
  const wsUrl = await new Promise((resolve, reject) => {
    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data;
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    proc.on('exit', () => reject(new Error(`Electron exited early:\n${stderr}`)));
    setTimeout(() => reject(new Error('timeout waiting for DevTools')), 20_000);
  });

  const httpPort = wsUrl.match(/ws:\/\/[^:/]+:(\d+)/)[1];
  let ws;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${httpPort}/json/list`).then((response) => response.json());
      const page = targets.find((target) => target.type === 'page' && target.url.includes('index.html'));
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve) => { ws.onopen = resolve; });
        break;
      }
    } catch { /* retry while Electron starts */ }
    await sleep(250);
  }
  if (!ws) throw new Error('renderer target did not appear');

  let messageId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  const send = (method, params = {}) => {
    const id = ++messageId;
    return new Promise((resolve, reject) => {
      pending.set(id, (message) => message.error ? reject(new Error(message.error.message)) : resolve(message.result));
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await evaluate('!!window.texeris')) break;
    await sleep(250);
  }

  const phrase = 'PDF round trip preserves selectable academic prose.';
  const source = `# PDF Round Trip\n\n${Array(16).fill(phrase).join(' ')}\n`;
  const exported = await evaluate(`(async () => {
    const created = await window.texeris.doc.create('pdf-source.md');
    const current = await window.texeris.doc.getText(created.id);
    await window.texeris.doc.commit({
      documentId: created.id,
      splices: [{ from: 0, to: current.text.length, deletedText: current.text, insertedText: ${JSON.stringify(source)} }],
      kind: 'paste',
    });
    return window.texeris.doc.exportDialog(created.id);
  })()`);
  check('export returns PDF format', exported?.format === 'pdf', JSON.stringify(exported));
  const bytes = fs.readFileSync(outputPath);
  check('Chromium wrote a non-empty PDF', bytes.length > 1_000 && bytes.subarray(0, 5).toString() === '%PDF-', `${bytes.length} bytes`);

  const imported = await evaluate('window.texeris.doc.importDialog()');
  check('PDF import returns a Markdown document', imported?.path === 'round-trip.md', JSON.stringify(imported));
  check('PDF import reports lossy conversion', imported?.warnings?.some((warning) => /lossy/i.test(warning)), JSON.stringify(imported?.warnings));
  const importedText = await evaluate(`window.texeris.doc.getText(${JSON.stringify(imported?.id)})`);
  check('exported text is selectable and re-imported', importedText?.text?.includes(phrase), importedText?.text?.slice(0, 160));

  ws.close();
  proc.kill('SIGTERM');
} finally {
  proc?.kill('SIGKILL');
  fs.rmSync(projectDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps passed');
process.exit(failures ? 1 : 0);
