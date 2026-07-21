import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CorpusSourceView } from '../../shared/profile-types';
import type { ProjectContext } from './project';
import { atomicWriteText, hashText } from './document';
import { workspaceDir } from './settings';

const SUPPORTED = new Set(['.md', '.markdown', '.mdown', '.txt', '.html', '.htm', '.docx', '.odt', '.rtf', '.pdf']);

/** Kept in lockstep with scripts/prepare-pandoc.mjs and the packaged resource. */
export const PANDOC_VERSION = '3.10';

interface Converted {
  markdown: string;
  converter: string;
  warnings: string[];
}

export class CorpusService {
  constructor(private readonly cacheDir = path.join(workspaceDir(), 'corpus-cache')) {}

  createGrant(
    project: ProjectContext,
    conversationId: string,
    selectedPaths: readonly string[],
    sourceKind: 'files' | 'folder',
  ): { grantId: string; sources: CorpusSourceView[] } {
    const files = snapshotFiles(selectedPaths);
    if (files.length === 0) throw new Error('no supported writing files were selected');
    const grantId = randomUUID();
    project.db
      .prepare('INSERT INTO corpus_grants (id, conversation_id, created_at, source_kind) VALUES (?, ?, ?, ?)')
      .run(grantId, conversationId, new Date().toISOString(), sourceKind);
    const insert = project.db.prepare(
      `INSERT INTO corpus_sources
       (id, grant_id, original_path, canonical_path, source_hash, source_size,
        source_mtime, format, markdown_path, markdown_hash, converter,
        detected_date, date_confidence, conversion_warnings_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const views: CorpusSourceView[] = [];
    for (const file of files) {
      const bytes = fs.readFileSync(file);
      const sourceHash = createHash('sha256').update(bytes).digest('hex');
      const converted = convert(file, bytes);
      const derivativeDir = path.join(this.cacheDir, sourceHash);
      fs.mkdirSync(derivativeDir, { recursive: true });
      const markdownPath = path.join(derivativeDir, 'document.md');
      atomicWriteText(markdownPath, converted.markdown);
      const stat = fs.statSync(file);
      const detected = detectDate(converted.markdown, path.basename(file));
      const id = randomUUID();
      insert.run(
        id,
        grantId,
        file,
        fs.realpathSync(file),
        sourceHash,
        stat.size,
        stat.mtime.toISOString(),
        path.extname(file).slice(1).toLowerCase(),
        markdownPath,
        hashText(converted.markdown),
        converted.converter,
        detected?.date ?? null,
        detected?.confidence ?? null,
        JSON.stringify(converted.warnings),
      );
      views.push({
        id,
        originalPath: file,
        format: path.extname(file).slice(1).toLowerCase(),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        detectedDate: detected?.date ?? null,
        dateConfidence: detected?.confidence ?? null,
        warnings: converted.warnings,
      });
    }
    project.db
      .prepare('UPDATE conversations SET corpus_grant_id = ? WHERE id = ?')
      .run(grantId, conversationId);
    return { grantId, sources: views };
  }

  grantForConversation(project: ProjectContext, conversationId: string): string | null {
    const row = project.db
      .prepare('SELECT corpus_grant_id FROM conversations WHERE id = ?')
      .get(conversationId) as { corpus_grant_id: string | null } | undefined;
    return row?.corpus_grant_id ?? null;
  }

  list(project: ProjectContext, grantId: string): CorpusSourceView[] {
    const rows = project.db
      .prepare(
        `SELECT id, original_path, format, source_size, source_mtime, detected_date,
                date_confidence, conversion_warnings_json
         FROM corpus_sources WHERE grant_id = ? ORDER BY original_path`,
      )
      .all(grantId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      originalPath: row.original_path as string,
      format: row.format as string,
      size: row.source_size as number,
      modifiedAt: row.source_mtime as string,
      detectedDate: row.detected_date as string | null,
      dateConfidence: row.date_confidence as string | null,
      warnings: JSON.parse(row.conversion_warnings_json as string) as string[],
    }));
  }

  read(project: ProjectContext, grantId: string, sourceId: string, offset: number, limit: number) {
    const row = project.db
      .prepare(
        `SELECT original_path, markdown_path, source_hash, markdown_hash
         FROM corpus_sources WHERE id = ? AND grant_id = ?`,
      )
      .get(sourceId, grantId) as
      | { original_path: string; markdown_path: string; source_hash: string; markdown_hash: string }
      | undefined;
    if (!row) throw new Error('source is not part of this conversation corpus');
    const currentHash = createHash('sha256').update(fs.readFileSync(row.original_path)).digest('hex');
    if (currentHash !== row.source_hash) throw new Error('source changed after corpus selection; start a new profile run');
    const text = fs.readFileSync(row.markdown_path, 'utf8');
    if (hashText(text) !== row.markdown_hash) throw new Error('cached conversion failed integrity validation');
    const start = Math.min(offset, text.length);
    const end = Math.min(start + limit, text.length);
    return { sourceId, offset: start, end, totalChars: text.length, text: text.slice(start, end) };
  }
}

function snapshotFiles(selected: readonly string[]): string[] {
  const files = new Set<string>();
  const visit = (entry: string): void => {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry, { withFileTypes: true })) {
        if (child.name.startsWith('.')) continue;
        visit(path.join(entry, child.name));
      }
      return;
    }
    if (stat.isFile() && SUPPORTED.has(path.extname(entry).toLowerCase())) {
      files.add(fs.realpathSync(entry));
    }
  };
  selected.forEach(visit);
  return [...files].sort();
}

function convert(file: string, bytes: Buffer): Converted {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.md' || ext === '.markdown' || ext === '.mdown' || ext === '.txt') {
    return { markdown: bytes.toString('utf8'), converter: 'direct-utf8-v1', warnings: [] };
  }
  if (ext === '.pdf') {
    try {
      const markdown = execFileSync('pdftotext', ['-layout', file, '-'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      const warnings = markdown.trim().length < 200
        ? ['PDF yielded very little text; it may be scanned or image-based']
        : [];
      return { markdown, converter: 'pdftotext-layout-v1', warnings };
    } catch (error) {
      return { markdown: '', converter: 'pdftotext-unavailable', warnings: [`PDF conversion failed: ${String(error)}`] };
    }
  }
  const pandoc = resolvePandoc();
  if (!pandoc) {
    return {
      markdown: '',
      converter: `pandoc-${PANDOC_VERSION}-missing`,
      warnings: ['The packaged Pandoc converter is unavailable. Reinstall Texeris or ask the administrator to repair the installation.'],
    };
  }
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
    return {
      markdown: '',
      converter: `pandoc-${PANDOC_VERSION}-failed`,
      warnings: [`Pandoc conversion failed: ${errorMessage(error)}`],
    };
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

  // electron-vite development runs have no app.asar. A PATH fallback keeps
  // contributor workflows convenient without making release builds depend on it.
  if (!isPackagedRuntime()) return { path: 'pandoc', kind: 'development-path' };
  return null;
}

function pandocPlatformDirectory(): string {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  return `${process.platform}-${arch}`;
}

function isPackagedRuntime(): boolean {
  return Boolean(process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'app.asar')));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function detectDate(text: string, filename: string): { date: string; confidence: string } | null {
  const frontmatter = text.slice(0, 4000).match(/^---\s*[\s\S]*?^date:\s*["']?([^\n"']+)/m);
  if (frontmatter) return { date: frontmatter[1].trim(), confidence: 'explicit-metadata' };
  const nameYear = filename.match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/);
  if (nameYear) return { date: nameYear[1], confidence: 'filename-year' };
  const published = text.slice(0, 8000).match(/(?:published|publication date)\s*[:—-]\s*([^\n]+)/i);
  return published ? { date: published[1].trim(), confidence: 'publication-statement' } : null;
}
