/** Manual evaluation checklist — static checkboxes, no persistence. */

export const CHECKLIST_ITEMS: string[] = [
  'Cursor movement near hidden syntax (arrow through a heading, emphasis span, and link; watch markers appear/disappear)',
  'Selection + deletion across a citation chip (select from before to after a pill, delete)',
  'Copy/paste of rendered text (inside the editor; then paste into a plain-text target)',
  'IME / dead-key composition (type accented characters, e.g. é or ü, in both modes)',
  'Table editing (Tiptap: real table cells; CodeMirror: styled pipe lines — compare the feel)',
  'Footnote navigation (find the def for a ref; check definition styling in both tabs)',
  'Repeated mode switching (rendered → raw → rendered several times; watch the round-trip badge)',
  'Partial patch acceptance (apply patch D with 2 of 3 groups; verify only those spots change)',
];

export function renderChecklist(container: HTMLElement): void {
  const details = document.createElement('details');
  details.className = 'checklist';
  const summary = document.createElement('summary');
  summary.textContent = `Evaluation checklist (${CHECKLIST_ITEMS.length} manual tests)`;
  details.appendChild(summary);
  const list = document.createElement('ol');
  for (const item of CHECKLIST_ITEMS) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    label.appendChild(box);
    label.appendChild(document.createTextNode(` ${item}`));
    li.appendChild(label);
    list.appendChild(li);
  }
  details.appendChild(list);
  container.appendChild(details);
}
