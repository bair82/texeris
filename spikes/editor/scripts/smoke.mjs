/**
 * Headless-browser interaction smoke test over raw CDP (no npm deps).
 * Usage: start the dev server on port 5199 first:
 *   pnpm --filter @texeris/spike-editor dev --port 5199 --strictPort
 * then:
 *   node scripts/smoke.mjs
 * Requires a chromium binary on PATH. Exits non-zero if any step fails or an
 * uncaught page exception occurs.
 */
import { spawn } from 'node:child_process';

const APP = 'http://localhost:5199/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn('chromium', [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--remote-debugging-port=0',
  'about:blank',
]);

const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  chrome.stderr.on('data', (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
  chrome.on('exit', () => reject(new Error('chrome exited')));
  setTimeout(() => reject(new Error('timeout waiting for DevTools')), 15000);
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const exceptions = [];

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  } else if (msg.method === 'Runtime.exceptionThrown') {
    exceptions.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description ?? ''));
  }
};

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

const { targetId } = await send('Target.createTarget', { url: APP });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);

async function evaljs(expression) {
  const res = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (res.exceptionDetails) {
    throw new Error(
      'page threw: ' + (res.exceptionDetails.exception?.description ?? res.exceptionDetails.text) + '\n  in: ' + expression.slice(0, 120),
    );
  }
  return res.result.value;
}

async function waitFor(expression, timeout = 10000) {
  const start = Date.now();
  for (;;) {
    const val = await evaljs(expression).catch(() => null);
    if (val) return val;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out: ' + expression);
    await sleep(150);
  }
}

// Wait for the app to boot before injecting helpers (navigation wipes globals).
await waitFor(`!!document.querySelector('#pane-codemirror .cm-editor')`);
await evaljs(`(() => {
  window.__s = {
    clickText(sel, text) {
      const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(text));
      if (!el) throw new Error('missing ' + sel + ' :: ' + text);
      el.click();
    },
    text(sel) { return document.querySelector(sel)?.textContent ?? ''; },
    count(sel) { return document.querySelectorAll(sel).length; },
    select(value) {
      const s = document.getElementById('sample-select');
      s.value = value;
      s.dispatchEvent(new Event('change'));
    },
  };
  return true;
})()`);

const results = [];
async function step(name, fn) {
  try {
    const out = await fn();
    results.push(`ok   ${name}${out ? ' — ' + out : ''}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err.message}`);
  }
}

// ---------- CM tab ----------
await step('CM editor boots with citation pills', async () => {
  await waitFor(`window.__s.count('#pane-codemirror .cm-editor') === 1`);
  // CM virtualizes: only viewport lines are in the DOM.
  const pills = await evaljs(`window.__s.count('#pane-codemirror .cite-pill')`);
  if (pills < 1) throw new Error('no pills rendered');
  return pills + ' pills in initial viewport';
});

await step('CM conflict demo fails safely', async () => {
  await evaljs(`window.__s.clickText('#pane-codemirror .patch-group .tool-btn', 'conflict demo')`);
  const msg = await evaljs(`window.__s.text('#pane-codemirror .message-line')`);
  if (!msg.includes('expected text not found')) throw new Error('no conflict message: ' + msg);
});

await step('CM revision list shows the racing user edit', async () => {
  const rev = await evaljs(`window.__s.text('#pane-codemirror .revision-list')`);
  if (!rev.includes('user')) throw new Error(rev);
});

await step('reload main sample (both tabs)', async () => {
  await evaljs(`window.__s.select('edge-sample.md')`);
  await sleep(300);
  await evaljs(`window.__s.select('main-sample.md')`);
  await sleep(300);
});

await step('CM patch C (insertion) highlights the inserted range', async () => {
  await evaljs(`window.__s.clickText('#pane-codemirror .patch-group .tool-btn', 'C · qualify')`);
  const msg = await evaljs(`window.__s.text('#pane-codemirror .message-line')`);
  if (!msg.includes('applied')) throw new Error(msg);
  const hl = await evaljs(`window.__s.count('#pane-codemirror .patch-highlight')`);
  if (hl < 1) throw new Error('no highlight marks');
  const rev = await evaljs(`window.__s.text('#pane-codemirror .revision-list')`);
  if (!rev.includes('agent')) throw new Error('no agent revision: ' + rev);
  return `highlight marks: ${hl}`;
});

await step('CM patch A applies (deletion)', async () => {
  await evaljs(`window.__s.clickText('#pane-codemirror .patch-group .tool-btn', 'A · trim hedge')`);
  const msg = await evaljs(`window.__s.text('#pane-codemirror .message-line')`);
  if (!msg.includes('applied')) throw new Error(msg);
  const text = await evaljs(`window.__texeris.getCanonical('codemirror')`);
  if (text.includes('It is important to note that')) throw new Error('phrase still present');
});

await step('CM raw mode switch keeps round-trip OK', async () => {
  await evaljs(`window.__s.clickText('#pane-codemirror .tool-group .tool-btn', 'Raw Markdown')`);
  await waitFor(`window.__s.count('#pane-codemirror .cm-host.raw-mode') === 1`);
  const badge = await evaljs(`window.__s.text('#pane-codemirror .rt-badge')`);
  await evaljs(`window.__s.clickText('#pane-codemirror .tool-group .tool-btn', 'Rendered')`);
  if (!badge.includes('OK')) throw new Error('badge: ' + badge);
  return badge.trim();
});

await step('CM typing records a user revision', async () => {
  const before = await evaljs(`window.__s.text('#pane-codemirror .revision-list')`);
  const rect = await evaljs(`document.querySelector('#pane-codemirror .cm-content').getBoundingClientRect().toJSON()`);
  const x = Math.floor(rect.x + 60);
  const y = Math.floor(rect.y + 40);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
  await send('Input.insertText', { text: 'Smoke test sentence. ' }, sessionId);
  await sleep(1600);
  const after = await evaljs(`window.__s.text('#pane-codemirror .revision-list')`);
  const hit = await evaljs(`document.elementFromPoint(${x},${y})?.className`);
  const hasText = await evaljs(`window.__texeris.getCanonical('codemirror').includes('Smoke test sentence')`);
  if (after === before || !after.includes('user')) {
    throw new Error(`no new user revision (hit=${hit} inserted=${hasText}) list=${JSON.stringify(after)}`);
  }
});

// ---------- Tiptap tab ----------
await step('Tiptap tab boots with pills and a real table', async () => {
  await evaljs(`window.__s.clickText('.tab-btn', 'Tiptap')`);
  await waitFor(`window.__s.count('#pane-tiptap .ProseMirror') === 1`);
  const pills = await evaljs(`window.__s.count('#pane-tiptap .cite-pill')`);
  const tables = await evaljs(`window.__s.count('#pane-tiptap .ProseMirror table')`);
  if (pills < 3 || tables < 1) throw new Error(`pills=${pills} tables=${tables}`);
  return `${pills} pills, ${tables} table`;
});

await step('Tiptap patch B applies (serialize→apply→reparse)', async () => {
  await evaljs(`window.__s.clickText('#pane-tiptap .patch-group .tool-btn', 'B · tighten')`);
  const msg = await evaljs(`window.__s.text('#pane-tiptap .message-line')`);
  if (!msg.includes('applied')) throw new Error(msg);
  const rev = await evaljs(`window.__s.text('#pane-tiptap .revision-list')`);
  if (!rev.includes('agent')) throw new Error('no agent revision: ' + rev);
});

await step('Tiptap raw mode (CM6) + back keeps round-trip OK', async () => {
  await evaljs(`window.__s.clickText('#pane-tiptap .tool-group .tool-btn', 'Raw Markdown')`);
  await waitFor(`window.__s.count('#pane-tiptap .tiptap-raw .cm-editor') === 1`);
  const badge1 = await evaljs(`window.__s.text('#pane-tiptap .rt-badge')`);
  await evaljs(`window.__s.clickText('#pane-tiptap .tool-group .tool-btn', 'Rendered')`);
  await sleep(300);
  const badge2 = await evaljs(`window.__s.text('#pane-tiptap .rt-badge')`);
  if (!badge1.includes('OK') || !badge2.includes('OK')) throw new Error(`${badge1} / ${badge2}`);
  return badge2.trim();
});

await step('Tiptap conflict demo fails safely', async () => {
  await evaljs(`window.__s.clickText('#pane-tiptap .patch-group .tool-btn', 'conflict demo')`);
  const msg = await evaljs(`window.__s.text('#pane-tiptap .message-line')`);
  if (!msg.includes('expected text not found')) throw new Error(msg);
});

await step('edge sample loads cleanly in both tabs', async () => {
  await evaljs(`window.__s.select('edge-sample.md')`);
  await sleep(400);
  const tt = await evaljs(`window.__s.text('#pane-tiptap .ProseMirror')`);
  if (!tt.includes('Edge Cases')) throw new Error('tiptap missing edge sample');
  const badge = await evaljs(`window.__s.text('#pane-tiptap .rt-badge')`);
  if (!badge.includes('OK')) throw new Error('badge: ' + badge);
  await evaljs(`window.__s.clickText('.tab-btn', 'CodeMirror')`);
  const cm = await evaljs(`window.__s.text('#pane-codemirror .cm-content')`);
  if (!cm.includes('Edge Cases')) throw new Error('cm missing edge sample');
});

console.log(results.join('\n'));
console.log('\nconsole errors:', consoleErrors.length ? consoleErrors : 'none');
console.log('uncaught exceptions:', exceptions.length ? exceptions : 'none');

ws.close();
chrome.kill();
const failed = results.filter((r) => r.startsWith('FAIL')).length;
process.exit(failed > 0 || exceptions.length > 0 ? 1 : 0);
