/**
 * EU7 smoke (recovery & onboarding): trash a document, restore it from the
 * trash dialog (it reopens, history intact), trash it again and delete it
 * permanently; then create a fresh project and check it opens on welcome.md.
 *
 * Usage: pnpm build first, then: node scripts/smoke-eu7.mjs
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

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-eu7proj-'));
const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-eu7parent-'));
let proc;
try {
  proc = spawn(ELECTRON, ['.', '--no-sandbox', '--remote-debugging-port=0'], {
    cwd: APP_DIR,
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
  const setInput = (selector, value) => `(async () => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return false;
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
    set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`;
  const navHas = (name) =>
    `[...document.querySelectorAll('.nav-file')].some(b => b.textContent.includes(${JSON.stringify(name)}))`;
  const trashViaMenu = async (name) => {
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.nav-file-row')].find(r => r.textContent.includes(${JSON.stringify(name)}));
      if (!row) return false;
      row.querySelector('.nav-file-menu-btn').click();
      return true;
    })()`);
    if (!(await waitFor(
      `[...document.querySelectorAll('.nav-menu button')].some(b => b.textContent.includes('Move to trash'))`,
      `row menu never opened for ${name}`,
    ))) return false;
    await evaluate(`[...document.querySelectorAll('.nav-menu button')].find(b => b.textContent.includes('Move to trash')).click(); true`);
    if (!(await waitFor(`!!document.querySelector('.nav-confirm-yes')`, 'trash confirm never showed'))) return false;
    await evaluate(`document.querySelector('.nav-confirm-yes').click(); true`);
    return waitFor(`!(${navHas(name)})`, `${name} still in the nav after trashing`);
  };
  const openTrashDialog = async () => {
    await evaluate(`document.querySelector('.trash-action').click(); true`);
    return waitFor(`!!document.querySelector('.trash-panel')`, 'trash dialog never opened');
  };

  await waitFor(`!!window.texeris && !!document.querySelector('.tiptap-rendered')`, 'editor never mounted');
  check('welcome.md is seeded into the dev project', await evaluate(navHas('welcome.md')));

  // An active project must still be able to reach the picker in order to
  // create another project (and inspect its welcome.md), then return safely.
  await evaluate(`document.querySelector('.footer-button').click(); true`);
  await waitFor(`!!document.querySelector('.project-picker')`, 'project picker never opened');
  check('active project can reopen the project picker', true);
  await evaluate(`document.querySelector('.picker-back').click(); true`);
  await waitFor(`!!document.querySelector('.tiptap-rendered')`, 'back from project picker never restored the project');
  check('project picker returns to the active project', true);

  // create a scratch document, then trash it through the row menu
  await evaluate(`document.querySelector('.nav-action:not(.import-action):not(.trash-action)').click(); true`);
  await evaluate(setInput('.nav-new-form input', 'scratch'));
  await evaluate(`document.querySelector('.nav-new-form input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
  await waitFor(navHas('scratch.md'), 'scratch.md never appeared in the nav');

  await trashViaMenu('scratch.md');
  const trashFiles = () =>
    fs.existsSync(path.join(projectDir, '.texeris', 'trash'))
      ? fs.readdirSync(path.join(projectDir, '.texeris', 'trash'))
      : [];
  check('trashed file moved to .texeris/trash', trashFiles().length === 1, trashFiles().join(','));

  // open the trash dialog and restore it
  await openTrashDialog();
  await waitFor(
    `[...document.querySelectorAll('.trash-doc-path')].some(el => el.textContent.includes('scratch.md'))`,
    'scratch.md never listed in the trash',
  );
  await evaluate(`[...document.querySelectorAll('.trash-actions button')].find(b => b.textContent === 'Restore').click(); true`);
  await waitFor(navHas('scratch.md'), 'restored document never reappeared in the nav');
  check(
    'restored document opens right away',
    await evaluate(`document.querySelector('.nav-file.active')?.textContent.includes('scratch.md') ?? false`),
  );
  await waitFor(
    `document.querySelector('.trash-panel')?.textContent.includes('trash is empty') ?? false`,
    'trash dialog did not empty after the restore',
  );
  check('trash dir is empty after the restore', trashFiles().length === 0, trashFiles().join(','));

  // close the dialog with the ✕ button, then trash scratch.md again
  await evaluate(`document.querySelector('.trash-panel header button').click(); true`);
  await waitFor(`!document.querySelector('.trash-panel')`, 'trash dialog did not close');
  await trashViaMenu('scratch.md');

  // delete it permanently (with the inline confirm)
  await openTrashDialog();
  await waitFor(
    `[...document.querySelectorAll('.trash-doc-path')].some(el => el.textContent.includes('scratch.md'))`,
    'scratch.md never listed in the trash again',
  );
  await evaluate(`[...document.querySelectorAll('.trash-actions button')].find(b => b.textContent.startsWith('Delete')).click(); true`);
  await waitFor(
    `[...document.querySelectorAll('.trash-actions button')].some(b => b.textContent === 'Delete')`,
    'permanent-delete confirm never showed',
  );
  await evaluate(`[...document.querySelectorAll('.trash-actions button')].find(b => b.textContent === 'Delete').click(); true`);
  await waitFor(
    `document.querySelector('.trash-panel')?.textContent.includes('trash is empty') ?? false`,
    'trash dialog did not empty after permanent delete',
  );
  check('permanently deleted file is gone from the trash dir', trashFiles().length === 0, trashFiles().join(','));
  check('scratch.md stays out of the nav', !(await evaluate(navHas('scratch.md'))));

  // close the dialog with Esc
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await waitFor(`!document.querySelector('.trash-panel')`, 'Esc did not close the trash dialog');
  check('Esc closes the trash dialog', true);

  // a brand-new project opens on welcome.md
  await evaluate(`window.texeris.project.create(${JSON.stringify(parentDir)}, 'fresh-proj')`);
  // the project switch reloads the page — wait until the NEW project is the
  // current one, not just for any editor (the old page had one too)
  await waitFor(
    `(async () => { const c = await window.texeris.project.current(); return c?.root?.endsWith('fresh-proj') ?? false; })()`,
    'app did not reload into the new project',
    100,
  );
  await waitFor(`!!document.querySelector('.tiptap-rendered')`, 'editor never mounted in the new project');
  check(
    'new project opens on welcome.md',
    await evaluate(`document.querySelector('.nav-file.active')?.textContent.includes('welcome.md') ?? false`),
  );
  check(
    'the welcome content is on screen',
    await evaluate(`document.querySelector('.tiptap-rendered')?.textContent.includes('Welcome to Texeris') ?? false`),
  );

  proc.kill('SIGTERM');
} finally {
  proc?.kill('SIGKILL');
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(parentDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} step(s) FAILED` : '\nall steps passed');
process.exit(failures ? 1 : 0);
