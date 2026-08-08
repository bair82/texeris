import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ArchiveAttachment,
  ArchiveImportReport,
  ArchivePreview,
  ArchiveReindexReport,
  ArchiveSearchResult,
  ArchiveSourceView,
} from '../../shared/archive-types';
import { atomicWriteBytes, atomicWriteText, hashText } from './document';
import { convertToMarkdown, PANDOC_VERSION } from './pandoc';
import { extractPdfText, pdfCorpusMarkdown, PDF_EXTRACTOR_VERSION } from './pdf';
import { isCancellation, throwIfCancelled } from '../jobs/runner';
import { workspaceDir } from './settings';
import { jobRunner } from '../jobs/current';

const SUPPORTED = new Set([
  '.md', '.markdown', '.mdown', '.txt', '.html', '.htm', '.docx', '.odt', '.rtf', '.pdf',
]);
const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_DEPTH = 10;
const PREVIEW_CHARS = 120_000;

interface WalkedFile {
  path: string;
  size: number;
  mtime: string;
}

interface Converted {
  markdown: string;
  converter: string;
  warnings: string[];
}

interface Passage {
  id: string;
  ordinal: number;
  heading: string | null;
  page: number | null;
  start: number;
  end: number;
  text: string;
}

interface SourceRow {
  id: string;
  title: string;
  original_path: string;
  canonical_path: string;
  format: string;
  source_hash: string;
  source_size: number;
  source_mtime: string;
  imported_at: string;
  snapshot_path: string;
  markdown_path: string;
  markdown_hash: string;
  converter: string;
  warnings_json: string;
  passage_count: number;
}

export interface ArchiveCorpusSource {
  originalPath: string;
  canonicalPath: string;
  snapshotPath: string;
  format: string;
  size: number;
  modifiedAt: string;
}

export interface ArchiveOptions {
  dir?: string;
}

/** Workspace-global immutable writing snapshots and their rebuildable FTS projection. */
export class ArchiveService {
  readonly root: string;
  private readonly databasePath: string;
  private readonly db: DatabaseSync;

  constructor(options: ArchiveOptions = {}) {
    this.root = path.join(options.dir ?? workspaceDir(), 'archive');
    fs.mkdirSync(this.root, { recursive: true });
    this.databasePath = path.join(this.root, 'archive.sqlite');
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  async importPaths(
    selectedPaths: readonly string[],
    signal?: AbortSignal,
    onProgress?: (done: number, total: number, file: string) => void,
  ): Promise<ArchiveImportReport> {
    const { files, warnings } = this.walk(selectedPaths);
    if (files.length === 0) throw new Error('no supported writing files were selected');
    const snapshots = path.join(this.root, 'snapshots');
    const derivatives = path.join(this.root, 'derivatives');
    fs.mkdirSync(snapshots, { recursive: true });
    fs.mkdirSync(derivatives, { recursive: true });

    let imported = 0;
    let duplicates = 0;
    let skipped = 0;
    for (let index = 0; index < files.length; index += 1) {
      throwIfCancelled(signal);
      const file = files[index];
      const bytes = fs.readFileSync(file.path);
      const sourceHash = createHash('sha256').update(bytes).digest('hex');
      const existing = this.db
        .prepare('SELECT id FROM archive_sources WHERE source_hash = ?')
        .get(sourceHash);
      if (existing) {
        duplicates += 1;
        onProgress?.(index + 1, files.length, path.basename(file.path));
        continue;
      }

      const extension = path.extname(file.path).toLowerCase();
      const snapshotPath = path.join(snapshots, `${sourceHash}${extension}`);
      const derivativeDir = path.join(derivatives, sourceHash);
      const markdownPath = path.join(derivativeDir, 'document.md');
      try {
        if (!fs.existsSync(snapshotPath)) atomicWriteBytes(snapshotPath, bytes);
        const converted = await convert(file.path, bytes, signal);
        throwIfCancelled(signal);
        fs.mkdirSync(derivativeDir, { recursive: true });
        atomicWriteText(markdownPath, converted.markdown);
        const passages = segment(converted.markdown);
        const id = randomUUID();
        const title = titleFrom(converted.markdown, file.path);
        this.db.exec('BEGIN');
        try {
          this.db.prepare(
            `INSERT INTO archive_sources
             (id, title, original_path, canonical_path, format, source_hash,
              source_size, source_mtime, imported_at, snapshot_path,
              markdown_path, markdown_hash, converter, warnings_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            title,
            file.path,
            fs.realpathSync(file.path),
            extension.slice(1),
            sourceHash,
            file.size,
            file.mtime,
            new Date().toISOString(),
            snapshotPath,
            markdownPath,
            hashText(converted.markdown),
            converted.converter,
            JSON.stringify(converted.warnings),
          );
          const insertPassage = this.db.prepare(
            `INSERT INTO archive_passages
             (id, source_id, ordinal, heading, page, start_offset, end_offset, text)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          const insertFts = this.db.prepare(
            `INSERT INTO archive_fts
             (passage_id, source_id, title, heading, text) VALUES (?, ?, ?, ?, ?)`,
          );
          for (const passage of passages) {
            insertPassage.run(
              passage.id, id, passage.ordinal, passage.heading, passage.page,
              passage.start, passage.end, passage.text,
            );
            insertFts.run(passage.id, id, title, passage.heading ?? '', passage.text);
          }
          this.db.exec('COMMIT');
          imported += 1;
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
      } catch (error) {
        if (isCancellation(error)) {
          this.removeUnreferenced(sourceHash, snapshotPath, derivativeDir);
          throw error;
        }
        skipped += 1;
        warnings.push(
          `skipped ${path.basename(file.path)}: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.removeUnreferenced(sourceHash, snapshotPath, derivativeDir);
      }
      onProgress?.(index + 1, files.length, path.basename(file.path));
    }
    return { imported, duplicates, skipped, warnings };
  }

  list(): ArchiveSourceView[] {
    const rows = this.db.prepare(
      `SELECT s.*, COUNT(p.id) AS passage_count
       FROM archive_sources s
       LEFT JOIN archive_passages p ON p.source_id = s.id
       GROUP BY s.id
       ORDER BY s.imported_at DESC, s.rowid DESC`,
    ).all() as unknown as SourceRow[];
    return rows.map((row) => this.sourceView(row));
  }

  search(query: string, limit = 20): ArchiveSearchResult[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const rows = this.db.prepare(
      `SELECT f.passage_id, f.source_id, f.title, p.heading, p.page,
              p.start_offset,
              snippet(archive_fts, 4, '‹', '›', ' … ', 28) AS excerpt
       FROM archive_fts f
       JOIN archive_passages p ON p.id = f.passage_id
       WHERE archive_fts MATCH ?
       ORDER BY bm25(archive_fts, 0, 0, 2, 1, 4), p.ordinal
       LIMIT ?`,
    ).all(match, limit) as Array<{
      passage_id: string;
      source_id: string;
      title: string;
      heading: string | null;
      page: number | null;
      excerpt: string;
      start_offset: number;
    }>;
    return rows.map((row) => ({
      passageId: row.passage_id,
      sourceId: row.source_id,
      title: row.title,
      heading: row.heading,
      page: row.page,
      excerpt: row.excerpt,
      startOffset: row.start_offset,
    }));
  }

  /** Atomically rebuild the disposable FTS projection from stored passages. */
  reindex(signal?: AbortSignal): Promise<ArchiveReindexReport> {
    return jobRunner().run<ArchiveReindexReport>(
      'archive-reindex',
      { databasePath: this.databasePath },
      { signal },
    );
  }

  preview(sourceId: string, offset = 0): ArchivePreview {
    const row = this.sourceRow(sourceId);
    const text = fs.readFileSync(row.markdown_path, 'utf8');
    if (hashText(text) !== row.markdown_hash) {
      throw new Error('the archived text snapshot failed integrity validation');
    }
    const start = Math.min(offset, Math.max(0, text.length - 1));
    return {
      source: this.sourceView(row),
      text: text.slice(start, start + PREVIEW_CHARS),
      offset: start,
      totalChars: text.length,
      truncated: start > 0 || start + PREVIEW_CHARS < text.length,
    };
  }

  passages(ids: readonly string[]): ArchiveAttachment[] {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)].slice(0, 12);
    const placeholders = unique.map(() => '?').join(', ');
    const raw = this.db.prepare(
      `SELECT p.id AS passage_id, p.source_id, s.title, p.heading, p.page,
              p.text AS excerpt, p.start_offset
       FROM archive_passages p
       JOIN archive_sources s ON s.id = p.source_id
       WHERE p.id IN (${placeholders})`,
    ).all(...unique) as Array<{
      passage_id: string;
      source_id: string;
      title: string;
      heading: string | null;
      page: number | null;
      excerpt: string;
      start_offset: number;
    }>;
    const rows: ArchiveSearchResult[] = raw.map((row) => ({
      passageId: row.passage_id,
      sourceId: row.source_id,
      title: row.title,
      heading: row.heading,
      page: row.page,
      excerpt: row.excerpt,
      startOffset: row.start_offset,
    }));
    const byId = new Map(rows.map((row) => [row.passageId, row]));
    return unique.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  }

  corpusSources(ids: readonly string[]): ArchiveCorpusSource[] {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT id, original_path, canonical_path, snapshot_path, format,
              source_size, source_mtime
       FROM archive_sources WHERE id IN (${placeholders})`,
    ).all(...unique) as Array<{
      id: string;
      original_path: string;
      canonical_path: string;
      snapshot_path: string;
      format: string;
      source_size: number;
      source_mtime: string;
    }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    return unique.flatMap((id) => {
      const row = byId.get(id);
      if (!row) return [];
      const bytes = fs.readFileSync(row.snapshot_path);
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      const expectedHash = path.basename(row.snapshot_path, path.extname(row.snapshot_path));
      if (actualHash !== expectedHash) {
        throw new Error(`the saved snapshot for ${path.basename(row.original_path)} failed integrity validation`);
      }
      return [{
          originalPath: row.original_path,
          canonicalPath: row.canonical_path,
          snapshotPath: row.snapshot_path,
          format: row.format,
          size: row.source_size,
          modifiedAt: row.source_mtime,
        }];
    });
  }

  delete(sourceId: string): void {
    const row = this.sourceRow(sourceId);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM archive_fts WHERE source_id = ?').run(sourceId);
      this.db.prepare('DELETE FROM archive_sources WHERE id = ?').run(sourceId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    fs.rmSync(row.snapshot_path, { force: true });
    fs.rmSync(path.dirname(row.markdown_path), { recursive: true, force: true });
  }

  private sourceRow(sourceId: string): SourceRow {
    const row = this.db.prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM archive_passages p WHERE p.source_id = s.id) AS passage_count
       FROM archive_sources s WHERE s.id = ?`,
    ).get(sourceId) as unknown as SourceRow | undefined;
    if (!row) throw new Error('archive source not found');
    return row;
  }

  private sourceView(row: SourceRow): ArchiveSourceView {
    let status: ArchiveSourceView['status'] = 'missing';
    try {
      const stat = fs.statSync(row.canonical_path);
      status =
        stat.size === row.source_size && stat.mtime.toISOString() === row.source_mtime
          ? 'current'
          : 'changed';
    } catch {
      status = 'missing';
    }
    return {
      id: row.id,
      title: row.title,
      originalPath: row.original_path,
      format: row.format,
      size: row.source_size,
      modifiedAt: row.source_mtime,
      importedAt: row.imported_at,
      status,
      passageCount: Number(row.passage_count),
      warnings: JSON.parse(row.warnings_json) as string[],
    };
  }

  private walk(selected: readonly string[]): { files: WalkedFile[]; warnings: string[] } {
    const files = new Map<string, WalkedFile>();
    const warnings: string[] = [];
    let totalBytes = 0;
    const visit = (entry: string, depth: number): void => {
      const stat = fs.lstatSync(entry);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        if (depth >= MAX_DEPTH) return;
        for (const child of fs.readdirSync(entry, { withFileTypes: true })) {
          if (!child.name.startsWith('.')) visit(path.join(entry, child.name), depth + 1);
        }
        return;
      }
      if (!stat.isFile() || !SUPPORTED.has(path.extname(entry).toLowerCase())) return;
      const real = fs.realpathSync(entry);
      if (files.has(real)) return;
      if (stat.size > MAX_FILE_BYTES) {
        warnings.push(`skipped ${entry}: larger than the 100 MB per-file limit`);
        return;
      }
      files.set(real, { path: real, size: stat.size, mtime: stat.mtime.toISOString() });
      totalBytes += stat.size;
      if (files.size > MAX_FILES) throw new Error(`archive import exceeds the ${MAX_FILES}-file limit`);
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('archive import exceeds the 1 GB total limit');
    };
    selected.forEach((entry) => visit(entry, 0));
    return { files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), warnings };
  }

  private removeUnreferenced(hash: string, snapshot: string, derivative: string): void {
    const used = this.db.prepare('SELECT 1 FROM archive_sources WHERE source_hash = ?').get(hash);
    if (!used) {
      fs.rmSync(snapshot, { force: true });
      fs.rmSync(derivative, { recursive: true, force: true });
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS archive_sources(
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        original_path TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        format TEXT NOT NULL,
        source_hash TEXT UNIQUE NOT NULL,
        source_size INTEGER NOT NULL,
        source_mtime TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        snapshot_path TEXT NOT NULL,
        markdown_path TEXT NOT NULL,
        markdown_hash TEXT NOT NULL,
        converter TEXT NOT NULL,
        warnings_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS archive_passages(
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES archive_sources(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        heading TEXT,
        page INTEGER,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        text TEXT NOT NULL,
        UNIQUE(source_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_archive_passages_source ON archive_passages(source_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(
        passage_id UNINDEXED,
        source_id UNINDEXED,
        title,
        heading,
        text,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
  }
}

async function convert(file: string, bytes: Buffer, signal?: AbortSignal): Promise<Converted> {
  const ext = path.extname(file).toLowerCase();
  if (['.md', '.markdown', '.mdown', '.txt'].includes(ext)) {
    return { markdown: bytes.toString('utf8'), converter: 'direct-utf8-v1', warnings: [] };
  }
  if (ext === '.pdf') {
    try {
      const extracted = await extractPdfText(bytes, signal);
      return {
        markdown: pdfCorpusMarkdown(extracted),
        converter: extracted.converter,
        warnings: extracted.warnings,
      };
    } catch (error) {
      if (isCancellation(error)) throw error;
      throw new Error(
        `PDF conversion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  try {
    return await convertToMarkdown(file, bytes, { signal });
  } catch (error) {
    if (isCancellation(error)) throw error;
    throw new Error(
      `Pandoc conversion failed (${PANDOC_VERSION}/${PDF_EXTRACTOR_VERSION}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function titleFrom(markdown: string, file: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || path.basename(file, path.extname(file));
}

function ftsQuery(query: string): string {
  return (query.match(/[\p{L}\p{N}_]+/gu) ?? [])
    .slice(0, 12)
    .map((token) => `"${token}"*`)
    .join(' AND ');
}

function segment(markdown: string): Passage[] {
  const passages: Passage[] = [];
  let heading: string | null = null;
  let page: number | null = null;
  let ordinal = 0;
  let group: { start: number; end: number; parts: string[] } | null = null;

  const flush = () => {
    if (!group) return;
    const text = group.parts.join('\n\n').trim();
    if (text) {
      passages.push({
        id: randomUUID(),
        ordinal: ordinal++,
        heading,
        page,
        start: group.start,
        end: group.end,
        text,
      });
    }
    group = null;
  };

  const blocks = [...markdown.matchAll(/(?:^|\n\n+)([\s\S]*?)(?=\n\n+|$)/g)];
  for (const match of blocks) {
    const raw = match[1];
    const text = raw.trim();
    if (!text) continue;
    const start = (match.index ?? 0) + raw.indexOf(text);
    const end = start + text.length;
    const pageMatch = text.match(/^<!--\s*texeris:pdf-page=(\d+)\s*-->$/);
    if (pageMatch) {
      flush();
      page = Number(pageMatch[1]);
      continue;
    }
    const headingMatch = text.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      flush();
      heading = headingMatch[1].trim();
      continue;
    }
    if (group && group.parts.join('\n\n').length + text.length + 2 > 1800) flush();
    if (!group) group = { start, end, parts: [] };
    group.parts.push(text);
    group.end = end;
  }
  flush();
  if (passages.length === 0 && markdown.trim()) {
    const text = markdown.trim().slice(0, 1800);
    passages.push({
      id: randomUUID(), ordinal: 0, heading: null, page: null,
      start: markdown.indexOf(text), end: markdown.indexOf(text) + text.length, text,
    });
  }
  return passages;
}
