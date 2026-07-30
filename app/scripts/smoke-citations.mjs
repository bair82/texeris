/**
 * G2 citation smoke: import a CSL JSON library from the citation picker,
 * search and insert in both editor modes, then verify citeproc output survives
 * PDF export/import.
 *
 * Usage: pnpm build first, then: node scripts/smoke-citations.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ELECTRON = new URL('../node_modules/electron/dist/electron', import.meta.url).pathname;
const APP_DIR = new URL('..', import.meta.url).pathname;
const FIXTURE = path.join(APP_DIR, 'test-fixtures', 'references.bib');
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

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-citations-'));
const outputPath = path.join(projectDir, 'citations.pdf');
let proc;
let ws;
try {
  proc = spawn(ELECTRON, ['.', '--no-sandbox', '--remote-debugging-port=0'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      TEXERIS_FAUX_PROVIDER: '1',
      TEXERIS_PROJECT_DIR: projectDir,
      TEXERIS_SMOKE: '1',
      TEXERIS_REFERENCE_IMPORT_PATH: FIXTURE,
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
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${httpPort}/json/list`).then((response) => response.json());
      const page = targets.find((target) => target.type === 'page' && target.url.includes('index.html'));
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve) => { ws.onopen = resolve; });
        break;
      }
    } catch { /* Electron is still starting. */ }
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
      pending.set(id, (message) =>
        message.error ? reject(new Error(message.error.message)) : resolve(message.result),
      );
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (expression, label, attempts = 80) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await evaluate(expression)) return true;
      await sleep(250);
    }
    check(label, false, `timed out: ${expression}`);
    return false;
  };
  const setInput = (selector, value) => `(async () => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`;
  const runPaletteCommand = async (query) => {
    await evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })); true");
    await waitFor("!!document.querySelector('.palette-input')", 'command palette did not open');
    await evaluate(setInput('.palette-input', query));
    await sleep(150);
    await evaluate("document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); true");
  };
  const focusEnd = async () => evaluate(`(() => {
    const editor = document.querySelector('.cm-raw .cm-content') || document.querySelector('.tiptap-rendered');
    if (!editor) return false;
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  })()`);

  await waitFor('!!window.texeris', 'preload API never attached');
  await waitFor("!!document.querySelector('.tiptap-rendered')", 'rendered editor never mounted');
  await focusEnd();
  await evaluate("document.querySelector('.citation-insert').click(); true");
  await waitFor("!!document.querySelector('.citation-picker')", 'citation picker never opened');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await waitFor(
    "!document.querySelector('.citation-picker')",
    'Escape did not close citation search',
  );
  check(
    'Escape closes citation search',
    await evaluate("!document.querySelector('.citation-picker')"),
  );
  await evaluate("document.querySelector('.citation-insert').click(); true");
  await waitFor("!!document.querySelector('.citation-picker')", 'citation picker did not reopen');
  check(
    'empty library offers add and import in the same picker',
    await evaluate("document.querySelector('.citation-empty')?.textContent.includes('Add a reference') && document.querySelector('.citation-empty')?.textContent.includes('Import a bibliography')"),
  );
  await evaluate("[...document.querySelectorAll('.citation-empty button')].find(button => button.textContent === 'Add a reference').click(); true");
  await waitFor("!!document.querySelector('.reference-form')", 'manual reference form did not open');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await waitFor(
    "!document.querySelector('.citation-picker')",
    'Escape did not close add-reference form',
  );
  check(
    'Escape closes add-reference form',
    await evaluate("!document.querySelector('.citation-picker')"),
  );
  await evaluate("document.querySelector('.citation-insert').click(); true");
  await waitFor("!!document.querySelector('.citation-picker')", 'citation picker did not reopen after form close');
  await evaluate("[...document.querySelectorAll('.citation-empty button')].find(button => button.textContent === 'Add a reference').click(); true");
  await waitFor("!!document.querySelector('.reference-form')", 'manual reference form did not reopen');
  if (process.env.TEXERIS_LIVE_DOI_SMOKE) {
    await evaluate(setInput('.reference-form input[placeholder=\"10.1000/example\"]', process.env.TEXERIS_LIVE_DOI_SMOKE));
    await evaluate("[...document.querySelectorAll('.reference-form button')].find(button => button.textContent === 'Find details').click(); true");
    await waitFor(
      "document.querySelector('.reference-form .citation-report')?.textContent.includes('Details found')",
      'live DOI metadata did not populate',
    );
    check(
      'live DOI lookup fills the editable core fields',
      await evaluate("document.querySelector('.reference-form input[placeholder=\"Title of the work\"]')?.value.length > 0 && document.querySelector('.reference-form input[placeholder=\"Ada Smith; Lin Jones\"]')?.value.length > 0 && document.querySelector('.reference-form input[placeholder=\"2026\"]')?.value.length > 0"),
    );
    await evaluate(setInput('.reference-form input[placeholder=\"10.1000/example\"]', ''));
    await evaluate(setInput('.reference-form input[placeholder=\"https://…\"]', ''));
    await evaluate(setInput('.reference-form-more label:last-child input', ''));
  }
  await evaluate(setInput('.reference-form input[placeholder=\"Title of the work\"]', 'Manually Added Source'));
  await evaluate(setInput('.reference-form input[placeholder=\"Ada Smith; Lin Jones\"]', 'Morgan Reed'));
  await evaluate(setInput('.reference-form input[placeholder=\"2026\"]', '2023'));
  check(
    'manual details generate a citation key',
    await evaluate("document.querySelector('.reference-key-preview')?.textContent.includes('@reed2023')"),
  );
  if (process.env.TEXERIS_REFERENCE_FORM_SCREENSHOT) {
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(
      process.env.TEXERIS_REFERENCE_FORM_SCREENSHOT,
      Buffer.from(screenshot.data, 'base64'),
    );
  }
  await evaluate("[...document.querySelectorAll('.reference-form button')].find(button => button.textContent === 'Add and cite').click(); true");
  await waitFor(
    "window.texeris.doc.getText().then(result => result.text.includes('[@reed2023]'))",
    'manual reference was not saved and cited',
  );
  check(
    'manual entry created the canonical project library',
    fs.existsSync(path.join(projectDir, 'references.csl.json')),
  );

  await focusEnd();
  await evaluate("document.querySelector('.citation-insert').click(); true");
  await waitFor("!!document.querySelector('.citation-picker')", 'citation picker did not reopen');
  await evaluate("[...document.querySelectorAll('.citation-picker button')].find(button => button.textContent === 'Import…').click(); true");
  await waitFor(
    "document.querySelector('.citation-report')?.textContent.includes('Imported 2')",
    'reference import did not complete',
  );
  check(
    'manual and imported records share one project library',
    JSON.parse(fs.readFileSync(path.join(projectDir, 'references.csl.json'), 'utf8')).length === 3,
  );

  await evaluate(setInput('.citation-search-row input', 'geometry'));
  await waitFor(
    "document.querySelector('.citation-result-title')?.textContent === 'The Geometry of Attention'",
    'search did not find imported reference',
  );
  if (process.env.TEXERIS_CITATION_SMOKE_SCREENSHOT) {
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(
      process.env.TEXERIS_CITATION_SMOKE_SCREENSHOT,
      Buffer.from(screenshot.data, 'base64'),
    );
  }
  await evaluate("document.querySelector('.citation-results > button').click(); true");
  await waitFor(
    "window.texeris.doc.getText().then(result => result.text.includes('[@smith2024]'))",
    'rendered citation was not committed',
  );
  check(
    'rendered mode displays a citation atom',
    await evaluate("!!document.querySelector('.tiptap-rendered .cite')"),
  );
  await evaluate("[...document.querySelectorAll('.tiptap-rendered .cite')].find(cite => cite.dataset.raw === '[@smith2024]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); true");
  await waitFor(
    "document.querySelector('.citation-picker h2')?.textContent === 'Replace citation'",
    'citation double-click did not open replacement search',
  );
  await evaluate(setInput('.citation-search-row input', 'ivanov'));
  await waitFor(
    "document.querySelector('.citation-result-title')?.textContent === 'Writing with Evidence'",
    'replacement search did not find imported reference',
  );
  await evaluate("document.querySelector('.citation-results > button').click(); true");
  await sleep(6500);
  const afterReplacement = await evaluate('window.texeris.doc.getText()');
  check(
    'rendered citation was replaced',
    afterReplacement.text.includes('[@ivanov2021]') &&
      !afterReplacement.text.includes('[@smith2024]'),
    afterReplacement.text.slice(-320),
  );

  await evaluate("[...document.querySelectorAll('.editor-status button')].find(button => button.textContent === 'Raw').click(); true");
  await waitFor("!!document.querySelector('.cm-raw')", 'raw editor never mounted');
  await focusEnd();
  await evaluate("document.querySelector('.cm-raw .cm-content').dispatchEvent(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); true");
  await waitFor("!!document.querySelector('.citation-picker')", 'citation shortcut did not open in raw mode');
  await evaluate(setInput('.citation-search-row input', 'geometry'));
  await waitFor(
    "document.querySelector('.citation-result-title')?.textContent === 'The Geometry of Attention'",
    'raw-mode search did not find imported reference',
  );
  await evaluate("document.querySelector('.citation-results > button').click(); true");
  await waitFor(
    "window.texeris.doc.getText().then(result => result.text.includes('[@smith2024]'))",
    'raw citation was not committed',
  );
  const canonical = await evaluate('window.texeris.doc.getText()');
  check(
    'both modes insert canonical Pandoc citation markers',
    canonical.text.includes('[@smith2024]') && canonical.text.includes('[@ivanov2021]'),
    canonical.text.slice(-240),
  );

  await runPaletteCommand('export document');
  await waitFor(
    "document.querySelector('.workspace-status-message')?.textContent.includes('Exported to')",
    'citation export did not complete',
  );
  const pdfBytes = fs.readFileSync(outputPath);
  check(
    'citeproc export produced a PDF',
    pdfBytes.length > 1_000 && pdfBytes.subarray(0, 5).toString() === '%PDF-',
    `${pdfBytes.length} bytes`,
  );

  await runPaletteCommand('import document');
  await waitFor(
    "document.querySelector('.workspace-status-message')?.textContent.includes('Imported citations.md')",
    'exported PDF did not re-import',
  );
  const imported = await evaluate(
    "window.texeris.doc.list().then(docs => docs.find(doc => doc.path === 'citations.md'))",
  );
  const importedText = await evaluate(`window.texeris.doc.getText(${JSON.stringify(imported?.id)})`);
  check(
    'export resolved citations and emitted bibliography entries',
    importedText?.text?.includes('Smith and Jones 2024') &&
      importedText.text.includes('The Geometry of Attention') &&
      importedText.text.includes('Writing with Evidence') &&
      importedText.text.includes('Manually Added Source'),
    importedText?.text?.slice(-600),
  );
} finally {
  ws?.close();
  proc?.kill('SIGKILL');
  fs.rmSync(projectDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps passed');
process.exit(failures ? 1 : 0);
