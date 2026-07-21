import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Kept in lockstep with scripts/prepare-pandoc.mjs and the packaged resource. */
export const PANDOC_VERSION = '3.10';

export type InterchangeFormat = 'markdown' | 'docx' | 'odt' | 'rtf';

export interface MarkdownConversion {
  markdown: string;
  converter: string;
  warnings: string[];
}

export function formatForPath(filePath: string): InterchangeFormat | null {
  switch (path.extname(filePath).toLowerCase()) {
    case '.md':
    case '.markdown':
    case '.mdown':
    case '.txt':
      return 'markdown';
    case '.docx':
      return 'docx';
    case '.odt':
      return 'odt';
    case '.rtf':
      return 'rtf';
    default:
      return null;
  }
}

/** Convert a user-selected interchange file into Texeris's canonical Markdown. */
export function convertToMarkdown(file: string, bytes: Buffer): MarkdownConversion {
  const format = formatForPath(file);
  if (!format) throw new Error(`unsupported import format: ${path.extname(file) || 'no extension'}`);
  if (format === 'markdown') {
    return { markdown: bytes.toString('utf8'), converter: 'direct-utf8-v1', warnings: [] };
  }
  const pandoc = resolvePandoc();
  if (!pandoc) throw new Error('The packaged Pandoc converter is unavailable. Reinstall Texeris or repair the installation.');
  try {
    const markdown = execFileSync(
      pandoc.path,
      [file, '--to=markdown', '--wrap=none', '--standalone=false', '--sandbox', '--track-changes=accept'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    return {
      markdown,
      converter: `pandoc-${PANDOC_VERSION}-${pandoc.kind}`,
      warnings: pandoc.kind === 'development-path'
        ? ['Using a development Pandoc installation; packaged builds use the pinned Texeris converter.']
        : [],
    };
  } catch (error) {
    throw new Error(`Pandoc import failed: ${errorMessage(error)}`);
  }
}

/** Write canonical Markdown as a DOCX, ODT, or RTF derivative. */
export function writePandocExport(markdown: string, outputPath: string, format: Exclude<InterchangeFormat, 'markdown'>): string[] {
  const pandoc = resolvePandoc();
  if (!pandoc) throw new Error('The packaged Pandoc converter is unavailable. Reinstall Texeris or repair the installation.');
  try {
    execFileSync(
      pandoc.path,
      ['--from=markdown', `--to=${format}`, '--output', outputPath, '--sandbox'],
      { input: markdown, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    throw new Error(`Pandoc export failed: ${errorMessage(error)}`);
  }
  return pandoc.kind === 'development-path'
    ? ['Using a development Pandoc installation; packaged builds use the pinned Texeris converter.']
    : [];
}

function resolvePandoc(): { path: string; kind: 'bundled' | 'development-path' } | null {
  const override = process.env.TEXERIS_PANDOC_PATH;
  if (override) return { path: override, kind: 'development-path' };
  const resourceRoot = process.resourcesPath;
  const bundled = resourceRoot
    ? path.join(resourceRoot, 'pandoc', pandocPlatformDirectory(), process.platform === 'win32' ? 'pandoc.exe' : 'pandoc')
    : null;
  if (bundled && fs.existsSync(bundled)) return { path: bundled, kind: 'bundled' };
  if (!isPackagedRuntime()) return { path: 'pandoc', kind: 'development-path' };
  return null;
}

function pandocPlatformDirectory(): string {
  return `${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
}

function isPackagedRuntime(): boolean {
  return Boolean(process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'app.asar')));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
