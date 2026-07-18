/**
 * Sample agent patches against the main sample document.
 * Offsets are resolved against the shipped sample text at module load, so a
 * broken anchor fails loudly instead of producing a silent misapply.
 */

import mainSample from '../samples/main-sample.md?raw';
import type { DocumentPatch } from '../lib/patch';

function span(anchor: string): { from: number; to: number } {
  const first = mainSample.indexOf(anchor);
  if (first < 0 || first !== mainSample.lastIndexOf(anchor)) {
    throw new Error(`patch anchor missing or not unique: ${JSON.stringify(anchor)}`);
  }
  return { from: first, to: first + anchor.length };
}

function point(anchor: string): number {
  return span(anchor).to;
}

const BASE = 'r0';
const DOC = 'main-sample';

/** (a) Delete an "It is important to note that"-style hedge. */
export const patchTrimHedge: DocumentPatch = {
  id: 'patch-trim-hedge',
  documentId: DOC,
  baseRevisionId: BASE,
  title: 'Trim throat-clearing',
  summary: 'Delete the "It is important to note that" hedge; the sentence is stronger without it.',
  groups: [
    {
      id: 'g1',
      explanation: 'Remove the hedge, keep the claim.',
      changes: [
        {
          ...span('It is important to note that '),
          expectedText: 'It is important to note that ',
          insert: '',
          suffixContext: 'readers did not merely',
        },
      ],
    },
  ],
};

/** (b) Replace a wordy sentence with a tighter one. */
export const patchTightenSentence: DocumentPatch = {
  id: 'patch-tighten-sentence',
  documentId: DOC,
  baseRevisionId: BASE,
  title: 'Tighten a wordy sentence',
  groups: [
    {
      id: 'g1',
      changes: [
        {
          ...span(
            'Due to the fact that printed books were expensive objects in the early modern period, owners tended to keep them for a long time and marked them heavily.',
          ),
          expectedText:
            'Due to the fact that printed books were expensive objects in the early modern period, owners tended to keep them for a long time and marked them heavily.',
          insert:
            'Because printed books were expensive in the early modern period, owners kept them longer and marked them heavily.',
        },
      ],
    },
  ],
};

/** (c) Insert a qualifying sentence after a claim. */
export const patchAddQualifier: DocumentPatch = {
  id: 'patch-add-qualifier',
  documentId: DOC,
  baseRevisionId: BASE,
  title: 'Qualify a sweeping claim',
  groups: [
    {
      id: 'g1',
      explanation: 'The claim overgeneralizes; add scope.',
      changes: [
        {
          from: point('Annotation was a social practice, not a solitary one.'),
          to: point('Annotation was a social practice, not a solitary one.'),
          expectedText: '',
          insert: ' This pattern, however, varies sharply by period, region, and genre.',
          prefixContext: 'not a solitary one.',
          suffixContext: ' Circulating annotated copies',
        },
      ],
    },
  ],
};

/** (d) Multi-group patch touching three separate spots (partial-accept demo). */
export const patchPolish: DocumentPatch = {
  id: 'patch-polish',
  documentId: DOC,
  baseRevisionId: BASE,
  title: 'Three small polish edits',
  summary: 'Independent tweaks; each group can be accepted on its own.',
  groups: [
    {
      id: 'wording',
      explanation: '"dog-eared" undersells a working copy.',
      changes: [
        {
          ...span('dog-eared copy of Plutarch'),
          expectedText: 'dog-eared copy of Plutarch',
          insert: 'well-thumbed copy of Plutarch',
          prefixContext: 'Consider a ',
        },
      ],
    },
    {
      id: 'register',
      explanation: '"quiet" is doing too little work here.',
      changes: [
        {
          ...span('quiet reader in Leiden'),
          expectedText: 'quiet reader in Leiden',
          insert: 'reticent reader in Leiden',
        },
      ],
    },
    {
      id: 'trim-paren',
      explanation: 'Drop a distracting parenthetical.',
      changes: [
        {
          ...span(' (often in pencil)'),
          expectedText: ' (often in pencil)',
          insert: '',
          suffixContext: ' outright mockery',
        },
      ],
    },
  ],
};

export const samplePatches: DocumentPatch[] = [
  patchTrimHedge,
  patchTightenSentence,
  patchAddQualifier,
  patchPolish,
];
