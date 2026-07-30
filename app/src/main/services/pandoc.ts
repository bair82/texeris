import * as fs from 'node:fs';
import * as path from 'node:path';
import { jobRunner } from '../jobs/current';
import type { CslReference } from '../../shared/reference-types';

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
  signal?: AbortSignal;
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
export async function convertToMarkdown(
  file: string,
  bytes: Buffer,
  options: ConversionOptions = {},
): Promise<MarkdownConversion> {
  const format = formatForPath(file);
  if (!format) throw new Error(`unsupported import format: ${path.extname(file) || 'no extension'}`);
  if (format === 'pdf') throw new Error('PDF imports must use the PDF text extractor');
  if (format === 'markdown') {
    const markdown = bytes.toString('utf8');
    if (!looksLikePandocMarkdown(markdown)) {
      return { markdown, converter: 'direct-utf8-v1', warnings: [] };
    }
    return convertWithPandoc(file, bytes, [
      'Pandoc-specific Markdown was normalized for the rendered editor; inspect complex formatting after import.',
    ], options);
  }
  return convertWithPandoc(file, bytes, [], options);
}

function looksLikePandocMarkdown(markdown: string): boolean {
  return /^\+[:=+\-]{3,}\+|\[[^\]\n]+\]\{\.(?:underline|smallcaps)\}/m.test(markdown);
}

async function convertWithPandoc(
  file: string,
  bytes: Buffer,
  initialWarnings: string[] = [],
  options: ConversionOptions = {},
): Promise<MarkdownConversion> {
  const pandoc = requirePandoc();
  const result = await jobRunner().run<{ markdown: string }>(
    'pandoc-convert',
    {
      pandocPath: pandoc.path,
      fileName: file,
      bytes,
      options: { mediaDir: options.mediaDir },
    },
    { signal: options.signal },
  );
  let markdown = result.markdown;
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
}

/** Write canonical Markdown as a DOCX, ODT, or RTF derivative. */
export async function writePandocExport(
  markdown: string,
  outputPath: string,
  format: Exclude<InterchangeFormat, 'markdown' | 'pdf'>,
  resourceRoot?: string,
  signal?: AbortSignal,
  bibliographyPath?: string,
  citationStylePath?: string,
): Promise<string[]> {
  const pandoc = requirePandoc();
  await jobRunner().run(
    'pandoc-export',
    {
      pandocPath: pandoc.path,
      markdown,
      outputPath,
      format,
      resourceRoot,
      bibliographyPath,
      citationStylePath,
    },
    { signal },
  );
  return pandoc.kind === 'development-path'
    ? ['Using a development Pandoc installation; packaged builds use the pinned Texeris converter.']
    : [];
}

/** Convert canonical Markdown to an HTML fragment without granting file access. */
export async function writePandocHtml(
  markdown: string,
  signal?: AbortSignal,
  bibliographyPath?: string,
  citationStylePath?: string,
): Promise<{ html: string; warnings: string[] }> {
  const pandoc = requirePandoc();
  const { html } = await jobRunner().run<{ html: string }>(
    'pandoc-html',
    { pandocPath: pandoc.path, markdown, bibliographyPath, citationStylePath },
    { signal },
  );
  return {
    html,
    warnings: pandoc.kind === 'development-path'
      ? ['Using a development Pandoc installation; packaged builds use the pinned Texeris converter.']
      : [],
  };
}

export async function importBibliography(
  fileName: string,
  format: 'bibtex' | 'ris',
  signal?: AbortSignal,
): Promise<CslReference[]> {
  const pandoc = requirePandoc();
  const { cslJson } = await jobRunner().run<{ cslJson: string }>(
    'pandoc-reference-import',
    { pandocPath: pandoc.path, fileName, format },
    { signal },
  );
  const parsed = JSON.parse(cslJson) as unknown;
  if (!Array.isArray(parsed)) throw new Error('reference converter returned invalid CSL JSON');
  return parsed as CslReference[];
}

export interface PandocResolution {
  path: string;
  kind: 'bundled' | 'development-path';
}

export function requirePandoc(): PandocResolution {
  const pandoc = resolvePandoc();
  if (!pandoc) {
    throw new Error('The packaged Pandoc converter is unavailable. Reinstall Texeris or repair the installation.');
  }
  return pandoc;
}

export function resolvePandoc(): PandocResolution | null {
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
