import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./pandoc', () => ({
  writePandocHtml: () => ({
    html: '<h1>Paper</h1><p>Printable text.</p>',
    warnings: [],
  }),
}));

import { buildPdfPrintHtml, inlineProjectImages, sanitizePrintHtml } from './pdfExportHtml';

describe('PDF print HTML', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.cwd(), '.texeris-pdf-html-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('sanitizes active content and unsafe resource URLs', () => {
    const html = sanitizePrintHtml('<h1 onclick="bad()">Title</h1><script>bad()</script><img src="file:///etc/passwd" alt="secret"><a href="javascript:bad()">link</a>');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).not.toMatch(/script|onclick|file:|javascript:/);
    expect(html).toContain('[Image: secret]');
  });

  it('embeds project images and wraps an A4, CSP-protected document', () => {
    const relative = 'assets/paper/media/figure.png';
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), Buffer.from('png bytes'));
    const source = `<h1>Paper</h1><img src="${relative}" alt="Figure"><img src="https://example.test/x.png" alt="Remote"><script>bad()</script>`;
    const inlined = inlineProjectImages(source, root);
    expect(inlined.markdown).toContain('data:image/png;base64,');
    const result = buildPdfPrintHtml(
      source,
      'Paper',
      root,
    );
    expect(result.html).toContain('@page { size: A4 portrait;');
    expect(result.html).toContain('Content-Security-Policy');
    expect(result.html).not.toMatch(/<script|https:\/\/example\.test/);
    expect(result.warnings.join(' ')).toMatch(/Remote images/);
  });
});
