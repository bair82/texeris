import { describe, expect, it } from 'vitest';
import {
  extractPdfText,
  pdfCorpusMarkdown,
  pdfDocumentMarkdown,
  PdfExtractionError,
} from './pdf';
import { makeImageOnlyPdf, makeTextPdf } from './pdf-fixture.test-helper';

const PAGE_ONE = '# Literal heading\n' + 'Selectable academic prose for extraction. '.repeat(7);
const PAGE_TWO = '- Literal list\n' + 'A second page retains its own text boundary. '.repeat(7);

describe('PDF text extraction', () => {
  it('extracts and normalizes text page by page without external tools', async () => {
    const extracted = await extractPdfText(makeTextPdf([PAGE_ONE, PAGE_TWO]));
    expect(extracted.totalPages).toBe(2);
    expect(extracted.pages[0]).toContain('Selectable academic prose');
    expect(extracted.pages[1]).toContain('second page');
    expect(extracted.warnings.join(' ')).toMatch(/lossy/i);
  });

  it('keeps editable Markdown clean and page markers in corpus text only', async () => {
    const extracted = await extractPdfText(makeTextPdf([PAGE_ONE, PAGE_TWO]));
    const document = pdfDocumentMarkdown(extracted);
    const corpus = pdfCorpusMarkdown(extracted);
    expect(document).not.toContain('texeris:pdf-page');
    expect(document).toContain('\\# Literal heading');
    expect(document).toContain('\\- Literal list');
    expect(corpus).toContain('<!-- texeris:pdf-page=1 -->');
    expect(corpus).toContain('<!-- texeris:pdf-page=2 -->');
  });

  it('rejects image-only and malformed PDFs with actionable errors', async () => {
    await expect(extractPdfText(makeImageOnlyPdf())).rejects.toMatchObject({
      code: 'no-text',
    } satisfies Partial<PdfExtractionError>);
    await expect(extractPdfText(Buffer.from('not a pdf'))).rejects.toMatchObject({
      code: 'invalid',
    } satisfies Partial<PdfExtractionError>);
  });
});
