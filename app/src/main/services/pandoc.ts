import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Kept in lockstep with scripts/prepare-pandoc.mjs and the packaged resource. */
export const PANDOC_VERSION = '3.10';

export type InterchangeFormat = 'markdown' | 'docx' | 'odt' | 'rtf' | 'pdf';

export interface MarkdownConversion {
  markdown: string;
  converter: string;
  warnings: string[];
}

export interface ConversionOptions {
  mediaDir?: string;
  mediaReferencePrefix?: string;
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
    case '.pdf':
      return 'pdf';
    default:
      return null;
  }
}

/** Convert a user-selected interchange file into Texeris's canonical Markdown. */
export function convertToMarkdown(file: string, bytes: Buffer, options: ConversionOptions = {}): MarkdownConversion {
  const format = formatForPath(file);
  if (!format) throw new Error(`unsupported import format: ${path.extname(file) || 'no extension'}`);
  if (format === 'pdf') throw new Error('PDF imports must use the PDF text extractor');
  if (format === 'markdown') {
    const markdown = bytes.toString('utf8');
    if (!looksLikePandocMarkdown(markdown)) {
      return { markdown, converter: 'direct-utf8-v1', warnings: [] };
    }
    return convertWithPandoc(file, [
      'Pandoc-specific Markdown was normalized for the rendered editor; inspect complex formatting after import.',
    ], options);
  }
  return convertWithPandoc(file, [], options);
}

function looksLikePandocMarkdown(markdown: string): boolean {
  return /^\+[:=+\-]{3,}\+|\[[^\]\n]+\]\{\.(?:underline|smallcaps)\}/m.test(markdown);
}

function convertWithPandoc(file: string, initialWarnings: string[] = [], options: ConversionOptions = {}): MarkdownConversion {
  const pandoc = resolvePandoc();
  if (!pandoc) throw new Error('The packaged Pandoc converter is unavailable. Reinstall Texeris or repair the installation.');
  try {
    const args = [file, '--to=gfm', '--wrap=none', '--standalone=false', '--sandbox', '--track-changes=accept'];
    if (options.mediaDir) args.push(`--extract-media=${options.mediaDir}`);
    let markdown = execFileSync(
      pandoc.path,
      args,
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (options.mediaDir && options.mediaReferencePrefix) {
      markdown = markdown.split(options.mediaDir).join(options.mediaReferencePrefix.replaceAll(path.sep, '/'));
    }
    return {
      markdown,
      converter: `pandoc-${PANDOC_VERSION}-${pandoc.kind}`,
      warnings: [
        ...initialWarnings,
        ...(pandoc.kind === 'development-path'
          ? ['Using a development Pandoc installation; packaged builds use the pinned Texeris converter.']
          : []),
      ],
    };
  } catch (error) {
    throw new Error(`Pandoc import failed: ${errorMessage(error)}`);
  }
}

/** Write canonical Markdown as a DOCX, ODT, or RTF derivative. */
export function writePandocExport(
  markdown: string,
  outputPath: string,
  format: Exclude<InterchangeFormat, 'markdown' | 'pdf'>,
  resourceRoot?: string,
): string[] {
  const pandoc = resolvePandoc();
  if (!pandoc) throw new Error('The packaged Pandoc converter is unavailable. Reinstall Texeris or repair the installation.');
  try {
    execFileSync(
      pandoc.path,
      [
        '--from=markdown',
        `--to=${format}`,
        '--output', outputPath,
        '--sandbox',
        ...(resourceRoot ? [`--resource-path=${resourceRoot}`] : []),
      ],
      { input: markdown, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: resourceRoot },
    );
  } catch (error) {
    throw new Error(`Pandoc export failed: ${errorMessage(error)}`);
  }
  return pandoc.kind === 'development-path'
    ? ['Using a development Pandoc installation; packaged builds use the pinned Texeris converter.']
    : [];
}

/** Convert canonical Markdown to an HTML fragment without granting file access. */
export function writePandocHtml(markdown: string): { html: string; warnings: string[] } {
  const pandoc = resolvePandoc();
  if (!pandoc) throw new Error('The packaged Pandoc converter is unavailable. Reinstall Texeris or repair the installation.');
  try {
    const html = execFileSync(
      pandoc.path,
      ['--from=markdown', '--to=html5', '--wrap=none', '--sandbox'],
      { input: markdown, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    return {
      html,
      warnings: pandoc.kind === 'development-path'
        ? ['Using a development Pandoc installation; packaged builds use the pinned Texeris converter.']
        : [],
    };
  } catch (error) {
    throw new Error(`Pandoc PDF preparation failed: ${errorMessage(error)}`);
  }
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
