import { describe, expect, it } from 'vitest';
import {
  citationLabel,
  findCitations,
  serializeCitation,
} from './citations';
import mainSample from '../samples/main-sample.md?raw';
import edgeSample from '../samples/edge-sample.md?raw';

describe('citation parser', () => {
  it('extracts the plain form with correct range', () => {
    const text = 'see [@smith2024] for details';
    const spans = findCitations(text);
    expect(spans).toHaveLength(1);
    expect(spans[0].from).toBe(4);
    expect(spans[0].to).toBe(4 + '[@smith2024]'.length);
    expect(text.slice(spans[0].from, spans[0].to)).toBe('[@smith2024]');
    expect(spans[0].items).toEqual([{ suppressAuthor: false, key: 'smith2024', suffix: '' }]);
  });

  it('extracts the suppress-author + locator form', () => {
    const [span] = findCitations('x [-@smith2024, p. 14] y');
    expect(span.raw).toBe('[-@smith2024, p. 14]');
    expect(span.items[0].suppressAuthor).toBe(true);
    expect(span.items[0].suffix).toBe(', p. 14');
  });

  it('extracts the two-key form', () => {
    const [span] = findCitations('[@smith2024; @jones2023]');
    expect(span.items.map((i) => i.key)).toEqual(['smith2024', 'jones2023']);
    expect(span.items[1].suffix).toBe('');
  });

  it('extracts the multi-key multi-locator form', () => {
    const [span] = findCitations('[@smith2024, pp. 18–20; @jones2023, ch. 4]');
    expect(span.items).toEqual([
      { suppressAuthor: false, key: 'smith2024', suffix: ', pp. 18–20' },
      { suppressAuthor: false, key: 'jones2023', suffix: ', ch. 4' },
    ]);
  });

  it('round-trips every marker found in the samples', () => {
    for (const text of [mainSample, edgeSample]) {
      for (const span of findCitations(text)) {
        expect(serializeCitation(span.items)).toBe(span.raw);
      }
    }
  });

  it('finds all sample citations, including the one inside a footnote', () => {
    const raws = [...findCitations(mainSample), ...findCitations(edgeSample)].map((s) => s.raw);
    expect(raws).toContain('[@smith2024]');
    expect(raws).toContain('[-@smith2024, p. 14]');
    expect(raws).toContain('[@smith2024; @jones2023]');
    expect(raws).toContain('[@smith2024, pp. 18–20; @jones2023, ch. 4]');
    expect(raws).toContain('[@jones2023]');
  });

  it('does not treat footnote refs or links as citations', () => {
    expect(findCitations('a note [^1] and a [link](https://x.test)')).toHaveLength(0);
  });

  it('derives readable labels', () => {
    const [span] = findCitations('[@smith2024; @jones2023]');
    expect(citationLabel(span.items)).toBe('Smith 2024; Jones 2023');
  });
});
