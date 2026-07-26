import { extractText, getDocumentProxy } from 'unpdf';
import { jobRunner } from '../jobs/current';

export const PDF_EXTRACTOR_VERSION = 'unpdf-1.6.2';
export const MAX_PDF_BYTES = 100 * 1024 * 1024;
export const MAX_PDF_PAGES = 1_000;
export const MIN_PDF_TEXT_CHARACTERS = 200;

const LOSSY_WARNING =
  'PDF text extraction is lossy; inspect columns, tables, equations, headers, footers, and line breaks after import.';

export class PdfExtractionError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'password' | 'too-large' | 'too-many-pages' | 'no-text',
  ) {
    super(message);
    this.name = 'PdfExtractionError';
  }
}

export interface PdfTextExtraction {
  pages: string[];
  totalPages: number;
  textCharacters: number;
  converter: string;
  warnings: string[];
}

function normalizePage(text: string): string {
  const lines = text
    .normalize('NFC')
    .replaceAll('\0', '')
    .replaceAll('\u00ad', '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t\v\f ]+/g, ' ').trimEnd());
  const normalized: string[] = [];
  let blank = false;
  for (const line of lines) {
    if (!line.trim()) {
      if (!blank && normalized.length) normalized.push('');
      blank = true;
    } else {
      normalized.push(line.trimStart());
      blank = false;
    }
  }
  return normalized.join('\n').trim();
}

function friendlyPdfError(error: unknown): PdfExtractionError {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  if (/password/i.test(`${name} ${message}`)) {
    return new PdfExtractionError(
      'This PDF is password-protected. Remove the password before importing it; Texeris does not prompt for PDF passwords.',
      'password',
    );
  }
  return new PdfExtractionError(`The PDF could not be read: ${message}`, 'invalid');
}

const PDF_ERROR_CODES = new Set(['invalid', 'password', 'too-large', 'too-many-pages', 'no-text']);

/**
 * Extract selectable text without native tools, rendering, OCR, or network
 * access. Runs on a job worker (unpdf is CPU-bound); typed error codes
 * survive the serialization boundary.
 */
export async function extractPdfText(bytes: Uint8Array, signal?: AbortSignal): Promise<PdfTextExtraction> {
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new PdfExtractionError('PDF files must be 100 MB or smaller.', 'too-large');
  }
  try {
    return await jobRunner().run<PdfTextExtraction>('pdf-extract', { bytes: Buffer.from(bytes) }, { signal });
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (error instanceof Error && typeof code === 'string' && PDF_ERROR_CODES.has(code)) {
      throw new PdfExtractionError(error.message, code as PdfExtractionError['code']);
    }
    throw error;
  }
}

/** The in-process extractor, executed inside the job worker (jobs/tasks.ts). */
export async function extractPdfTextInProcess(bytes: Uint8Array): Promise<PdfTextExtraction> {
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new PdfExtractionError('PDF files must be 100 MB or smaller.', 'too-large');
  }
  let document: Awaited<ReturnType<typeof getDocumentProxy>> | null = null;
  try {
    document = await getDocumentProxy(Uint8Array.from(bytes));
    if (document.numPages > MAX_PDF_PAGES) {
      throw new PdfExtractionError('PDF files must contain 1,000 pages or fewer.', 'too-many-pages');
    }
    const extracted = await extractText(document, { mergePages: false });
    const pages = extracted.text.map(normalizePage);
    const textCharacters = pages.join('').replace(/\s/g, '').length;
    if (textCharacters < MIN_PDF_TEXT_CHARACTERS) {
      throw new PdfExtractionError(
        'This PDF contains too little selectable text to import. It may be scanned or image-based; OCR is not supported yet.',
        'no-text',
      );
    }
    return {
      pages,
      totalPages: extracted.totalPages,
      textCharacters,
      converter: PDF_EXTRACTOR_VERSION,
      warnings: [LOSSY_WARNING],
    };
  } catch (error) {
    if (error instanceof PdfExtractionError) throw error;
    throw friendlyPdfError(error);
  } finally {
    await document?.destroy();
  }
}

function escapePlainMarkdown(text: string): string {
  return text
    .split('\n')
    .map((line) => line
      .replace(/([\\`*_{}|~])/g, '\\$1')
      .replace(/^(\s{0,3})([#>+*-])(?=\s)/, '$1\\$2')
      .replace(/^(\s{0,3}\d+)([.)])(?=\s)/, '$1\\$2'))
    .join('\n');
}

export function pdfDocumentMarkdown(extraction: PdfTextExtraction): string {
  return `${extraction.pages.map(escapePlainMarkdown).filter(Boolean).join('\n\n').trim()}\n`;
}

export function pdfCorpusMarkdown(extraction: PdfTextExtraction): string {
  return `${extraction.pages.map((page, index) =>
    `<!-- texeris:pdf-page=${index + 1} -->\n\n${page}`,
  ).join('\n\n').trim()}\n`;
}
