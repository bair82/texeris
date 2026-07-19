import { describe, expect, it } from 'vitest';
import { extractHeadings, sliceSection } from './markdown';

const DOC = [
  '# Title',
  '',
  'intro text',
  '',
  '## Methods',
  '',
  '```',
  '# not a heading',
  '```',
  '',
  'methods text',
  '',
  '### Subsection',
  '',
  'sub text',
  '',
  '## Results',
  '',
  'results text',
].join('\n');

describe('extractHeadings', () => {
  it('finds ATX headings and ignores # inside fenced code', () => {
    const headings = extractHeadings(DOC);
    expect(headings.map((h) => h.text)).toEqual([
      'Title',
      'Methods',
      'Subsection',
      'Results',
    ]);
    expect(headings.map((h) => h.level)).toEqual([1, 2, 3, 2]);
  });

  it('handles documents with no headings', () => {
    expect(extractHeadings('just text\n\nmore text')).toEqual([]);
  });
});

describe('sliceSection', () => {
  it('returns the section up to the next same-or-higher heading', () => {
    const section = sliceSection(DOC, 'Methods');
    expect(section).toContain('## Methods');
    expect(section).toContain('methods text');
    expect(section).toContain('### Subsection');
    expect(section).toContain('# not a heading'); // code fences ride along as raw text
    expect(section).not.toContain('Results');
  });

  it('returns null for a missing heading', () => {
    expect(sliceSection(DOC, 'Discussion')).toBeNull();
  });
});
