import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { referencedAssets } from '../services/assets';
import { extractPdfTextInProcess, type PdfTextExtraction } from '../services/pdf';
import { renderPrintDocument, sanitizePrintHtml } from '../services/pdfExportHtml';
import type { JobRunOptions, JobRunnerLike } from './runner';

/**
 * Pure, Electron-free task implementations executed inside the job worker
 * (jobs/worker.ts) and directly unit-testable in plain Node via runTask.
 * Everything CPU- or subprocess-heavy that used to block the main event
 * loop lives here.
 */

const MAX_BUFFER = 64 * 1024 * 1024;

export interface PandocConvertPayload {
  pandocPath: string;
  fileName: string;
  bytes: Buffer;
  options: { mediaDir?: string };
}

export interface PandocExportPayload {
  pandocPath: string;
  markdown: string;
  outputPath: string;
  format: 'docx' | 'odt' | 'rtf';
  resourceRoot?: string;
  bibliographyPath?: string;
  citationStylePath?: string;
}

export interface PandocHtmlPayload {
  pandocPath: string;
  markdown: string;
  bibliographyPath?: string;
  citationStylePath?: string;
}

export interface PandocReferenceImportPayload {
  pandocPath: string;
  fileName: string;
  format: 'bibtex' | 'ris';
}

export interface PdfPrepareHtmlPayload {
  pandocPath: string;
  markdown: string;
  title: string;
  resourceRoot: string;
  bibliographyPath?: string;
  citationStylePath?: string;
}

export interface PdfExtractPayload {
  bytes: Buffer;
}

export interface ArchiveReindexPayload {
  databasePath: string;
}

/** execFile as a promise, with optional stdin (execFile has no `input` option). */
function execFileAsync(
  file: string,
  args: string[],
  options: { input?: string; cwd?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { encoding: 'utf8', maxBuffer: MAX_BUFFER, cwd: options.cwd },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
    if (options.input !== undefined) {
      // If the child exits without reading stdin (e.g. an immediate argument
      // error), the write raises EPIPE on the stream — swallow it; the real
      // failure surfaces through the exit callback.
      child.stdin!.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') throw error;
      });
      child.stdin!.end(options.input);
    }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pandocConvert(payload: PandocConvertPayload): Promise<{ markdown: string; warnings: string[] }> {
  const args = [payload.fileName, '--to=gfm', '--wrap=none', '--standalone=false', '--sandbox', '--track-changes=accept'];
  if (payload.options.mediaDir) args.push(`--extract-media=${payload.options.mediaDir}`);
  try {
    const markdown = await execFileAsync(payload.pandocPath, args);
    return { markdown, warnings: [] };
  } catch (error) {
    throw new Error(`Pandoc import failed: ${errorMessage(error)}`);
  }
}

async function pandocExport(payload: PandocExportPayload): Promise<{ warnings: string[] }> {
  try {
    await execFileAsync(
      payload.pandocPath,
      [
        '--from=markdown',
        `--to=${payload.format}`,
        '--output', payload.outputPath,
        '--sandbox',
        ...(payload.resourceRoot ? [`--resource-path=${payload.resourceRoot}`] : []),
        ...(payload.bibliographyPath
          ? [
              '--citeproc',
              `--bibliography=${payload.bibliographyPath}`,
              ...(payload.citationStylePath ? [`--csl=${payload.citationStylePath}`] : []),
            ]
          : []),
      ],
      { input: payload.markdown, cwd: payload.resourceRoot },
    );
    return { warnings: [] };
  } catch (error) {
    throw new Error(`Pandoc export failed: ${errorMessage(error)}`);
  }
}

async function pandocHtml(payload: PandocHtmlPayload): Promise<{ html: string; warnings: string[] }> {
  try {
    const html = await execFileAsync(
      payload.pandocPath,
      [
        '--from=markdown',
        '--to=html5',
        '--wrap=none',
        '--sandbox',
        ...(payload.bibliographyPath
          ? [
              '--citeproc',
              `--bibliography=${payload.bibliographyPath}`,
              ...(payload.citationStylePath ? [`--csl=${payload.citationStylePath}`] : []),
            ]
          : []),
      ],
      { input: payload.markdown },
    );
    return { html, warnings: [] };
  } catch (error) {
    throw new Error(`Pandoc PDF preparation failed: ${errorMessage(error)}`);
  }
}

async function pandocReferenceImport(
  payload: PandocReferenceImportPayload,
): Promise<{ cslJson: string }> {
  try {
    const cslJson = await execFileAsync(payload.pandocPath, [
      payload.fileName,
      `--from=${payload.format}`,
      '--to=csljson',
      '--standalone',
      '--sandbox',
    ]);
    return { cslJson };
  } catch (error) {
    throw new Error(`Reference import failed: ${errorMessage(error)}`);
  }
}

const IMAGE_MIME: Record<string, string> = {
  '.avif': 'image/avif', '.gif': 'image/gif', '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};

/** Replace project-owned image references with base64 data URIs (async fs). */
export async function inlineProjectImages(
  markdown: string,
  root: string,
): Promise<{ markdown: string; warnings: string[] }> {
  let output = markdown;
  const warnings: string[] = [];
  for (const relative of referencedAssets(markdown)) {
    const target = path.resolve(root, ...relative.split('/'));
    const rootPrefix = `${path.resolve(root)}${path.sep}`;
    const mime = IMAGE_MIME[path.extname(relative).toLowerCase()];
    const stat = await fs.stat(target).catch(() => null);
    if (!target.startsWith(rootPrefix) || !mime || !stat?.isFile()) {
      warnings.push(`Image ${relative} was omitted because its project asset is unavailable.`);
      continue;
    }
    const dataUri = `data:${mime};base64,${(await fs.readFile(target)).toString('base64')}`;
    output = output.replaceAll(relative, dataUri);
  }
  if (/!\[[^\]]*\]\(https?:\/\/|<img\b[^>]*\bsrc=["']https?:\/\//i.test(output)) {
    warnings.push('Remote images were omitted from the PDF; only project-owned image assets are embedded.');
  }
  return { markdown: output, warnings };
}

/** Inline images, convert to HTML via Pandoc, sanitize, and wrap for printToPDF. */
async function pdfPrepareHtml(payload: PdfPrepareHtmlPayload): Promise<{ html: string; warnings: string[] }> {
  const inlined = await inlineProjectImages(payload.markdown, payload.resourceRoot);
  const converted = await pandocHtml({
    pandocPath: payload.pandocPath,
    markdown: inlined.markdown,
    bibliographyPath: payload.bibliographyPath,
    citationStylePath: payload.citationStylePath,
  });
  if (/<img\b[^>]*\bsrc=["']https?:\/\//i.test(converted.html)
    && !inlined.warnings.some((warning) => warning.startsWith('Remote images'))) {
    inlined.warnings.push('Remote images were omitted from the PDF; only project-owned image assets are embedded.');
  }
  const body = sanitizePrintHtml(converted.html);
  return {
    html: renderPrintDocument(payload.title, body),
    warnings: [...inlined.warnings, ...converted.warnings],
  };
}

async function pdfExtract(payload: PdfExtractPayload): Promise<PdfTextExtraction> {
  return extractPdfTextInProcess(payload.bytes);
}

function archiveReindex(
  payload: ArchiveReindexPayload,
): { sources: number; passages: number } {
  const db = new DatabaseSync(payload.databasePath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const sources = (
      db.prepare('SELECT COUNT(*) AS count FROM archive_sources').get() as { count: number }
    ).count;
    const passages = (
      db.prepare('SELECT COUNT(*) AS count FROM archive_passages').get() as { count: number }
    ).count;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        DELETE FROM archive_fts;
        INSERT INTO archive_fts (passage_id, source_id, title, heading, text)
        SELECT p.id, p.source_id, s.title, COALESCE(p.heading, ''), p.text
        FROM archive_passages p
        JOIN archive_sources s ON s.id = p.source_id
        ORDER BY s.rowid, p.ordinal
      `);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { sources, passages };
  } finally {
    db.close();
  }
}

/** Dispatch table shared by the worker entry and in-process test runs. */
export async function runTask(
  kind: string,
  payload: unknown,
  onProgress?: (progress: unknown) => void,
): Promise<unknown> {
  void onProgress; // tasks currently report no intra-task progress
  switch (kind) {
    case 'pandoc-convert':
      return pandocConvert(payload as PandocConvertPayload);
    case 'pandoc-export':
      return pandocExport(payload as PandocExportPayload);
    case 'pandoc-html':
      return pandocHtml(payload as PandocHtmlPayload);
    case 'pandoc-reference-import':
      return pandocReferenceImport(payload as PandocReferenceImportPayload);
    case 'pdf-prepare-html':
      return pdfPrepareHtml(payload as PdfPrepareHtmlPayload);
    case 'pdf-extract':
      return pdfExtract(payload as PdfExtractPayload);
    case 'archive-reindex':
      return archiveReindex(payload as ArchiveReindexPayload);
    default:
      throw new Error(`unknown job task: ${kind}`);
  }
}

/** Runner for unit tests: same task code, no worker thread. Cancellation is
 * only honored before the task starts (nothing to terminate in-process). */
export function createInProcessRunner(): JobRunnerLike {
  return {
    async run<T>(kind: string, payload: unknown, options: JobRunOptions = {}): Promise<T> {
      if (options.signal?.aborted) throw new Error('cancelled');
      return (await runTask(kind, payload, options.onProgress)) as T;
    },
  };
}
