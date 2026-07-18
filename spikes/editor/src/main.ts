/** Texeris Milestone 0 spike: compare CM6 live-render vs Tiptap structured editing. */

import './styles.css';
import mainSample from './samples/main-sample.md?raw';
import edgeSample from './samples/edge-sample.md?raw';
import { TabController } from './ui/tabs';
import { renderChecklist } from './ui/checklist';

const SAMPLES: Record<string, string> = {
  'main-sample.md': mainSample,
  'edge-sample.md': edgeSample,
};

const app = document.getElementById('app');
if (!app) throw new Error('#app missing');

app.innerHTML = `
  <header class="app-header">
    <div class="app-title">
      <h1>Texeris — editor spike</h1>
      <span class="app-sub">Milestone 0: CodeMirror live-render vs Tiptap structured editing</span>
    </div>
    <label class="sample-picker">
      Sample:
      <select id="sample-select">
        <option value="main-sample.md">main-sample.md</option>
        <option value="edge-sample.md">edge-sample.md</option>
      </select>
    </label>
  </header>
  <nav class="tab-bar" role="tablist">
    <button type="button" class="tab-btn active" data-tab="codemirror" role="tab" aria-selected="true">A · CodeMirror</button>
    <button type="button" class="tab-btn" data-tab="tiptap" role="tab" aria-selected="false">B · Tiptap</button>
  </nav>
  <main id="panes">
    <div id="pane-codemirror"></div>
    <div id="pane-tiptap" class="hidden"></div>
  </main>
  <footer id="checklist-root"></footer>
`;

function currentSampleText(): string {
  const select = document.getElementById('sample-select') as HTMLSelectElement;
  return SAMPLES[select.value];
}

const cmPane = document.getElementById('pane-codemirror') as HTMLElement;
const ttPane = document.getElementById('pane-tiptap') as HTMLElement;

const controllers: Record<string, TabController> = {
  codemirror: new TabController('codemirror', cmPane, currentSampleText()),
  tiptap: new TabController('tiptap', ttPane, currentSampleText()),
};

const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab-btn'));
for (const btn of tabButtons) {
  btn.addEventListener('click', () => {
    for (const b of tabButtons) {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    }
    controllers.codemirror.setVisible(btn.dataset.tab === 'codemirror');
    controllers.tiptap.setVisible(btn.dataset.tab === 'tiptap');
    controllers[btn.dataset.tab ?? 'codemirror'].focus();
  });
}

document.getElementById('sample-select')?.addEventListener('change', () => {
  const text = currentSampleText();
  controllers.codemirror.loadSample(text);
  controllers.tiptap.loadSample(text);
});

renderChecklist(document.getElementById('checklist-root') as HTMLElement);
controllers.codemirror.focus();

// Debug/eval handle: lets the human (and the smoke test) poke at tab state.
(window as unknown as Record<string, unknown>).__texeris = {
  controllers,
  getCanonical: (tab: 'codemirror' | 'tiptap') =>
    controllers[tab]['handle'].getCanonicalText(),
};
