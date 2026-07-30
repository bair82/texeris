import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTextPdf } from '../services/pdf-fixture.test-helper';
import { convertToMarkdown } from '../services/pandoc';
import { inlineProjectImages, runTask } from './tasks';

/**
 * Task implementations run in-process here (the same code the worker
 * executes). Real Pandoc conversions are gated on TEXERIS_PANDOC_PATH, like
 * pandoc-compat.test.ts — CI without the binary skips them.
 */
const pandoc = process.env.TEXERIS_PANDOC_PATH;

describe('job tasks', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-tasks-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('extracts PDF text through the dispatch table', async () => {
    const bytes = makeTextPdf([
      Array(7).fill('A page of selectable academic prose for extraction.').join('\n'),
    ]);
    const result = (await runTask('pdf-extract', { bytes })) as { totalPages: number; warnings: string[] };
    expect(result.totalPages).toBe(1);
    expect(result.warnings.join(' ')).toMatch(/lossy/i);
  });

  it('rejects unknown task kinds', async () => {
    await expect(runTask('nope', {})).rejects.toThrow(/unknown job task/);
  });

  it('surfaces a missing Pandoc binary as an import failure', async () => {
    await expect(
      runTask('pandoc-convert', {
        pandocPath: path.join(root, 'no-such-pandoc'),
        fileName: 'paper.docx',
        bytes: Buffer.from('x'),
        options: {},
      }),
    ).rejects.toThrow(/Pandoc import failed/);
  });

  it('surfaces the reinstall message when the packaged converter is missing', async () => {
    // Simulate a packaged runtime whose bundled Pandoc is absent.
    const resources = path.join(root, 'resources');
    fs.mkdirSync(path.join(resources, 'app.asar'), { recursive: true });
    const previousResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    const previousOverride = process.env.TEXERIS_PANDOC_PATH;
    delete process.env.TEXERIS_PANDOC_PATH;
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });
    try {
      await expect(convertToMarkdown('paper.docx', Buffer.from('x'))).rejects.toThrow(/Reinstall Texeris/);
    } finally {
      if (previousResources) Object.defineProperty(process, 'resourcesPath', previousResources);
      else delete (process as { resourcesPath?: string }).resourcesPath;
      if (previousOverride) process.env.TEXERIS_PANDOC_PATH = previousOverride;
    }
  });

  it('inlines project images as data URIs and warns on missing assets', async () => {
    const relative = 'assets/paper/media/figure.png';
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), Buffer.from('png bytes'));
    const inlined = await inlineProjectImages(
      `![Figure](${relative})\n\n![Missing](assets/paper/media/gone.png)\n`,
      root,
    );
    expect(inlined.markdown).toContain('data:image/png;base64,');
    expect(inlined.warnings.join(' ')).toMatch(/gone\.png.*unavailable/);
  });

  it.skipIf(!pandoc)('converts a docx fixture via pandoc-convert', async () => {
    const docx = path.join(root, 'fixture.docx');
    execFileSync(pandoc!, ['--from=markdown', '--to=docx', '--output', docx, '--sandbox'], {
      input: '# Fixture Title\n\nBody paragraph text.\n',
    });
    const result = (await runTask('pandoc-convert', {
      pandocPath: pandoc!,
      fileName: docx,
      bytes: fs.readFileSync(docx),
      options: {},
    })) as { markdown: string };
    expect(result.markdown).toContain('Fixture Title');
    expect(result.markdown).toContain('Body paragraph text.');
  });

  it.skipIf(!pandoc)('converts BibTeX and RIS bibliographies to CSL JSON', async () => {
    const fixtures = path.resolve(import.meta.dirname, '../../../test-fixtures');
    for (const [fileName, format] of [
      ['references.bib', 'bibtex'],
      ['references.ris', 'ris'],
    ] as const) {
      const result = (await runTask('pandoc-reference-import', {
        pandocPath: pandoc!,
        fileName: path.join(fixtures, fileName),
        format,
      })) as { cslJson: string };
      const records = JSON.parse(result.cslJson) as Array<{
        id: string;
        title: string;
      }>;
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'smith2024',
            title: 'The Geometry of Attention',
          }),
        ]),
      );
    }
  });

  it.skipIf(!pandoc)('applies an explicit CSL style during citeproc HTML conversion', async () => {
    const bibliography = path.join(root, 'references.json');
    fs.writeFileSync(
      bibliography,
      JSON.stringify([{
        id: 'smith2024',
        type: 'article-journal',
        title: 'Styled Evidence',
        author: [{ family: 'Smith', given: 'Ada' }],
        issued: { 'date-parts': [[2024]] },
      }]),
    );
    const style = path.resolve(import.meta.dirname, '../../../resources/csl/ieee.csl');
    const result = (await runTask('pandoc-html', {
      pandocPath: pandoc!,
      markdown: 'A claim [@smith2024].',
      bibliographyPath: bibliography,
      citationStylePath: style,
    })) as { html: string };
    expect(result.html).toMatch(/A claim \[1\]/);
    expect(result.html).toContain('Styled Evidence');
  });

  it.skipIf(!pandoc)('prepares sanitized print HTML with inlined images via pdf-prepare-html', async () => {
    const relative = 'assets/paper/media/figure.png';
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), Buffer.from('png bytes'));
    const result = (await runTask('pdf-prepare-html', {
      pandocPath: pandoc!,
      markdown: `# Paper\n\n![Figure](${relative})\n\n![Remote](https://example.test/x.png)\n`,
      title: 'Paper',
      resourceRoot: root,
    })) as { html: string; warnings: string[] };
    expect(result.html).toContain('@page { size: A4 portrait;');
    expect(result.html).toContain('Content-Security-Policy');
    expect(result.html).toContain('data:image/png;base64,');
    expect(result.html).not.toMatch(/https:\/\/example\.test/);
    expect(result.warnings.join(' ')).toMatch(/Remote images/);
  });
});
