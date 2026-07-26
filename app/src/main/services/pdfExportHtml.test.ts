import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPdfPrintHtml, sanitizePrintHtml } from './pdfExportHtml';

describe('PDF print HTML', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.cwd(), '.texeris-pdf-html-'));
    // Stand-in converter: the pipeline feeds Markdown on stdin and treats
    // stdout as HTML, so echoing stdin back exercises inlining + sanitize.
    const fakePandoc = path.join(root, 'fake-pandoc.sh');
    fs.writeFileSync(fakePandoc, '#!/bin/sh\ncat\n');
    fs.chmodSync(fakePandoc, 0o755);
    process.env.TEXERIS_PANDOC_PATH = fakePandoc;
  });

  afterEach(() => {
    delete process.env.TEXERIS_PANDOC_PATH;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('sanitizes active content and unsafe resource URLs', () => {
    const html = sanitizePrintHtml('<h1 onclick="bad()">Title</h1><script>bad()</script><img src="file:///etc/passwd" alt="secret"><a href="javascript:bad()">link</a>');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).not.toMatch(/script|onclick|file:|javascript:/);
    expect(html).toContain('[Image: secret]');
  });

  it('embeds project images and wraps an A4, CSP-protected document', async () => {
    const relative = 'assets/paper/media/figure.png';
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), Buffer.from('png bytes'));
    const source = `<h1>Paper</h1><img src="${relative}" alt="Figure"><img src="https://example.test/x.png" alt="Remote"><script>bad()</script>`;
    const result = await buildPdfPrintHtml(source, 'Paper', root);
    expect(result.html).toContain('data:image/png;base64,');
    expect(result.html).toContain('@page { size: A4 portrait;');
    expect(result.html).toContain('Content-Security-Policy');
    expect(result.html).not.toMatch(/<script|https:\/\/example\.test/);
    expect(result.warnings.join(' ')).toMatch(/Remote images/);
  });
});
