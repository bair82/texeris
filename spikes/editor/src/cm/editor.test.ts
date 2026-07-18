/**
 * Smoke test: building the live-render decoration set must not throw
 * (overlapping replace ranges throw at Decoration.set build time) and must
 * produce decorations, for both samples and for a few cursor positions.
 * DOM-free: EditorState + the lezer tree run in plain node.
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import mainSample from '../samples/main-sample.md?raw';
import edgeSample from '../samples/edge-sample.md?raw';
import { buildLiveDecorations } from './editor';

function stateFor(doc: string, cursor: number) {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
    selection: { anchor: Math.min(cursor, doc.length) },
  });
}

describe('CM live-render decoration build', () => {
  it.each([
    ['main-sample', mainSample],
    ['edge-sample', edgeSample],
  ])('builds without throwing (%s)', (_name, text) => {
    const deco = buildLiveDecorations(stateFor(text, 0));
    expect(deco.size).toBeGreaterThan(0);
  });

  it('builds with the cursor inside constructs (raw reveal path)', () => {
    // Cursor in the heading line, inside the first citation, inside a table.
    const positions = [
      2,
      mainSample.indexOf('[@smith2024]') + 3,
      mainSample.indexOf('| Practice'),
      mainSample.indexOf('[^1]:') + 2,
    ];
    for (const pos of positions) {
      expect(() => buildLiveDecorations(stateFor(mainSample, pos))).not.toThrow();
    }
    const edgePositions = [
      edgeSample.indexOf('***term***') + 2,
      edgeSample.indexOf('[link]') + 2,
      edgeSample.indexOf('[^e1]') + 2,
    ];
    for (const pos of edgePositions) {
      expect(() => buildLiveDecorations(stateFor(edgeSample, pos))).not.toThrow();
    }
  });
});
