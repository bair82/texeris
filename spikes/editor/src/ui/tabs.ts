/** One editor tab: toolbar, editor mount, side panel, revision grouping. */

import type { EditorHandle, EditorMode } from './handle';
import { createCMEditor } from '../cm/editor';
import { createTiptapEditor } from '../tiptap/editor';
import { RevisionGrouper } from '../lib/revisions';
import { validatePatch, type DocumentPatch } from '../lib/patch';
import { markdownIn } from '../lib/markdown-in';
import { markdownOut } from '../lib/markdown-out';
import { diffLineCounts, formatCompactDiff, lineDiff } from '../lib/diff';
import {
  patchAddQualifier,
  patchPolish,
  patchTightenSentence,
  patchTrimHedge,
} from '../patches/samples';
import { formatConflicts, renderRevisions, showMessage, showRoundTrip } from './panels';

export class TabController {
  private grouper = new RevisionGrouper(1000);
  private handle: EditorHandle;
  private modeRenderedBtn: HTMLButtonElement;
  private modeRawBtn: HTMLButtonElement;
  private rtBadge: HTMLElement;
  private diffEl: HTMLElement;
  private messageEl: HTMLElement;
  private revisionListEl: HTMLElement;

  constructor(
    readonly kind: 'codemirror' | 'tiptap',
    readonly root: HTMLElement,
    sampleText: string,
  ) {
    root.classList.add('tab-pane');
    const toolbar = el('div', 'toolbar');
    this.modeRenderedBtn = button('Rendered', () => this.switchMode('rendered'));
    this.modeRawBtn = button('Raw Markdown', () => this.switchMode('raw'));
    const modeGroup = el('span', 'tool-group');
    modeGroup.append(label('Mode:'), this.modeRenderedBtn, this.modeRawBtn);

    this.rtBadge = el('span', 'rt-badge unknown');
    this.rtBadge.textContent = 'round-trip —';
    const rtGroup = el('span', 'tool-group');
    rtGroup.append(label('Round-trip:'), button('Check', () => this.runRoundTrip()), this.rtBadge);

    const patchGroup = el('span', 'tool-group patch-group');
    patchGroup.append(label('Patches:'));
    patchGroup.append(
      patchButton('A · trim hedge', patchTrimHedge, () => this.applyPatch(patchTrimHedge)),
      patchButton('B · tighten', patchTightenSentence, () =>
        this.applyPatch(patchTightenSentence),
      ),
      patchButton('C · qualify', patchAddQualifier, () => this.applyPatch(patchAddQualifier)),
      patchButton('D · polish (3 groups)', patchPolish, () => this.applyPatch(patchPolish)),
      patchButton('D · partial (2/3)', patchPolish, () =>
        this.applyPatch(patchPolish, ['wording', 'trim-paren']),
      ),
      button('⚠ conflict demo', () => this.conflictDemo(), 'Simulate a local edit racing the patch'),
    );

    toolbar.append(modeGroup, rtGroup, patchGroup);

    const body = el('div', 'tab-body');
    const editorMount = el('div', 'editor-mount');
    const side = el('aside', 'side-panel');
    this.messageEl = el('div', 'message-line info');
    this.diffEl = el('pre', 'diff-view');
    this.diffEl.style.display = 'none';
    const revHead = el('h3', '');
    revHead.textContent = 'Revisions';
    this.revisionListEl = el('ol', 'revision-list');
    side.append(this.messageEl, this.diffEl, revHead, this.revisionListEl);
    body.append(editorMount, side);
    root.append(toolbar, body);

    this.handle =
      kind === 'codemirror'
        ? createCMEditor({
            doc: sampleText,
            onRevisionEvent: (ev) => {
              this.grouper.record(ev);
              this.refreshRevisions();
            },
          })
        : createTiptapEditor({
            doc: sampleText,
            onRevisionEvent: (ev) => {
              this.grouper.record(ev);
              this.refreshRevisions();
            },
          });
    this.handle.mount(editorMount);
    this.syncModeButtons();
    this.refreshRevisions();
    this.runRoundTrip();
  }

  loadSample(text: string): void {
    this.handle.setCanonicalText(text);
    this.grouper.reset();
    this.refreshRevisions();
    showMessage(this.messageEl, 'sample loaded', 'info');
    this.runRoundTrip();
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }

  focus(): void {
    this.handle.focus();
  }

  private switchMode(mode: EditorMode): void {
    this.handle.setMode(mode);
    this.syncModeButtons();
    this.runRoundTrip();
  }

  private syncModeButtons(): void {
    const mode = this.handle.getMode();
    this.modeRenderedBtn.classList.toggle('active', mode === 'rendered');
    this.modeRawBtn.classList.toggle('active', mode === 'raw');
    this.modeRenderedBtn.setAttribute('aria-pressed', String(mode === 'rendered'));
    this.modeRawBtn.setAttribute('aria-pressed', String(mode === 'raw'));
  }

  private refreshRevisions(): void {
    renderRevisions(this.revisionListEl, this.grouper.entries(), this.grouper.currentRevisionId);
  }

  private runRoundTrip(): void {
    const canonical = this.handle.getCanonicalText();
    try {
      const roundTripped = markdownOut(markdownIn(canonical));
      if (roundTripped === canonical) {
        showRoundTrip(this.rtBadge, this.diffEl, { ok: true });
      } else {
        const ops = lineDiff(canonical, roundTripped);
        const { added, removed } = diffLineCounts(ops);
        showRoundTrip(this.rtBadge, this.diffEl, {
          ok: false,
          differingLines: added + removed,
          diff: formatCompactDiff(ops),
        });
      }
    } catch (err) {
      showRoundTrip(this.rtBadge, this.diffEl, {
        ok: false,
        diff: `serializer error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private applyPatch(patch: DocumentPatch, groupIds?: string[]): void {
    const current = this.handle.getCanonicalText();
    const validation = validatePatch(
      current,
      patch,
      this.grouper.currentRevisionId,
      groupIds,
    );
    const result = this.handle.applyDocumentPatch(patch, groupIds);
    if (!result.ok) {
      showMessage(this.messageEl, formatConflicts(result.conflicts), 'error');
      return;
    }
    let msg = `applied “${patch.title}” [${result.appliedGroups.join(', ')}]`;
    if (
      !validation.ok &&
      validation.errors.some((e) => e.reason === 'base-revision-mismatch')
    ) {
      msg += ` — base ${patch.baseRevisionId} ≠ current ${this.grouper.currentRevisionId}, applied via expected-text check (auto-rebase)`;
      showMessage(this.messageEl, msg, 'info');
    } else {
      showMessage(this.messageEl, msg, 'ok');
    }
    this.runRoundTrip();
  }

  private conflictDemo(): void {
    const changed = this.handle.replaceLiteral(
      'It is important to note that',
      'It is worth observing that',
    );
    if (!changed) {
      showMessage(
        this.messageEl,
        'demo phrase not found — the document may already be modified',
        'error',
      );
      return;
    }
    const result = this.handle.applyDocumentPatch(patchTrimHedge);
    if (!result.ok) {
      showMessage(
        this.messageEl,
        `local edit raced the patch (as intended):\n${formatConflicts(result.conflicts)}`,
        'error',
      );
    } else {
      showMessage(this.messageEl, 'unexpected: patch applied despite the local edit', 'error');
    }
    this.runRoundTrip();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function label(text: string): HTMLElement {
  const s = el('span', 'tool-label');
  s.textContent = text;
  return s;
}

function button(text: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = el('button', 'tool-btn');
  b.type = 'button';
  b.textContent = text;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function patchButton(
  text: string,
  patch: DocumentPatch,
  onClick: () => void,
): HTMLButtonElement {
  return button(text, onClick, patch.summary ?? patch.title);
}
